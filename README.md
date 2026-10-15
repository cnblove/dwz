# dwz · 短链与私域活码

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cnblove/dwz)

**仓库地址**

- CNB（主仓库）：<https://cnb.cool/cnblove/dwz>
- GitHub（镜像）：<https://github.com/cnblove/dwz>

代码同时托管在 CNB 与 GitHub 上：CNB 是主要的开发与流水线平台，GitHub 用作镜像与一键部署入口。

> 一键部署（需仓库有 GitHub 镜像），或看 [详细部署教程](docs/DEPLOY.md) —— 含 wrangler 手动部署与 CNB 流水线部署。

跑在 Cloudflare 上的短链 / 活码系统：**全栈一个 Worker（Hono + 静态资源绑定），D1 存数据，KV 做缓存**。
不依赖任何服务器，免费额度内即可支撑日常私域推广。

## 演示

线上演示环境：**<https://dwz-api.1007479270.workers.dev>**

- 后台入口就是根路径 `/`，登录后可看到概览、短链、活码、渠道码、卡密等全部页面
- 短链形如 `https://dwz-api.1007479270.workers.dev/{slug}`，与后台同域
- 兑换页：`https://dwz-api.1007479270.workers.dev/redeem`

演示环境的数据随时可能被清空，仅供功能预览，不要放真实业务。

### 后台截图

| 概览 | 短链 |
| --- | --- |
| ![后台概览](docs/images/dashboard.png) | ![短链管理](docs/images/short-links.png) |

| 活码与客服码 | 渠道码 |
| --- | --- |
| ![活码与客服码](docs/images/codes.png) | ![渠道码](docs/images/channels.png) |

| 卡密 | 素材库 |
| --- | --- |
| ![卡密](docs/images/cardkeys.png) | ![素材库](docs/images/assets.png) |

| 域名 | 通知渠道 |
| --- | --- |
| ![域名](docs/images/domains.png) | ![通知渠道](docs/images/notify-channels.png) |

| 巡检日志 | 用户组 |
| --- | --- |
| ![巡检日志](docs/images/inspection.png) | ![用户组](docs/images/groups.png) |

| 账号管理 | 开放接口（API Key） |
| --- | --- |
| ![账号管理](docs/images/users.png) | ![开放接口](docs/images/api-keys.png) |

登录页：

![登录页](docs/images/login.png)

截图取自本地 `npm run dev` 起的完整环境（存了演示数据），与线上演示站同一套代码。

## 功能

| 模块 | 能力 |
| --- | --- |
| 短链 | 自定义或随机 key、按设备分流（iOS / Android / 桌面）、访问限制（微信 / 手机 / 电脑）、有效期与过期跳转、入口域名轮询、访问统计 |
| 活码 | 群活码按阈值轮换多张群二维码；访客去重（同一人固定看同一张）；子码全部触顶后可回落到兜底客服码 |
| 客服码 | 阈值 / 随机两种选取模式；展示客服微信号并一键复制；按周配置在线时段并展示在线状态 |
| 渠道码 | 短链 + 来源归因，按 App / 操作系统聚合访问数据，支持按 IP 封禁访客 |
| 域名 | 入口 / 落地 / 短链 / 备用四类域名池，支持可用性探测 |
| 卡密 | 批次化生成、明文只出一次（库存哈希）、公开兑换接口、按 IP 每日限流、库存阈值告警 |
| 通知渠道 | Webhook / 邮件 / Bark / 企业微信 / 方糖 / PushPlus，统一消息体，支持测试发送 |
| 定时巡检 | Cloudflare Cron 每 30 分钟检查域名可达性与卡密库存，异常经通知渠道告警，结果可回溯 |
| 开放 API | HMAC-SHA256 签名 + `dv1_*` 版本化契约；**后台能点的都能调**：三类码增删改查、活码子码、访问分析、域名 / 卡密 / 素材 / 通知 / 用户 / 巡检，还能用 API 自助发 Key；自带 AI skill |
| 账号 | 超管 / 成员两级角色，用户组可控制后台可见页面与**创建配额**（短链 / 活码 / 子码 / 渠道码 / 素材，留空 = 不限额），登录会话、改密踢线、操作审计 |
| 素材库 | 图片上传到 Cloudflare R2 集中托管，列表可复制链接，活码子码可直接从素材库选取，避免到处粘外链 |

