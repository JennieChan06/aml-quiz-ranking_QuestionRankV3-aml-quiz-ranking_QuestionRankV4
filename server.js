const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// 安全性中間件
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "ws:", "wss:"]
    }
  }
}));

app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 速率限制
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分鐘
  max: 100, // 每個IP最多100個請求
  message: { error: '請求過於頻繁，請稍後再試' }
});
app.use('/api/', limiter);

// 初始化資料庫
const db = new sqlite3.Database(':memory:', (err) => {
  if (err) {
    console.error('數據庫連接錯誤:', err.message);
  } else {
    console.log('✅ SQLite 數據庫連接成功');
    initDatabase();
  }
});

// 創建數據表
function initDatabase() {
  const createQuizResultsTableSQL = `
    CREATE TABLE IF NOT EXISTS quiz_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_name TEXT NOT NULL,
      score INTEGER NOT NULL,
      correct_answers INTEGER NOT NULL,
      total_questions INTEGER NOT NULL,
      time_taken INTEGER NOT NULL,
      answers TEXT NOT NULL,
      completion_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      ip_address TEXT
    )
  `;
  
  const createLiveScoresTableSQL = `
    CREATE TABLE IF NOT EXISTS live_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_name TEXT NOT NULL,
      current_score INTEGER NOT NULL,
      questions_answered INTEGER NOT NULL,
      total_questions INTEGER NOT NULL,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
      session_id TEXT,
      ip_address TEXT,
      UNIQUE(player_name, session_id)
    )
  `;
  
  db.run(createQuizResultsTableSQL, (err) => {
    if (err) {
      console.error('創建quiz_results數據表錯誤:', err.message);
    } else {
      console.log('✅ quiz_results數據表創建成功');
    }
  });
  
  db.run(createLiveScoresTableSQL, (err) => {
    if (err) {
      console.error('創建live_scores數據表錯誤:', err.message);
    } else {
      console.log('✅ live_scores數據表創建成功');
    }
  });
}

// API路由

