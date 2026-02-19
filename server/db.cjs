const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'shop.db');
const db = new sqlite3.Database(dbPath);

const ensureColumn = (tableName, columnName, columnDef) => {
    db.all(`PRAGMA table_info(${tableName})`, [], (err, rows) => {
        if (err) {
            console.error(`Failed to inspect table ${tableName}:`, err.message);
            return;
        }

        const exists = rows.some((row) => row.name === columnName);
        if (exists) return;

        db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`, (alterErr) => {
            if (alterErr) {
                console.error(`Failed to add ${columnName} to ${tableName}:`, alterErr.message);
            }
        });
    });
};

db.serialize(() => {
    // 商品表 (保持不变)
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        price INTEGER,
        discountPrice INTEGER,
        category TEXT,
        typeId TEXT,
        stock INTEGER,
        image TEXT,
        desc TEXT,
        specs TEXT,
        detailText TEXT,
        detailImages TEXT,
        shippingTag TEXT,
        shippingCost INTEGER
    )`);

    // [修改] 升级订单表，增加地址详情字段
    // status 定义: 0=已取消, 1=待付款, 2=待发货(已付款), 3=已发货, 4=已完成, 5=待确认(用户已付款)
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        total INTEGER,
        originalTotal REAL DEFAULT 0,
        discountAmount REAL DEFAULT 0,
        couponCode TEXT,
        items TEXT,         -- JSON: 商品列表
        contactName TEXT,   -- 联系人
        contactPhone TEXT,  -- 电话
        contactEmail TEXT,  -- 邮箱
        province TEXT,      -- 省
        city TEXT,          -- 市
        district TEXT,      -- 区
        addressDetail TEXT, -- 详细地址
        trackingCompany TEXT, -- 快递公司
        trackingNo TEXT,      -- 快递单号
        status INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 埋点事件表: 用于转化率统计与行为分析
    db.run(`CREATE TABLE IF NOT EXISTS analytics_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT,
        eventKey TEXT,
        page TEXT,
        meta TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE INDEX IF NOT EXISTS idx_analytics_event_key_time
            ON analytics_events(eventKey, created_at)`);

    db.run(`CREATE INDEX IF NOT EXISTS idx_analytics_session
            ON analytics_events(sessionId)`);

    db.run(`CREATE TABLE IF NOT EXISTS site_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS coupons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE,
        name TEXT,
        batchNo TEXT,
        minSpend REAL DEFAULT 0,
        discountType TEXT DEFAULT 'amount',
        discountValue REAL DEFAULT 0,
        maxDiscount REAL,
        status INTEGER DEFAULT 1,
        expiresAt DATETIME,
        usedOrderId TEXT,
        used_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE INDEX IF NOT EXISTS idx_coupons_status_batch
            ON coupons(status, batchNo)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_coupons_code
            ON coupons(code)`);

    db.run(`CREATE TABLE IF NOT EXISTS contact_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        contact TEXT,
        orderId TEXT,
        content TEXT,
        status INTEGER DEFAULT 0,
        handled_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE INDEX IF NOT EXISTS idx_contact_messages_status_time
            ON contact_messages(status, created_at)`);

    db.run(`CREATE TABLE IF NOT EXISTS email_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orderId TEXT NOT NULL,
        toEmail TEXT NOT NULL,
        eventKey TEXT NOT NULL,
        subject TEXT NOT NULL,
        html TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        maxAttempts INTEGER NOT NULL DEFAULT 5,
        nextRunAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        lastError TEXT,
        sentAt DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE INDEX IF NOT EXISTS idx_email_jobs_status_next
            ON email_jobs(status, nextRunAt)`);

    db.run(`CREATE INDEX IF NOT EXISTS idx_email_jobs_order_event_time
            ON email_jobs(orderId, eventKey, created_at)`);

    ensureColumn('products', 'discountPrice', 'INTEGER');
    ensureColumn('orders', 'originalTotal', 'REAL DEFAULT 0');
    ensureColumn('orders', 'discountAmount', 'REAL DEFAULT 0');
    ensureColumn('orders', 'couponCode', 'TEXT');
    ensureColumn('contact_messages', 'handled_at', 'DATETIME');
});

module.exports = db;