访问限制、过期拦截、阈值轮换这些判断全部在**服务端**完成，不依赖前端 JS —— 微信内置浏览器里不会出现白屏或二次跳转。

后台是**响应式**的：手机、平板、桌面同一套页面，窄屏把侧边导航收成顶栏、表格转成卡片、
弹窗按钮竖排铺开，320px 到 2560px 都不会出现横向滚动。手机上换码、看数据不用再开电脑。

### 成员创建配额

配额配在**用户组**上（不是逐个账号），有五类资源各自的上限：短链、活码、子码、渠道码、素材。
留空表示不限额 —— 空和不限是一回事，不用填一个「大到像没限制」的数字。

两条口径值得说清楚：

- **只对成员生效，超管不受限。** 超管是兜底账号，把限制也压在它身上，
  配错一个 `0` 就会让整个后台再也建不出东西，而且没有第二个人能改回来。
- **算的是「该成员名下现有多少」，不是「累计建过多少」。** 所以删掉一条就腾出一个位置。
  否则总量满了就成了死局：谁都不能再建，也没人知道该删谁的。

改了配额立即生效，组内成员不用重新登录。参考项目的运营同学提的正是这条
（「限制成员能创建多少群码，要不然无脑创建很容易死」）。

## 架构

```
浏览器 ──► Worker (dwz-api)
             ├─ 静态资源（管理后台 SPA，assets 绑定）
             ├─ /{slug} 跳转与落地页（服务端直出 HTML）
             ├─ /api/* 后台接口、/open/* 开放接口
             ├─ /media/{key} 素材回源（从 R2 读出）
             ├─► D1     业务数据与统计
             ├─► KV     短时缓存
             └─► R2     素材图片对象
```

- **一个 Worker 干完所有事**：静态资源、跳转、接口、Cron 巡检都在同一个 Worker 里，不需要 Pages。
- 后台与短链**天然同域**：`https://你的域名/` 是后台，`https://你的域名/abc123` 是短链。
- 短链、活码、渠道码**共用同一个 slug 命名空间**，跳转时按 短链 → 活码 → 渠道码 的顺序命中。

> 后台路由是固定的一张表（见 `packages/worker/src/lib/assets.js`），Worker 靠它区分
> 「这是后台页面」与「这是短链 key」—— 两者都是不带扩展名的单段路径，平台层分不清。

### 数据模型

核心表（完整定义见 `packages/worker/migrations/0001_init.sql`）：

- `users` / `user_groups` / `sessions` —— 账号、授权页面、登录会话（令牌只存哈希）
- `short_links` —— 短链
- `codes` / `code_qrcodes` / `code_merges` —— 活码宿主、子码、并流关系
- `channels` / `channel_visits` / `channel_blocks` —— 渠道码与来源归因
- `domains` / `domain_checks` —— 域名池与巡检
- `hourly_stats` / `daily_visitors` / `daily_counters` —— 统计聚合
- `visit_logs` —— 最近访客明细（保留原始 IP，按天滚动清理，默认 7 天）
- `cardkey_batches` / `cardkeys` / `cardkey_redeems` —— 卡密批次、卡密（只存哈希）、兑换记录
- `notify_channels` / `inspection_logs` —— 通知渠道与巡检日志
- `api_credentials` / `audit_logs` —— 开放接口凭证与操作审计
- `assets` —— 素材库元数据（文件本体在 R2，库内只存 `object_key`）
- `short_slugs` —— 短链 / 活码 / 渠道码共用的 slug 命名空间（唯一性由数据库兜底）

## 快速开始

