const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('./db.cjs');
const { createEmailService } = require('./email.cjs');

const loadEnvFile = (filePath) => {
    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const line = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
        const equalIndex = line.indexOf('=');
        if (equalIndex <= 0) continue;

        const key = line.slice(0, equalIndex).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;

        let value = line.slice(equalIndex + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        } else {
            const commentIndex = value.search(/\s+#/);
            if (commentIndex !== -1) value = value.slice(0, commentIndex).trim();
        }
        process.env[key] = value.replace(/\\n/g, '\n');
    }
};

loadEnvFile(path.resolve(__dirname, '..', '.env'));

const app = express();
const PORT = 13221;

const normalizeApiPrefix = (value) => {
    const raw = String(value || '/shop-api').trim();
    if (!raw) return '/shop-api';
    const normalized = raw.startsWith('/') ? raw : `/${raw}`;
    return normalized.replace(/\/+$/, '') || '/shop-api';
};

const API_PREFIX = normalizeApiPrefix(process.env.API_PREFIX || '/shop-api');
const API_UPLOADS_PATH = `${API_PREFIX}/uploads`;
const LEGACY_API_UPLOADS_PREFIX = '/api/uploads/';

const apiPath = (routePath = '') => {
    const clean = String(routePath || '').trim();
    if (!clean || clean === '/') return API_PREFIX;
    return `${API_PREFIX}/${clean.replace(/^\/+/, '')}`;
};

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const isWebpBufferHeader = (buffer) => (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
);

const isRealWebpFile = (filePath) => {
    let fd = null;
    try {
        fd = fs.openSync(filePath, 'r');
        const header = Buffer.alloc(12);
        const bytesRead = fs.readSync(fd, header, 0, 12, 0);
        return bytesRead >= 12 && isWebpBufferHeader(header);
    } catch (_) {
        return false;
    } finally {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch (_) { /* ignore */ }
        }
    }
};

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

app.use(cors());
app.use(bodyParser.json());
app.use(apiPath('/uploads'), express.static(uploadDir));

function safeParse(str, fallback) {
    try { return JSON.parse(str); } catch { return fallback; }
}

const SALES_VALID_STATUSES = [2, 3, 4, 5]; // 已支付到已完成阶段
const ORDER_STATUS_VALUES = [0, 1, 2, 3, 4, 5];
const STATUS_TRANSITIONS = {
    0: [],
    1: [0, 2, 5], // 待付款 -> 取消 / 待发货 / 待确认
    2: [0, 3],    // 待发货 -> 取消 / 已发货
    3: [4],       // 已发货 -> 已完成
    4: [],        // 已完成终态
    5: [0, 2]     // 待确认 -> 取消 / 待发货
};
const CANCELLABLE_STATUSES = [1, 2, 5];
const SELF_SERVICE_CONTACT_EDITABLE_STATUSES = new Set([1, 2, 5]);
const SELF_SERVICE_MERGEABLE_SOURCE_STATUSES = new Set([1, 2, 5]);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123456';
const ADMIN_AUTH_SECRET = process.env.ADMIN_AUTH_SECRET || 'sos-admin-auth-secret-change-me';
const ADMIN_TOKEN_TTL_SECONDS = Number(process.env.ADMIN_TOKEN_TTL_SECONDS || 24 * 60 * 60);
const FREE_SHIPPING_THRESHOLD = Math.max(0, Number(process.env.FREE_SHIPPING_THRESHOLD || 150));
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map();
const FUNNEL_STEPS = [
    { key: 'home_view', label: '首页访问' },
    { key: 'product_view', label: '商品详情访问' },
    { key: 'add_to_cart', label: '加入购物车' },
    { key: 'checkout_view', label: '进入结算页' },
    { key: 'order_submitted', label: '提交订单' },
    { key: 'payment_submitted', label: '提交支付' }
];
const DEFAULT_SITE_CONFIG = Object.freeze({
    payment: {
        wechatQr: '',
        alipayQr: '',
        friendQr: ''
    }
});
const COUPON_STATUS = Object.freeze({
    DISABLED: 0,
    UNUSED: 1,
    USED: 2
});
const COUPON_DISCOUNT_TYPES = ['amount', 'percent'];
const PRESALE_MODES = Object.freeze({
    NONE: 'none',
    GOAL: 'goal',
    FIXED: 'fixed'
});
const PRESALE_MODE_VALUES = new Set(Object.values(PRESALE_MODES));
const PRESALE_FIXED_DATE_TYPES = Object.freeze({
    MONTH_START: 'month_start',
    MONTH_END: 'month_end',
    DATE: 'date'
});
const PRESALE_FIXED_DATE_TYPE_VALUES = new Set(Object.values(PRESALE_FIXED_DATE_TYPES));
const PRESALE_MONTH_VALUE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const PRESALE_DATE_VALUE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const EMAIL_NOTIFICATIONS_ENABLED = String(process.env.EMAIL_NOTIFICATIONS_ENABLED || 'false');
const MAIL_PROVIDER = process.env.MAIL_PROVIDER || 'auto';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'true');
const SMTP_AUTH_MODE = process.env.SMTP_AUTH_MODE || 'auto';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const OAUTH2_CLIENT_ID = process.env.OAUTH2_CLIENT_ID || '';
const OAUTH2_CLIENT_SECRET = process.env.OAUTH2_CLIENT_SECRET || '';
const OAUTH2_REFRESH_TOKEN = process.env.OAUTH2_REFRESH_TOKEN || '';
const OAUTH2_ACCESS_TOKEN = process.env.OAUTH2_ACCESS_TOKEN || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_API_BASE_URL = process.env.RESEND_API_BASE_URL || 'https://api.resend.com';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || '春日商城';
const MAIL_FROM_ADDRESS = process.env.MAIL_FROM_ADDRESS || '';
const MAIL_REPLY_TO = process.env.MAIL_REPLY_TO || '';
const MAIL_MAX_ATTEMPTS = Number(process.env.MAIL_MAX_ATTEMPTS || 5);
const MAIL_RETRY_BACKOFFS_MINUTES = process.env.MAIL_RETRY_BACKOFFS_MINUTES || '1,5,15,60,180';
const MAIL_WORKER_INTERVAL_MS = Number(process.env.MAIL_WORKER_INTERVAL_MS || 10000);
const MAIL_WORKER_BATCH_SIZE = Number(process.env.MAIL_WORKER_BATCH_SIZE || 20);
const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || '';
const MAIL_ORDER_QUERY_URL = process.env.MAIL_ORDER_QUERY_URL || '';

const dbAll = (sql, params = []) =>
    new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

const dbGet = (sql, params = []) =>
    new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));

const dbRun = (sql, params = []) =>
    new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });

const normalizeOrderMergeMeta = (rawValue) => {
    const toMoney = (value) => Number((Number(value) || 0).toFixed(2));
    const toStatus = (value) => {
        const num = Number(value);
        return Number.isInteger(num) ? num : null;
    };
    const cleanId = (value) => String(value || '').trim();
    const dedupeParts = (parts) => {
        const map = new Map();
        for (const part of parts) {
            const orderId = cleanId(part?.orderId);
            if (!orderId) continue;
            const prev = map.get(orderId);
            if (prev) {
                prev.amount = toMoney(prev.amount + toMoney(part.amount));
                if (prev.statusBeforeMerge === null) prev.statusBeforeMerge = toStatus(part.statusBeforeMerge);
                map.set(orderId, prev);
            } else {
                map.set(orderId, {
                    orderId,
                    amount: toMoney(part.amount),
                    statusBeforeMerge: toStatus(part.statusBeforeMerge)
                });
            }
        }
        return [...map.values()];
    };

    const parsed = typeof rawValue === 'string' ? safeParse(rawValue, null) : rawValue;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const computeShippingAdjustment = (sourceShippingFee, appendedShippingFee, mergedShippingFee) =>
        toMoney(toMoney(mergedShippingFee) - toMoney(sourceShippingFee) - toMoney(appendedShippingFee));

    const normalizedParts = Array.isArray(parsed.parts)
        ? dedupeParts(parsed.parts)
        : [];
    if (normalizedParts.length === 0) {
        const legacyParts = [];
        const legacySourceOrderId = cleanId(parsed.sourceOrderId);
        const legacySubmittedOrderId = cleanId(parsed.submittedOrderId);
        if (legacySourceOrderId) {
            legacyParts.push({
                orderId: legacySourceOrderId,
                amount: toMoney(parsed.sourceAmount),
                statusBeforeMerge: null
            });
        }
        if (legacySubmittedOrderId) {
            legacyParts.push({
                orderId: legacySubmittedOrderId,
                amount: toMoney(parsed.appendedAmount),
                statusBeforeMerge: null
            });
        }
        normalizedParts.push(...dedupeParts(legacyParts));
    }

    const normalizedHistory = [];
    if (Array.isArray(parsed.history)) {
        for (const row of parsed.history) {
            const sourceOrderId = cleanId(row?.sourceOrderId);
            const appendedOrderId = cleanId(row?.appendedOrderId || row?.submittedOrderId);
            const newOrderId = cleanId(row?.newOrderId || row?.mergedOrderId);
            if (!sourceOrderId || !appendedOrderId || !newOrderId) continue;
            const sourceShippingFee = toMoney(row?.sourceShippingFee);
            const appendedShippingFee = toMoney(row?.appendedShippingFee);
            const mergedShippingFee = toMoney(row?.mergedShippingFee);
            const shippingAdjustment = row?.shippingAdjustment !== undefined
                ? toMoney(row.shippingAdjustment)
                : computeShippingAdjustment(sourceShippingFee, appendedShippingFee, mergedShippingFee);
            const appendedAmount = toMoney(row?.appendedAmount);
            normalizedHistory.push({
                sourceOrderId,
                appendedOrderId,
                newOrderId,
                sourceAmount: toMoney(row?.sourceAmount),
                appendedAmount,
                mergedAmount: toMoney(row?.mergedAmount),
                sourceShippingFee,
                appendedShippingFee,
                mergedShippingFee,
                shippingAdjustment,
                incrementalPayable: toMoney(
                    row?.incrementalPayable !== undefined ? row.incrementalPayable : Math.max(0, appendedAmount + shippingAdjustment)
                ),
                shippingSaved: toMoney(
                    row?.shippingSaved !== undefined ? row.shippingSaved : Math.max(0, -shippingAdjustment)
                ),
                mergedAt: row?.mergedAt ? String(row.mergedAt) : null
            });
        }
    }

    if (normalizedHistory.length === 0) {
        const sourceOrderId = cleanId(parsed.sourceOrderId);
        const appendedOrderId = cleanId(parsed.submittedOrderId);
        const newOrderId = cleanId(parsed.mergedOrderId);
        if (sourceOrderId && appendedOrderId && newOrderId) {
            const sourceShippingFee = toMoney(parsed.sourceShippingFee);
            const appendedShippingFee = toMoney(parsed.appendedShippingFee);
            const mergedShippingFee = toMoney(parsed.mergedShippingFee);
            const shippingAdjustment = computeShippingAdjustment(sourceShippingFee, appendedShippingFee, mergedShippingFee);
            const appendedAmount = toMoney(parsed.appendedAmount);
            normalizedHistory.push({
                sourceOrderId,
                appendedOrderId,
                newOrderId,
                sourceAmount: toMoney(parsed.sourceAmount),
                appendedAmount,
                mergedAmount: toMoney(parsed.mergedAmount),
                sourceShippingFee,
                appendedShippingFee,
                mergedShippingFee,
                shippingAdjustment,
                incrementalPayable: toMoney(Math.max(0, appendedAmount + shippingAdjustment)),
                shippingSaved: toMoney(
                    parsed.shippingSaved !== undefined ? parsed.shippingSaved : Math.max(0, -shippingAdjustment)
                ),
                mergedAt: parsed.mergedAt ? String(parsed.mergedAt) : null
            });
        }
    }

    const latestHistory = normalizedHistory.length > 0 ? normalizedHistory[normalizedHistory.length - 1] : null;
    const mergedOrderId = cleanId(parsed.mergedOrderId || latestHistory?.newOrderId);
    const sourceOrderId = cleanId(parsed.sourceOrderId || latestHistory?.sourceOrderId);
    const submittedOrderId = cleanId(parsed.submittedOrderId || latestHistory?.appendedOrderId);
    const sourceShippingFee = toMoney(parsed.sourceShippingFee ?? latestHistory?.sourceShippingFee);
    const appendedShippingFee = toMoney(parsed.appendedShippingFee ?? latestHistory?.appendedShippingFee);
    const mergedShippingFee = toMoney(parsed.mergedShippingFee ?? latestHistory?.mergedShippingFee);
    const shippingAdjustment = parsed.shippingAdjustment !== undefined
        ? toMoney(parsed.shippingAdjustment)
        : computeShippingAdjustment(sourceShippingFee, appendedShippingFee, mergedShippingFee);
    const sourceAmount = toMoney(parsed.sourceAmount ?? latestHistory?.sourceAmount);
    const appendedAmount = toMoney(parsed.appendedAmount ?? latestHistory?.appendedAmount);
    const mergedAmount = toMoney(parsed.mergedAmount ?? latestHistory?.mergedAmount);
    const incrementalPayable = toMoney(
        parsed.incrementalPayable !== undefined
            ? parsed.incrementalPayable
            : (latestHistory?.incrementalPayable !== undefined
                ? latestHistory.incrementalPayable
                : Math.max(0, appendedAmount + shippingAdjustment))
    );

    if (!mergedOrderId && normalizedParts.length === 0 && !sourceOrderId && !submittedOrderId) {
        return null;
    }

    return {
        mergedOrderId: mergedOrderId || null,
        sourceOrderId: sourceOrderId || null,
        submittedOrderId: submittedOrderId || null,
        sourceAmount,
        appendedAmount,
        mergedAmount,
        sourceShippingFee,
        appendedShippingFee,
        mergedShippingFee,
        shippingAdjustment,
        incrementalPayable,
        shippingSaved: toMoney(
            parsed.shippingSaved !== undefined
                ? parsed.shippingSaved
                : (latestHistory?.shippingSaved !== undefined ? latestHistory.shippingSaved : Math.max(0, -shippingAdjustment))
        ),
        contactPolicy: parsed.contactPolicy ? String(parsed.contactPolicy) : 'new_order',
        contactChanged: Boolean(parsed.contactChanged),
        mergedAt: parsed.mergedAt ? String(parsed.mergedAt) : (latestHistory?.mergedAt || null),
        mergeCount: Math.max(
            Number.isInteger(Number(parsed.mergeCount)) ? Number(parsed.mergeCount) : 0,
            normalizedHistory.length
        ),
        parts: normalizedParts,
        history: normalizedHistory
    };
};

