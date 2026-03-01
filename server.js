// 1. Load biến môi trường từ file .env
require('dotenv').config(); 

const express = require('express');
const sql = require('mssql');
const http = require('http'); 
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// 2. Cấu hình Socket.io (Tối ưu cho Cloud Render)
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    },
    transports: ['websocket'] 
});

app.use(express.json());

// 3. Cấu hình kết nối MSSQL dùng biến môi trường
const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    port: parseInt(process.env.DB_PORT) || 1433,
    database: process.env.DB_DATABASE,
    options: {
        encrypt: false, 
        trustServerCertificate: true
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    }
};

let pool;

// 4. Logic tự động cập nhật và phát tin Real-time
async function autoUpdateStationStatus() {
    try {
        if (!pool) return;
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            // CẬP NHẬT TRẠNG THÁI: Nếu quá 5 phút không thấy tín hiệu (lastSeen) thì coi là Offline
            const updateActive = `
                UPDATE ChargeStation SET Status = 1 WHERE Name IN (
                    SELECT DISTINCT ChargePointId FROM ConnectorStatus 
                    WHERE DATEDIFF(MINUTE, lastSeen, GETUTCDATE()) <= 5
                )`;

            const updateInactive = `
                UPDATE ChargeStation SET Status = 0 WHERE Name IN (
                    SELECT ChargePointId FROM ConnectorStatus GROUP BY ChargePointId
                    HAVING MIN(DATEDIFF(MINUTE, lastSeen, GETUTCDATE())) > 5
                )`;

            await transaction.request().query(updateActive);
            await transaction.request().query(updateInactive);
            await transaction.commit();
            
            // Lấy dữ liệu mới nhất để gửi cho Client qua Socket
            const result = await pool.request().query(`
                SELECT ChargePointId, ConnectorId, LastStatus, lastSeen,
                CASE WHEN DATEDIFF(MINUTE, lastSeen, GETUTCDATE()) > 5 THEN 'Offline' ELSE 'Online' END AS ConnectionStatus
                FROM ConnectorStatus`);
            
            io.emit('status-updated', result.recordset); 
            console.log(`[${new Date().toLocaleTimeString()}] 🔄 Chu kỳ 5 phút: Đã cập nhật trạm & Phát tin.`);
            
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (err) {
        console.error('❌ Lỗi xử lý cập nhật:', err.message);
    }
}

// 5. Kết nối Database và thiết lập chu kỳ quét
async function connectDB() {
    try {
        pool = await sql.connect(config);
        console.log('✅ Kết nối SQL Server thành công');

        // Chạy lần đầu ngay khi khởi động server
        await autoUpdateStationStatus();

        // THAY ĐỔI: Quét mỗi 5 phút (5 * 60 * 1000 = 300.000 ms)
        setInterval(autoUpdateStationStatus, 300000); 

    } catch (err) {
        console.error('❌ Kết nối thất bại:', err.message);
        setTimeout(connectDB, 5000);
    }
}

connectDB();

// 6. API Routes
app.get('/', (req, res) => {
    res.send('EV Charging Station Real-time Backend (5-min Cycle) is running...');
});

app.get('/charge-stations', async (req, res) => {
    try {
        if (!pool) return res.status(500).send("Database chưa sẵn sàng");
        const result = await pool.request().query(`SELECT * FROM ChargeStation ORDER BY ChargeStationId ASC`);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.get('/connector-status', async (req, res) => {
    try {
        if (!pool) return res.status(500).send("Database chưa sẵn sàng");
        const result = await pool.request().query(`
            SELECT *, 
            CASE WHEN DATEDIFF(MINUTE, lastSeen, GETUTCDATE()) > 5 THEN 'Offline' ELSE 'Online' END AS ConnectionStatus 
            FROM ConnectorStatus`);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// 7. Socket.io Events
io.on('connection', (socket) => {
    console.log('⚡ Client connected:', socket.id);
    socket.on('disconnect', () => {
        console.log('🔥 Client disconnected');
    });
});

// 8. Chạy Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại port ${PORT} (Chu kỳ quét: 5 phút)`);
});