```bash
npm install

# 1) 建 D1 数据库，把输出的 database_id 填进 packages/worker/wrangler.toml
npx wrangler d1 create dwz

# 2) 建 KV 命名空间，同样填入 id
npx wrangler kv namespace create CACHE

# 2.5) 建 R2 桶（素材库用，绑定名固定为 MEDIA）
npx wrangler r2 bucket create dwz-media

# 3) 应用迁移
npm run migrate:remote          # 线上
npm run migrate:local           # 本地

# 4) 设置访客哈希盐（生产必做）
npx wrangler secret put VISITOR_SALT --config packages/worker/wrangler.toml

# 5) 部署后会按 wrangler.toml 的 triggers 每 30 分钟巡检一次
#    本地想手动跑一次：curl "http://localhost:8788/cdn-cgi/handler/scheduled"

# 6) 起本地开发（先构建后台产物，再由 Worker 一起提供）
npm run dev                     # Worker 于 :8788，后台与短链同域

# 想改前端时用 Vite 热更新（后台 :5173，已配好 /api 代理），
# 但短链与后端仍要看 :8788
npm run dev:web
```

首次打开后台会引导创建管理员账号 —— **第一个注册的账号自动成为超级管理员**，之后注册入口即关闭，只能由超管在「账号」页添加成员。

### 部署

三条路，任选一条：

1. **一键部署** —— 点顶部的 `Deploy to Cloudflare` 按钮，向导里建 D1 / KV / R2 并绑定，再补 `VISITOR_SALT` 与域名变量。
   注意向导需要 `wrangler.toml` 里保留 `REPLACE_WITH_*` 占位符；本仓库已写实 id，fork 出去才适合点。
2. **手动 wrangler** —— 见下方命令。
3. **CNB 流水线** —— 打 Tag 或页面上点部署按钮。

```bash
# 后台与 Worker 一起发布（同时注册 triggers.crons 的定时任务）
npm run deploy

# 等价于：
#   npm run build:web
#   npx wrangler deploy --config packages/worker/wrangler.toml
```

`wrangler.toml` 的 `[assets].directory` 指向 `packages/web/dist`，所以 **构建后台产物必须排在
`wrangler deploy` 之前**（`npm run deploy` 已经替你串好了顺序）。

部署后把 `wrangler.toml` 里的 `WEB_ORIGIN` / `SHORT_ORIGIN` 改成你的域名；同域部署时两者相同，
留空则回落到请求自身的 origin，不会出错。

**完整部署教程（含一键部署向导、自定义域名、常见排错）：[docs/DEPLOY.md](docs/DEPLOY.md)**

## 开放 API

对外开放接口是**全量**的：后台里能点的事情，脚本和 AI 助手都能做。

- **三类码**：短链 / 活码 / 渠道码，`create` `list` `get` `update` `delete` `reset` 全都有
- **活码子码**（真正的二维码图片）：增删改、启停、计数清零
- **访问分析**：小时分布 + 近 N 天趋势 + 独立访客
- **周边设施**：域名、卡密批次、素材库、通知渠道、用户、巡检、访问明细
- **凭证自管**：用 API 再发一串 API Key，不用回后台点

每个用户可以在后台「API Key」页自助创建凭证，密钥只显示一次。

凭证有三道闸，创建时都能设：**到期时间**（默认 90 天，可留空 = 永不过期）、
**调用配额**（留空 = 不限额，填了就按次刹车）、**IP 白名单**（留空 = 不限制）。
到期管「什么时候失效」，配额管「这段时间里能花多少」—— 一张一年期的 key 若被扫到，
一天就能刷爆；反过来一张建完就忘的 key，配额到顶会自动停，不用人记得去删。两者缺一不可。

接口是**自描述**的 —— 不确定有哪些动作时别猜，直接问平台（无需鉴权）：

```bash
curl https://你的域名/open/v1
```

返回里有每个命名空间可用的动作、参与签名的字段名、参数说明与示例。

### 形状

```
GET  /open/v1                          自描述目录
POST /open/v1/stats                    访问分析
POST /open/v1/{命名空间}/{动作}         所有动作
```

统一用 POST + JSON body，**包括读操作** —— 签名是请求体的一部分，
放进 query 会让密钥出现在 URL 与访问日志里。

命名空间分两类：

| 类型 | 命名空间 | 定位方式 | 授权 |
| --- | --- | --- | --- |
| 资源 | `short-links` / `codes` / `channels` | `dv1_slug` | 只能碰自己名下的 |
| 后台类 | `domains` / `cardkeys` / `assets` / `notify-channels` / `users` / `inspection` / `credentials` / `stats-admin` | `dv1_id` | 需要 `dv1_grant: "owner"` |