const mapOrderRow = (row) => {
    if (!row) return null;
    const mergeMeta = normalizeOrderMergeMeta(row.mergeMeta);
    return {
        ...row,
        total: Number(row.total) || 0,
        originalTotal: Number(row.originalTotal) || 0,
        discountAmount: Number(row.discountAmount) || 0,
        status: Number(row.status),
        exported: row.exported ? 1 : 0,
        items: safeParse(row.items, []),
        mergeMeta,
        contact: {
            name: row.contactName,
            phone: row.contactPhone,
            email: row.contactEmail,
            province: row.province,
            city: row.city,
            district: row.district,
            addressDetail: row.addressDetail
        }
    };
};

const getOrderDetailById = async (orderId) => {
    const row = await dbGet('SELECT * FROM orders WHERE id = ?', [orderId]);
    return mapOrderRow(row);
};

const emailService = createEmailService({
    dbAll,
    dbRun,
    logger: console,
    enabled: EMAIL_NOTIFICATIONS_ENABLED,
    mailProvider: MAIL_PROVIDER,
    smtpHost: SMTP_HOST,
    smtpPort: SMTP_PORT,
    smtpSecure: SMTP_SECURE,
    smtpAuthMode: SMTP_AUTH_MODE,
    smtpUser: SMTP_USER,
    smtpPass: SMTP_PASS,
    oauth2ClientId: OAUTH2_CLIENT_ID,
    oauth2ClientSecret: OAUTH2_CLIENT_SECRET,
    oauth2RefreshToken: OAUTH2_REFRESH_TOKEN,
    oauth2AccessToken: OAUTH2_ACCESS_TOKEN,
    resendApiKey: RESEND_API_KEY,
    resendApiBaseUrl: RESEND_API_BASE_URL,
    mailFromName: MAIL_FROM_NAME,
    mailFromAddress: MAIL_FROM_ADDRESS,
    mailReplyTo: MAIL_REPLY_TO,
    maxAttempts: MAIL_MAX_ATTEMPTS,
    retryBackoffs: MAIL_RETRY_BACKOFFS_MINUTES,
    workerIntervalMs: MAIL_WORKER_INTERVAL_MS,
    workerBatchSize: MAIL_WORKER_BATCH_SIZE,
    publicSiteUrl: PUBLIC_SITE_URL,
    orderQueryUrl: MAIL_ORDER_QUERY_URL,
    basePath: process.env.VITE_BASE_PATH || '/shop/'
});

const enqueueOrderEmailSafely = async (eventKey, orderId) => {
    try {
        const order = await getOrderDetailById(orderId);
        if (!order) return;
        await emailService.enqueueOrderEmail(eventKey, order);
    } catch (err) {
        console.error(`[Mail] enqueue failed for event=${eventKey} order=${orderId}:`, err.message || err);
    }
};

const createBadRequestError = (message) => {
    const error = new Error(message);
    error.isBadRequest = true;
    return error;
};

const normalizeOrderContactInput = (contact) => {
    if (!contact || typeof contact !== 'object') throw createBadRequestError('收货信息不能为空');

    const contactName = String(contact.name || '').trim();
    const contactPhone = String(contact.phone || '').trim();
    const contactEmail = String(contact.email || '').trim();
    const contactProvince = String(contact.province || '').trim();
    const contactCity = String(contact.city || '').trim();
    const contactDistrict = String(contact.district || '').trim();
    const contactAddressDetail = String(contact.addressDetail || contact.address || '').trim();

    if (!contactName) throw createBadRequestError('收货人姓名不能为空');
    if (!/^1[3-9]\d{9}$/.test(contactPhone)) throw createBadRequestError('手机号格式错误');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) throw createBadRequestError('邮箱格式错误');
    if (!contactProvince || !contactCity || !contactDistrict) throw createBadRequestError('省市区信息不完整');
    if (!contactAddressDetail) throw createBadRequestError('详细地址不能为空');

    return {
        contactName,
        contactPhone,
        contactEmail,
        contactProvince,
        contactCity,
        contactDistrict,
        contactAddressDetail
    };
};

const cloneDefaultSiteConfig = () => JSON.parse(JSON.stringify(DEFAULT_SITE_CONFIG));

const sanitizeConfigText = (value, maxLength = 300) => {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, maxLength);
};

const sanitizeConfigUrl = (value) => {
    const clean = sanitizeConfigText(value, 500);
    if (!clean) return '';
    if (/^https?:\/\//i.test(clean)) return clean;
    if (clean.startsWith(`${API_UPLOADS_PATH}/`)) return clean;
    if (clean.startsWith(LEGACY_API_UPLOADS_PREFIX)) {
        return `${API_UPLOADS_PATH}/${clean.slice(LEGACY_API_UPLOADS_PREFIX.length)}`;
    }
    return '';
};

const toPositivePriceOrNull = (value) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    if (num <= 0) return null;
    return Math.round(num * 100) / 100;
};

const normalizeDiscountPrice = (discountPrice, rawPrice) => {
    const price = Number(rawPrice);
    const discount = toPositivePriceOrNull(discountPrice);
    if (discount === null) return null;
    if (Number.isFinite(price) && price > 0 && discount >= price) return null;
    return discount;
};

const normalizeIntegerDeltaInput = (value) => {
    if (value === undefined || value === null || value === '') return 0;
    const numeric = Number(value);
    if (!Number.isInteger(numeric)) return null;
    return numeric;
};

const normalizeProductPresaleInput = (payload = {}) => {
    const modeRaw = String(payload.presaleMode || PRESALE_MODES.NONE).trim().toLowerCase();
    const mode = PRESALE_MODE_VALUES.has(modeRaw) ? modeRaw : PRESALE_MODES.NONE;
    const goalTargetRaw = Number.parseInt(payload.presaleGoalTarget, 10);
    const goalTarget = Number.isInteger(goalTargetRaw) && goalTargetRaw > 0 ? goalTargetRaw : 0;
    const fixedDateTypeRaw = String(payload.presaleFixedDateType || '').trim().toLowerCase();
    const fixedDateType = PRESALE_FIXED_DATE_TYPE_VALUES.has(fixedDateTypeRaw) ? fixedDateTypeRaw : '';
    const fixedDateValueRaw = String(payload.presaleFixedDateValue || '').trim();

    if (mode === PRESALE_MODES.GOAL) {
        if (goalTarget <= 0) {
            return { error: '预售目标数量必须为大于0的整数' };
        }
        return {
            mode,
            goalTarget,
            fixedDateType: '',
            fixedDateValue: ''
        };
    }

    if (mode === PRESALE_MODES.FIXED) {
        if (!fixedDateType) {
            return { error: '请设置固定预售日期类型' };
        }
        if (!fixedDateValueRaw) {
            return { error: '请设置固定预售日期' };
        }

        if (
            (fixedDateType === PRESALE_FIXED_DATE_TYPES.MONTH_START || fixedDateType === PRESALE_FIXED_DATE_TYPES.MONTH_END)
            && !PRESALE_MONTH_VALUE_PATTERN.test(fixedDateValueRaw)
        ) {
            return { error: '固定预售月份格式应为 YYYY-MM' };
        }

        if (fixedDateType === PRESALE_FIXED_DATE_TYPES.DATE) {
            if (!PRESALE_DATE_VALUE_PATTERN.test(fixedDateValueRaw)) {
                return { error: '固定预售日期格式应为 YYYY-MM-DD' };
            }
            const parsedDate = new Date(`${fixedDateValueRaw}T00:00:00`);
            if (Number.isNaN(parsedDate.getTime())) {
                return { error: '固定预售日期无效' };
            }
            const normalizedDateValue = parsedDate.toISOString().slice(0, 10);
            if (normalizedDateValue !== fixedDateValueRaw) {
                return { error: '固定预售日期无效' };
            }
        }

        return {
            mode,
            goalTarget: 0,
            fixedDateType,
            fixedDateValue: fixedDateValueRaw
        };
    }

    return {
        mode: PRESALE_MODES.NONE,
        goalTarget: 0,
        fixedDateType: '',
        fixedDateValue: ''
    };
};

const getProductPresaleSnapshot = (productRow = {}) => {
    const normalized = normalizeProductPresaleInput({
        presaleMode: productRow.presaleMode,
        presaleGoalTarget: productRow.presaleGoalTarget,
        presaleFixedDateType: productRow.presaleFixedDateType,
        presaleFixedDateValue: productRow.presaleFixedDateValue
    });
    if (normalized.error) {
        return {
            mode: PRESALE_MODES.NONE,
            goalTarget: 0,
            fixedDateType: '',
            fixedDateValue: '',
            isPresale: false
        };
    }
    return {
        ...normalized,
        isPresale: normalized.mode !== PRESALE_MODES.NONE
    };
};

const buildPaidProductQuantityMap = async () => {
    const rows = await dbAll(
        `SELECT items FROM orders WHERE status IN (${SALES_VALID_STATUSES.map(() => '?').join(', ')})`,
        SALES_VALID_STATUSES
    );
    const quantityMap = new Map();
    rows.forEach((row) => {
        const items = safeParse(row?.items, []);
        if (!Array.isArray(items)) return;
        items.forEach((item) => {
            const productId = Number(item?.id);
            const quantity = Number(item?.quantity) || 0;
            if (!Number.isInteger(productId) || productId <= 0) return;
            if (quantity <= 0) return;
            quantityMap.set(productId, (quantityMap.get(productId) || 0) + quantity);
        });
    });
    return quantityMap;
};

const normalizeSiteConfig = (rawConfig) => {
    const normalized = cloneDefaultSiteConfig();
    const payment = rawConfig && typeof rawConfig === 'object' ? rawConfig.payment || {} : {};

    normalized.payment.wechatQr = sanitizeConfigUrl(payment.wechatQr);
    normalized.payment.alipayQr = sanitizeConfigUrl(payment.alipayQr);
    normalized.payment.friendQr = sanitizeConfigUrl(payment.friendQr);

    return normalized;
};

const loadSiteConfig = async () => {
    const row = await dbGet('SELECT value FROM site_settings WHERE key = ?', ['site_config']);
    const parsed = safeParse(row?.value, null);
    return normalizeSiteConfig(parsed);
};

