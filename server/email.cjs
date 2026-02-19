let nodemailer = null;
try {
    nodemailer = require('nodemailer');
} catch {}

const ORDER_STATUS_LABELS = Object.freeze({
    0: '已取消',
    1: '待付款',
    2: '待发货',
    3: '已发货',
    4: '已完成',
    5: '待确认'
});

const EMAIL_EVENTS = new Set([
    'order_created',
    'payment_submitted',
    'order_shipped',
    'order_completed',
    'order_cancelled'
]);

const DEFAULT_BACKOFF_MINUTES = [1, 5, 15, 60, 180];

const toBoolean = (value, fallback = false) => {
    if (value === null || value === undefined || value === '') return fallback;
    const raw = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
    return fallback;
};

const toPositiveInt = (value, fallback) => {
    const num = Number(value);
    if (!Number.isInteger(num) || num <= 0) return fallback;
    return num;
};

const normalizeBackoffs = (value) => {
    if (Array.isArray(value)) {
        const list = value
            .map((item) => Number(item))
            .filter((item) => Number.isFinite(item) && item > 0)
            .map((item) => Math.floor(item));
        return list.length > 0 ? list : [...DEFAULT_BACKOFF_MINUTES];
    }

    const raw = String(value || '')
        .split(',')
        .map((item) => Number(item.trim()))
        .filter((item) => Number.isFinite(item) && item > 0)
        .map((item) => Math.floor(item));
    return raw.length > 0 ? raw : [...DEFAULT_BACKOFF_MINUTES];
};

const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());

const escapeHtml = (value) =>
    String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