// 提交測驗結果
app.post('/api/submit-quiz', (req, res) => {
  const { playerName, score, correctAnswers, totalQuestions, timeTaken, answers } = req.body;
  const ipAddress = req.ip || req.connection.remoteAddress;
  
  // 驗證數據
  if (!playerName || typeof score !== 'number' || typeof correctAnswers !== 'number') {
    return res.status(400).json({ error: '無效的數據格式' });
  }
  
  if (playerName.length > 20) {
    return res.status(400).json({ error: '姓名長度不能超過20個字元' });
  }
  
  const insertSQL = `
    INSERT INTO quiz_results (player_name, score, correct_answers, total_questions, time_taken, answers, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;
  
  db.run(insertSQL, [
    playerName,
    score,
    correctAnswers,
    totalQuestions,
    timeTaken,
    JSON.stringify(answers),
    ipAddress
  ], function(err) {
    if (err) {
      console.error('插入數據錯誤:', err.message);
      return res.status(500).json({ error: '數據保存失敗' });
    }
    
    // 計算排名
    const rankSQL = `
      SELECT COUNT(*) + 1 as rank 
      FROM quiz_results 
      WHERE score > ? OR (score = ? AND completion_time < (
        SELECT completion_time FROM quiz_results WHERE id = ?
      ))
    `;
    
    db.get(rankSQL, [score, score, this.lastID], (err, row) => {
      if (err) {
        console.error('計算排名錯誤:', err.message);
        return res.status(500).json({ error: '排名計算失敗' });
      }
      
      const rank = row.rank;
      
      // 廣播即時分數更新
      io.emit('live-score-update', {
        playerName,
        currentScore: score,
        rank
      });
      
      // 廣播排行榜更新
      updateLeaderboard();
      
      res.json({
        success: true,
        rank,
        message: '測驗結果提交成功'
      });
    });
  });
});

// 獲取排行榜
app.get('/api/leaderboard', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  
  const leaderboardSQL = `
    SELECT 
      player_name,
      score,
      correct_answers,
      total_questions,
      time_taken,
      completion_time,
      ROW_NUMBER() OVER (ORDER BY score DESC, completion_time ASC) as rank
    FROM quiz_results
    ORDER BY score DESC, completion_time ASC
    LIMIT ?
  `;
  
  db.all(leaderboardSQL, [limit], (err, rows) => {
    if (err) {
      console.error('獲取排行榜錯誤:', err.message);
      return res.status(500).json({ error: '獲取排行榜失敗' });
    }
    
    res.json(rows);
  });
});

// 獲取統計數據
app.get('/api/stats', (req, res) => {
  const statsSQL = `
    SELECT 
      COUNT(*) as totalParticipants,
      AVG(score) as averageScore,
      MAX(score) as highestScore,
      MIN(score) as lowestScore
    FROM quiz_results
  `;
  
  db.get(statsSQL, [], (err, row) => {
    if (err) {
      console.error('獲取統計數據錯誤:', err.message);
      return res.status(500).json({ error: '獲取統計數據失敗' });
    }
    
    res.json({
      totalParticipants: row.totalParticipants || 0,
      averageScore: row.averageScore || 0,
      highestScore: row.highestScore || 0,
      lowestScore: row.lowestScore || 0
    });
  });
});

// 即時排位API - 處理每題答完後的排位更新
app.post('/api/live-ranking', (req, res) => {
  const { playerName, currentScore, questionsAnswered, totalQuestions } = req.body;
  const ipAddress = req.ip || req.connection.remoteAddress;
  const sessionId = req.headers['x-session-id'] || `${playerName}_${Date.now()}`;
  
  // 驗證數據
  if (!playerName || typeof currentScore !== 'number' || typeof questionsAnswered !== 'number') {
    return res.status(400).json({ error: '無效的數據格式' });
  }
  
  // 存儲或更新即時分數
  const upsertLiveScoreSQL = `
    INSERT OR REPLACE INTO live_scores 
    (player_name, current_score, questions_answered, total_questions, session_id, ip_address, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `;
  
  db.run(upsertLiveScoreSQL, [
    playerName, currentScore, questionsAnswered, totalQuestions, sessionId, ipAddress
  ], function(err) {
    if (err) {
      console.error('存儲即時分數錯誤:', err.message);
      return res.status(500).json({ error: '存儲分數失敗' });
    }
    
    // 獲取所有即時分數和已完成測驗的排行榜
    const getAllPlayersSQL = `
      SELECT 
        'live' as type,
        player_name,
        current_score as score,
        questions_answered,
        total_questions,
        last_updated as completion_time
      FROM live_scores
      WHERE questions_answered < total_questions
      
      UNION ALL
      
      SELECT 
        'completed' as type,
        player_name,
        score,
        total_questions as questions_answered,
        total_questions,
        completion_time
      FROM quiz_results
      
      ORDER BY score DESC, completion_time ASC
    `;
    
    db.all(getAllPlayersSQL, [], (err, allPlayers) => {
      if (err) {
        console.error('獲取排行榜錯誤:', err.message);
        return res.status(500).json({ error: '獲取排行榜失敗' });
      }
      
      // 重新分配排名
      allPlayers.forEach((player, index) => {
        player.rank = index + 1;
      });
      
      // 找到當前玩家的排名
      const currentPlayerRank = allPlayers.find(p => p.player_name === playerName);
      
      // 廣播即時分數更新
      io.emit('live-score-update', {
        playerName,
        currentScore,
        questionsAnswered,
        totalQuestions,
        rank: currentPlayerRank?.rank || null
      });
      
      res.json({
        success: true,
        rankings: allPlayers.slice(0, 10), // 只返回前10名
        currentPlayerRank: currentPlayerRank?.rank || null,
        totalPlayers: allPlayers.length
      });
    });
  });
});

// 清理即時分數API - 測驗完成後清理即時分數記錄
app.post('/api/clear-live-score', (req, res) => {
  const { playerName, sessionId } = req.body;
  
  // 驗證數據
  if (!playerName || !sessionId) {
    return res.status(400).json({ error: '無效的數據格式' });
  }
  
  const deleteSQL = `
    DELETE FROM live_scores 
    WHERE player_name = ? AND session_id = ?
  `;
  
  db.run(deleteSQL, [playerName, sessionId], function(err) {
    if (err) {
      console.error('清理即時分數錯誤:', err.message);
      return res.status(500).json({ error: '清理分數失敗' });
    }
    
    console.log(`✅ 已清理 ${playerName} 的即時分數記錄`);
    
    // 廣播即時分數更新（移除該玩家）
    io.emit('live-score-removed', {
      playerName,
      sessionId
    });
    
    res.json({
      success: true,
      message: '即時分數記錄已清理'
    });
  });
});

// 健康檢查端點
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// 主頁路由
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.IO 連接處理
io.on('connection', (socket) => {
  console.log(`👤 用戶連接: ${socket.id}`);
  
  // 發送當前排行榜給新連接的用戶
  updateLeaderboard();
  
  socket.on('disconnect', () => {
    console.log(`👋 用戶斷開連接: ${socket.id}`);
  });
  
  socket.on('join-quiz', (data) => {
    console.log(`🎯 ${data.playerName} 加入測驗`);
    socket.broadcast.emit('player-joined', {
      playerName: data.playerName,
      timestamp: new Date().toISOString()
    });
  });
});

// 更新排行榜並廣播
function updateLeaderboard() {
  const leaderboardSQL = `
    SELECT 
      player_name,
      score,
      correct_answers,
      total_questions,
      time_taken,
      completion_time,
      ROW_NUMBER() OVER (ORDER BY score DESC, completion_time ASC) as rank
    FROM quiz_results
    ORDER BY score DESC, completion_time ASC
    LIMIT 20
  `;
  
  db.all(leaderboardSQL, [], (err, rows) => {
    if (err) {
      console.error('更新排行榜錯誤:', err.message);
      return;
    }
    
    io.emit('leaderboard-update', rows);
  });
}

// 錯誤處理中間件
app.use((err, req, res, next) => {
  console.error('服務器錯誤:', err.stack);
  res.status(500).json({ error: '服務器內部錯誤' });
});

// 404 處理
app.use((req, res) => {
  res.status(404).json({ error: '找不到請求的資源' });
});

// 優雅關閉
process.on('SIGINT', () => {
  console.log('\n🔄 正在關閉服務器...');
  
  db.close((err) => {
    if (err) {
      console.error('關閉數據庫錯誤:', err.message);
    } else {
      console.log('✅ 數據庫連接已關閉');
    }
  });
  
  server.close(() => {
    console.log('✅ 服務器已關閉');
    process.exit(0);
  });
});

// 啟動服務器
server.listen(PORT, () => {
  console.log(`🚀 服務器運行在端口 ${PORT}`);
  console.log(`🌐 本地訪問: http://localhost:${PORT}`);
  console.log(`📊 API 端點: http://localhost:${PORT}/api/`);
  console.log(`🏆 即時排行榜已啟用`);
});

module.exports = app; 