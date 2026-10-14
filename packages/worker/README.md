# @dwz/worker

Worker 侧实现：跳转、后台 API、开放接口，以及访客落地页。

## 路由

| 路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查 |
| `GET /{slug}` | 短链 / 活码 / 渠道码跳转（含落地页） |
| `GET /report/longpress?zm_id=` | 子码长按计数上报 |
| `POST /api/cardkeys/redeem` | 卡密兑换（公开，无需登录，按 IP 每日限流） |
| `/api/**` | 后台接口（需登录，`Authorization: Bearer <token>` 或会话 Cookie） |
| `/open/v1/**` | 开放接口（HMAC 签名） |
| `scheduled`（Cron） | 定时巡检：域名可达性 + 卡密库存，异常经通知渠道告警 |

跳转按 **短链 → 活码 → 渠道码** 顺序命中，三者共用一个 slug 命名空间。

## 模块

- `lib/` —— 与业务无关的基础能力
  - `crypto.js` PBKDF2 口令哈希、常量时间比较、随机令牌
  - `auth.js` 会话签发与校验、登录
  - `ua.js` 设备 / 来源 App 识别、访问限制判定、按设备挑分流目标
  - `stats.js` 访问计数与聚合查询
  - `time.js` 北京时间口径的日期 / 小时 / 在线时段判断
  - `visitor.js` 访客 IP 单向哈希
  - `keys.js` slug 生成
  - `notify.js` 通知渠道发送（Webhook / 邮件 / Bark / 企微 / 方糖），从不抛错
  - `validate.js` 入参校验（含 URL 协议白名单）
- `domain/resolve.js` —— 三类资源的解析逻辑与计数
- `domain/pages.js` —— 访客侧 HTML（服务端渲染）
- `domain/inspection.js` —— Cron 巡检与巡检日志查询
- `routes/` —— 各资源的 HTTP 接口（含 `cardkeys.js`、`notify.js`）

## 约定

- 统一响应 `{code, msg, ...}`；`code` 与 HTTP 状态码同值。
- 校验失败抛 `AppError`，由 `index.js` 统一转成响应，不在业务代码里手写 400。
- 跳转路径上的计数一律走 `ctx.waitUntil`，统计异常不得影响跳转。

## 环境变量

| 名称 | 说明 |
| --- | --- |
| `WEB_ORIGIN` | 后台站点地址，用于 CORS 白名单（多个用逗号分隔） |
| `SHORT_ORIGIN` | 短链域名，用于后台展示与轮询跳转拼接 |
| `DEFAULT_KEY_LENGTH` | 随机 slug 默认长度（4~12） |
| `VISITOR_SALT` | 访客哈希盐，**生产必须用 secret 覆盖** |

绑定：`DB`（D1）、`CACHE`（KV）。

定时任务：`wrangler.toml` 的 `[triggers] crons = ["*/30 * * * *"]`，每 30 分钟巡检一次。
本地手动触发：`curl "http://localhost:8788/cdn-cgi/handler/scheduled"`。

## 迁移

`migrations/` 下的 SQL 按文件名顺序执行，新增能力一律追加新文件，不改历史文件：

- `0001_init.sql` —— 账号、短链、活码、渠道码、域名、统计、通知渠道、开放 API、审计
- `0002_cardkeys_and_inspection.sql` —— 卡密批次 / 卡密 / 兑换记录、巡检日志
