# dwz · 短链与私域活码

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cnblove/dwz)

> 一键部署（需仓库有 GitHub 镜像），或看 [详细部署教程](docs/DEPLOY.md) —— 含 wrangler 手动部署与 CNB 流水线部署。

跑在 Cloudflare 上的短链 / 活码系统：**Workers（Hono）承担 API 与跳转，Pages 承担管理后台，D1 存数据，KV 做缓存**。
不依赖任何服务器，免费额度内即可支撑日常私域推广。

## 功能

| 模块 | 能力 |
| --- | --- |
| 短链 | 自定义或随机 key、按设备分流（iOS / Android / 桌面）、访问限制（微信 / 手机 / 电脑）、有效期与过期跳转、入口域名轮询、访问统计 |
| 活码 | 群活码按阈值轮换多张群二维码；访客去重（同一人固定看同一张）；子码全部触顶后可回落到兜底客服码 |
| 客服码 | 阈值 / 随机两种选取模式；展示客服微信号并一键复制；按周配置在线时段并展示在线状态 |
| 渠道码 | 短链 + 来源归因，按 App / 操作系统聚合访问数据，支持按 IP 封禁访客 |
| 域名 | 入口 / 落地 / 短链 / 备用四类域名池，支持可用性探测 |
| 卡密 | 批次化生成、明文只出一次（库存哈希）、公开兑换接口、按 IP 每日限流、库存阈值告警 |
| 通知渠道 | Webhook / 邮件 / Bark / 企业微信 / 方糖，统一消息体，支持测试发送 |
| 定时巡检 | Cloudflare Cron 每 30 分钟检查域名可达性与卡密库存，异常经通知渠道告警，结果可回溯 |
| 开放 API | HMAC-SHA256 签名，配额与 IP 白名单，可外部创建短链、查询统计 |
| 账号 | 超管 / 成员两级角色，用户组可控制后台可见页面，登录会话、改密踢线、操作审计 |
| 素材库 | 二维码与图片集中托管，活码子码直接从素材库选取，避免到处粘 URL |

访问限制、过期拦截、阈值轮换这些判断全部在**服务端**完成，不依赖前端 JS —— 微信内置浏览器里不会出现白屏或二次跳转。

## 架构

```
浏览器 ──► Pages (管理后台 SPA)  ──/api/*──► Worker (API + 跳转 + 落地页)
                                               │
                                               ├─► D1     业务数据与统计
                                               └─► KV     短时缓存
```

- **Worker** 一个入口同时处理三类请求：`/{slug}` 跳转、`/api/*` 后台接口、`/open/*` 开放接口。
- **Pages** 只放管理后台；访客看到的跳转与落地页由 Worker 直接输出 HTML。
- 短链、活码、渠道码**共用同一个 slug 命名空间**，跳转时按 短链 → 活码 → 渠道码 的顺序命中。

### 数据模型

核心表（完整定义见 `packages/worker/migrations/0001_init.sql`）：

- `users` / `user_groups` / `sessions` —— 账号、授权页面、登录会话（令牌只存哈希）
- `short_links` —— 短链
- `codes` / `code_qrcodes` / `code_merges` —— 活码宿主、子码、并流关系
- `channels` / `channel_visits` / `channel_blocks` —— 渠道码与来源归因
- `domains` / `domain_checks` —— 域名池与巡检
- `hourly_stats` / `daily_visitors` / `daily_counters` —— 统计聚合
- `cardkey_batches` / `cardkeys` / `cardkey_redeems` —— 卡密批次、卡密（只存哈希）、兑换记录
- `notify_channels` / `inspection_logs` —— 通知渠道与巡检日志
- `api_credentials` / `audit_logs` / `assets`
- `short_slugs` —— 短链 / 活码 / 渠道码共用的 slug 命名空间（唯一性由数据库兜底）

## 快速开始

```bash
npm install

# 1) 建 D1 数据库，把输出的 database_id 填进 packages/worker/wrangler.toml
npx wrangler d1 create dwz

# 2) 建 KV 命名空间，同样填入 id
npx wrangler kv namespace create CACHE

# 3) 应用迁移
npm run migrate:remote          # 线上
npm run migrate:local           # 本地

# 4) 设置访客哈希盐（生产必做）
npx wrangler secret put VISITOR_SALT --config packages/worker/wrangler.toml

# 5) 部署后会按 wrangler.toml 的 triggers 每 30 分钟巡检一次
#    本地想手动跑一次：curl "http://localhost:8788/cdn-cgi/handler/scheduled"

# 6) 起本地开发
npm run dev                     # Worker 于 :8788
npm run dev:web                 # 后台 于 :5173，已配好 /api 代理
```

