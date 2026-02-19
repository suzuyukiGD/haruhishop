let nodemailer = null;
try {
    nodemailer = require('nodemailer');
} catch { }
const http = require('http');
const https = require('https');

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
    'order_confirmed',
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

const normalizeAuthMode = (value) => {
    const raw = String(value || '').trim().toLowerCase();
    if (['oauth2', 'oauth', 'xoauth2'].includes(raw)) return 'oauth2';
    if (['password', 'pass', 'basic', 'login'].includes(raw)) return 'password';
    return 'auto';
};

const normalizeMailProvider = (value) => {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'resend') return 'resend';
    if (raw === 'smtp') return 'smtp';
    return 'auto';
};

const normalizeResendApiBaseUrl = (value) => {
    const raw = String(value || 'https://api.resend.com').trim();
    if (!raw) return 'https://api.resend.com';
    return raw.replace(/\/+$/, '');
};

const postJson = (urlString, headers, payload) =>
    new Promise((resolve, reject) => {
        let parsedUrl;
        try {
            parsedUrl = new URL(urlString);
        } catch (err) {
            reject(err);
            return;
        }

        const body = JSON.stringify(payload || {});
        const transport = parsedUrl.protocol === 'https:' ? https : http;
        const requestOptions = {
            protocol: parsedUrl.protocol,
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                ...headers
            }
        };

        const req = transport.request(requestOptions, (res) => {
            let responseText = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                responseText += chunk;
            });
            res.on('end', () => {
                const status = Number(res.statusCode) || 0;
                resolve({
                    status,
                    ok: status >= 200 && status < 300,
                    bodyText: responseText
                });
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });

const statusTextByEvent = (eventKey, status) => {
    if (eventKey === 'order_created') return '待付款';
    if (eventKey === 'order_confirmed') return '待发货';
    if (eventKey === 'order_shipped') return '已发货';
    if (eventKey === 'order_completed') return '已完成';
    if (eventKey === 'order_cancelled') return '已取消';
    return ORDER_STATUS_LABELS[Number(status)] || '状态更新';
};

const titleTextByEvent = (eventKey) => {
    if (eventKey === 'order_created') return '订单已创建';
    if (eventKey === 'order_confirmed') return '订单已确认';
    if (eventKey === 'order_shipped') return '订单已发货';
    if (eventKey === 'order_completed') return '订单已完成';
    if (eventKey === 'order_cancelled') return '订单已取消';
    return '订单状态更新';
};

const descriptionTextByEvent = (eventKey) => {
    if (eventKey === 'order_created') return '我们已收到您的订单，请在24小时内完成支付。';
    if (eventKey === 'order_confirmed') return '您的支付已确认，订单已进入待发货状态，我们将尽快安排发货。';
    if (eventKey === 'order_shipped') return '您的订单已发货，请留意物流动态。';
    if (eventKey === 'order_completed') return '订单已完成，感谢您的支持。';
    if (eventKey === 'order_cancelled') return '因未验证到正确的支付状态，订单已取消，如有疑问可联系管理员。';
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

    const subject = `[春日商城] ${title}`;

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
    const mailProvider = normalizeMailProvider(options.mailProvider);
    const smtpHost = String(options.smtpHost || '').trim();
    const smtpPort = toPositiveInt(options.smtpPort, 465);
    const smtpSecure = toBoolean(options.smtpSecure, true);
    const smtpAuthMode = normalizeAuthMode(options.smtpAuthMode);
    const smtpUser = String(options.smtpUser || '').trim();
    const smtpPass = String(options.smtpPass || '').trim();
    const oauth2ClientId = String(options.oauth2ClientId || '').trim();
    const oauth2ClientSecret = String(options.oauth2ClientSecret || '').trim();
    const oauth2RefreshToken = String(options.oauth2RefreshToken || '').trim();
    const oauth2AccessToken = String(options.oauth2AccessToken || '').trim();
    const mailFromName = String(options.mailFromName || '春日商城').trim();
    const mailFromAddress = String(options.mailFromAddress || '').trim();
    const mailReplyTo = String(options.mailReplyTo || '').trim();
    const resendApiKey = String(options.resendApiKey || '').trim();
    const resendApiBaseUrl = normalizeResendApiBaseUrl(options.resendApiBaseUrl);
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
    let activeAuthMode = '';
    let activeProvider = '';
    let canSend = false;

    const resolveAuthConfig = () => {
        if (smtpAuthMode === 'oauth2') {
            if (oauth2AccessToken) {
                return {
                    mode: 'oauth2',
                    auth: {
                        type: 'OAuth2',
                        user: smtpUser,
                        accessToken: oauth2AccessToken
                    }
                };
            }

            if (oauth2ClientId && oauth2ClientSecret && oauth2RefreshToken) {
                return {
                    mode: 'oauth2',
                    auth: {
                        type: 'OAuth2',
                        user: smtpUser,
                        clientId: oauth2ClientId,
                        clientSecret: oauth2ClientSecret,
                        refreshToken: oauth2RefreshToken
                    }
                };
            }

            return {
                mode: 'oauth2',
                auth: null,
                reason: 'OAuth2 配置不完整（需 accessToken，或 clientId+clientSecret+refreshToken）'
            };
        }

        if (smtpAuthMode === 'password') {
            if (smtpPass) {
                return {
                    mode: 'password',
                    auth: {
                        user: smtpUser,
                        pass: smtpPass
                    }
                };
            }
            return { mode: 'password', auth: null, reason: 'SMTP_PASS 未配置' };
        }

        if (oauth2AccessToken) {
            return {
                mode: 'oauth2',
                auth: {
                    type: 'OAuth2',
                    user: smtpUser,
                    accessToken: oauth2AccessToken
                }
            };
        }

        if (oauth2ClientId && oauth2ClientSecret && oauth2RefreshToken) {
            return {
                mode: 'oauth2',
                auth: {
                    type: 'OAuth2',
                    user: smtpUser,
                    clientId: oauth2ClientId,
                    clientSecret: oauth2ClientSecret,
                    refreshToken: oauth2RefreshToken
                }
            };
        }

        if (smtpPass) {
            return {
                mode: 'password',
                auth: {
                    user: smtpUser,
                    pass: smtpPass
                }
            };
        }

        return { mode: 'auto', auth: null, reason: '未配置可用的 SMTP 鉴权信息' };
    };

    const resolveProvider = () => {
        if (mailProvider === 'resend') return 'resend';
        if (mailProvider === 'smtp') return 'smtp';
        if (resendApiKey) return 'resend';
        return 'smtp';
    };

    const providerToUse = resolveProvider();

    if (!serviceEnabled) {
        unavailableReason = 'EMAIL_NOTIFICATIONS_ENABLED=false';
    } else if (!mailFromAddress) {
        unavailableReason = 'MAIL_FROM_ADDRESS 未配置';
    } else if (providerToUse === 'resend') {
        if (!resendApiKey) {
            unavailableReason = 'Resend 配置不完整（需 RESEND_API_KEY）';
        } else {
            activeProvider = 'resend';
            canSend = true;
        }
    } else {
        if (!nodemailer) {
            unavailableReason = 'nodemailer 模块未安装';
        } else if (!smtpHost || !smtpUser) {
            unavailableReason = 'SMTP 基础配置不完整（需 SMTP_HOST、SMTP_USER）';
        } else {
            const authConfig = resolveAuthConfig();
            if (!authConfig.auth) {
                unavailableReason = authConfig.reason || 'SMTP 鉴权配置不完整';
            } else {
                activeProvider = 'smtp';
                activeAuthMode = authConfig.mode;
                transporter = nodemailer.createTransport({
                    host: smtpHost,
                    port: smtpPort,
                    secure: smtpSecure,
                    auth: authConfig.auth
                });
                canSend = true;
            }
        }
    }

    if (!canSend) {
        logger.warn(`[Mail] 邮件通知不可用: ${unavailableReason}`);
    } else if (activeProvider === 'resend') {
        logger.log('[Mail] 邮件通知已启用（Resend API）');
    } else {
        logger.log(`[Mail] 邮件通知已启用（SMTP, auth=${activeAuthMode || smtpAuthMode || 'unknown'}）`);
    }

    const from = mailFromName ? `"${mailFromName.replace(/"/g, '')}" <${mailFromAddress}>` : mailFromAddress;

    const sendMailViaSmtp = async (job) => {
        if (!transporter) {
            const error = new Error('SMTP transporter unavailable');
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

    const sendMailViaResend = async (job) => {
        const payload = {
            from,
            to: String(job.toEmail || '').trim(),
            subject: String(job.subject || '').trim(),
            html: String(job.html || ''),
            text: String(job.text || '')
        };
        if (mailReplyTo) payload.reply_to = mailReplyTo;

        let responseInfo = null;
        if (typeof fetch === 'function') {
            const response = await fetch(`${resendApiBaseUrl}/emails`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${resendApiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            responseInfo = {
                status: Number(response.status) || 0,
                ok: response.ok,
                bodyText: await response.text().catch(() => '')
            };
        } else {
            responseInfo = await postJson(
                `${resendApiBaseUrl}/emails`,
                {
                    Authorization: `Bearer ${resendApiKey}`
                },
                payload
            );
        }

        if (responseInfo.ok) return;

        const detail = responseInfo.bodyText ? ` - ${responseInfo.bodyText}` : '';
        const error = new Error(`Resend API 请求失败(${responseInfo.status})${detail}`);
        if (responseInfo.status >= 400 && responseInfo.status < 500 && responseInfo.status !== 429) {
            error.nonRetryable = true;
        }
        throw error;
    };

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
        if (!canSend) {
            const error = new Error(unavailableReason || 'mail service unavailable');
            error.nonRetryable = true;
            throw error;
        }

        if (activeProvider === 'resend') {
            await sendMailViaResend(job);
            return;
        }

        await sendMailViaSmtp(job);
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