const saveSiteConfig = async (siteConfig) => {
    const normalized = normalizeSiteConfig(siteConfig);
    await dbRun(
        `INSERT INTO site_settings (key, value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
        ['site_config', JSON.stringify(normalized)]
    );
    return normalized;
};

const roundMoney = (value) => Number((Number(value) || 0).toFixed(2));

const normalizeCouponCode = (code) => String(code || '').trim().toUpperCase();

const normalizeCouponPrefix = (prefix) => {
    const clean = String(prefix || 'CPN').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    return clean || 'CPN';
};

const parseCouponDateTimeInput = (value) => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
};

const normalizeCouponRuleInput = (payload = {}) => {
    const name = sanitizeConfigText(payload.name || '优惠券', 60) || '优惠券';
    const minSpend = Number(payload.minSpend || 0);
    if (!Number.isFinite(minSpend) || minSpend < 0) return { error: '优惠门槛金额无效' };

    const discountType = String(payload.discountType || 'amount').trim();
    if (!COUPON_DISCOUNT_TYPES.includes(discountType)) return { error: '优惠类型无效' };

    const discountValue = Number(payload.discountValue);
    if (!Number.isFinite(discountValue) || discountValue <= 0) return { error: '优惠力度无效' };

    let maxDiscount = null;
    if (discountType === 'percent') {
        if (discountValue >= 100) return { error: '折扣比例必须小于100%' };

        if (payload.maxDiscount !== null && payload.maxDiscount !== undefined && String(payload.maxDiscount) !== '') {
            const max = Number(payload.maxDiscount);
            if (!Number.isFinite(max) || max <= 0) return { error: '最高优惠金额无效' };
            maxDiscount = roundMoney(max);
        }
    } else {
        maxDiscount = null;
    }

    const expiresAt = parseCouponDateTimeInput(payload.expiresAt);
    if (payload.expiresAt && !expiresAt) return { error: '过期时间格式错误' };
    if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) return { error: '过期时间必须晚于当前时间' };

    return {
        rule: {
            name,
            minSpend: roundMoney(minSpend),
            discountType,
            discountValue: roundMoney(discountValue),
            maxDiscount,
            expiresAt
        }
    };
};

const getCouponDiscountAmount = (coupon, orderAmount) => {
    const amount = roundMoney(orderAmount);
    const minSpend = roundMoney(coupon.minSpend || 0);
    if (amount < minSpend) {
        return { error: `订单金额未达到使用门槛 ¥${minSpend}` };
    }

    const discountType = String(coupon.discountType || 'amount');
    const discountValue = Number(coupon.discountValue);
    if (!COUPON_DISCOUNT_TYPES.includes(discountType) || !Number.isFinite(discountValue) || discountValue <= 0) {
        return { error: '优惠券配置异常' };
    }

    let discountAmount = 0;
    if (discountType === 'percent') {
        discountAmount = (amount * discountValue) / 100;
        const maxDiscount = Number(coupon.maxDiscount);
        if (Number.isFinite(maxDiscount) && maxDiscount > 0) {
            discountAmount = Math.min(discountAmount, maxDiscount);
        }
    } else {
        discountAmount = discountValue;
    }

    discountAmount = roundMoney(discountAmount);
    if (discountAmount <= 0) return { error: '优惠券金额无效' };

    return {
        discountAmount: Math.min(discountAmount, amount),
        payableAmount: roundMoney(Math.max(0, amount - discountAmount))
    };
};

const isCouponExpired = (coupon) => {
    if (!coupon?.expiresAt) return false;
    const timestamp = new Date(coupon.expiresAt).getTime();
    if (Number.isNaN(timestamp)) return true;
    return timestamp <= Date.now();
};

const formatCoupon = (coupon) => ({
    ...coupon,
    code: normalizeCouponCode(coupon.code),
    minSpend: roundMoney(coupon.minSpend),
    discountValue: roundMoney(coupon.discountValue),
    maxDiscount: coupon.maxDiscount === null || coupon.maxDiscount === undefined || coupon.maxDiscount === '' ? null : roundMoney(coupon.maxDiscount),
    status: Number(coupon.status),
    isExpired: isCouponExpired(coupon)
});

const getCouponBenefitText = (coupon) => {
    if (coupon.discountType === 'percent') {
        if (coupon.maxDiscount && Number(coupon.maxDiscount) > 0) {
            return `${coupon.discountValue}% (最高减¥${coupon.maxDiscount})`;
        }
        return `${coupon.discountValue}%`;
    }
    return `减¥${coupon.discountValue}`;
};

const evaluateCoupon = (coupon, orderAmount) => {
    if (!coupon) return { error: '优惠券不存在' };
    const row = formatCoupon(coupon);
    if (row.status !== COUPON_STATUS.UNUSED) return { error: '优惠券不可用' };
    if (row.isExpired) return { error: '优惠券已过期' };

    const discount = getCouponDiscountAmount(row, orderAmount);
    if (discount.error) return discount;

    return {
        coupon: row,
        ...discount
    };
};

const getCouponByCode = async (code) =>
    dbGet('SELECT * FROM coupons WHERE code = ?', [normalizeCouponCode(code)]);

const generateBatchNo = () => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    return `B${y}${m}${d}${h}${min}${s}`;
};

const generateCouponCode = (prefix) => {
    const random = crypto.randomBytes(4).toString('hex').toUpperCase();
    const tail = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `${prefix}-${random}${tail}`;
};

const getEffectiveProductPrice = (productRow) => {
    const discountPrice = normalizeDiscountPrice(productRow.discountPrice, productRow.price);
    if (discountPrice !== null) return roundMoney(discountPrice);
    return roundMoney(Number(productRow.price) || 0);
};

const toShippingGroupKey = (value) => String(value || 'default').trim() || 'default';

const calculateOrderPricing = (normalizedItems, productRowsById) => {
    const pricedItems = [];
    const shippingGroups = {};
    let productsTotal = 0;

    for (const item of normalizedItems) {
        const product = productRowsById.get(item.id);
        if (!product) throw createBadRequestError(`商品 ${item.name || item.id} 不存在`);
        const presaleSnapshot = getProductPresaleSnapshot(product);

        const productStock = Number(product.stock) || 0;
        if (!presaleSnapshot.isPresale && productStock < item.quantity) {
            throw createBadRequestError(`商品 ${product.name || item.id} 库存不足`);
        }

        const price = getEffectiveProductPrice(product);
        const originalPrice = roundMoney(Number(product.price) || price);
        const discountPrice = normalizeDiscountPrice(product.discountPrice, product.price);
        const shippingTag = toShippingGroupKey(product.shippingTag);
        const shippingCost = roundMoney(Number(product.shippingCost) || 0);

        if (shippingGroups[shippingTag] === undefined || shippingCost > shippingGroups[shippingTag]) {
            shippingGroups[shippingTag] = shippingCost;
        }

        productsTotal += price * item.quantity;
        pricedItems.push({
            id: item.id,
            name: product.name || item.name || `商品${item.id}`,
            quantity: item.quantity,
            price,
            originalPrice,
            discountPrice,
            shippingTag,
            shippingCost,
            isPresale: presaleSnapshot.isPresale,
            presaleMode: presaleSnapshot.mode
        });
    }

    productsTotal = roundMoney(productsTotal);
    const rawShippingFee = roundMoney(Object.values(shippingGroups).reduce((sum, fee) => sum + Number(fee || 0), 0));
    const shippingFee = productsTotal >= FREE_SHIPPING_THRESHOLD ? 0 : rawShippingFee;
    const originalTotal = roundMoney(productsTotal + shippingFee);

    return {
        pricedItems,
        productsTotal,
        shippingFee,
        originalTotal
    };
};

const normalizePricedItemForMerge = (item = {}) => {
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) return null;

    const parsedId = Number(item.id);
    const productId = Number.isInteger(parsedId) && parsedId > 0 ? parsedId : null;
    const price = roundMoney(Math.max(0, Number(item.price) || 0));
    const originalPrice = roundMoney(Math.max(price, Number(item.originalPrice) || price));
    const discountPrice = normalizeDiscountPrice(item.discountPrice, originalPrice);
    const shippingTag = toShippingGroupKey(item.shippingTag);
    const shippingCost = roundMoney(Math.max(0, Number(item.shippingCost) || 0));
    const presaleMode = PRESALE_MODE_VALUES.has(String(item.presaleMode || '').trim().toLowerCase())
        ? String(item.presaleMode).trim().toLowerCase()
        : (Boolean(item.isPresale) ? PRESALE_MODES.GOAL : PRESALE_MODES.NONE);
    const isPresale = presaleMode !== PRESALE_MODES.NONE;

    return {
        id: productId,
        name: String(item.name || '').trim() || (productId ? `商品${productId}` : '未命名商品'),
        quantity,
        price,
        originalPrice,
        discountPrice,
        shippingTag,
        shippingCost,
        isPresale,
        presaleMode
    };
};

const mergePricedItems = (...itemGroups) => {
    const merged = new Map();

    for (const group of itemGroups) {
        if (!Array.isArray(group)) continue;
        for (const rawItem of group) {
            const item = normalizePricedItemForMerge(rawItem);
            if (!item) continue;

            const key = JSON.stringify([
                item.id === null ? '' : item.id,
                item.name,
                item.price,
                item.originalPrice,
                item.discountPrice === null ? '' : item.discountPrice,
                item.shippingTag,
                item.shippingCost,
                item.isPresale ? 1 : 0,
                item.presaleMode
            ]);

            const existing = merged.get(key);
            if (existing) {
                existing.quantity += item.quantity;
            } else {
                merged.set(key, { ...item });
            }
        }
    }

    return [...merged.values()].filter((item) => Number(item.quantity) > 0);
};

const calculatePricingFromPricedItems = (pricedItems) => {
    const normalized = mergePricedItems(pricedItems);
    const shippingGroups = {};
    let productsTotal = 0;

    for (const item of normalized) {
        productsTotal += Number(item.price || 0) * Number(item.quantity || 0);
        const shippingTag = toShippingGroupKey(item.shippingTag);
        const shippingCost = roundMoney(Number(item.shippingCost) || 0);
        if (shippingGroups[shippingTag] === undefined || shippingCost > shippingGroups[shippingTag]) {
            shippingGroups[shippingTag] = shippingCost;
        }
    }

    productsTotal = roundMoney(productsTotal);
    const rawShippingFee = roundMoney(Object.values(shippingGroups).reduce((sum, fee) => sum + Number(fee || 0), 0));
    const shippingFee = productsTotal >= FREE_SHIPPING_THRESHOLD ? 0 : rawShippingFee;
    const originalTotal = roundMoney(productsTotal + shippingFee);

    return {
        pricedItems: normalized,
        productsTotal,
        shippingFee,
        originalTotal
    };
};

const buildOrderId = (now = new Date()) => {
    const datePart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}${String(now.getMilliseconds()).padStart(3, '0')}`;
    const randPart = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    return `SOS-${datePart}-${timePart}-${randPart}`;
};

const generateUniqueOrderId = async (maxRetries = 10) => {
    for (let i = 0; i < maxRetries; i += 1) {
        const candidate = buildOrderId();
        const exists = await dbGet('SELECT id FROM orders WHERE id = ?', [candidate]);
        if (!exists) return candidate;
    }
    throw new Error('生成新订单号失败，请稍后重试');
};

if (
    IS_PRODUCTION &&
    (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD || !process.env.ADMIN_AUTH_SECRET)
) {
    throw new Error('生产环境必须配置 ADMIN_USERNAME / ADMIN_PASSWORD / ADMIN_AUTH_SECRET');
}

if (
    !IS_PRODUCTION &&
    (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD || !process.env.ADMIN_AUTH_SECRET)
) {
    console.warn('[Auth] 当前使用默认管理员凭据，仅适用于本地开发，请勿用于生产环境。');
}

const safeStringEqual = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    if (x.length !== y.length) return false;
    return crypto.timingSafeEqual(x, y);
};

const signAdminToken = (payload) => {
    const headerBase64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const data = `${headerBase64}.${payloadBase64}`;
    const signature = crypto.createHmac('sha256', ADMIN_AUTH_SECRET).update(data).digest('base64url');
    return `${data}.${signature}`;
};

const verifyAdminToken = (token) => {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerBase64, payloadBase64, signature] = parts;
    const data = `${headerBase64}.${payloadBase64}`;
    const expectedSignature = crypto.createHmac('sha256', ADMIN_AUTH_SECRET).update(data).digest('base64url');
    if (!safeStringEqual(signature, expectedSignature)) return null;

    let payload;
    try {
        payload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf8'));
    } catch {
        return null;
    }

    if (!payload || typeof payload !== 'object') return null;
    if (payload.exp && Number(payload.exp) <= Math.floor(Date.now() / 1000)) return null;
    return payload;
};

const extractBearerToken = (req) => {
    const authHeader = req.headers.authorization || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
};

const requireAdminAuth = (req, res, next) => {
    const token = extractBearerToken(req);
    const payload = verifyAdminToken(token);
    if (!payload || payload.role !== 'admin') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    req.admin = payload;
    next();
};