资源类动作：`create` `list` `get` `update` `delete` `reset`，
外加 `channels/blocks`（访客黑名单）和 `codes/qrcodes/*`（子码）。
后台类动作见表格对应的目录条目。

### 改（update）

`update` 是这轮补的重点 —— 以前想改一条短链的目标链接，只能删了重建，
而 slug 会跟着变，已经发出去的链接就全废了。

```bash
curl -X POST https://你的域名/open/v1/short-links/update \
  -H 'content-type: application/json' \
  -d '{
    "dv1_title": "", "dv1_type": "", "dv1_url": "",
    "dv1_slug": "<slug>",
    "dv1_new_title": "改过的标题",
    "dv1_target_url": "https://example.com/new",
    "api_key": "dwz_xxxxxxxxxxxxxxxx",
    "sign": "<签名 tag 位补空串>"
  }'
```

**只改传进来的字段**：没传的一律不碰。「没传」与「传 null」是两件事 ——
后者是显式清空（比如取消过期时间）。改名用 `dv1_new_title`，
不要动 `dv1_title`：后者是签名 tag 位。

### 授权（后台类动作）

后台类动作要在 body 里加 `dv1_grant: "owner"`，它**参与签名**：

```
signString = 标题 + "|" + 访问限制 + "|" + 目标链接 + "|" + dv1_grant + "|" + api_key + "|" + api_secret
```

这个位置缺省补空串。

**声明不等于权限**：`dv1_grant` 只是「打开本来就属于这个人的视图」，
真正的身份仍取决于**凭证主人是不是超管**。一个成员账号发出来的 key，
就算写了 `dv1_grant: "owner"`，调后台类动作照样 403。

### 活码子码

活码的宿主只是一组设置，访客扫到哪张二维码由**子码**决定 ——
所以子码也是开放接口的一部分，动作挂在 codes 下：
`list` / `create` / `update` / `delete` / `reset`。

定位子码用「宿主 slug + `dv1_qrcode`」：后者既可以写子码的数字 id，
也可以写它在该宿主下的序号（从 1 开始）。除了 `dv1_slug` / `dv1_qrcode`，
其余参数是 `dv1_image_url`（图片地址，http/https 或 `/media/...` 站内地址）、
`dv1_contact`（客服微信号）、`dv1_threshold`（阈值，不传按活码类型给默认）、
`dv1_status`（`active` / `disabled`）。签名 tag 位照旧补空串。

```bash
# 给活码加一张二维码
curl -X POST https://你的域名/open/v1/codes/qrcodes/create \
  -H 'content-type: application/json' \
  -d '{
    "dv1_title": "", "dv1_type": "", "dv1_url": "",
    "dv1_slug": "<活码 slug>",
    "dv1_image_url": "/media/assets/202610/xxx.png",
    "api_key": "dwz_xxxxxxxxxxxxxxxx",
    "sign": "<按上式计算的签名>"
  }'
```

### 素材库

图片上传是唯一收二进制的动作，请求体是 `multipart/form-data`，
签名 tag 与凭据放在表单字段里（签名规则不变，签的仍是那几个位置）：

```bash
curl -X POST https://你的域名/open/v1/assets/upload \
  -F 'dv1_title=' -F 'dv1_type=' -F 'dv1_url=' \
  -F 'dv1_grant=owner' \
  -F 'api_key=dwz_xxxxxxxxxxxxxxxx' \
  -F 'sign=<按签名算法计算>' \
  -F 'file=@qrcode.png'
```

返回的 `item.url` 是 `/media/{key}` 站内地址，可以直接喂给
`codes/qrcodes/create --image` —— 比外链可靠（外链会失效）。

### 签名

```
signString = 标题 + "|" + 访问限制 + "|" + 目标链接 + "|" + dv1_grant + "|" + api_key + "|" + api_secret
sign       = hex(HMAC-SHA256(api_secret, signString))
```

