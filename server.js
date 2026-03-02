require('dotenv').config();
const express = require('express');
const sql = require('mssql');
const http = require('http');
const { Server } = require('socket.io');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket']
});

app.use(express.json());

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_APP_PASSWORD
    }
});

const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    port: parseInt(process.env.DB_PORT) || 1433,
    database: process.env.DB_DATABASE,
    options: { 
        encrypt: true, // Render yêu cầu mã hóa để bảo mật
        trustServerCertificate: true, 
        connectTimeout: 30000, // Chờ 30 giây để kết nối thay vì 15 giây mặc định
        requestTimeout: 30000  // Chờ 30 giây cho mỗi câu lệnh SQL
    },
    pool: { 
        max: 10, 
        min: 0, 
        idleTimeoutMillis: 30000 
    }
};

let pool;
// Bộ nhớ đệm lưu trạng thái - Sẽ được XÓA SẠCH mỗi khi restart server
let lastStateMap = new Map();

// ... (Các phần cấu hình transporter và config giữ nguyên)

function createBulkEmailTemplate(alerts) {
    let rows = alerts.map(item => {
        const isFault = item.type === 'FAULTED';
        const statusLabel = isFault ? 'LỖI KỸ THUẬT' : 'MẤT KẾT NỐI';
        const statusBg = isFault ? '#FEF2F2' : '#F9FAFB';
        const statusColor = isFault ? '#DC2626' : '#4B5563';
        const dotColor = isFault ? '#EF4444' : '#9CA3AF';

        return `
            <tr style="border-bottom: 1px solid #F3F4F6;">
                <td style="padding: 12px 8px; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
                    <div style="font-weight: bold; color: #111827; font-size: 13px; margin-bottom: 4px;">${item.id}</div>
                    <div style="font-size: 11px; color: #9CA3AF; display: block;">${item.timeString}</div>
                </td>
                <td style="padding: 12px 8px; text-align: right; vertical-align: middle;">
                    <span style="background-color: ${statusBg}; color: ${statusColor}; padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: bold; border: 1px solid ${statusColor}20; white-space: nowrap; display: inline-block;">
                        <span style="color: ${dotColor}; margin-right: 4px;">●</span>${statusLabel}
                    </span>
                </td>
            </tr>
        `;
    }).join('');

    return `
    <div style="background-color: #F9FAFB; padding: 20px 10px; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
        <table align="center" border="0" cellpadding="0" cellspacing="0" style="max-width: 500px; width: 100%; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
            <tr>
                <td style="background-color: #0F172A; padding: 30px 20px; text-align: center;">
                    <div style="color: #38BDF8; font-size: 10px; font-weight: bold; letter-spacing: 2px; margin-bottom: 8px; text-transform: uppercase;">System Alert</div>
                    <h1 style="color: #ffffff; margin: 0; font-size: 20px; font-weight: 600;">SolarEV Monitor</h1>
                </td>
            </tr>

            <tr>
                <td style="padding: 15px 20px; border-bottom: 1px solid #F3F4F6; background-color: #F8FAFC;">
                    <table width="100%">
                        <tr>
                            <td style="font-size: 13px; color: #64748B;">Phát hiện: <strong>${alerts.length} sự cố</strong></td>
                            <td style="font-size: 11px; color: #94A3B8; text-align: right;">${new Date().toLocaleTimeString('vi-VN')}</td>
                        </tr>
                    </table>
                </td>
            </tr>

            <tr>
                <td style="padding: 10px 20px;">
                    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
                        <thead>
                            <tr style="text-align: left;">
                                <th style="padding: 10px 8px; font-size: 11px; color: #94A3B8; text-transform: uppercase; border-bottom: 1px solid #E5E7EB;">Thiết bị / Thời gian</th>
                                <th style="padding: 10px 8px; font-size: 11px; color: #94A3B8; text-transform: uppercase; border-bottom: 1px solid #E5E7EB; text-align: right;">Trạng thái</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows}
                        </tbody>
                    </table>
                </td>
            </tr>

            <tr>
                <td style="padding: 20px;">
                    <div style="background-color: #F0F9FF; border-radius: 8px; padding: 15px; border-left: 4px solid #0EA5E9;">
                        <table width="100%">
                            <tr>
                                <td style="vertical-align: top; width: 25px; font-size: 16px;">💡</td>
                                <td style="font-size: 12px; color: #0369A1; line-height: 1.5;">
                                    <strong>Hành động:</strong> Các trụ mất kết nối đã được hệ thống đưa về <b>Available</b> để tránh treo ứng dụng.
                                </td>
                            </tr>
                        </table>
                    </div>
                </td>
            </tr>

            <tr>
                <td style="padding: 20px; text-align: center; background-color: #F9FAFB;">
                    <p style="color: #94A3B8; font-size: 11px; margin: 0;">© 2026 SolarEV Operations Cloud</p>
                </td>
            </tr>
        </table>
    </div>`;
}

