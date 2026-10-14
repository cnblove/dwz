# 部署教程

从零把 dwz 部署到 Cloudflare 的完整流程。全程只用 Cloudflare 免费额度，不需要自己的服务器。

三种部署方式，按熟悉程度挑一种：

| 方式 | 适合谁 | 耗时 | 需要的东西 |
| --- | --- | --- | --- |
| [一键部署按钮](#方式一一键部署deploy-to-cloudflare) | 想最快看到效果 | ~10 分钟 | Cloudflare 账号、GitHub 账号 |
| [手动 wrangler](#方式二手动部署wrangler-cli) | 想完全掌控每一步 | ~20 分钟 | Node 20+、Cloudflare API Token |
| [CNB 流水线](#方式三cnb-流水线自动部署) | 仓库已在 CNB，想按 Tag 发布 | ~15 分钟 | CNB 仓库、密钥仓库 |

三种方式最终都会创建**同一套资源**，先看一遍下面的资源清单，再决定从哪进入。

## 部署后你会得到

```
访客 ──► Worker (dwz-api)  ──► D1 (dwz)  业务数据
             │                └► KV (CACHE)  缓存
             └─ /{slug} 跳转、/api/* 后台接口、/open/* 开放接口

管理员 ──► Pages (dwz)  管理后台 SPA（/api 转发给 Worker）
```

一共 4 样东西：

- **Worker** `dwz-api` —— API + 跳转 + 落地页，一个入口干三件事
- **Pages** `dwz` —— 管理后台静态站点
- **D1** `dwz` —— 业务数据库，需要跑迁移
- **KV** `CACHE` —— 短时缓存与统计去重

再加 1 个 secret：`VISITOR_SALT`（访客 IP 哈希用的盐）。

> **域名怎么选？**
> 想省事就一个域名走到底（同域部署）：`https://dwz.example.com/abc123` 是短链，
> `https://dwz.example.com/` 是后台。需要自定义域名时参考 [自定义域名](#自定义域名)。

## 前置准备

- Cloudflare 账号（免费版即可）
- 本地装 Node.js 20 或更高：`node -v` 能打出版本号
- 用方式一还需要一个 GitHub 账号（Cloudflare 的 Deploy to Cloudflare 按钮走 GitHub 授权）

把仓库拉到本地：

```bash
git clone https://cnb.cool/cnblove/dwz.git
cd dwz
npm install
```

## 方式一：一键部署（Deploy to Cloudflare）

点按钮 → 授权 GitHub → Cloudflare 建资源 → 跑迁移 → 建管理员，全程在浏览器里完成。

> 说明：一键部署依赖仓库同时在 GitHub 上有镜像，且 `wrangler.toml` 里不能写死 `database_id` / `id`。
> 本仓库（cnblove/dwz）主用方式是 CNB 流水线，已把真实 id 写进 `wrangler.toml`，因此**本仓库自身不适合再点这个按钮**。
> Fork 出去想用一键部署的话，先把 `packages/worker/wrangler.toml` 里的 id 改回 `REPLACE_WITH_*` 占位符再点。

### 1. 点按钮

README 顶部的 **Deploy to Cloudflare** 按钮会用 Cloudflare 的 Deploy 流程打开一个向导页面。

### 2. 授权并创建资源

向导里按提示操作：

1. 授权 Cloudflare 访问你的 GitHub（没有仓库会自动 fork 一份）
2. 选择/新建仓库，Cloudflare 会自动检测到这是 Worker 项目
3. 向导会提示创建 D1 与 KV，**名字按提示填**：
   - D1 数据库名：`dwz`
   - KV 命名空间：`CACHE`
4. 创建完成后，Cloudflare 会把真实的 `database_id` / `id` 写回仓库的 `wrangler.toml`

> 如果向导没有自动绑定，部署会失败并提示找不到 `DB` / `CACHE` 绑定 —— 到「Workers & Pages → dwz-api → 设置 → 绑定」手动补上即可。

### 3. 补上仓库里以 secret 形式存在的配置

打开 Cloudflare Dashboard：

- **Workers & Pages → dwz-api → 设置 → 变量和密钥**
  添加加密变量：`VISITOR_SALT` = 一串足够长的随机字符串（例如 `openssl rand -hex 32` 的输出）

  这个盐决定访客去重口径，**上线后不要再改**，改了历史访客会被当成新访客。

- **同一个页面的「变量」里**，把普通变量改成你的真实域名：
  - `WEB_ORIGIN` → 后台地址，例如 `https://dwz.example.com`
  - `SHORT_ORIGIN` → 短链地址，同域部署时与上面相同

### 4. 跑数据库迁移

在 Cloudflare Dashboard 里 D1 控制台可以直接执行 SQL，但**迁移是按顺序执行的多个文件**，手工粘贴容易漏。
推荐本地跑一次（只需要一次）：

```bash
npx wrangler login
npx wrangler d1 execute dwz --remote --file packages/worker/migrations/0001_init.sql
npx wrangler d1 execute dwz --remote --file packages/worker/migrations/0002_cardkeys_and_inspection.sql
npx wrangler d1 execute dwz --remote --file packages/worker/migrations/0003_cleanup_and_integrity.sql
```

或者用 `wrangler.toml` 里的配置一步到位（会自动记录已执行的迁移）：

```bash
npx wrangler d1 migrations apply dwz --remote --config packages/worker/wrangler.toml
```

### 5. 部署管理后台（Pages）

Workers & Pages → 创建 → Pages → 连接到 Git：

- 构建命令：`npm run build:web`
- 输出目录：`packages/web/dist`
- 环境变量（可选）：`NODE_VERSION` = `22`

保存后 Cloudflare 会自动构建并给出 `https://dwz.pages.dev` 之类的地址。

### 6. 初始化管理员

打开 Pages 地址 → 首次会显示「初始化你的部署」→ 填账号密码 → **第一个注册的账号自动成为超级管理员**，
之后注册入口自动关闭，新账号只能由超管在「账号」页添加。

到这一步就可用性验证完成了，跳到 [验收](#部署后验收)。

## 方式二：手动部署（wrangler CLI）

完全可控，也是排查问题最直接的方式。

### 1. 登录 Cloudflare

```bash
npx wrangler login
```

无浏览器环境（比如在容器/CI 里）改用 API Token：

```bash
export CLOUDFLARE_API_TOKEN=<你的 token>
export CLOUDFLARE_ACCOUNT_ID=<你的 account id>
```

Token 在 Cloudflare Dashboard → My Profile → API Tokens → Create Token 创建，
权限需要 **Workers Scripts:Edit、D1:Edit、Workers KV Storage:Edit、Cloudflare Pages:Edit**。

### 2. 建 D1 数据库

```bash
npx wrangler d1 create dwz
```

输出里会有一行 `database_id = "xxxx-..."`，把它填进 `packages/worker/wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "dwz"
database_id = "<这里换成上面输出的 id>"
```

### 3. 建 KV 命名空间

```bash
npx wrangler kv namespace create CACHE
```

同样把输出的 `id`（以及 `preview_id`，本地开发用）填进 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "CACHE"
id = "<线上 id>"
preview_id = "<本地预览 id>"
```

> 只拿到一个 id 也可以：`preview_id` 可以填同一个值，或者再建一个 `CACHE_preview` 只用本地。

### 4. 设置访客哈希盐

```bash
npx wrangler secret put VISITOR_SALT --config packages/worker/wrangler.toml
```

回车后粘贴一串随机值（`openssl rand -hex 32`）。生产环境**必须**用 secret 覆盖，
否则代码里 `change-me-in-production` 的默认值会让所有人的访客哈希口径可预测。

### 5. 跑迁移

```bash
npm run migrate:remote   # 线上 D1
npm run migrate:local    # 本地 D1，开发用
```

`migrate:remote` 走的是 `wrangler d1 migrations apply`，会跳过已经执行过的文件，重复执行安全。

### 6. 改普通变量

编辑 `packages/worker/wrangler.toml` 的 `[vars]`：

```toml
[vars]
WEB_ORIGIN = "https://你的后台域名"
SHORT_ORIGIN = "https://你的短链域名"   # 同域部署时与 WEB_ORIGIN 相同
DEFAULT_KEY_LENGTH = "6"
```

`WEB_ORIGIN` / `SHORT_ORIGIN` 支持逗号分隔多个值（例如同时允许 `pages.dev` 和自定义域名）。

### 7. 部署 Worker

```bash
npx wrangler deploy --config packages/worker/wrangler.toml
```

这一条同时会注册 `wrangler.toml` 里的定时任务（每 30 分钟巡检一次域名与卡密库存）。

验证：

```bash
curl https://你的-worker-域名/health
# {"status":"healthy","time":...}
```

### 8. 部署管理后台

```bash
npm run build:web
npx wrangler pages deploy packages/web/dist --project-name dwz
```

首次执行会提示创建 Pages 项目，项目名就是 `dwz`。

### 9. 让后台能调到 API

后台默认把 `/api/*`、`/open/*` 请求打到**同源**地址。分域部署时有两种选择：

- **推荐：同域部署。** 在 Pages 上挂一条路由把 `/api/*` 转发给 Worker，访客侧 `/{slug}` 也从 Pages 转发。
  这样 `api.js` 里的相对路径请求不用动。

- **分域部署。** 后台域名与 Worker 域名不同时，`WEB_ORIGIN` 必须包含后台域名（CORS 白名单），
  并且前端要换成绝对 API 地址 —— 当前 `packages/web/src/api.js` 用相对路径请求，
  分域需要改这里或加一层反向代理。**同域部署能省掉这一步，没有特殊需求就不要分域。**

> 部署顺序上，先用 Pages 拿到后台域名，再把域名回填 `WEB_ORIGIN` 后重新 `wrangler deploy` 一次 Worker。
> CORS 白名单空了会拒绝跨域，但**留空时允许所有来源**（`allowed.length === 0` 时放行），
> 所以本地开发不会卡住；生产建议明确写上。

### 10. 初始化管理员

同方式一第 6 步。

## 方式三：CNB 流水线自动部署

仓库已经在 CNB 上，希望「打 Tag 即发布」。仓库自带 `.cnb.yml`，需先补三样东西：
Cloudflare 凭据（密钥仓库）、真实的 D1 / KV id、手动部署入口。

> **别跳过第 2 步。** 流水线不会替你在 Cloudflare 上建资源 —— 它只按 `wrangler.toml`
> 里写的 id 去操作。占位符 `REPLACE_WITH_*` 没换掉时，`migrate` 会以
> `Invalid property: databaseId => Invalid uuid [code: 7400]` 失败。
> 现在流水线在 `migrate` 前加了 `check-deploy-config` 自检：仍是占位符就直接给出这条提示并退出，
> 不会再抛 Cloudflare 的原始报错。

### 1. 创建密钥仓库存 Cloudflare 凭据

CNB 上新建一个**密钥仓库**，在里面建 `envs.yml`：

```yaml
CLOUDFLARE_API_TOKEN: <你的 token>
CLOUDFLARE_ACCOUNT_ID: <你的 account id>
```

密钥仓库的访问控制通过同名文件里的 `allow_*` 字段声明（也可以不加，此时按「引用者是否为该密钥仓库的开发者」校验）：

```yaml
# 只允许 cnblove 组织下的仓库引用
allow_slugs:
  - "cnblove/**"
# 只允许部署相关事件读取
allow_events:
  - tag_push
  - "tag_deploy.*"
  - web_trigger
```

一旦声明了 `allow_*` 规则，就完全按规则校验。

### 2. 填真实的 D1 / KV id

流水线跑的是仓库里的 `packages/worker/wrangler.toml`，其中的 id 必须是**本次部署账号**下已存在的资源：

1. 建资源（账号里没有才需要）：

   ```bash
   npx wrangler login
   npx wrangler d1 create dwz
   npx wrangler kv namespace create CACHE
   npx wrangler kv namespace create CACHE --preview   # 供本地开发用
   ```

2. 把输出的 id 替换掉 `packages/worker/wrangler.toml` 里的占位符：

   ```toml
   [[kv_namespaces]]
   binding = "CACHE"
   id = "<CACHE 的线上 id>"
   preview_id = "<CACHE 的 preview id>"

   [[d1_databases]]
   binding = "DB"
   database_name = "dwz"
   database_id = "<dwz 数据库的 id>"
   migrations_dir = "migrations"   # 相对 wrangler.toml 所在目录，默认即此值
   ```

   改完提交到仓库 —— 流水线工作在无交互环境，只认配置文件里的值，不会去问你想用哪个库。
   本仓库当前填的是：

   ```toml
   [[kv_namespaces]]
   binding = "CACHE"
   id = "6fee1fc8e6e64087b29ee06bbbade5af"
   preview_id = "6fee1fc8e6e64087b29ee06bbbade5af"

   [[d1_databases]]
   binding = "DB"
   database_name = "dwz"
   database_id = "30238aca-1863-473b-b20d-aedbf5d0281d"
   ```

:::note

`database_id` 是账号级资源标识，**不能**由 AI 或流水线自动生成，必须人工从 Cloudflare 拿到。
若仓库同时用 GitHub 的一键部署按钮，注意那条路要求保留占位符，两种方式共用同一个 `wrangler.toml` 时会冲突，
按你的主用方式二选一：本仓库选了 CNB 流水线，id 已写实。

:::

### 2. 接入流水线

在 `.cnb.yml` 里通过 `imports` 引用这份凭据。凭据只作为环境变量注入，**不会**出现在构建日志里。

本仓库的 `.cnb.yml` 已经把这条流水线写好了，只需要把 `imports` 里的地址换成你的密钥仓库：

```yaml
main:
  tag_push:
    - imports:
        - https://cnb.cool/<你的组织>/<密钥仓库>/-/blob/main/envs.yml
      stages:
        - name: install
          image: node:22
          script: npm ci
        - name: test
          image: node:22
          script: npm test
        - name: migrate
          image: node:22
          script: npx wrangler d1 migrations apply dwz --remote --config packages/worker/wrangler.toml
        - name: deploy-worker
          image: node:22
          script: npx wrangler deploy --config packages/worker/wrangler.toml
        - name: deploy-pages
          image: node:22
          script: |
            npm run build:web
            npx wrangler pages deploy packages/web/dist --project-name dwz --branch "$CNB_BRANCH"
```

注意顺序：**先跑迁移再部署 Worker**。新代码依赖新表时反过来会挂在运行时。

> `npm ci` 需要 `package-lock.json`。本仓库有，且 lockfile 里包含了 `packages/worker` 的 `hono` / `zod`
> 依赖；若你改过 `package.json` 却忘了提交 lockfile，CI 会以 `ERR_MODULE_NOT_FOUND` 的形式失败。

### 3. 页面上一键部署

只靠打 Tag 还不够顺手。改用 CNB 的部署能力，可以在页面上点按钮选环境发布。
本仓库已加 `.cnb/tag_deploy.yml`：

```yaml
environments:
  - name: production
    description: 部署到 Cloudflare 生产环境（Worker + Pages）
    permissions:
      roles:
        - master
        - owner
```

点「部署」会触发 `.cnb.yml` 里的 `tag_deploy.production` 事件（本仓库已配好），
流水线基于当前 Tag 的代码构建，不依赖分支最新状态。

### 4. 触发一次

打一个 Tag：

```bash
git tag v0.1.0
git push origin v0.1.0
```

或者到仓库的 Tag 列表页 / 部署页点按钮。构建日志里能看到 worker 与 pages 的部署输出。

## 部署后验收

逐条确认，任何一条不过就按提示排查：

```bash
# 1. Worker 活着
curl https://你的域名/health

# 2. 后台能打开（出现「初始化你的部署」或登录页）
curl -I https://你的后台域名/

# 3. 库表齐了 —— 应该返回大量表名
npx wrangler d1 execute dwz --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```

后台里再走一遍：

1. 建一个短链，目标填 `https://example.com`，保存后列表里能看到完整短链
2. 浏览器打开那个短链 → 应该 302 到目标地址
3. 回到「概览」刷新 → 访问数 +1
4. 到「巡检日志」点「立即巡检」→ 有记录产生（没配域名/卡密阈值时是空跳过，属正常）

## 自定义域名

Cloudflare 上把域名加进来（NS 或 CNAME 接入），然后：

- **Worker**：Workers & Pages → dwz-api → 设置 → 域和路由 → 添加自定义域
- **Pages**：Pages 项目 → 自定义域 → 添加，Cloudflare 会自动签证书

同域部署的推荐做法：自定义域挂在 **Worker** 上，Pages 保持默认 `*.pages.dev`，
把 `WEB_ORIGIN` 指向 Pages 域名。两种方案都行，选一种后就别再改，否则已发出的短链域名会变。

## 常见问题

**CI 报 `ERR_MODULE_NOT_FOUND: Cannot find package 'hono'`**
`npm ci` 没跑或没装上依赖。确认流水线里 `install` 这一步在 `test` 之前，且 `package-lock.json` 与
`package.json` 同步（本地 `npm install` 后把 lockfile 一起提交）。

**`Error: no database selected` / 找不到 `DB` 绑定**
D1 的 `database_id` 还是占位符，或者建库的账号和部署的账号不是同一个。核对 `wrangler.toml` 与 Dashboard。

**页面 404，但 `/health` 正常**
Pages 的 `_routes.json`（`packages/web/public/_redirects`）负责把路径回落到 `index.html`。
确认构建产物里带了 `_redirects`，并且 `outDir` 是 `packages/web/dist`。

**后台打开一片空白、控制台报 CORS**
`WEB_ORIGIN` 没包含当前后台域名。改 `wrangler.toml` 后重新 `wrangler deploy`。
注意 `WEB_ORIGIN` 是逗号分隔列表，写多个不要带空格歧义。

**短链能创建但点开是「链接不存在」**
三类资源共用一个 slug 命名空间，确认建的是短链而不是活码；也确认访问的域名指向的是 Worker 而不是 Pages。

**定时巡检没跑**
`wrangler deploy` 才注册 cron（`wrangler dev` 不会）。确认 Dashboard → Worker → 触发器里能看到 `*/30 * * * *`。
手动触发一次：`curl "https://你的域名/cdn-cgi/handler/scheduled"`（线上）或对本地 `:8788` 同路径执行。

**`VISITOR_SALT` 忘了设**
访客去重会退化。设完 secret 后重新 `wrangler deploy` 生效。历史统计不会重算 —— 盐只能在初始化前决定。

**改了迁移文件怎么办**
不要改历史迁移。新增能力一律追加 `0004_xxx.sql`，再跑一次 `npm run migrate:remote`。
本地测试用 `npm test`，它会用真实 SQLite 顺序执行全部迁移，写错立刻暴露。

**想回滚**
D1 不会自动降级。回滚代码用 `wrangler rollback`，但**数据库结构的变更要自己写反向 SQL**。
涉及删表删列的迁移，上线前先 `wrangler d1 export dwz --remote` 导一份。

## 维护提示

- 每次改完 `packages/worker/migrations/`，记得 `npm test` + `npm run typecheck`
- 打 Tag 部署会顺带跑迁移，确认迁移是幂等的（`CREATE TABLE IF NOT EXISTS` / `INSERT OR IGNORE`）
- 卡密明文只在生成时返回一次，导出备份时要留意 —— 库里只有哈希，导出来也还原不了明文