前三个 tag 位是**按位置**参与签名的：`create` 时填标题 / 访问限制 / 目标链接，
`list` / `get` / `delete` / `stats` / 后台类动作一律补空串。标题为空就是空串，
不要因为「这个字段没意义」就把它删掉 —— 串短了一段，服务端算出来的签名就对不上。

第四位是**授权声明**，缺省也补空串：`dv1_grant` 只在后台类动作里填 `owner`。

对应的参数名是 `dv1_title` / `dv1_type` / `dv1_url`。`dv1_` 前缀是**版本化契约**：
字段语义要变时新增 `dv2_*`，而不是改 `dv1_*` 的含义 —— 否则线上还在跑的调用方
会在某次发布后悄悄签不过。

### 建一条短链

```bash
curl -X POST https://你的域名/open/v1/short-links/create \
  -H 'content-type: application/json' \
  -d '{
    "dv1_title": "双十一活动",
    "dv1_type": "any",
    "dv1_url": "https://example.com/act",
    "api_key": "dwz_xxxxxxxxxxxxxxxx",
    "sign": "<按上式计算的签名>"
  }'
```

`dv1_type` 支持 `any` / `wechat` / `ios` / `android` / `mobile` / `desktop`；
另可传 `dv1_slug` 指定自定义短链（留空则生成不可枚举的随机串）。

### 看访问数据

```bash
curl -X POST https://你的域名/open/v1/stats \
  -H 'content-type: application/json' \
  -d '{"dv1_slug":"<slug>","dv1_days":7,"api_key":"dwz_...","sign":"<签名 tag 位补空串>"}'
```

返回三块：`hourly`（当天 24 小时分布）、`daily`（近 N 天趋势）、
`visitors`（累计独立访客 / 今日独立访客 / 今日 PV）。
独立访客是按天去重的加盐哈希 —— 它回答「今天大概多少人」，
带原始 IP 的明细只在后台保留（默认 7 天），不进开放接口。

### 配套的 skill

仓库里的 [`skills/dwz-api`](skills/dwz-api/) 是对这套接口的封装，两种用法：

- **给 AI 用**：`SKILL.md` 是给模型看的说明书（触发条件、签名规则、典型任务、
  常见错误对照），把目录交给 Claude Code / CodeBuddy 之类的助手即可。
- **给脚本用**：`scripts/dwz.mjs` 是零依赖 CLI（只用 Node 内置能力），签名已经封装好。

**一键安装到本机助手**（脚本源码 [`skills/install.sh`](skills/install.sh)）：

```bash
curl -fsSL https://raw.githubusercontent.com/cnblove/dwz/main/skills/install.sh | sh
```

脚本只做两件事：把 skill 拉到 `~/.agents/skills/dwz-api`，再软链进
`~/.claude/skills`、`~/.codebuddy/skills`（哪几个目录存在就链哪几个）；
已存在的同名 skill 会被跳过，不覆盖。装完在后台「设置」页最底部也能一键复制这条命令。

```bash
export DWZ_ORIGIN=https://你的域名
export DWZ_API_KEY=dwz_xxxxxxxxxxxxxxxx
export DWZ_API_SECRET=<secret>

node skills/dwz-api/scripts/dwz.mjs check
node skills/dwz-api/scripts/dwz.mjs short-links create --title "活动" --url https://example.com/act
node skills/dwz-api/scripts/dwz.mjs short-links update --slug <slug> --target-url https://example.com/new
node skills/dwz-api/scripts/dwz.mjs qrcodes create --code <活码 slug> --image /media/xxx.png
node skills/dwz-api/scripts/dwz.mjs stats --slug <slug> --days 7

# 后台类动作：加 --grant owner。只对「超管账号创建的 key」生效
node skills/dwz-api/scripts/dwz.mjs users list --grant owner
node skills/dwz-api/scripts/dwz.mjs assets upload --grant owner --file qrcode.png
node skills/dwz-api/scripts/dwz.mjs domains list --grant owner
```

后台「API Key」页会把上面这几行连同当前环境地址一起拼好，点一下就复制走。

## 卡密兑换

后台「卡密」页按批次生成，卡密明文**只在生成时返回一次**，库里只存 SHA-256 哈希。

兑换有两种用法：