const isLoginRateLimited = (ip) => {
    const now = Date.now();
    const record = loginAttempts.get(ip);
    if (!record) return false;

    if (now - record.firstAt > LOGIN_WINDOW_MS) {
        loginAttempts.delete(ip);
        return false;
    }
    return record.count >= LOGIN_MAX_ATTEMPTS;
};

const recordLoginFailure = (ip) => {
    const now = Date.now();
    const record = loginAttempts.get(ip);
    if (!record || now - record.firstAt > LOGIN_WINDOW_MS) {
        loginAttempts.set(ip, { count: 1, firstAt: now });
        return;
    }
    record.count += 1;
    loginAttempts.set(ip, record);
};

const clearLoginFailure = (ip) => {
    loginAttempts.delete(ip);
};

const extractPhoneLast4 = (phone) => {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 4) return '';
    return digits.slice(-4);
};

const formatDate = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
};

const parseDateInput = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return null;
    return date;
};

const getToday = () => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return now;
};

const buildDateRange = (startDate, endDate) => {
    const list = [];
    const cur = parseDateInput(startDate);
    const end = parseDateInput(endDate);
    if (!cur || !end || cur > end) return list;

    while (cur <= end) {
        list.push(formatDate(cur));
        cur.setDate(cur.getDate() + 1);
    }
    return list;
};

function resolveStatsRange({ period, startDate, endDate, defaultPeriod = '30', allowAll = true }) {
    const selectedPeriod = String(period || defaultPeriod);
    const today = getToday();

    if (selectedPeriod === 'all') {
        if (!allowAll) return { error: 'period 不支持 all' };
        return { period: 'all', startDate: null, endDate: null };
    }

    if (selectedPeriod === 'custom') {
        const start = parseDateInput(startDate);
        const end = parseDateInput(endDate);
        if (!start || !end) return { error: '自定义时间格式错误' };
        if (start > end) return { error: '开始日期不能晚于结束日期' };
        return { period: 'custom', startDate: formatDate(start), endDate: formatDate(end) };
    }

    const daySpan = Number(selectedPeriod);
    if (![7, 30, 90].includes(daySpan)) return { error: 'period 参数无效' };

    const start = new Date(today);
    start.setDate(start.getDate() - daySpan + 1);
    return { period: String(daySpan), startDate: formatDate(start), endDate: formatDate(today) };
}

function getPeriodRangeForProductReport(period) {
    const p = String(period || 'week');
    const today = getToday();

    if (p === 'all') return { period: 'all', startDate: null, endDate: null };

    if (p === 'week') {
        const start = new Date(today);
        const day = start.getDay() === 0 ? 7 : start.getDay();
        start.setDate(start.getDate() - day + 1);
        return { period: 'week', startDate: formatDate(start), endDate: formatDate(today) };
    }

    if (p === 'month') {
        const start = new Date(today.getFullYear(), today.getMonth(), 1);
        return { period: 'month', startDate: formatDate(start), endDate: formatDate(today) };
    }

    return { error: 'period 参数无效' };
}

app.post(apiPath('/admin/login'), (req, res) => {
    const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
    if (isLoginRateLimited(clientIp)) {
        return res.status(429).json({ error: '登录尝试过于频繁，请稍后再试' });
    }

    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
        recordLoginFailure(clientIp);
        return res.status(400).json({ error: '用户名或密码格式错误' });
    }

    if (!safeStringEqual(username.trim(), ADMIN_USERNAME) || !safeStringEqual(password, ADMIN_PASSWORD)) {
        recordLoginFailure(clientIp);
        return res.status(401).json({ error: '用户名或密码错误' });
    }

    clearLoginFailure(clientIp);

    const now = Math.floor(Date.now() / 1000);
    const token = signAdminToken({
        sub: ADMIN_USERNAME,
        role: 'admin',
        iat: now,
        exp: now + ADMIN_TOKEN_TTL_SECONDS
    });

    res.json({
        token,
        tokenType: 'Bearer',
        expiresIn: ADMIN_TOKEN_TTL_SECONDS,
        user: { name: ADMIN_USERNAME }
    });
});

app.get(apiPath('/admin/me'), requireAdminAuth, (req, res) => {
    res.json({
        user: { name: req.admin.sub || ADMIN_USERNAME },
        exp: req.admin.exp
    });
});