const toSqliteDateTime = (date) => {
    const d = date instanceof Date ? date : new Date();
    const pad = (num) => String(num).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

const formatDateTime = (value) => {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('zh-CN', { hour12: false });
};

const formatMoney = (value) => {
    const num = Number(value || 0);
    return `¥${Number.isFinite(num) ? num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'}`;
};

const normalizeBasePath = (value) => {
    const raw = String(value || '/').trim();
    if (!raw || raw === '/') return '/';
    let normalized = raw.startsWith('/') ? raw : `/${raw}`;
    normalized = normalized.replace(/\/{2,}/g, '/');
    if (!normalized.endsWith('/')) normalized += '/';
    return normalized;
};

const normalizePublicSiteUrl = (value) => String(value || '').trim().replace(/\/+$/, '');

const resolveOrderQueryUrl = ({ explicitOrderQueryUrl, publicSiteUrl, basePath }) => {
    const explicit = String(explicitOrderQueryUrl || '').trim();
    if (explicit) return explicit;

    const siteUrl = normalizePublicSiteUrl(publicSiteUrl);
    if (!siteUrl) return '';
    const appBasePath = normalizeBasePath(basePath || '/shop/');
    const prefix = appBasePath === '/' ? '' : appBasePath.replace(/\/+$/, '');
    return `${siteUrl}${prefix}/query`;
};

const statusTextByEvent = (eventKey, status) => {
    if (eventKey === 'order_created') return '待付款';
    if (eventKey === 'payment_submitted') return '待确认';
    if (eventKey === 'order_shipped') return '已发货';
    if (eventKey === 'order_completed') return '已完成';
    if (eventKey === 'order_cancelled') return '已取消';
    return ORDER_STATUS_LABELS[Number(status)] || '状态更新';
};

const titleTextByEvent = (eventKey) => {
    if (eventKey === 'order_created') return '订单已创建';
    if (eventKey === 'payment_submitted') return '支付已提交';
    if (eventKey === 'order_shipped') return '订单已发货';
    if (eventKey === 'order_completed') return '订单已完成';
    if (eventKey === 'order_cancelled') return '订单已取消';
    return '订单状态更新';
};

const descriptionTextByEvent = (eventKey) => {
    if (eventKey === 'order_created') return '我们已收到您的订单，请在规定时间内完成支付。';
    if (eventKey === 'payment_submitted') return '我们已收到您的支付提交，正在等待人工核销。';
    if (eventKey === 'order_shipped') return '您的订单已发货，请留意物流动态。';
    if (eventKey === 'order_completed') return '订单已完成，感谢您的支持。';
    if (eventKey === 'order_cancelled') return '订单已取消，如有疑问可联系管理员。';
    return '您的订单状态已更新。';
};

const buildOrderEmail = ({ eventKey, order, orderQueryUrl }) => {
    const statusText = statusTextByEvent(eventKey, order?.status);
    const title = titleTextByEvent(eventKey);
    const description = descriptionTextByEvent(eventKey);
    const orderId = String(order?.id || '').trim();
    const createdAtText = formatDateTime(order?.created_at);
    const trackingText = order?.trackingCompany && order?.trackingNo ? `${order.trackingCompany} / ${order.trackingNo}` : '-';
    const addressText = `${order?.contact?.province || ''}${order?.contact?.city || ''}${order?.contact?.district || ''}${order?.contact?.addressDetail || ''}` || '-';

    const items = Array.isArray(order?.items) ? order.items : [];
    const itemsHtml = items
        .map((item) => `<li>${escapeHtml(item?.name || '商品')} × ${Number(item?.quantity) || 0}</li>`)
        .join('');
    const itemsText = items
        .map((item) => `${item?.name || '商品'} x${Number(item?.quantity) || 0}`)
        .join('；');

    const subject = `[春日商城] ${title} - ${orderId}`;

    const queryHintHtml = orderQueryUrl
        ? `<p>订单查询入口：<a href="${escapeHtml(orderQueryUrl)}" target="_blank" rel="noreferrer">${escapeHtml(orderQueryUrl)}</a></p>`
        : '';
    const queryHintText = orderQueryUrl ? `订单查询入口：${orderQueryUrl}\n` : '';

    const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#111827;">
  <h2 style="margin:0 0 10px;color:#1d4ed8;">${escapeHtml(title)}</h2>
  <p style="margin:0 0 16px;color:#374151;">${escapeHtml(description)}</p>

  <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;">
    <p style="margin:0 0 8px;"><strong>订单号：</strong>${escapeHtml(orderId)}</p>
    <p style="margin:0 0 8px;"><strong>当前状态：</strong>${escapeHtml(statusText)}</p>
    <p style="margin:0 0 8px;"><strong>下单时间：</strong>${escapeHtml(createdAtText)}</p>
    <p style="margin:0 0 8px;"><strong>订单金额：</strong>${escapeHtml(formatMoney(order?.total))}</p>
    <p style="margin:0 0 8px;"><strong>收货人：</strong>${escapeHtml(order?.contact?.name || '-')}</p>
    <p style="margin:0 0 8px;"><strong>联系方式：</strong>${escapeHtml(order?.contact?.phone || '-')}</p>
    <p style="margin:0 0 8px;"><strong>收货地址：</strong>${escapeHtml(addressText)}</p>
    <p style="margin:0;"><strong>物流信息：</strong>${escapeHtml(trackingText)}</p>
  </div>

  <div style="margin-top:14px;">
    <p style="margin:0 0 8px;"><strong>商品明细</strong></p>
    <ul style="margin:0;padding-left:18px;">${itemsHtml || '<li>-</li>'}</ul>
  </div>

  <div style="margin-top:14px;color:#374151;">
    ${queryHintHtml}
    <p style="margin:0;">如有问题请通过“联系我们”页面留言，我们会尽快处理。</p>
  </div>

  <p style="margin-top:18px;color:#6b7280;font-size:12px;">本邮件由系统自动发送，请勿直接回复。</p>
</div>`.trim();

    const text = [
        `${title}`,
        `${description}`,
        `订单号：${orderId}`,
        `当前状态：${statusText}`,
        `下单时间：${createdAtText}`,
        `订单金额：${formatMoney(order?.total)}`,
        `收货人：${order?.contact?.name || '-'}`,
        `联系方式：${order?.contact?.phone || '-'}`,
        `收货地址：${addressText}`,
        `物流信息：${trackingText}`,
        `商品明细：${itemsText || '-'}`,
        queryHintText.trim(),
        '如有问题请通过“联系我们”页面留言。',
        '本邮件由系统自动发送，请勿直接回复。'
    ]
        .filter(Boolean)
        .join('\n');

    return { subject, html, text };
};

const createEmailService = (options = {}) => {
    const dbAll = options.dbAll;
    const dbRun = options.dbRun;
    const logger = options.logger || console;

    if (typeof dbAll !== 'function' || typeof dbRun !== 'function') {
        throw new Error('createEmailService requires dbAll and dbRun');
    }

    const serviceEnabled = toBoolean(options.enabled, false);
    const smtpHost = String(options.smtpHost || '').trim();
    const smtpPort = toPositiveInt(options.smtpPort, 465);
    const smtpSecure = toBoolean(options.smtpSecure, true);
    const smtpUser = String(options.smtpUser || '').trim();
    const smtpPass = String(options.smtpPass || '').trim();
    const mailFromName = String(options.mailFromName || '春日商城').trim();
    const mailFromAddress = String(options.mailFromAddress || '').trim();
    const mailReplyTo = String(options.mailReplyTo || '').trim();
    const maxAttempts = toPositiveInt(options.maxAttempts, 5);
    const retryBackoffs = normalizeBackoffs(options.retryBackoffs);
    const workerIntervalMs = toPositiveInt(options.workerIntervalMs, 10000);
    const workerBatchSize = Math.min(200, toPositiveInt(options.workerBatchSize, 20));
    const orderQueryUrl = resolveOrderQueryUrl({
        explicitOrderQueryUrl: options.orderQueryUrl,
        publicSiteUrl: options.publicSiteUrl,
        basePath: options.basePath
    });

    let transporter = null;
    let unavailableReason = '';
    if (!serviceEnabled) {
        unavailableReason = 'EMAIL_NOTIFICATIONS_ENABLED=false';
    } else if (!nodemailer) {
        unavailableReason = 'nodemailer 模块未安装';
    } else if (!smtpHost || !smtpUser || !smtpPass || !mailFromAddress) {
        unavailableReason = 'SMTP 配置不完整';
    } else {
        transporter = nodemailer.createTransport({
            host: smtpHost,
            port: smtpPort,
            secure: smtpSecure,
            auth: {
                user: smtpUser,
                pass: smtpPass
            }
        });
    }

    const canSend = Boolean(transporter);
    if (!canSend) {
        logger.warn(`[Mail] 邮件通知不可用: ${unavailableReason}`);
    } else {
        logger.log('[Mail] 邮件通知已启用（SMTP）');
    }

    const from = mailFromName ? `"${mailFromName.replace(/"/g, '')}" <${mailFromAddress}>` : mailFromAddress;

    const insertJob = async ({
        orderId,
        toEmail,
        eventKey,
        subject,
        html,
        text,
        status,
        attempts,
        nextRunAt,
        lastError
    }) => {
        await dbRun(
            `INSERT INTO email_jobs
             (orderId, toEmail, eventKey, subject, html, text, status, attempts, maxAttempts, nextRunAt, lastError)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                orderId,
                toEmail,
                eventKey,
                subject,
                html,
                text,
                status,
                attempts,
                maxAttempts,
                nextRunAt || toSqliteDateTime(new Date()),
                lastError || null
            ]
        );
    };

    const enqueueOrderEmail = async (eventKey, order) => {
        if (!serviceEnabled) return false;

        const orderId = String(order?.id || '').trim();
        const toEmail = String(order?.contact?.email || order?.contactEmail || '').trim();
        if (!orderId) return false;

        if (!EMAIL_EVENTS.has(eventKey)) {
            await insertJob({
                orderId,
                toEmail: toEmail || '-',
                eventKey,
                subject: '[春日商城] 通知任务创建失败',
                html: '<p>邮件事件类型不支持。</p>',
                text: '邮件事件类型不支持。',
                status: 'failed',
                attempts: 0,
                lastError: `unsupported eventKey: ${eventKey}`
            });
            logger.warn(`[Mail] unsupported eventKey: ${eventKey}`);
            return false;
        }

        if (!isValidEmail(toEmail)) {
            const built = buildOrderEmail({ eventKey, order, orderQueryUrl });
            await insertJob({
                orderId,
                toEmail: toEmail || '-',
                eventKey,
                subject: built.subject,
                html: built.html,
                text: built.text,
                status: 'failed',
                attempts: 0,
                lastError: 'invalid recipient email'
            });
            logger.warn(`[Mail] invalid recipient email for order ${orderId}: ${toEmail || '-'}`);
            return false;
        }

        const built = buildOrderEmail({ eventKey, order, orderQueryUrl });
        const createAsFailed = !canSend;
        await insertJob({
            orderId,
            toEmail,
            eventKey,
            subject: built.subject,
            html: built.html,
            text: built.text,
            status: createAsFailed ? 'failed' : 'pending',
            attempts: 0,
            lastError: createAsFailed ? unavailableReason : null
        });
        return !createAsFailed;
    };

    const sendMail = async (job) => {
        if (!canSend || !transporter) {
            const error = new Error(unavailableReason || 'mail service unavailable');
            error.nonRetryable = true;
            throw error;
        }

        const mailOptions = {
            from,
            to: String(job.toEmail || '').trim(),
            subject: String(job.subject || '').trim(),
            html: String(job.html || ''),
            text: String(job.text || '')
        };
        if (mailReplyTo) mailOptions.replyTo = mailReplyTo;

        await transporter.sendMail(mailOptions);
    };

    const computeNextRunAt = (attempts) => {
        const idx = Math.max(0, Math.min(retryBackoffs.length - 1, attempts - 1));
        const minutes = retryBackoffs[idx];
        return toSqliteDateTime(new Date(Date.now() + minutes * 60 * 1000));
    };

    const fetchDueJobs = async () =>
        dbAll(
            `SELECT * FROM email_jobs
             WHERE status = 'pending'
               AND DATETIME(nextRunAt) <= DATETIME('now')
             ORDER BY id ASC
             LIMIT ?`,
            [workerBatchSize]
        );

    const claimJob = async (jobId) =>
        dbRun(
            `UPDATE email_jobs
             SET status = 'processing',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?
               AND status = 'pending'`,
            [jobId]
        );

    const markSent = async (jobId) =>
        dbRun(
            `UPDATE email_jobs
             SET status = 'sent',
                 attempts = attempts + 1,
                 sentAt = CURRENT_TIMESTAMP,
                 lastError = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [jobId]
        );

    const markFailed = async (jobId, attempts, lastError) =>
        dbRun(
            `UPDATE email_jobs
             SET status = 'failed',
                 attempts = ?,
                 lastError = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [attempts, String(lastError || '').slice(0, 800), jobId]
        );

    const markRetry = async (jobId, attempts, nextRunAt, lastError) =>
        dbRun(
            `UPDATE email_jobs
             SET status = 'pending',
                 attempts = ?,
                 nextRunAt = ?,
                 lastError = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [attempts, nextRunAt, String(lastError || '').slice(0, 800), jobId]
        );

    const processOneJob = async (job) => {
        const attempts = Number(job.attempts || 0) + 1;
        const max = Number(job.maxAttempts || maxAttempts) > 0 ? Number(job.maxAttempts || maxAttempts) : maxAttempts;

        try {
            await sendMail(job);
            await markSent(job.id);
            logger.log(`[Mail] sent job#${job.id} event=${job.eventKey} order=${job.orderId}`);
        } catch (err) {
            const message = err?.message || String(err);
            if (err?.nonRetryable || attempts >= max) {
                await markFailed(job.id, attempts, message);
                logger.error(`[Mail] failed job#${job.id} event=${job.eventKey} order=${job.orderId}: ${message}`);
                return;
            }

            const nextRunAt = computeNextRunAt(attempts);
            await markRetry(job.id, attempts, nextRunAt, message);
            logger.warn(`[Mail] retry job#${job.id} attempts=${attempts}/${max} next=${nextRunAt}: ${message}`);
        }
    };

    let running = false;
    const processEmailJobs = async () => {
        if (running) return;
        running = true;
        try {
            const jobs = await fetchDueJobs();
            for (const job of jobs) {
                const claimResult = await claimJob(job.id);
                if (Number(claimResult?.changes) !== 1) continue;
                await processOneJob(job);
            }
        } catch (err) {
            logger.error(`[Mail] worker error: ${err?.message || err}`);
        } finally {
            running = false;
        }
    };

    let timer = null;
    const startWorker = () => {
        if (!serviceEnabled) return;
        if (timer) return;
        timer = setInterval(() => {
            processEmailJobs();
        }, workerIntervalMs);
        if (typeof timer.unref === 'function') timer.unref();
        processEmailJobs();
        logger.log(`[Mail] worker started, interval=${workerIntervalMs}ms, batch=${workerBatchSize}`);
    };

    const stopWorker = () => {
        if (!timer) return;
        clearInterval(timer);
        timer = null;
    };

    return {
        canSend,
        enqueueOrderEmail,
        processEmailJobs,
        startWorker,
        stopWorker
    };
};

module.exports = {
    createEmailService,
    buildOrderEmail
};