- **兑换页**：`https://你的域名/redeem`，服务端直出的表单页，无需登录，适合直接发到群里。
  地址在后台「卡密」页可一键复制；加 `?k=批次ID` 让标题显示批次名。
- **兑换接口**：给自有小程序 / 脚本调用。

接口不需要登录，但同一 IP 每天最多兑换 5 次：

```bash
curl -X POST https://你的域名/api/cardkeys/redeem \
  -H 'content-type: application/json' \
  -d '{"code": "DWZ-XXXXXXXX-XXXXXXXX-XXXXXXXX"}'
```

兑换成功返回批次内容与可选跳转地址（配了跳转地址时兑换页会自动跳过去）；
卡密只能被使用一次，重复提交会被拒绝。

## 定时巡检

`wrangler.toml` 里配了 `crons = ["*/30 * * * *"]`，每 30 分钟触发一次巡检：

- **域名**：在「域名」页开启开关后，逐个探测入口/落地/短链域名，不可达时经指定通知渠道告警；
- **卡密库存**：批次剩余量低于设定阈值时告警。

结果写入 `inspection_logs`，可在后台「巡检日志」页按类型筛选查看，也能点「立即巡检」手动触发。
通知发送失败不会让巡检任务失败 —— 日志里能看到记录，通知是尽力而为的旁路能力。

**各渠道的字段含义、统一消息体与排错：[docs/NOTIFY.md](docs/NOTIFY.md)** —— 重点是 Webhook
的 `url` / `method` / `header` 怎么填，以及接进来后会收到什么格式。

## 测试

```bash
npm test          # 251 项：单元 + 接口集成 + skill CLI 端到端（真实 SQLite 跑迁移）
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
│   │   ├── lib/              加密、时间、UA、统计、通知、开放接口底座等基础能力
│   │   ├── domain/           短链/活码/渠道码的解析、落地页渲染与定时巡检
│   │   ├── open/             开放接口的资源动作、访问分析与自描述目录
│   │   ├── routes/           各资源的业务实现 + Hono 子应用（api / open）
│   │   ├── app.js            Hono 应用装配：中间件 + 路由注册
│   │   └── index.js          Worker 入口（HTTP + Cron 调度）
│   └── test/
├── web/                     管理后台（Vite + 原生 DOM，无框架运行时依赖）
└── skills/dwz-api/           开放 API 的 AI skill + 零依赖 CLI
```

## 设计取舍

- **零前端依赖**：管理后台只用了 Vite 做打包，运行时没有 React/Vue。产物 gzip 后约 10 KB。
- **后端只上一个框架**：路由交给 Hono，业务逻辑仍按资源拆在 `routes/*.js` 里，handler 不感知框架；鉴权、CORS、错误归一都收敛成中间件，避免每个 handler 重复解会话。
- **服务端渲染落地页**：访客的第一跳不能等 JS，否则微信里会白屏。
- **访客 IP 分两条口径存**：聚合口径只存加盐哈希（`daily_visitors`，回答「今天多少人」）；运营口径另开 `visit_logs` 存原始 IP（回答「谁来过、从哪来」），并按天滚动清理，默认保留 7 天，可在概览页一键调紧或清空。两者写入都挂在 `ctx.waitUntil` 上，不拖慢跳转。
- **强签名替代明文摘要**：开放 API 用 HMAC-SHA256 而不是「字段拼接后 MD5」，避免长度扩展与彩虹表。
- **slug 用 UUID v4**：短链 key 公开在 URL 上，必须不可枚举 —— 参考项目用固定长度随机串，我们直接上 128 位随机值，并且不允许自定义 key 绕开随机性。
- **命名空间唯一性交给数据库**：三类资源共用一个 slug 空间，靠 `INSERT OR IGNORE` + UNIQUE 保证；「先查后插」在并发创建下会漏，两个请求会同时认为没人占用。
- **计数一律原子自增**：`hits` / `hits_today` / 子码阈值计数都用单条 `UPDATE ... SET x = x + 1`。读改写会丢计数，而丢计数会直接让阈值轮换提前切码。
- **降级路径必须存在**：轮询域名池为空或候选域名探测失败时，回退到备用/入口域名继续跳转，而不是把访客留在错误页。
- **热点计数直接打宿主表**：跳转路径上不做多轮写库，小时维度与去重访客异步落表（`ctx.waitUntil`），统计失败不影响跳转。
- **卡密明文不落库**：只存 SHA-256 哈希，明文仅在生成时返回一次。与登录令牌同样的理由 —— 库被拖走不等于卡密被拖走。
- **兑换靠状态机而非先查后写**：`UPDATE … WHERE status='unused'` 的受影响行数决定成败，天然避免并发下超发。
- **通知是尽力而为**：任何渠道发送失败都不抛错、不重试、不影响主流程，只在巡检日志里留痕。巡检本身失败也只记录，不让 Cron 任务挂掉。
- **渠道配置按类型收敛字段**：Webhook / 企微 / Bark / 方糖 / PushPlus / 邮件各有自己的字段，入库前统一校验，避免脏配置写到线上才发现。
- **PushPlus 按业务返回码判定成败**：它的接口是异步的，HTTP 200 只代表请求被受理，因此 `code != 200` 也要当失败返回，否则「测试通过」会误导人。