首次打开后台会引导创建管理员账号 —— **第一个注册的账号自动成为超级管理员**，之后注册入口即关闭，只能由超管在「账号」页添加成员。

### 部署

三条路，任选一条：

1. **一键部署** —— 点顶部的 `Deploy to Cloudflare` 按钮，向导里建 D1 / KV 并绑定，再补 `VISITOR_SALT` 与域名变量。
2. **手动 wrangler** —— 见下方命令。
3. **CNB 流水线** —— 打 Tag 或页面上点部署按钮。

```bash
# API（同时注册 wrangler.toml 中 triggers.crons 的定时任务）
npx wrangler deploy --config packages/worker/wrangler.toml

# 后台
npm run build:web
npx wrangler pages deploy packages/web/dist --project-name dwz
```

部署后把 `wrangler.toml` 里的 `WEB_ORIGIN` / `SHORT_ORIGIN` 改成 Pages 域名（两者可以相同，实现同域部署）。

> 想让短链和后台同域（`https://你的域名/abc123` 既是短链又是后台）：
> 把 Pages 项目设为 Worker 的 route 前置，或直接在 Pages 上挂 `_routes.json` 把 `/{slug}` 转发给 Worker。

**完整部署教程（含一键部署向导、自定义域名、常见排错）：[docs/DEPLOY.md](docs/DEPLOY.md)**

## 开放 API

签名算法：

```
sign = HMAC-SHA256(api_secret, "{标题}|{访问限制}|{目标链接}|{apiKey}|{apiSecret}")  // hex
```

创建短链：

```bash
curl -X POST https://你的域名/open/v1/short-links \
  -H 'content-type: application/json' \
  -d '{
    "dwz_title": "双十一活动",
    "dwz_type": "any",
    "dwz_url": "https://example.com/act",
    "api_key": "dwz_xxxxxxxxxxxxxxxx",
    "sign": "<按上式计算的签名>"
  }'
```

`/open/v1/stats` 用同样的签名查询自己创建的短链统计。配额与 IP 白名单在后台「设置」页配置。

## 卡密兑换

后台「卡密」页按批次生成，卡密明文**只在生成时返回一次**，库里只存 SHA-256 哈希。
兑换接口不需要登录，但同一 IP 每天最多兑换 5 次：

```bash
curl -X POST https://你的域名/api/cardkeys/redeem \
  -H 'content-type: application/json' \
  -d '{"code": "DWZ-XXXXXXXX-XXXXXXXX-XXXXXXXX"}'
```

兑换成功返回批次内容与可选跳转地址；卡密只能被使用一次，重复提交会被拒绝。

## 定时巡检

`wrangler.toml` 里配了 `crons = ["*/30 * * * *"]`，每 30 分钟触发一次巡检：

- **域名**：在「域名」页开启开关后，逐个探测入口/落地/短链域名，不可达时经指定通知渠道告警；
- **卡密库存**：批次剩余量低于设定阈值时告警。

结果写入 `inspection_logs`，可在后台「巡检日志」页按类型筛选查看，也能点「立即巡检」手动触发。
通知发送失败不会让巡检任务失败 —— 日志里能看到记录，通知是尽力而为的旁路能力。

## 测试

```bash
npm test          # 91 项：单元 + 接口集成（真实 SQLite 跑迁移）
npm run typecheck # 类型检查
```

测试直接用 `node:sqlite` 对迁移脚本建库，不 mock 数据层 —— 迁移写错会立刻在测试里暴露。
巡检与通知的外部依赖（fetch）在测试里注入替身，因此不需要外网也能覆盖失败分支。

## 目录

```
packages/
├── worker/
│   ├── migrations/           D1 迁移
│   ├── src/
│   │   ├── lib/              加密、时间、UA、统计、通知、校验等基础能力
│   │   ├── domain/           短链/活码/渠道码的解析、落地页渲染与定时巡检
│   │   ├── routes/           各资源的业务实现 + Hono 子应用（api / open）
│   │   ├── app.js            Hono 应用装配：中间件 + 路由注册
│   │   └── index.js          Worker 入口（HTTP + Cron 调度）
│   └── test/
└── web/                     管理后台（Vite + 原生 DOM，无框架运行时依赖）
```

