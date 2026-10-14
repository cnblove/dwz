# @dwz/worker

Worker 侧实现：跳转、后台 API、开放接口，以及访客落地页。

## 路由

| 路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查 |
| `GET /{slug}` | 短链 / 活码 / 渠道码跳转（含落地页） |
| `GET /report/longpress?zm_id=` | 子码长按计数上报 |
| `/api/**` | 后台接口（需登录，`Authorization: Bearer <token>` 或会话 Cookie） |
| `/open/v1/**` | 开放接口（HMAC 签名） |

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
  - `validate.js` 入参校验（含 URL 协议白名单）
- `domain/resolve.js` —— 三类资源的解析逻辑与计数
- `domain/pages.js` —— 访客侧 HTML（服务端渲染）
- `routes/` —— 各资源的 HTTP 接口

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