app.get(apiPath('/site-config'), async (req, res) => {
    try {
        const config = await loadSiteConfig();
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get(apiPath('/admin/site-config'), requireAdminAuth, async (req, res) => {
    try {
        const config = await loadSiteConfig();
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put(apiPath('/admin/site-config'), requireAdminAuth, async (req, res) => {
    try {
        const config = await saveSiteConfig(req.body || {});
        res.json({ success: true, config });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post(apiPath('/coupons/preview'), async (req, res) => {
    const code = normalizeCouponCode(req.body?.code);
    const orderAmount = Number(req.body?.orderAmount);

    if (!code) return res.status(400).json({ error: '请输入优惠券码' });
    if (!Number.isFinite(orderAmount) || orderAmount <= 0) {
        return res.status(400).json({ error: '订单金额无效' });
    }

    try {
        const coupon = await getCouponByCode(code);
        const result = evaluateCoupon(coupon, orderAmount);
        if (result.error) return res.status(400).json({ error: result.error });

        res.json({
            valid: true,
            code: result.coupon.code,
            name: result.coupon.name,
            minSpend: result.coupon.minSpend,
            discountType: result.coupon.discountType,
            discountValue: result.coupon.discountValue,
            maxDiscount: result.coupon.maxDiscount,
            benefitText: getCouponBenefitText(result.coupon),
            orderAmount: roundMoney(orderAmount),
            discountAmount: result.discountAmount,
            payableAmount: result.payableAmount
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get(apiPath('/admin/coupons'), requireAdminAuth, async (req, res) => {
    const status = String(req.query.status || 'all');
    const batchNo = sanitizeConfigText(req.query.batchNo || '', 80);
    const keyword = sanitizeConfigText(req.query.keyword || '', 80);
    const sortBy = String(req.query.sortBy || 'created_at');
    const sortDir = String(req.query.sortDir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));
    const conditions = [];
    const params = [];

    if (status !== 'all') {
        const numericStatus = Number(status);
        if (![COUPON_STATUS.DISABLED, COUPON_STATUS.UNUSED, COUPON_STATUS.USED].includes(numericStatus)) {
            return res.status(400).json({ error: 'status 参数无效' });
        }
        conditions.push('status = ?');
        params.push(numericStatus);
    }

    if (batchNo) {
        conditions.push('batchNo = ?');
        params.push(batchNo);
    }

    if (keyword) {
        conditions.push('(code LIKE ? OR name LIKE ?)');
        params.push(`%${keyword}%`, `%${keyword}%`);
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sortByMap = {
        created_at: 'created_at',
        expiresAt: 'expiresAt',
        minSpend: 'minSpend',
        status: 'status',
        id: 'id'
    };
    const orderByField = sortByMap[sortBy] || 'created_at';
    const offset = (page - 1) * pageSize;

    try {
        const countRow = await dbGet(`SELECT COUNT(*) AS total FROM coupons ${whereSql}`, params);
        const total = Number(countRow?.total) || 0;
        const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;

        const rows = await dbAll(
            `SELECT * FROM coupons
             ${whereSql}
             ORDER BY ${orderByField} ${sortDir}, id DESC
             LIMIT ? OFFSET ?`,
            [...params, pageSize, offset]
        );
        const items = rows.map((row) => {
                const coupon = formatCoupon(row);
                return { ...coupon, benefitText: getCouponBenefitText(coupon) };
        });
        res.json({
            items,
            pagination: { page, pageSize, total, totalPages },
            sort: { by: orderByField, dir: sortDir.toLowerCase() },
            filters: { status, batchNo, keyword }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post(apiPath('/admin/coupons/batch'), requireAdminAuth, async (req, res) => {
    const quantity = Number(req.body?.quantity);
    const prefix = normalizeCouponPrefix(req.body?.prefix);
    const customBatchNo = sanitizeConfigText(req.body?.batchNo || '', 30).toUpperCase();
    const batchNo = customBatchNo || generateBatchNo();
    let transactionStarted = false;

    const normalizedRule = normalizeCouponRuleInput(req.body || {});
    if (normalizedRule.error) return res.status(400).json({ error: normalizedRule.error });

    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 2000) {
        return res.status(400).json({ error: '优惠券数量必须为1-2000的整数' });
    }

    try {
        await dbRun('BEGIN IMMEDIATE TRANSACTION');
        transactionStarted = true;

        const generatedCodes = [];
        for (let i = 0; i < quantity; i += 1) {
            let inserted = false;

            for (let attempt = 0; attempt < 10 && !inserted; attempt += 1) {
                const code = generateCouponCode(prefix);
                try {
                    await dbRun(
                        `INSERT INTO coupons
                         (code, name, batchNo, minSpend, discountType, discountValue, maxDiscount, status, expiresAt)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            code,
                            normalizedRule.rule.name,
                            batchNo,
                            normalizedRule.rule.minSpend,
                            normalizedRule.rule.discountType,
                            normalizedRule.rule.discountValue,
                            normalizedRule.rule.maxDiscount,
                            COUPON_STATUS.UNUSED,
                            normalizedRule.rule.expiresAt
                        ]
                    );
                    generatedCodes.push(code);
                    inserted = true;
                } catch (err) {
                    if (err.code === 'SQLITE_CONSTRAINT') continue;
                    throw err;
                }
            }

            if (!inserted) {
                throw new Error('优惠券码生成冲突，请重试');
            }
        }

        await dbRun('COMMIT');
        transactionStarted = false;

        res.json({
            success: true,
            batchNo,
            quantity: generatedCodes.length,
            couponRule: normalizedRule.rule,
            codes: generatedCodes
        });
    } catch (err) {
        if (transactionStarted) {
            try { await dbRun('ROLLBACK'); } catch {}
        }
        res.status(500).json({ error: err.message });
    }
});

app.put(apiPath('/admin/coupons/:id/status'), requireAdminAuth, async (req, res) => {
    const couponId = Number(req.params.id);
    const status = Number(req.body?.status);
    if (!Number.isInteger(couponId) || couponId <= 0) {
        return res.status(400).json({ error: '优惠券ID无效' });
    }
    if (![COUPON_STATUS.DISABLED, COUPON_STATUS.UNUSED].includes(status)) {
        return res.status(400).json({ error: '仅支持设置为禁用或可用' });
    }

    try {
        const coupon = await dbGet('SELECT id, status FROM coupons WHERE id = ?', [couponId]);
        if (!coupon) return res.status(404).json({ error: '优惠券不存在' });
        if (Number(coupon.status) === COUPON_STATUS.USED) {
            return res.status(400).json({ error: '已使用优惠券不可更改状态' });
        }

        await dbRun('UPDATE coupons SET status = ? WHERE id = ?', [status, couponId]);
        res.json({ success: true, status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete(apiPath('/admin/coupons/:id'), requireAdminAuth, async (req, res) => {
    const couponId = Number(req.params.id);
    if (!Number.isInteger(couponId) || couponId <= 0) {
        return res.status(400).json({ error: '优惠券ID无效' });
    }

    try {
        const coupon = await dbGet('SELECT id, status FROM coupons WHERE id = ?', [couponId]);
        if (!coupon) return res.status(404).json({ error: '优惠券不存在' });
        if (Number(coupon.status) === COUPON_STATUS.USED) {
            return res.status(400).json({ error: '已使用优惠券不可删除' });
        }

        await dbRun('DELETE FROM coupons WHERE id = ?', [couponId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post(apiPath('/contact/messages'), async (req, res) => {
    const name = sanitizeConfigText(req.body?.name || '', 60);
    const contact = sanitizeConfigText(req.body?.contact || '', 80);
    const orderId = sanitizeConfigText(req.body?.orderId || '', 60);
    const content = sanitizeConfigText(req.body?.content || '', 2000);

    if (!name) return res.status(400).json({ error: '请填写您的称呼' });
    if (!contact) return res.status(400).json({ error: '请填写联系方式' });
    if (!content) return res.status(400).json({ error: '请填写留言内容' });

    try {
        const result = await dbRun(
            `INSERT INTO contact_messages (name, contact, orderId, content, status)
             VALUES (?, ?, ?, ?, 0)`,
            [name, contact, orderId || null, content]
        );
        res.json({ success: true, id: result.lastID });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get(apiPath('/admin/contact-messages'), requireAdminAuth, async (req, res) => {
    const status = String(req.query.status || 'all');
    const keyword = sanitizeConfigText(req.query.keyword || '', 80);
    const sortBy = String(req.query.sortBy || 'created_at');
    const sortDir = String(req.query.sortDir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));
    const conditions = [];
    const params = [];

    if (status !== 'all') {
        const numericStatus = Number(status);
        if (![0, 1].includes(numericStatus)) {
            return res.status(400).json({ error: 'status 参数无效' });
        }
        conditions.push('status = ?');
        params.push(numericStatus);
    }

    if (keyword) {
        conditions.push('(name LIKE ? OR contact LIKE ? OR orderId LIKE ? OR content LIKE ?)');
        params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sortByMap = {
        created_at: 'created_at',
        status: 'status',
        id: 'id',
        handled_at: 'handled_at'
    };
    const orderByField = sortByMap[sortBy] || 'created_at';
    const offset = (page - 1) * pageSize;

    try {
        const countRow = await dbGet(`SELECT COUNT(*) AS total FROM contact_messages ${whereSql}`, params);
        const total = Number(countRow?.total) || 0;
        const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;
        const rows = await dbAll(
            `SELECT * FROM contact_messages
             ${whereSql}
             ORDER BY ${orderByField} ${sortDir}, id DESC
             LIMIT ? OFFSET ?`,
            [...params, pageSize, offset]
        );

        res.json({
            items: rows.map((row) => ({ ...row, status: Number(row.status) })),
            pagination: { page, pageSize, total, totalPages },
            sort: { by: orderByField, dir: sortDir.toLowerCase() },
            filters: { status, keyword }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put(apiPath('/admin/contact-messages/:id/status'), requireAdminAuth, async (req, res) => {
    const messageId = Number(req.params.id);
    const status = Number(req.body?.status);

    if (!Number.isInteger(messageId) || messageId <= 0) {
        return res.status(400).json({ error: '留言ID无效' });
    }
    if (![0, 1].includes(status)) {
        return res.status(400).json({ error: '状态仅支持 0 或 1' });
    }

    try {
        const existing = await dbGet('SELECT id FROM contact_messages WHERE id = ?', [messageId]);
        if (!existing) return res.status(404).json({ error: '留言不存在' });

        await dbRun(
            `UPDATE contact_messages
             SET status = ?,
                 handled_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END
             WHERE id = ?`,
            [status, status, messageId]
        );
        res.json({ success: true, status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- 商品相关接口 (保持不变) ---
app.get(apiPath('/products'), async (req, res) => {
    try {
        const [rows, paidQuantityMap] = await Promise.all([
            dbAll("SELECT * FROM products ORDER BY sortOrder ASC, id ASC", []),
            buildPaidProductQuantityMap()
        ]);

        const products = rows.map((p) => {
            const presaleSnapshot = getProductPresaleSnapshot(p);
            const paidCountBase = paidQuantityMap.get(Number(p.id)) || 0;
            const paidOffsetRaw = Number.parseInt(p.presalePaidOffset, 10);
            const paidOffset = Number.isInteger(paidOffsetRaw) ? paidOffsetRaw : 0;
            const paidCount = Math.max(0, paidCountBase + paidOffset);
            return {
                ...p,
                price: Number(p.price) || 0,
                discountPrice: normalizeDiscountPrice(p.discountPrice, p.price),
                imageOriginal: p.imageOriginal || '',
                specs: safeParse(p.specs, []),
                detailImages: safeParse(p.detailImages, []),
                shippingTag: p.shippingTag || 'default',
                shippingCost: Number(p.shippingCost) || 0,
                presaleMode: presaleSnapshot.mode,
                presaleGoalTarget: presaleSnapshot.goalTarget,
                presaleFixedDateType: presaleSnapshot.fixedDateType,
                presaleFixedDateValue: presaleSnapshot.fixedDateValue,
                presalePaidCountBase: paidCountBase,
                presalePaidOffset: paidOffset,
                presalePaidCount: paidCount
            };
        });
        res.json(products);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post(apiPath('/upload'), requireAdminAuth, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const rawPurpose = String(req.body?.purpose || '').trim().toLowerCase();
    const purpose = rawPurpose === 'qr' ? 'qr' : (rawPurpose === 'original' ? 'original' : 'general');
    const mimeType = String(req.file.mimetype || '').toLowerCase();
    const isImage = mimeType.startsWith('image/');
    const removeUploadedFile = () => {
        try {
            if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        } catch (_) {
            // ignore cleanup errors
        }
    };

    if (!isImage) {
        removeUploadedFile();
        return res.status(400).json({ error: '仅支持图片文件' });
    }

    if (purpose === 'general' && mimeType !== 'image/webp') {
        removeUploadedFile();
        return res.status(400).json({ error: '非二维码图片仅支持 WebP 上传' });
    }

    if (purpose === 'general' && !isRealWebpFile(req.file.path)) {
        removeUploadedFile();
        return res.status(400).json({ error: 'WebP 文件内容无效，请更换浏览器后重试' });
    }

    if (purpose === 'general') {
        const ext = path.extname(req.file.filename).toLowerCase();
        if (ext !== '.webp') {
            const webpFilename = `${path.basename(req.file.filename, ext)}.webp`;
            const webpPath = path.join(uploadDir, webpFilename);
            try {
                fs.renameSync(req.file.path, webpPath);
                req.file.filename = webpFilename;
                req.file.path = webpPath;
            } catch (err) {
                removeUploadedFile();
                return res.status(500).json({ error: 'WebP 文件保存失败' });
            }
        }
    }

    res.json({ url: `${apiPath('/uploads')}/${req.file.filename}` });
});

app.post(apiPath('/products'), requireAdminAuth, (req, res) => {
    const {
        name,
        price,
        discountPrice,
        category,
        typeId,
        stock,
        image,
        imageMobile,
        imageOriginal,
        desc,
        specs,
        detailText,
        detailImages,
        shippingTag,
        shippingCost,
        presaleMode,
        presaleGoalTarget,
        presaleFixedDateType,
        presaleFixedDateValue
    } = req.body;
    const cleanPrice = Number(price);
    const cleanStock = Number(stock);
    const cleanShippingCost = Number(shippingCost || 0);
    const cleanDiscountPrice = normalizeDiscountPrice(discountPrice, cleanPrice);
    const presale = normalizeProductPresaleInput({
        presaleMode,
        presaleGoalTarget,
        presaleFixedDateType,
        presaleFixedDateValue
    });

    if (!Number.isFinite(cleanPrice) || cleanPrice < 0) {
        return res.status(400).json({ error: '商品价格无效' });
    }
    if (!Number.isInteger(cleanStock) || cleanStock < 0) {
        return res.status(400).json({ error: '库存无效' });
    }
    if (!Number.isFinite(cleanShippingCost) || cleanShippingCost < 0) {
        return res.status(400).json({ error: '运费无效' });
    }
    if (discountPrice !== null && discountPrice !== undefined && String(discountPrice) !== '' && cleanDiscountPrice === null) {
        return res.status(400).json({ error: '折扣价必须大于0且小于原价' });
    }
    if (presale.error) {
        return res.status(400).json({ error: presale.error });
    }

    const sql = `INSERT INTO products (name, price, discountPrice, category, typeId, stock, image, imageMobile, imageOriginal, desc, specs, detailText, detailImages, shippingTag, shippingCost, presaleMode, presaleGoalTarget, presaleFixedDateType, presaleFixedDateValue, presalePaidOffset) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const params = [
        String(name || '').trim(),
        cleanPrice,
        cleanDiscountPrice,
        String(category || '').trim(),
        String(typeId || '').trim(),
        cleanStock,
        image || '',
        imageMobile || '',
        imageOriginal || '',
        desc || '',
        JSON.stringify(specs || []),
        detailText || '',
        JSON.stringify(detailImages || []),
        shippingTag || 'default',
        cleanShippingCost,
        presale.mode,
        presale.goalTarget,
        presale.fixedDateType,
        presale.fixedDateValue,
        0
    ];
    db.run(sql, params, function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, ...req.body });
    });
});

app.put(apiPath('/products/reorder'), requireAdminAuth, (req, res) => {
    const { order } = req.body; // [{ id, sortOrder }, ...]
    if (!Array.isArray(order)) return res.status(400).json({ error: '参数错误' });
    const stmt = db.prepare('UPDATE products SET sortOrder = ? WHERE id = ?');
    db.serialize(() => {
        for (const item of order) {
            stmt.run(Number(item.sortOrder), Number(item.id));
        }
        stmt.finalize((err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'OK' });
        });
    });
});

app.put(apiPath('/products/:id'), requireAdminAuth, async (req, res) => {
    const {
        name,
        price,
        discountPrice,
        category,
        typeId,
        stock,
        image,
        imageMobile,
        imageOriginal,
        desc,
        specs,
        detailText,
        detailImages,
        shippingTag,
        shippingCost,
        presaleMode,
        presaleGoalTarget,
        presaleFixedDateType,
        presaleFixedDateValue
    } = req.body;
    const productId = Number(req.params.id);
    const cleanPrice = Number(price);
    const hasStockInput = !(stock === undefined || stock === null || String(stock) === '');
    const cleanStock = hasStockInput ? Number(stock) : null;
    const cleanShippingCost = Number(shippingCost || 0);
    const cleanDiscountPrice = normalizeDiscountPrice(discountPrice, cleanPrice);
    const presale = normalizeProductPresaleInput({
        presaleMode,
        presaleGoalTarget,
        presaleFixedDateType,
        presaleFixedDateValue
    });

    if (!Number.isFinite(cleanPrice) || cleanPrice < 0) {
        return res.status(400).json({ error: '商品价格无效' });
    }
    if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ error: '商品ID无效' });
    }
    if (hasStockInput && (!Number.isInteger(cleanStock) || cleanStock < 0)) {
        return res.status(400).json({ error: '库存无效' });
    }
    if (!Number.isFinite(cleanShippingCost) || cleanShippingCost < 0) {
        return res.status(400).json({ error: '运费无效' });
    }
    if (discountPrice !== null && discountPrice !== undefined && String(discountPrice) !== '' && cleanDiscountPrice === null) {
        return res.status(400).json({ error: '折扣价必须大于0且小于原价' });
    }
    if (presale.error) {
        return res.status(400).json({ error: presale.error });
    }

    try {
        const existing = await dbGet('SELECT id, stock FROM products WHERE id = ?', [productId]);
        if (!existing) return res.status(404).json({ error: '商品不存在' });

        const finalStock = hasStockInput ? cleanStock : (Number(existing.stock) || 0);
        const sql = `UPDATE products SET name=?, price=?, discountPrice=?, category=?, typeId=?, stock=?, image=?, imageMobile=?, imageOriginal=?, desc=?, specs=?, detailText=?, detailImages=?, shippingTag=?, shippingCost=?, presaleMode=?, presaleGoalTarget=?, presaleFixedDateType=?, presaleFixedDateValue=? WHERE id=?`;
        const params = [
            String(name || '').trim(),
            cleanPrice,
            cleanDiscountPrice,
            String(category || '').trim(),
            String(typeId || '').trim(),
            finalStock,
            image || '',
            imageMobile || '',
            imageOriginal || '',
            desc || '',
            JSON.stringify(specs || []),
            detailText || '',
            JSON.stringify(detailImages || []),
            shippingTag || 'default',
            cleanShippingCost,
            presale.mode,
            presale.goalTarget,
            presale.fixedDateType,
            presale.fixedDateValue,
            productId
        ];
        const result = await dbRun(sql, params);
        res.json({ message: 'Updated', changes: Number(result?.changes) || 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put(apiPath('/admin/products/:id/adjust'), requireAdminAuth, async (req, res) => {
    const productId = Number(req.params.id);
    const stockDelta = normalizeIntegerDeltaInput(req.body?.stockDelta);
    const presalePaidDelta = normalizeIntegerDeltaInput(req.body?.presalePaidDelta);

    if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ error: '商品ID无效' });
    }
    if (stockDelta === null || presalePaidDelta === null) {
        return res.status(400).json({ error: '调整数量必须为整数' });
    }
    if (stockDelta === 0 && presalePaidDelta === 0) {
        return res.status(400).json({ error: '请至少调整一项数量' });
    }

    try {
        const product = await dbGet(
            'SELECT id, stock, presalePaidOffset FROM products WHERE id = ?',
            [productId]
        );
        if (!product) return res.status(404).json({ error: '商品不存在' });

        const currentStock = Number(product.stock) || 0;
        const currentOffsetRaw = Number.parseInt(product.presalePaidOffset, 10);
        const currentOffset = Number.isInteger(currentOffsetRaw) ? currentOffsetRaw : 0;
        const nextStock = currentStock + stockDelta;
        if (nextStock < 0) {
            return res.status(400).json({ error: `库存不足，当前库存仅 ${currentStock}` });
        }

        const paidQuantityMap = await buildPaidProductQuantityMap();
        const paidCountBase = paidQuantityMap.get(productId) || 0;
        const nextPresaleOffset = currentOffset + presalePaidDelta;
        const nextPresalePaidCount = paidCountBase + nextPresaleOffset;
        if (nextPresalePaidCount < 0) {
            return res.status(400).json({ error: `预售进度不足，当前仅 ${Math.max(0, paidCountBase + currentOffset)}` });
        }

        await dbRun(
            'UPDATE products SET stock = ?, presalePaidOffset = ? WHERE id = ?',
            [nextStock, nextPresaleOffset, productId]
        );

        res.json({
            success: true,
            productId,
            stock: nextStock,
            presalePaidCountBase: paidCountBase,
            presalePaidOffset: nextPresaleOffset,
            presalePaidCount: nextPresalePaidCount
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete(apiPath('/products/:id'), requireAdminAuth, (req, res) => {
    db.run("DELETE FROM products WHERE id = ?", req.params.id, function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Deleted', changes: this.changes });
    });
});

// --- 订单管理核心接口 ---

// 1. 获取订单列表 (支持状态过滤)
app.get(apiPath('/orders'), requireAdminAuth, (req, res) => {
    const status = String(req.query.status || 'all');
    const keyword = sanitizeConfigText(req.query.keyword || '', 80);
    const sortBy = String(req.query.sortBy || 'created_at');
    const sortDir = String(req.query.sortDir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));

    const sortByMap = {
        created_at: 'created_at',
        total: 'total',
        status: 'status',
        id: 'id'
    };
    const orderByField = sortByMap[sortBy] || 'created_at';

    const conditions = [];
    const params = [];
    if (status !== 'all') {
        const numericStatus = Number(status);
        if (!ORDER_STATUS_VALUES.includes(numericStatus)) {
            return res.status(400).json({ error: 'status 参数无效' });
        }
        conditions.push('status = ?');
        params.push(numericStatus);
    }
    if (keyword) {
        conditions.push('(id LIKE ? OR contactName LIKE ? OR contactPhone LIKE ? OR mergeMeta LIKE ?)');
        params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    db.get(`SELECT COUNT(*) AS total FROM orders ${whereSql}`, params, (countErr, countRow) => {
        if (countErr) return res.status(500).json({ error: countErr.message });

        const total = Number(countRow?.total) || 0;
        const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;
        const sql = `SELECT * FROM orders ${whereSql} ORDER BY ${orderByField} ${sortDir}, id DESC LIMIT ? OFFSET ?`;

        db.all(sql, [...params, pageSize, offset], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const orders = rows.map((row) => mapOrderRow(row));
            res.json({
                items: orders,
                pagination: { page, pageSize, total, totalPages },
                sort: { by: orderByField, dir: sortDir.toLowerCase() },
                filters: { status, keyword }
            });
        });
    });
});

// 获取指定状态的所有订单 ID（用于跨页批量勾选）
app.get(apiPath('/orders/ids'), requireAdminAuth, (req, res) => {
    const status = String(req.query.status || 'all');
    const exported = req.query.exported;

    const conditions = [];
    const params = [];
    if (status !== 'all') {
        const numericStatus = Number(status);
        if (!ORDER_STATUS_VALUES.includes(numericStatus)) {
            return res.status(400).json({ error: 'status 参数无效' });
        }
        conditions.push('status = ?');
        params.push(numericStatus);
    }
    if (exported !== undefined && exported !== '') {
        conditions.push('exported = ?');
        params.push(Number(exported) ? 1 : 0);
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    db.all(`SELECT id FROM orders ${whereSql}`, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ids: rows.map(r => r.id) });
    });
});

// 批量标记订单为已导出
app.put(apiPath('/orders/mark-exported'), requireAdminAuth, async (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: '请提供订单 ID 列表' });
    }
    const placeholders = ids.map(() => '?').join(',');
    try {
        await dbRun(`UPDATE orders SET exported = 1 WHERE id IN (${placeholders})`, ids);
        res.json({ success: true, count: ids.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 1.1 总览看板聚合数据
app.get(apiPath('/admin/dashboard-summary'), requireAdminAuth, async (req, res) => {
    try {
        const [pendingVerifyRow, pendingShipmentRow, totalSalesRow, totalOrdersRow] = await Promise.all([
            dbGet('SELECT COUNT(*) AS total FROM orders WHERE status = ?', [5]),
            dbGet('SELECT COUNT(*) AS total FROM orders WHERE status = ?', [2]),
            dbGet(
                `SELECT COALESCE(SUM(total), 0) AS total
                 FROM orders
                 WHERE status IN (${SALES_VALID_STATUSES.map(() => '?').join(', ')})`,
                SALES_VALID_STATUSES
            ),
            dbGet('SELECT COUNT(*) AS total FROM orders')
        ]);

        res.json({
            pendingVerify: Number(pendingVerifyRow?.total) || 0,
            pendingShipment: Number(pendingShipmentRow?.total) || 0,
            totalSales: roundMoney(totalSalesRow?.total),
            totalOrders: Number(totalOrdersRow?.total) || 0
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. 创建订单 (事务 + 锁库存)
app.post(apiPath('/orders'), async (req, res) => {
    const { id, items, contact, total, couponCode: rawCouponCode, mergeTarget } = req.body || {};
    let transactionStarted = false;

    try {
        if (!id || typeof id !== 'string') throw createBadRequestError('订单号不能为空');
        if (!Array.isArray(items) || items.length === 0) throw createBadRequestError('订单商品不能为空');
        const normalizedContact = normalizeOrderContactInput(contact);

        const normalizedItems = items.map((item, index) => {
            const productId = Number(item.id);
            const quantity = Number(item.quantity);
            if (!Number.isInteger(productId) || productId <= 0) {
                throw createBadRequestError(`第 ${index + 1} 个商品ID无效`);
            }
            if (!Number.isInteger(quantity) || quantity <= 0) {
                throw createBadRequestError(`商品 ${item.name || productId} 数量无效`);
            }
            return { ...item, id: productId, quantity };
        });

        const clientTotal = Number(total);
        if (!Number.isFinite(clientTotal) || clientTotal < 0) {
            throw createBadRequestError('订单金额无效');
        }
        const couponCode = normalizeCouponCode(rawCouponCode);
        const mergeOrderId = String(mergeTarget?.orderId || '').trim();
        const mergePhoneLast4 = String(mergeTarget?.phoneLast4 || '').trim();
        const shouldMerge = Boolean(mergeOrderId || mergePhoneLast4);
        if (shouldMerge) {
            if (!mergeOrderId) throw createBadRequestError('请输入待合并订单号');
            if (!/^\d{4}$/.test(mergePhoneLast4)) throw createBadRequestError('请填写手机号后四位');
            if (mergeOrderId === id) throw createBadRequestError('待合并订单号不能与当前订单号相同');
        }

        await dbRun('BEGIN IMMEDIATE TRANSACTION');
        transactionStarted = true;

        const uniqueProductIds = [...new Set(normalizedItems.map((item) => item.id))];
        const productRows = await dbAll(
            `SELECT id, name, price, discountPrice, stock, shippingTag, shippingCost, presaleMode, presaleGoalTarget, presaleFixedDateType, presaleFixedDateValue
             FROM products
             WHERE id IN (${uniqueProductIds.map(() => '?').join(', ')})`,
            uniqueProductIds
        );
        const productRowsById = new Map(productRows.map((row) => [Number(row.id), row]));
        const quantityByProductId = normalizedItems.reduce((map, item) => {
            map.set(item.id, (map.get(item.id) || 0) + item.quantity);
            return map;
        }, new Map());

        for (const [productId, totalQty] of quantityByProductId) {
            const product = productRowsById.get(productId);
            if (!product) throw createBadRequestError(`商品 ${productId} 不存在`);
            const presaleSnapshot = getProductPresaleSnapshot(product);
            if (!presaleSnapshot.isPresale && (Number(product.stock) || 0) < totalQty) {
                throw createBadRequestError(`商品 ${product.name || productId} 库存不足`);
            }
        }

        const pricing = calculateOrderPricing(normalizedItems, productRowsById);

        let couponDiscountAmount = 0;
        let appliedCoupon = null;
        if (couponCode) {
            const coupon = await getCouponByCode(couponCode);
            const evaluatedCoupon = evaluateCoupon(coupon, pricing.originalTotal);
            if (evaluatedCoupon.error) throw createBadRequestError(evaluatedCoupon.error);

            appliedCoupon = evaluatedCoupon.coupon;
            couponDiscountAmount = evaluatedCoupon.discountAmount;
        }

        const currentOrderServerTotal = roundMoney(Math.max(0, pricing.originalTotal - couponDiscountAmount));
        if (!shouldMerge && Math.abs(clientTotal - currentOrderServerTotal) > 0.01) {
            throw createBadRequestError('订单金额已变化，请刷新页面后重试');
        }

        let finalOrderId = id;
        let finalPricedItems = pricing.pricedItems;
        let finalOriginalTotal = pricing.originalTotal;
        let finalDiscountAmount = couponDiscountAmount;
        let finalServerTotal = currentOrderServerTotal;
        let finalCouponCode = appliedCoupon ? appliedCoupon.code : null;
        let mergeMeta = null;
        let sourceOrder = null;
        let sourceCouponCode = '';

        if (shouldMerge) {
            sourceOrder = await dbGet('SELECT * FROM orders WHERE id = ?', [mergeOrderId]);
            if (!sourceOrder) throw createBadRequestError('待合并订单不存在');
            if (!SELF_SERVICE_MERGEABLE_SOURCE_STATUSES.has(Number(sourceOrder.status))) {
                throw createBadRequestError('仅支持合并未发货订单');
            }

            const expectedLast4 = extractPhoneLast4(sourceOrder.contactPhone);
            if (!expectedLast4 || expectedLast4 !== mergePhoneLast4) {
                throw createBadRequestError('手机号后四位校验失败');
            }

            sourceCouponCode = normalizeCouponCode(sourceOrder.couponCode);
            if (sourceCouponCode && couponCode) {
                throw createBadRequestError('暂不支持两个订单都使用优惠券后再合并');
            }

            const sourceMergeMeta = normalizeOrderMergeMeta(sourceOrder.mergeMeta);
            const sourceItems = mergePricedItems(safeParse(sourceOrder.items, []));
            if (sourceItems.length === 0) {
                throw createBadRequestError('待合并订单商品数据异常，无法合并');
            }

            const sourcePricing = calculatePricingFromPricedItems(sourceItems);
            const sourceDiscountAmount = roundMoney(Number(sourceOrder.discountAmount) || 0);
            const sourceAmount = roundMoney(Number(sourceOrder.total) || 0);
            const mergedItems = mergePricedItems(sourceItems, pricing.pricedItems);
            const mergedPricing = calculatePricingFromPricedItems(mergedItems);
            const shippingAdjustment = roundMoney(
                mergedPricing.shippingFee - sourcePricing.shippingFee - pricing.shippingFee
            );
            const shippingSaved = roundMoney(Math.max(0, -shippingAdjustment));
            const mergeTime = new Date().toISOString();

            finalOrderId = await generateUniqueOrderId();
            finalPricedItems = mergedPricing.pricedItems;
            finalOriginalTotal = mergedPricing.originalTotal;
            finalDiscountAmount = roundMoney(sourceDiscountAmount + couponDiscountAmount);
            finalServerTotal = roundMoney(Math.max(0, finalOriginalTotal - finalDiscountAmount));
            finalCouponCode = sourceCouponCode || (appliedCoupon ? appliedCoupon.code : null) || null;
            const sourceContact = {
                name: String(sourceOrder.contactName || '').trim(),
                phone: String(sourceOrder.contactPhone || '').trim(),
                email: String(sourceOrder.contactEmail || '').trim(),
                province: String(sourceOrder.province || '').trim(),
                city: String(sourceOrder.city || '').trim(),
                district: String(sourceOrder.district || '').trim(),
                addressDetail: String(sourceOrder.addressDetail || '').trim()
            };
            const nextContact = {
                name: normalizedContact.contactName,
                phone: normalizedContact.contactPhone,
                email: normalizedContact.contactEmail,
                province: normalizedContact.contactProvince,
                city: normalizedContact.contactCity,
                district: normalizedContact.contactDistrict,
                addressDetail: normalizedContact.contactAddressDetail
            };
            const contactChanged = JSON.stringify(sourceContact) !== JSON.stringify(nextContact);

            const sourceParts =
                Array.isArray(sourceMergeMeta?.parts) && sourceMergeMeta.parts.length > 0
                    ? sourceMergeMeta.parts.map((part) => ({
                        orderId: String(part?.orderId || '').trim(),
                        amount: roundMoney(part?.amount),
                        statusBeforeMerge: Number.isInteger(Number(part?.statusBeforeMerge))
                            ? Number(part.statusBeforeMerge)
                            : null
                    })).filter((part) => part.orderId)
                    : [
                        {
                            orderId: sourceOrder.id,
                            amount: sourceAmount,
                            statusBeforeMerge: Number(sourceOrder.status)
                        }
                    ];

            const partsByOrderId = new Map();
            for (const part of sourceParts) {
                const existing = partsByOrderId.get(part.orderId);
                if (existing) {
                    existing.amount = roundMoney(existing.amount + part.amount);
                } else {
                    partsByOrderId.set(part.orderId, { ...part });
                }
            }
            if (partsByOrderId.has(id)) {
                const existing = partsByOrderId.get(id);
                existing.amount = roundMoney(existing.amount + currentOrderServerTotal);
                partsByOrderId.set(id, existing);
            } else {
                partsByOrderId.set(id, {
                    orderId: id,
                    amount: currentOrderServerTotal,
                    statusBeforeMerge: 1
                });
            }

            const sourceHistory =
                Array.isArray(sourceMergeMeta?.history)
                    ? sourceMergeMeta.history
                        .map((row) => ({
                            sourceOrderId: String(row?.sourceOrderId || '').trim(),
                            appendedOrderId: String(row?.appendedOrderId || row?.submittedOrderId || '').trim(),
                            newOrderId: String(row?.newOrderId || row?.mergedOrderId || '').trim(),
                            sourceAmount: roundMoney(row?.sourceAmount),
                            appendedAmount: roundMoney(row?.appendedAmount),
                            mergedAmount: roundMoney(row?.mergedAmount),
                            sourceShippingFee: roundMoney(row?.sourceShippingFee),
                            appendedShippingFee: roundMoney(row?.appendedShippingFee),
                            mergedShippingFee: roundMoney(row?.mergedShippingFee),
                            shippingAdjustment: row?.shippingAdjustment !== undefined
                                ? roundMoney(row.shippingAdjustment)
                                : roundMoney(
                                    (Number(row?.mergedShippingFee) || 0)
                                    - (Number(row?.sourceShippingFee) || 0)
                                    - (Number(row?.appendedShippingFee) || 0)
                                ),
                            incrementalPayable: row?.incrementalPayable !== undefined
                                ? roundMoney(row.incrementalPayable)
                                : roundMoney(
                                    Math.max(
                                        0,
                                        (Number(row?.appendedAmount) || 0)
                                        + (
                                            row?.shippingAdjustment !== undefined
                                                ? Number(row.shippingAdjustment)
                                                : (
                                                    (Number(row?.mergedShippingFee) || 0)
                                                    - (Number(row?.sourceShippingFee) || 0)
                                                    - (Number(row?.appendedShippingFee) || 0)
                                                )
                                        )
                                    )
                                ),
                            shippingSaved: roundMoney(row?.shippingSaved),
                            mergedAt: row?.mergedAt ? String(row.mergedAt) : null
                        }))
                        .filter((row) => row.sourceOrderId && row.appendedOrderId && row.newOrderId)
                    : [];
            const currentHistory = {
                sourceOrderId: sourceOrder.id,
                appendedOrderId: id,
                newOrderId: finalOrderId,
                sourceAmount,
                appendedAmount: currentOrderServerTotal,
                mergedAmount: finalServerTotal,
                sourceShippingFee: sourcePricing.shippingFee,
                appendedShippingFee: pricing.shippingFee,
                mergedShippingFee: mergedPricing.shippingFee,
                shippingAdjustment,
                incrementalPayable: roundMoney(Math.max(0, currentOrderServerTotal + shippingAdjustment)),
                shippingSaved,
                mergedAt: mergeTime
            };
            const mergedHistory = [...sourceHistory, currentHistory];

            mergeMeta = {
                mergedOrderId: finalOrderId,
                sourceOrderId: sourceOrder.id,
                submittedOrderId: id,
                sourceAmount,
                appendedAmount: currentOrderServerTotal,
                mergedAmount: finalServerTotal,
                sourceShippingFee: sourcePricing.shippingFee,
                appendedShippingFee: pricing.shippingFee,
                mergedShippingFee: mergedPricing.shippingFee,
                shippingAdjustment,
                incrementalPayable: roundMoney(Math.max(0, currentOrderServerTotal + shippingAdjustment)),
                shippingSaved,
                contactPolicy: 'new_order',
                contactChanged,
                mergedAt: mergeTime,
                mergeCount: mergedHistory.length,
                parts: [...partsByOrderId.values()],
                history: mergedHistory
            };
        }

        if (shouldMerge && Math.abs(clientTotal - finalServerTotal) > 0.01) {
            throw createBadRequestError('合并后订单金额已变化，请重新校验后重试');
        }

        for (const [productId, totalQty] of quantityByProductId) {
            const product = productRowsById.get(productId);
            if (!product) continue;
            const presaleSnapshot = getProductPresaleSnapshot(product);
            if (presaleSnapshot.isPresale) continue;
            await dbRun("UPDATE products SET stock = stock - ? WHERE id = ?", [totalQty, productId]);
        }

        const sql = `INSERT INTO orders
            (id, total, originalTotal, discountAmount, couponCode, mergeMeta, items, contactName, contactPhone, contactEmail, province, city, district, addressDetail, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        const params = [
            finalOrderId,
            finalServerTotal,
            finalOriginalTotal,
            finalDiscountAmount,
            finalCouponCode,
            mergeMeta ? JSON.stringify(mergeMeta) : null,
            JSON.stringify(finalPricedItems),
            normalizedContact.contactName,
            normalizedContact.contactPhone,
            normalizedContact.contactEmail,
            normalizedContact.contactProvince,
            normalizedContact.contactCity,
            normalizedContact.contactDistrict,
            normalizedContact.contactAddressDetail,
            1 // 状态1: 待付款
        ];

        await dbRun(sql, params);

        if (sourceOrder && sourceCouponCode) {
            await dbRun(
                `UPDATE coupons
                 SET usedOrderId = ?
                 WHERE code = ? AND usedOrderId = ? AND status = ?`,
                [finalOrderId, sourceCouponCode, sourceOrder.id, COUPON_STATUS.USED]
            );
        }

        if (appliedCoupon) {
            const result = await dbRun(
                `UPDATE coupons
                 SET status = ?, usedOrderId = ?, used_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status = ?`,
                [COUPON_STATUS.USED, finalOrderId, appliedCoupon.id, COUPON_STATUS.UNUSED]
            );
            if (Number(result.changes) !== 1) {
                throw createBadRequestError('优惠券已被使用，请更换后重试');
            }
        }

        if (sourceOrder) {
            await dbRun('DELETE FROM orders WHERE id = ?', [sourceOrder.id]);
        }

        await dbRun('COMMIT');
        transactionStarted = false;
        enqueueOrderEmailSafely('order_created', finalOrderId);

        res.json({
            success: true,
            orderId: finalOrderId,
            total: finalServerTotal,
            originalTotal: finalOriginalTotal,
            discountAmount: finalDiscountAmount,
            couponCode: finalCouponCode,
            mergeMeta
        });
    } catch (err) {
        if (transactionStarted) {
            try { await dbRun('ROLLBACK'); } catch (rollbackErr) { console.error('Rollback create order failed:', rollbackErr); }
        }

        if (err.isBadRequest) {
            return res.status(400).json({ error: err.message });
        }
        if (err.code === 'SQLITE_CONSTRAINT') {
            try {
                const existingOrder = await dbGet(
                    'SELECT id, total, originalTotal, discountAmount, couponCode FROM orders WHERE id = ?',
                    [id]
                );
                if (existingOrder) {
                    return res.json({
                        success: true,
                        orderId: existingOrder.id,
                        total: roundMoney(existingOrder.total),
                        originalTotal: roundMoney(existingOrder.originalTotal),
                        discountAmount: roundMoney(existingOrder.discountAmount),
                        couponCode: existingOrder.couponCode || null
                    });
                }
            } catch {}
            return res.status(409).json({ error: '订单号已存在，请重新提交订单' });
        }

        console.error('Order creation failed:', err);
        res.status(500).json({ error: 'Order creation failed' });
    }
});

// 3. 按订单号查询单个订单 (前台用)
app.get(apiPath('/orders/:id'), (req, res) => {
    db.get("SELECT * FROM orders WHERE id = ?", [req.params.id], (err, orderRow) => {
        if (err) return res.status(500).json({ error: err.message });
        const order = mapOrderRow(orderRow);
        if (!order) return res.status(404).json({ error: '订单不存在' });

        const adminPayload = verifyAdminToken(extractBearerToken(req));
        if (!adminPayload || adminPayload.role !== 'admin') {
            const phoneLast4 = String(req.query.phoneLast4 || '').trim();
            if (!/^\d{4}$/.test(phoneLast4)) {
                return res.status(400).json({ error: '请填写手机号后四位' });
            }

            const expectedLast4 = extractPhoneLast4(order.contactPhone);
            if (!expectedLast4 || phoneLast4 !== expectedLast4) {
                return res.status(403).json({ error: '手机号后四位校验失败' });
            }
        }

        res.json(order);
    });
});

// 修改订单收货信息：
// - 用户端：需手机号后四位校验，且仅允许未发货订单
// - 管理端：携带管理员 token 可直接修改
app.put(apiPath('/orders/:id/contact'), async (req, res) => {
    const orderId = String(req.params.id || '').trim();
    if (!orderId) return res.status(400).json({ error: '订单号不能为空' });

    try {
        const existingOrder = await dbGet(
            'SELECT id, status, contactPhone FROM orders WHERE id = ?',
            [orderId]
        );
        if (!existingOrder) return res.status(404).json({ error: '订单不存在' });

        const adminPayload = verifyAdminToken(extractBearerToken(req));
        const isAdmin = Boolean(adminPayload && adminPayload.role === 'admin');

        if (!isAdmin) {
            const phoneLast4 = String(req.body?.phoneLast4 || req.query?.phoneLast4 || '').trim();
            if (!/^\d{4}$/.test(phoneLast4)) {
                return res.status(400).json({ error: '请填写手机号后四位' });
            }

            const expectedLast4 = extractPhoneLast4(existingOrder.contactPhone);
            if (!expectedLast4 || phoneLast4 !== expectedLast4) {
                return res.status(403).json({ error: '手机号后四位校验失败' });
            }

            if (!SELF_SERVICE_CONTACT_EDITABLE_STATUSES.has(Number(existingOrder.status))) {
                return res.status(400).json({ error: '订单已发货，仅支持联系管理员修改收货信息' });
            }
        }

        const normalized = normalizeOrderContactInput(req.body?.contact);
        await dbRun(
            `UPDATE orders
             SET contactName = ?,
                 contactPhone = ?,
                 contactEmail = ?,
                 province = ?,
                 city = ?,
                 district = ?,
                 addressDetail = ?
             WHERE id = ?`,
            [
                normalized.contactName,
                normalized.contactPhone,
                normalized.contactEmail,
                normalized.contactProvince,
                normalized.contactCity,
                normalized.contactDistrict,
                normalized.contactAddressDetail,
                orderId
            ]
        );

        const updatedOrder = await dbGet('SELECT * FROM orders WHERE id = ?', [orderId]);
        if (!updatedOrder) return res.status(404).json({ error: '订单不存在' });
        res.json(mapOrderRow(updatedOrder));
    } catch (err) {
        if (err?.isBadRequest) return res.status(400).json({ error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// 用户提交支付凭证：待付款(1) -> 待确认(5)
app.post(apiPath('/orders/:id/payment'), async (req, res) => {
    const orderId = req.params.id;
    let transactionStarted = false;

    try {
        await dbRun('BEGIN IMMEDIATE TRANSACTION');
        transactionStarted = true;

        const order = await dbGet("SELECT status FROM orders WHERE id = ?", [orderId]);
        if (!order) {
            await dbRun('ROLLBACK');
            transactionStarted = false;
            return res.status(404).json({ error: '订单不存在' });
        }

        const oldStatus = Number(order.status);
        if (oldStatus === 5) {
            await dbRun('COMMIT');
            transactionStarted = false;
            return res.json({ success: true, status: 5 });
        }

        if (oldStatus !== 1) {
            await dbRun('ROLLBACK');
            transactionStarted = false;
            return res.status(400).json({ error: '当前订单状态不允许提交支付' });
        }

        await dbRun("UPDATE orders SET status = 5 WHERE id = ?", [orderId]);
        await dbRun('COMMIT');
        transactionStarted = false;
        res.json({ success: true, status: 5 });
    } catch (err) {
        if (transactionStarted) {
            try { await dbRun('ROLLBACK'); } catch {}
        }
        res.status(500).json({ error: err.message });
    }
});

// 4. 更新订单状态 (状态机校验 + 事务库存回滚)
app.put(apiPath('/orders/:id/status'), requireAdminAuth, async (req, res) => {
    const orderId = req.params.id;
    const { trackingCompany, trackingNo } = req.body || {};
    const newStatus = Number(req.body?.status);
    let transactionStarted = false;
    let notifyEventKey = '';

    if (!Number.isInteger(newStatus) || !ORDER_STATUS_VALUES.includes(newStatus)) {
        return res.status(400).json({ error: '订单状态值无效' });
    }

    try {
        await dbRun('BEGIN IMMEDIATE TRANSACTION');
        transactionStarted = true;

        const order = await dbGet("SELECT status, items FROM orders WHERE id = ?", [orderId]);
        if (!order) {
            await dbRun('ROLLBACK');
            transactionStarted = false;
            return res.status(404).json({ error: 'Order not found' });
        }

        const oldStatus = Number(order.status);
        const allowedNextStatuses = STATUS_TRANSITIONS[oldStatus] || [];
        if (newStatus !== oldStatus && !allowedNextStatuses.includes(newStatus)) {
            await dbRun('ROLLBACK');
            transactionStarted = false;
            return res.status(400).json({
                error: `非法状态流转: ${oldStatus} -> ${newStatus}`
            });
        }

        if (newStatus !== oldStatus) {
            if (newStatus === 0) notifyEventKey = 'order_cancelled';
            if (newStatus === 2) notifyEventKey = 'order_confirmed';
            if (newStatus === 3) notifyEventKey = 'order_shipped';
            if (newStatus === 4) notifyEventKey = 'order_completed';
        }

        if (newStatus === 0 && CANCELLABLE_STATUSES.includes(oldStatus)) {
            const items = safeParse(order.items, []);
            for (const item of items) {
                const productId = Number(item.id);
                const quantity = Number(item.quantity) || 0;
                if (Boolean(item?.isPresale)) continue;
                if (Number.isInteger(productId) && quantity > 0) {
                    await dbRun("UPDATE products SET stock = stock + ? WHERE id = ?", [quantity, productId]);
                }
            }
        }

        let sql = "UPDATE orders SET status = ?";
        const params = [newStatus];

        if (newStatus === 3 && trackingCompany && trackingNo) {
            sql += ", trackingCompany = ?, trackingNo = ?";
            params.push(trackingCompany, trackingNo);
        }

        sql += " WHERE id = ?";
        params.push(orderId);

        await dbRun(sql, params);
        await dbRun('COMMIT');
        transactionStarted = false;
        if (notifyEventKey) enqueueOrderEmailSafely(notifyEventKey, orderId);

        res.json({ success: true, status: newStatus });
    } catch (err) {
        if (transactionStarted) {
            try { await dbRun('ROLLBACK'); } catch (rollbackErr) { console.error('Rollback update status failed:', rollbackErr); }
        }
        res.status(500).json({ error: err.message });
    }
});

// 5. 删除待确认订单（仅后台：用于清理异常/测试单）
app.delete(apiPath('/orders/:id'), requireAdminAuth, async (req, res) => {
    const orderId = String(req.params.id || '').trim();
    let transactionStarted = false;

    if (!orderId) {
        return res.status(400).json({ error: '订单号不能为空' });
    }

    try {
        await dbRun('BEGIN IMMEDIATE TRANSACTION');
        transactionStarted = true;

        const order = await dbGet('SELECT id, status, items, couponCode FROM orders WHERE id = ?', [orderId]);
        if (!order) {
            await dbRun('ROLLBACK');
            transactionStarted = false;
            return res.status(404).json({ error: '订单不存在' });
        }

        if (Number(order.status) !== 5) {
            await dbRun('ROLLBACK');
            transactionStarted = false;
            return res.status(400).json({ error: '仅允许删除待确认订单' });
        }

        const items = safeParse(order.items, []);
        for (const item of items) {
            const productId = Number(item.id);
            const quantity = Number(item.quantity) || 0;
            if (Boolean(item?.isPresale)) continue;
            if (Number.isInteger(productId) && quantity > 0) {
                await dbRun('UPDATE products SET stock = stock + ? WHERE id = ?', [quantity, productId]);
            }
        }

        if (order.couponCode) {
            await dbRun(
                `UPDATE coupons
                 SET status = ?, usedOrderId = NULL, used_at = NULL
                 WHERE code = ? AND usedOrderId = ? AND status = ?`,
                [COUPON_STATUS.UNUSED, normalizeCouponCode(order.couponCode), orderId, COUPON_STATUS.USED]
            );
        }

        await dbRun('DELETE FROM orders WHERE id = ?', [orderId]);
        await dbRun('COMMIT');
        transactionStarted = false;
        res.json({ success: true });
    } catch (err) {
        if (transactionStarted) {
            try { await dbRun('ROLLBACK'); } catch (rollbackErr) { console.error('Rollback delete order failed:', rollbackErr); }
        }
        res.status(500).json({ error: err.message });
    }
});

// --- 数据统计与转化埋点接口 ---

app.post(apiPath('/analytics/event'), async (req, res) => {
    const { sessionId, eventKey, page, meta } = req.body || {};
    const cleanEventKey = typeof eventKey === 'string' ? eventKey.trim().slice(0, 80) : '';

    if (!cleanEventKey) {
        return res.status(400).json({ error: 'eventKey 不能为空' });
    }

    const cleanSessionId =
        typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim().slice(0, 120) : 'anonymous';
    const cleanPage = typeof page === 'string' ? page.slice(0, 200) : '';
    const cleanMeta =
        meta && typeof meta === 'object'
            ? JSON.stringify(meta).slice(0, 2000)
            : JSON.stringify({});

    try {
        await dbRun(
            `INSERT INTO analytics_events (sessionId, eventKey, page, meta)
             VALUES (?, ?, ?, ?)`,
            [cleanSessionId, cleanEventKey, cleanPage, cleanMeta]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get(apiPath('/admin/stats/sales-trend'), requireAdminAuth, async (req, res) => {
    const parsedRange = resolveStatsRange({
        period: req.query.period,
        startDate: req.query.startDate,
        endDate: req.query.endDate,
        defaultPeriod: '30',
        allowAll: true
    });

    if (parsedRange.error) return res.status(400).json({ error: parsedRange.error });

    try {
        let { startDate, endDate } = parsedRange;
        const statusPlaceholders = SALES_VALID_STATUSES.map(() => '?').join(', ');

        if (parsedRange.period === 'all') {
            const span = await dbGet(
                `SELECT MIN(DATE(created_at)) AS startDate, MAX(DATE(created_at)) AS endDate
                 FROM orders
                 WHERE status IN (${statusPlaceholders})`,
                SALES_VALID_STATUSES
            );

            if (!span || !span.startDate) {
                return res.json({
                    period: 'all',
                    startDate: null,
                    endDate: null,
                    points: [],
                    summary: { salesAmount: 0, orderCount: 0, avgOrderAmount: 0 }
                });
            }

            startDate = span.startDate;
            endDate = span.endDate;
        }

        const rows = await dbAll(
            `SELECT DATE(created_at) AS day, SUM(total) AS salesAmount, COUNT(*) AS orderCount
             FROM orders
             WHERE status IN (${statusPlaceholders})
               AND DATE(created_at) BETWEEN DATE(?) AND DATE(?)
             GROUP BY DATE(created_at)
             ORDER BY DATE(created_at) ASC`,
            [...SALES_VALID_STATUSES, startDate, endDate]
        );

        const rowMap = new Map(
            rows.map((r) => [
                r.day,
                {
                    salesAmount: Number(r.salesAmount) || 0,
                    orderCount: Number(r.orderCount) || 0
                }
            ])
        );

        const points = buildDateRange(startDate, endDate).map((day) => {
            const item = rowMap.get(day) || { salesAmount: 0, orderCount: 0 };
            return { date: day, salesAmount: item.salesAmount, orderCount: item.orderCount };
        });

        const summary = points.reduce(
            (acc, item) => {
                acc.salesAmount += item.salesAmount;
                acc.orderCount += item.orderCount;
                return acc;
            },
            { salesAmount: 0, orderCount: 0 }
        );
        summary.avgOrderAmount = summary.orderCount > 0 ? Number((summary.salesAmount / summary.orderCount).toFixed(2)) : 0;

        res.json({
            period: parsedRange.period,
            startDate,
            endDate,
            points,
            summary
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get(apiPath('/admin/stats/product-sales'), requireAdminAuth, async (req, res) => {
    const range = getPeriodRangeForProductReport(req.query.period);
    if (range.error) return res.status(400).json({ error: range.error });

    try {
        const statusPlaceholders = SALES_VALID_STATUSES.map(() => '?').join(', ');
        let sql = `SELECT items FROM orders WHERE status IN (${statusPlaceholders})`;
        const params = [...SALES_VALID_STATUSES];

        if (range.period !== 'all') {
            sql += ` AND DATE(created_at) BETWEEN DATE(?) AND DATE(?)`;
            params.push(range.startDate, range.endDate);
        }

        const rows = await dbAll(sql, params);
        const summaryMap = new Map();

        rows.forEach((row) => {
            const items = safeParse(row.items, []);
            items.forEach((item) => {
                const quantity = Number(item.quantity) || 0;
                if (quantity <= 0) return;

                const key = item.id ? `id:${item.id}` : `name:${item.name || 'unknown'}`;
                if (!summaryMap.has(key)) {
                    summaryMap.set(key, {
                        productId: item.id || null,
                        name: item.name || '未命名商品',
                        quantity: 0,
                        amount: 0
                    });
                }

                const rowItem = summaryMap.get(key);
                rowItem.quantity += quantity;
                rowItem.amount += (Number(item.price) || 0) * quantity;
            });
        });

        const items = [...summaryMap.values()].sort((a, b) => b.quantity - a.quantity || b.amount - a.amount);
        const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
        const totalAmount = items.reduce((sum, item) => sum + item.amount, 0);

        res.json({
            period: range.period,
            startDate: range.startDate,
            endDate: range.endDate,
            items,
            totalQuantity,
            totalAmount
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get(apiPath('/admin/stats/conversion'), requireAdminAuth, async (req, res) => {
    const parsedRange = resolveStatsRange({
        period: req.query.period,
        startDate: req.query.startDate,
        endDate: req.query.endDate,
        defaultPeriod: '30',
        allowAll: true
    });

    if (parsedRange.error) return res.status(400).json({ error: parsedRange.error });

    try {
        let { startDate, endDate } = parsedRange;

        if (parsedRange.period === 'all') {
            const span = await dbGet(
                `SELECT MIN(DATE(created_at)) AS startDate, MAX(DATE(created_at)) AS endDate
                 FROM analytics_events`
            );

            if (!span || !span.startDate) {
                const emptySteps = FUNNEL_STEPS.map((step, index) => ({
                    ...step,
                    visitors: 0,
                    conversionRate: index === 0 ? 100 : 0
                }));

                return res.json({
                    period: 'all',
                    startDate: null,
                    endDate: null,
                    steps: emptySteps,
                    overallConversion: 0
                });
            }

            startDate = span.startDate;
            endDate = span.endDate;
        }

        const eventKeys = FUNNEL_STEPS.map((step) => step.key);
        const placeholders = eventKeys.map(() => '?').join(', ');
        const rows = await dbAll(
            `SELECT eventKey, COUNT(DISTINCT sessionId) AS visitors
             FROM analytics_events
             WHERE eventKey IN (${placeholders})
               AND DATE(created_at) BETWEEN DATE(?) AND DATE(?)
             GROUP BY eventKey`,
            [...eventKeys, startDate, endDate]
        );

        const visitorMap = new Map(rows.map((row) => [row.eventKey, Number(row.visitors) || 0]));

        const steps = FUNNEL_STEPS.map((step, index) => {
            const visitors = visitorMap.get(step.key) || 0;
            const prevVisitors = index === 0 ? visitors : visitorMap.get(FUNNEL_STEPS[index - 1].key) || 0;
            const conversionRate =
                index === 0 ? 100 : prevVisitors > 0 ? Number(((visitors / prevVisitors) * 100).toFixed(2)) : 0;

            return { ...step, visitors, conversionRate };
        });

        const firstStepVisitors = steps[0]?.visitors || 0;
        const lastStepVisitors = steps[steps.length - 1]?.visitors || 0;
        const overallConversion =
            firstStepVisitors > 0 ? Number(((lastStepVisitors / firstStepVisitors) * 100).toFixed(2)) : 0;

        res.json({
            period: parsedRange.period,
            startDate,
            endDate,
            steps,
            overallConversion
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT} (API prefix: ${API_PREFIX})`);
    emailService.startWorker();
});