async function autoUpdateStationStatus() {
    try {
        if (!pool) return;
        const currentTime = new Date().toLocaleTimeString('vi-VN');

        // 1. CẬP NHẬT DATABASE QUA 3 BẢNG
        const queryUpdate = `
            -- Bước A: Cập nhật LastStatus nội bộ cho các trụ mất kết nối > 5 phút
            UPDATE ConnectorStatus SET LastStatus = 'Available' 
            WHERE DATEDIFF(SECOND, lastSeen, GETDATE()) > 300 AND LastStatus <> 'Available';

            -- Bước B: TẮT Trạm (Status = 0) nếu có trụ thuộc trạm đó bị Faulted hoặc Offline
            UPDATE ChargeStation 
            SET Status = 0 
            WHERE ChargeStationId IN ( 
                SELECT cp.ChargeStationId 
                FROM ChargePoint cp
                JOIN ConnectorStatus cs ON cp.Name = cs.ChargePointId
                WHERE cs.LastStatus = 'Faulted' 
                   OR DATEDIFF(SECOND, cs.lastSeen, GETDATE()) > 300
            );

            -- Bước C: BẬT Trạm (Status = 1) nếu TẤT CẢ trụ thuộc trạm đó đều ổn định
            UPDATE ChargeStation 
            SET Status = 1 
            WHERE ChargeStationId NOT IN (
                SELECT cp.ChargeStationId 
                FROM ChargePoint cp
                JOIN ConnectorStatus cs ON cp.Name = cs.ChargePointId
                WHERE cs.LastStatus = 'Faulted' 
                   OR DATEDIFF(SECOND, cs.lastSeen, GETDATE()) > 300
            );
        `;
        await pool.request().query(queryUpdate);

        // 2. LẤY DỮ LIỆU KIỂM TRA BIẾN ĐỘNG GỬI MAIL
        const result = await pool.request().query(`
            SELECT ChargePointId, LastStatus, 
            CONVERT(VARCHAR(19), lastSeen, 120) as lastSeenStr,
            CASE 
                WHEN LastStatus = 'Faulted' THEN 'Faulted' 
                WHEN DATEDIFF(SECOND, lastSeen, GETDATE()) > 300 THEN 'Offline' 
                ELSE 'Online' 
            END AS CurrentState
            FROM ConnectorStatus
        `);

        let newAlerts = [];
        let totalErrors = 0;

        for (const row of result.recordset) {
            const id = row.ChargePointId;
            const currentState = row.CurrentState;
            const prevState = lastStateMap.get(id);

            if (currentState === "Offline" || currentState === "Faulted") {
                totalErrors++;
                // Chỉ gửi mail khi chuyển trạng thái từ bình thường sang lỗi
                if (prevState === undefined || prevState === "Online") {
                    newAlerts.push({
                        id: id,
                        type: currentState.toUpperCase(),
                        timeString: row.lastSeenStr
                    });
                }
            }
            lastStateMap.set(id, currentState);
        }

        // 3. LOG VÀ GỬI THÔNG BÁO
        if (newAlerts.length > 0) {
            newAlerts.sort((a, b) => a.id.localeCompare(b.id));
            const mailOptions = {
                from: `"SolarEV Monitor 🚨" <${process.env.EMAIL_USER}>`,
                to: 'xuanviet06062003@gmail.com',
                subject: `🚨 [CẢNH BÁO MỚI] Phát hiện ${newAlerts.length} trụ gặp sự cố`,
                html: createBulkEmailTemplate(newAlerts)
            };
            
            await transporter.sendMail(mailOptions);
            console.log(`📩 [${currentTime}] PHÁT HIỆN LỖI: Đã cập nhật Status=0 cho các trạm liên quan và gửi mail.`);
        } else {
            // Thông báo trạng thái quét sạch lỗi hoặc lỗi cũ
            const msg = totalErrors > 0 ? `Hệ thống vẫn có ${totalErrors} trụ đang lỗi (đã báo mail).` : `Hệ thống ổn định (Tất cả Online).`;
            console.log(`🔍 [${currentTime}] Đang quét... ${msg}`);
        }

        io.emit('status-updated', result.recordset);
    } catch (err) {
        console.error('❌ [Lỗi quét hệ thống]:', err.message);
    }
}

// Hàm khởi động
async function connectDB() {
    try {
        pool = await sql.connect(config);
        console.log('--- SOLAR EV MONITOR: CHẾ ĐỘ QUÉT LIÊN TỤC ---');
        
        lastStateMap.clear(); // Xóa cache để lần đầu tiên chạy sẽ gửi "Full" các trụ đang lỗi
        
        await autoUpdateStationStatus();
        
        // Quét mỗi 15-30 giây để đảm bảo tính "tức thời" mà không gây quá tải DB
        setInterval(autoUpdateStationStatus, 20000); 
    } catch (err) {
        console.error('❌ Lỗi kết nối:', err.message);
        setTimeout(connectDB, 5000);
    }
}
connectDB();

app.get('/', (req, res) => res.send('SolarEV Pro Monitor is Running (Restart Mode)...'));
server.listen(process.env.PORT || 3000, () => console.log(`🚀 Server listening on port ${process.env.PORT || 3000}`));

