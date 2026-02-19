# Spring Day Shop

## 本地运行

```bash
npm install
cp .env.example .env
# 编辑 .env
npm run start
```

默认配置：
- 前端挂载路径：`/shop/`
- 后端 API 前缀：`/shop-api`

## 环境变量

```bash
ADMIN_USERNAME=your-admin-user
ADMIN_PASSWORD=your-strong-password
ADMIN_AUTH_SECRET=replace-with-a-long-random-secret
ADMIN_TOKEN_TTL_SECONDS=86400
FREE_SHIPPING_THRESHOLD=150

API_PREFIX=/shop-api
VITE_BASE_PATH=/shop/
VITE_API_BASE=/shop-api
VITE_DEV_API_TARGET=http://localhost:13221

# 订单状态邮件通知（SMTP）
EMAIL_NOTIFICATIONS_ENABLED=false
SMTP_HOST=
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=
SMTP_PASS=
MAIL_FROM_NAME=春日商城
MAIL_FROM_ADDRESS=notify@example.com
MAIL_REPLY_TO=service@example.com
MAIL_MAX_ATTEMPTS=5
MAIL_RETRY_BACKOFFS_MINUTES=1,5,15,60,180
MAIL_WORKER_INTERVAL_MS=10000
MAIL_WORKER_BATCH_SIZE=20
PUBLIC_SITE_URL=https://haruyuki.cn
MAIL_ORDER_QUERY_URL=
```

说明：
- 生产环境(`NODE_ENV=production`)下，未配置 `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_AUTH_SECRET` 会拒绝启动。
- `API_PREFIX` 与 `VITE_API_BASE` 必须保持一致。
- `VITE_BASE_PATH` 末尾必须带 `/`，例如 `/shop/`。
- `FREE_SHIPPING_THRESHOLD` 为包邮门槛（元），默认 `150`。
- 邮件通知默认关闭，设置 `EMAIL_NOTIFICATIONS_ENABLED=true` 后生效。
- 推荐同时配置 `PUBLIC_SITE_URL`，邮件内会自动生成“订单查询”入口链接；若需自定义可设置 `MAIL_ORDER_QUERY_URL`。

## 生产构建

```bash
npm run build
```

构建产物在 `dist/`，应通过反向代理挂到 `/shop/`。

## Nginx 示例（/shop + /shop-api）

```nginx
# 前端静态资源
location ^~ /shop/ {
    alias /var/www/haruhishop/dist/;
    try_files $uri $uri/ /shop/index.html;
}

# 后端 API（Node 13221）
location ^~ /shop-api/ {
    proxy_pass http://127.0.0.1:13221/shop-api/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```