## 参考项目

本项目的问题域与功能边界参考了 [likeyun/liKeYun_ylb](https://github.com/likeyun/liKeYun_ylb) —— 一个成熟的 PHP 短链 / 活码系统。
感谢作者把这类系统该有的形态先跑通了一遍，让我们能站在明确的靶子上做设计，而不是从头猜需求。

需要特别说明的是：**我们只参考了它的功能清单、参数语义与对外行为，没有取用它的任何代码与产物。**
开放接口的 `dwz_title` / `dwz_type` / `dwz_dlws` 属于需要兼容的对外契约，因此保持一致；
而它的源码、命名、表名前缀与字段名、页面文案、CSS、目录结构，均未被复制或改写。

### 实现原理

参考项目走的是**多阶段 PHP 页面 + 302 重定向 + 前端 JS 跳转**的路线；
我们把同一套业务搬到 Cloudflare 边缘，换成**一个 Worker 直出 HTML、跳转首选 `Response.redirect`** 的路线，
链路上不需要 JS 参与，微信内置浏览器里不会白屏，也没有二次跳转。

- 落地页与跳转判断全部在**服务端**完成，访问限制、过期拦截、阈值轮换不依赖前端；
- 短链 / 活码 / 渠道码共用同一个 slug 命名空间，跳转时按序命中；
- 计数一律单条原子 `UPDATE`，去重访客与小时统计异步落表，统计失败不影响跳转。

### 技术栈

| 层 | 选型 |
| --- | --- |
| 运行时 | Cloudflare Workers（全栈一个 Worker，无需 Pages） |
| 后端框架 | Hono（鉴权、CORS、错误归一收敛为中间件） |
| 数据库 | Cloudflare D1（SQLite，迁移脚本自带） |
| 缓存 | Cloudflare KV |
| 对象存储 | Cloudflare R2（素材库图片） |
| 管理后台 | Vite + 原生 DOM（零框架运行时，产物 gzip 约 10 KB） |
| 定时任务 | Cloudflare Cron（每 30 分钟巡检域名与卡密库存） |
| 测试 | `node:sqlite` 跑真实迁移 + 接口集成 + skill CLI 端到端，251 项用例 |

技术栈、数据模型、接口设计、页面结构、构建与测试方式均为自建；
差异点（服务端渲染、UUID 标识、HMAC 签名等）都在上文「设计取舍」里逐条标注了原因。

## 致谢

- 感谢 [CNB](https://cnb.cool/) 提供代码托管与流水线能力。本项目的开发过程使用了 CNB 的 **NPC（AI 助手）功能** —— 需求拆解、代码编写、PR 评审与文档整理都有 NPC 参与，很大程度上是「和 NPC 一起写出来的」。
- 感谢 [Cloudflare](https://www.cloudflare.com/) 的 Workers / D1 / KV / R2 免费额度，让这个项目不需要一台服务器就能跑起来。
- 感谢 [likeyun/liKeYun_ylb](https://github.com/likeyun/liKeYun_ylb) 与 [Hono](https://hono.dev/) 的作者与社区。

## 许可

MIT
