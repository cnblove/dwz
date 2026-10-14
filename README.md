# dwz · 短链与私域活码

跑在 Cloudflare 上的短链 / 活码系统：**Workers 承担 API 与跳转，Pages 承担管理后台，D1 存数据，KV 做缓存**。
不依赖任何服务器，免费额度内即可支撑日常私域推广。

## 功能

| 模块 | 能力 |
| --- | --- |
| 短链 | 自定义或随机 key、按设备分流（iOS / Android / 桌面）、访问限制（微信 / 手机 / 电脑）、有效期与过期跳转、入口域名轮询、访问统计 |
| 活码 | 群活码按阈值轮换多张群二维码；访客去重（同一人固定看同一张）；子码全部触顶后可回落到兜底客服码 |
| 客服码 | 阈值 / 随机两种选取模式；展示客服微信号并一键复制；按周配置在线时段并展示在线状态 |
| 渠道码 | 短链 + 来源归因，按 App / 操作系统聚合访问数据，支持按 IP 封禁访客 |
| 域名 | 入口 / 落地 / 短链 / 备用四类域名池，支持可用性探测 |
| 开放 API | HMAC-SHA256 签名，配额与 IP 白名单，可外部创建短链、查询统计 |
| 账号 | 超管 / 成员两级角色，用户组可控制后台可见页面，登录会话、改密踢线、操作审计 |

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
- `api_credentials` / `audit_logs` / `assets`

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

# 5) 起本地开发
npm run dev                     # Worker 于 :8788
npm run dev:web                 # 后台 于 :5173，已配好 /api 代理
```

首次打开后台会引导创建管理员账号 —— **第一个注册的账号自动成为超级管理员**，之后注册入口即关闭，只能由超管在「账号」页添加成员。

### 部署

```bash
# API
npx wrangler deploy --config packages/worker/wrangler.toml

# 后台
npm run build:web
npx wrangler pages deploy packages/web/dist --project-name dwz
```

部署后把 `wrangler.toml` 里的 `WEB_ORIGIN` / `SHORT_ORIGIN` 改成 Pages 域名（两者可以相同，实现同域部署）。

> 想让短链和后台同域（`https://你的域名/abc123` 既是短链又是后台）：
> 把 Pages 项目设为 Worker 的 route 前置，或直接在 Pages 上挂 `_routes.json` 把 `/{slug}` 转发给 Worker。

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

## 测试

```bash
npm test          # 57 项：单元 + 接口集成（真实 SQLite 跑迁移）
npm run typecheck # 类型检查
```

测试直接用 `node:sqlite` 对迁移脚本建库，不 mock 数据层 —— 迁移写错会立刻在测试里暴露。

## 目录

```
packages/
├── worker/
│   ├── migrations/           D1 迁移
│   ├── src/
│   │   ├── lib/              加密、时间、UA、统计、校验等基础能力
│   │   ├── domain/           短链/活码/渠道码的解析与落地页渲染
│   │   ├── routes/           各资源的接口实现
│   │   └── index.js          路由入口
│   └── test/
└── web/                     管理后台（Vite + 原生 DOM，无框架运行时依赖）
```

## 设计取舍

- **零前端依赖**：管理后台只用了 Vite 做打包，运行时没有 React/Vue。产物 gzip 后约 10 KB。
- **服务端渲染落地页**：访客的第一跳不能等 JS，否则微信里会白屏。
- **访客 IP 只存哈希**：统计只需要「同一天是不是同一个人」，不需要原文，因此落库前统一加盐哈希，且盐存在 Worker secret 里。
- **强签名替代明文摘要**：开放 API 用 HMAC-SHA256 而不是「字段拼接后 MD5」，避免长度扩展与彩虹表。
- **热点计数直接打宿主表**：跳转路径上不做多轮写库，小时维度与去重访客异步落表（`ctx.waitUntil`），统计失败不影响跳转。

## 净室开发声明

本项目采用净室（clean room）模式开发。

- 参考对象 [likeyun/liKeYun_ylb](https://github.com/likeyun/liKeYun_ylb) 仅用于**确认功能边界与用户预期**：这个领域有哪些模块、每个模块要解决什么问题。
- 其 PHP / jQuery 代码、数据库表名前缀（`huoma_*`、`ylb_*`）、字段命名、页面文案、样式与目录结构**均未被复制或改写**。
- 本项目的技术栈（Cloudflare Workers / Pages / D1 / KV）、数据模型、接口设计、页面结构与实现代码全部独立完成。
- 目标行为一致，实现互不派生。因此本项目与参考项目不存在代码层面的继承关系，仅为同一问题域下的独立实现。

## 许可

MIT
