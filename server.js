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
        origin: "*", // Cho phép tất cả các nguồn truy cập (có thể siết lại khi deploy thật)
        methods: ["GET", "POST"]
    },
    transports: ['websocket'] // Rất quan trọng: Render hoạt động tốt nhất với websocket thuần
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
        encrypt: false, // Để false nếu SQL Server không yêu cầu mã hóa SSL
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
            /**
             * LƯU Ý MÚI GIỜ: 
             * - Sử dụng GETUTCDATE() nếu server SQL và Render lệch múi giờ.
             * - Nếu SQL Server của bạn đặt cứng giờ VN, hãy đổi GETUTCDATE() thành GETDATE().
             */
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
            
            // Gửi dữ liệu cho tất cả client đang kết nối
            io.emit('status-updated', result.recordset); 
            console.log(`[${new Date().toLocaleTimeString()}] 🔄 Đã cập nhật trạm & Phát tin Real-time.`);
            
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

        // Chạy lần đầu ngay khi start
        await autoUpdateStationStatus();

        // Quét mỗi 1 phút (60000ms)
        setInterval(autoUpdateStationStatus, 60000); 

    } catch (err) {
        console.error('❌ Kết nối thất bại:', err.message);
        console.log('Thử lại sau 5 giây...');
        setTimeout(connectDB, 5000);
    }
}

connectDB();

// 6. API Routes
app.get('/', (req, res) => {
    res.send('EV Charging Station Real-time Backend is running...');
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

// 7. Lắng nghe Socket kết nối (để debug)
io.on('connection', (socket) => {
    console.log('⚡ Một client mới đã kết nối:', socket.id);
    socket.on('disconnect', () => {
        console.log('🔥 Client đã ngắt kết nối');
    });
});

// 8. Chạy Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại port ${PORT}`);
});