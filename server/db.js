const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'shop.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // 商品表 (保持不变)
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        price INTEGER,
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
});

module.exports = db;