## 设计取舍

- **零前端依赖**：管理后台只用了 Vite 做打包，运行时没有 React/Vue。产物 gzip 后约 10 KB。
- **后端只上一个框架**：路由交给 Hono，业务逻辑仍按资源拆在 `routes/*.js` 里，handler 不感知框架；鉴权、CORS、错误归一都收敛成中间件，避免每个 handler 重复解会话。
- **服务端渲染落地页**：访客的第一跳不能等 JS，否则微信里会白屏。
- **访客 IP 只存哈希**：统计只需要「同一天是不是同一个人」，不需要原文，因此落库前统一加盐哈希，且盐存在 Worker secret 里。
- **强签名替代明文摘要**：开放 API 用 HMAC-SHA256 而不是「字段拼接后 MD5」，避免长度扩展与彩虹表。
- **slug 用 UUID v4**：短链 key 公开在 URL 上，必须不可枚举 —— 参考实现用固定长度随机串，我们直接上 128 位随机值，并且不允许自定义 key 绕开随机性。
- **命名空间唯一性交给数据库**：三类资源共用一个 slug 空间，靠 `INSERT OR IGNORE` + UNIQUE 保证；「先查后插」在并发创建下会漏，两个请求会同时认为没人占用。
- **计数一律原子自增**：`hits` / `hits_today` / 子码阈值计数都用单条 `UPDATE ... SET x = x + 1`。读改写会丢计数，而丢计数会直接让阈值轮换提前切码。
- **降级路径必须存在**：轮询域名池为空或候选域名探测失败时，回退到备用/入口域名继续跳转，而不是把访客留在错误页。
- **热点计数直接打宿主表**：跳转路径上不做多轮写库，小时维度与去重访客异步落表（`ctx.waitUntil`），统计失败不影响跳转。
- **卡密明文不落库**：只存 SHA-256 哈希，明文仅在生成时返回一次。与登录令牌同样的理由 —— 库被拖走不等于卡密被拖走。
- **兑换靠状态机而非先查后写**：`UPDATE … WHERE status='unused'` 的受影响行数决定成败，天然避免并发下超发。
- **通知是尽力而为**：任何渠道发送失败都不抛错、不重试、不影响主流程，只在巡检日志里留痕。巡检本身失败也只记录，不让 Cron 任务挂掉。
- **渠道配置按类型收敛字段**：Webhook / 企微 / Bark / 方糖 / 邮件各有自己的字段，入库前统一校验，避免脏配置写到线上才发现。

## 净室开发声明

本项目采用净室（clean room）模式开发。参考对象 [likeyun/liKeYun_ylb](https://github.com/likeyun/liKeYun_ylb)
是同一问题域下的 PHP 实现；我们只读它的**行为**，不抄它的**代码**。具体边界：

**只观察行为，不取用产物**

- 参考对象的信息来源仅限：在线文档与仓库内 README / 用户可见页面所描述的功能清单、参数语义（例如开放接口的 `dwz_title` / `dwz_type` / `dwz_dlws` 这些**对外契约**需要兼容，属于接口约定而非实现），以及运行时的可观察行为。
- 其 PHP / jQuery 源码、类与方法命名、`huoma_*` / `ylb_*` 表名前缀与字段名、页面文案、CSS、目录结构，**均未被复制或改写**。
- 参考对象采用的是**另一条技术路线**：多阶段 PHP 页面 + 302 重定向 + 前端 JS 跳转。我们的实现里没有这些环节 —— 落地页由 Worker 服务端直出 HTML，跳转首选 `Response.redirect`，路径上不需要 JS 参与。

**独立完成的部分**

- 技术栈（Cloudflare Workers + Hono / Pages / D1 / KV）、数据模型、接口设计、页面结构、构建方式与测试方式全部自建。
- 功能边界内的行为等价，实现互不派生（例如同为「阈值轮换」，参考对象用「读旧值再写回」，我们用单条原子 `UPDATE`；同一时间只命中一张子码的语义一致，实现不同）。

**可复核的独立性**

- 仓库内不存在参考对象的任何源码文件、表名前缀或页面文案。
- 行为对齐项与实现差异都记录在上文的功能表与「设计取舍」里，可逐条对照。
- 落地差异（如换成服务端渲染、UUID 标识、HMAC 签名）都标注了原因，而不是无差别改名。

## 许可

MIT
