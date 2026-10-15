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
访客 / 管理员 ──► Worker (dwz-api)
                   ├─ 后台页面（静态资源，assets 绑定）
                   ├─ /{slug} 跳转、/api/* 后台接口、/open/* 开放接口
                   ├─► D1 (dwz)      业务数据
                   ├─► KV (CACHE)    缓存
                   └─► R2 (dwz-media) 素材图片
```

一共 4 样东西：

- **Worker** `dwz-api` —— 后台页面 + API + 跳转 + 落地页 + Cron 巡检，全在这一个 Worker 里
- **D1** `dwz` —— 业务数据库，需要跑迁移
- **KV** `CACHE` —— 短时缓存与统计去重
- **R2** `dwz-media` —— 素材库的图片对象（可选：不用素材库也可以先建好，绑定名必须是 `MEDIA`）

再加 1 个 secret：`VISITOR_SALT`（访客 IP 哈希用的盐）。

> 注意：`VISITOR_SALT` 只影响**去重聚合**那一份哈希。概览页的「最近访客记录」按设计
> 保留原始 IP，不走这个盐 —— 它是给人看的明细，不是匿名计数。保留天数默认 7 天，
> 由 Cron 每 30 分钟滚动清理，可在概览页调整。

**没有 Pages。** 后台 SPA 的构建产物通过 `wrangler.toml` 的 `[assets]` 绑定随 Worker 一起发布，
这也是 Cloudflare 目前推荐的全栈形态：一个 Worker 同时提供静态资源与动态接口。

> **域名怎么选？**
> 后台与短链**天然同域**：`https://dwz.example.com/` 是后台，
> `https://dwz.example.com/abc123` 是短链。需要单独给短链配域名时参考 [自定义域名](#自定义域名)。

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

README 顶部那颗按钮**点了就是部署**，不是在 clone 代码。它打开的向导会拿你授权给 Cloudflare 的
GitHub 账号，把仓库 fork 一份到你自己名下，再在你的 Cloudflare 账号里建好 D1 / KV / R2、
写好绑定、把 Worker 发上去。不需要本地装 Node 或 wrangler，也不需要 Pages。

按钮的地址就是要部署的仓库：

```
https://deploy.workers.cloudflare.com/?url=https://github.com/cnblove/dwz
```

想指向别的仓库（比如你自己的 fork），把 `?url=` 后面那段换成那个仓库地址即可。

> **一键部署依赖 GitHub 镜像。** 本仓库主仓库在 CNB，靠 CNB 流水线同步到 GitHub
> （见 [方式三 · 同步到 GitHub](#15-同步到-github可选)），按钮指向的正是 GitHub 那份。

> **本仓库自身不适合再点这个按钮。** `packages/worker/wrangler.toml` 里已写实本仓库自己的
> `database_id` / `id`，直接点会把 Worker 绑到一个**不属于你**的 D1 / KV 上。
> Fork 出去用一键部署，先把这三处改回占位符再点：
>
> ```toml
> [[kv_namespaces]]
> id = "REPLACE_WITH_KV_ID"
> preview_id = "REPLACE_WITH_KV_ID"
>
> [[d1_databases]]
> database_id = "REPLACE_WITH_D1_ID"
> ```
>
> 这和发版流水线里的 `check-deploy-config` 自检是同一个约束 —— 流水线发现占位符会直接拒绝部署
> （见 [方式三](#2-填真实的-d1--kv-id)），一键部署则相反，需要占位符好让向导填真值。

### 1. 点按钮

README 顶部的 **Deploy to Cloudflare** 按钮会用 Cloudflare 的 Deploy 流程打开一个向导页面。

### 2. 授权并创建资源

向导里按提示操作：

1. 授权 Cloudflare 访问你的 GitHub（没有仓库会自动 fork 一份）
2. 选择/新建仓库，Cloudflare 会自动检测到这是 Worker 项目
3. 向导会提示创建 D1 与 KV，**名字按提示填**：
   - D1 数据库名：`dwz`
   - KV 命名空间：`CACHE`
   - R2 存储桶：`dwz-media`（一键部署向导若未提示，可部署后在绑定里手动补 `MEDIA`）
4. 创建完成后，Cloudflare 会把真实的 `database_id` / `id` 写回仓库的 `wrangler.toml`

> 如果向导没有自动绑定，部署会失败并提示找不到 `DB` / `CACHE` 绑定 —— 到「Workers & Pages → dwz-api → 设置 → 绑定」手动补上即可。

### 3. 补上仓库里以 secret 形式存在的配置

打开 Cloudflare Dashboard：

- **Workers & Pages → dwz-api → 设置 → 变量和密钥**
  添加加密变量：`VISITOR_SALT` = 一串足够长的随机字符串（例如 `openssl rand -hex 32` 的输出）

  这个盐决定访客去重口径，**上线后不要再改**，改了历史访客会被当成新访客。

- **同一个页面的「变量」里**：`WEB_ORIGIN` / `SHORT_ORIGIN` 默认留空就行 ——
  后台与短链同域，后端会按请求自身的 origin 推导。
  只有给短链单独配了域名时，才需要把 `SHORT_ORIGIN` 填成那个域名。

### 4. 跑数据库迁移

向导只建库，**不会建表**。跳过这一步部署也算是成功的，但一注册就报
`{"code":500,"msg":"服务暂时不可用，请稍后重试"}`，或提示「数据库尚未初始化」——
每个查询都会撞上 `no such table: users`。

在 Cloudflare Dashboard 里 D1 控制台可以直接执行 SQL，但**迁移是按顺序执行的多个文件**，手工粘贴容易漏。
推荐本地跑一次（只需要一次）：

```bash
npx wrangler login
npx wrangler d1 execute dwz --remote --file packages/worker/migrations/0001_init.sql
npx wrangler d1 execute dwz --remote --file packages/worker/migrations/0002_cardkeys_and_inspection.sql
npx wrangler d1 execute dwz --remote --file packages/worker/migrations/0003_cleanup_and_integrity.sql
```

或者用 `wrangler.toml` 里的配置一步到位（会自动记录已执行的迁移，重复执行安全）：

```bash
npx wrangler d1 migrations apply dwz --remote --config packages/worker/wrangler.toml
```

一键部署不用 `wrangler login` —— 本地跑上面这条命令前先 `npx wrangler login` 一次，
或者按 [方式二第 1 步](#1-登录-cloudflare) 用 API Token。

> 迁移是**部署后的收尾步骤，不是部署的前置条件**，所以向导里没有这一步。
> 顺序上：先让 Worker 上线，再补 secret 与迁移，最后注册管理员。三件事都做完才算能用。

### 5. 初始化管理员

打开 Worker 的地址（`https://dwz-api.<你的子域>.workers.dev` 或自定义域名）→ 首次会显示
「初始化你的部署」→ 填账号密码 → **第一个注册的账号自动成为超级管理员**，之后注册入口自动关闭，
新账号只能由超管在「账号」页添加。

后台和短链是同一个地址，不需要额外部署前端。

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
权限需要 **Workers Scripts:Edit、D1:Edit、Workers KV Storage:Edit、Workers R2 Storage:Edit**。

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

### 3.5 建 R2 存储桶（素材库用）

```bash
npx wrangler r2 bucket create dwz-media
```

桶名与 `wrangler.toml` 里 `[[r2_buckets]]` 的 `bucket_name` 保持一致，绑定名固定为 `MEDIA`：

```toml
[[r2_buckets]]
binding = "MEDIA"
bucket_name = "dwz-media"
```

> 素材默认走同域 `/media/{key}` 由 Worker 回源，**不需要**把桶设为公开访问。
> 若已经把桶绑了自定义域名或接了 CDN，把它填进 `[vars].MEDIA_ORIGIN`，素材链接就是你的域名。

### 4. 设置访客哈希盐

```bash
npx wrangler secret put VISITOR_SALT --config packages/worker/wrangler.toml
```

回车后粘贴一串随机值（`openssl rand -hex 32`）。生产环境**必须**用 secret 覆盖，
否则代码里 `change-me-in-production` 的默认值会让所有人的访客哈希口径可预测。

走 CNB 流水线的话也可以把这一串填进密钥仓库的 `envs.yml`，
`.cnb.yml` 里的 `ensure-visitor-salt` stage 会在部署前自动补设；
两种方式等价，挑一种顺手即可。

### 5. 跑迁移

```bash
npm run migrate:remote   # 线上 D1
npm run migrate:local    # 本地 D1，开发用
```

`migrate:remote` 走的是 `wrangler d1 migrations apply`，会跳过已经执行过的文件，重复执行安全。

### 6. 域名变量（通常可以跳过）

编辑 `packages/worker/wrangler.toml` 的 `[vars]`：

```toml
[vars]
WEB_ORIGIN = ""    # 留空 → 按请求自身 origin 推导
SHORT_ORIGIN = ""  # 给短链单独配了域名时才填
DEFAULT_KEY_LENGTH = "6"
```

后台与短链同域，所以这两个留空是对的。`WEB_ORIGIN` 只在有外部域名跨域调接口时才需要
（支持逗号分隔），`SHORT_ORIGIN` 只在短链要挂另一个域名时才需要。

### 7. 部署（后台 + Worker 一起）

```bash
npm run deploy            # = npm run build:web && wrangler deploy
```

这一条会：构建后台产物 → 上传 Worker（含静态资源）→ 注册定时任务（每 30 分钟巡检）。

`wrangler.toml` 里 `[assets].directory = "../web/dist"`，所以 **`build:web` 必须在
`wrangler deploy` 之前跑完**。`dist/` 不进版本库，漏了这一步会直接报目录不存在。

单独部署 Worker 也可以，但记得先构建：

```bash
npm run build:web
npx wrangler deploy --config packages/worker/wrangler.toml
```

验证：

```bash
curl https://你的域名/health          # {"status":"healthy","time":...}
curl -I https://你的域名/             # 200，后台页面
```

### 8. 前后端同源，不需要额外配置

后台页面、`/api/*`、`/{slug}` 全在一个 Worker、一个域名下，
前端用的就是相对路径（`packages/web/src/api.js`），不存在跨域问题。

### 9. 初始化管理员

同方式一第 5 步。

## 方式三：CNB 流水线自动部署

仓库已经在 CNB 上，希望「打 Tag 即发布」。仓库自带 `.cnb.yml`，需先补三样东西：
Cloudflare 凭据（密钥仓库）、真实的 D1 / KV id、手动部署入口。
（想让 `main` 的 push 自动镜像到 GitHub，另见 [1.5 同步到 GitHub](#15-同步到-github可选)。）

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
# 同步到 GitHub 用（可选，不用同步就不填；详见「同步到 GitHub」）
GIT_USERNAME: <你的 GitHub 用户名>
GIT_ACCESS_TOKEN: <GitHub PAT，需 repo 权限>
# 访客哈希盐（可选）。填了的话流水线里 `ensure-visitor-salt`
# 那个 stage 会在部署前自动帮你 `wrangler secret put`。
# 不填就自己跑一次 `npx wrangler secret put VISITOR_SALT`，
# 否则生产环境会一直用 wrangler.toml 里 `change-me-in-production` 的默认值。
VISITOR_SALT: <openssl rand -hex 32 的输出>
```

> `VISITOR_SALT` 放在密钥仓库里，只是为了让流水线替你按下 `secret put`。
> 它不像 Cloudflare 的 secret 那样单独加密存储，对密钥仓库有读权限的人
> 都能看到明文 —— 想手动管这份密钥，删掉 `.cnb.yml` 里的 `ensure-visitor-salt`
> stage 即可。

密钥仓库的访问控制通过同名文件里的 `allow_*` 字段声明（也可以不加，此时按「引用者是否为该密钥仓库的开发者」校验）：

```yaml
# 只允许 cnblove 组织下的仓库引用
allow_slugs:
  - "cnblove/**"
# 只允许部署 / 同步相关事件读取
allow_events:
  - tag_push
  - push
  - "tag_deploy.*"
  - web_trigger
```

一旦声明了 `allow_*` 规则，就完全按规则校验。

### 1.5 同步到 GitHub（可选）

README 顶部的「Deploy to Cloudflare」一键部署按钮指向 `github.com/cnblove/dwz`，
所以想让按钮可用、或只是想让两边提交历史一致，就把 `main` 分支的 push 镜像到 GitHub：

`.cnb.yml` 的 `main → push` 里已加好 `sync-to-github` 这个 stage（官方插件
[`tencentcom/git-sync`](https://cnb.cool/cnb/plugins/tencentcom/git-sync)），只要把 `target_url`
换成你的 GitHub 仓库，并在密钥仓库的 `envs.yml` 里补上 `GIT_USERNAME` / `GIT_ACCESS_TOKEN` 即可：

```yaml
main:
  push:
    - stages:
        # ...校验用的 install / test / typecheck / build-web...
        # 先自检凭据注入情况：缺变量时直说缺哪个，比 git-sync 的含糊报错好查
        - name: check-sync-credentials
          image: node:22
          imports:
            - https://cnb.cool/<你的组织>/<密钥仓库>/-/blob/main/envs.yml
          script: |
            [ -n "$GIT_USERNAME" ] && [ -n "$GIT_ACCESS_TOKEN" ] \
              || { echo "✘ 缺少 GIT_USERNAME / GIT_ACCESS_TOKEN"; exit 1; }
        - name: sync-to-github
          image: tencentcom/git-sync
          imports:
            - https://cnb.cool/<你的组织>/<密钥仓库>/-/blob/main/envs.yml
          settings:
            target_url: https://github.com/<你的用户名>/dwz.git
            auth_type: https
            username: ${GIT_USERNAME}
            password: ${GIT_ACCESS_TOKEN}
            push_tags: true   # 标签也镜像过去
```

几个要点：

- **凭据只走密钥仓库**：`GIT_ACCESS_TOKEN` 是 GitHub PAT，别写进 `.cnb.yml`。
- **只在 main push 时同步**：插件默认推送所有分支，配合 `push_tags: true` 连标签一起镜像，
  所以标签不需要另配一条同步流水线。
- **放在校验之后**：没通过 `test` / `typecheck` 的 main 不会被推到 GitHub。
- **首次同步前 GitHub 上先建个空仓库**（不要勾 README / .gitignore），否则 push 会失败。
- GitHub PAT 在 GitHub → Settings → Developer settings → Personal access tokens 创建，勾 `repo` 权限。

#### 同步没生效怎么查

同步是流水线最后一步，前面的校验都通过时，失败只会出现在 `sync-to-github` 上。
按症状对：

| 症状 | 原因 | 怎么办 |
| --- | --- | --- |
| `Failed to parse file: envs.yml` + `parse yaml failed` | `envs.yml` 不是合法 YAML，凭据根本没注入 | 按下文修 `envs.yml` |
| `check-sync-credentials` 报缺少 `GIT_USERNAME` / `GIT_ACCESS_TOKEN` | 变量没写，或密钥仓库 `allow_events` 没放行 `push` | 补变量、放行事件 |
| `sync-to-github` 里 push 被拒 | GitHub 上没有仓库 / 仓库非空 / PAT 权限不足 | 建空仓库、检查 PAT 勾了 `repo` |
| 流水线整体没跑到同步 | `sync-to-github` 只挂在 `main` 的 push 上，PR 不触发 | 推一次 main |

**`envs.yml` 的 YAML 语法**是这里最容易踩的坑。它是被当 YAML 解析的，所以：

- **不能写成列表**。不要 `- KEY: value` 开头，直接一行一个 `KEY: value`。
- **冒号后要有空格**。`KEY:value` 和 `KEY : value` 都容易出问题，写 `KEY: value`。
- **一行一个键**。键名中间断行、一行里塞两个键，报错都指向你完全没动过的那行。
- **值里有 `#` `:` 等字符时加引号**，例如 `GIT_ACCESS_TOKEN: "ghp_xxx"`。

本仓库实际踩过一次：`envs.yml` 第 4 行报
`can not read a block mapping entry; a multiline key may not be an implicit key`。
stage 只跑了 98ms 就退出，`sync-to-github` 压根没启动 —— 看着像「同步没配」，
实则是密钥文件解析失败。

想先本地验一遍，把这行粘到有 PyYAML 的环境：

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('envs.yml')); print('YAML OK')"
```

解析通过后，按上面表格看是不是变量或权限问题。

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

### 3. 接入流水线

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
        - name: deploy
          image: node:22
          script: |
            # 后台产物必须先于部署构建：wrangler.toml 的 [assets].directory
            # 指向 packages/web/dist，而 dist 不进版本库
            npm run build:web
            npx wrangler deploy --config packages/worker/wrangler.toml
```

两点顺序都是硬的：

- **先跑迁移再部署 Worker** —— 新代码依赖新表时反过来会挂在运行时。
- **先构建后台再 `wrangler deploy`** —— 静态资源是随 Worker 上传的，产物不在就会报目录不存在。
- **R2 桶要先存在** —— 桶不存在时 `wrangler deploy` 会直接失败；素材相关接口在未绑定 `MEDIA` 时返回 503。

> `npm ci` 需要 `package-lock.json`。本仓库有，且 lockfile 里包含了 `packages/worker` 的 `hono` / `zod`
> 依赖；若你改过 `package.json` 却忘了提交 lockfile，CI 会以 `ERR_MODULE_NOT_FOUND` 的形式失败。

### 4. 页面上一键部署

只靠打 Tag 还不够顺手。改用 CNB 的部署能力，可以在页面上点按钮选环境发布。
本仓库已加 `.cnb/tag_deploy.yml`：

```yaml
environments:
  - name: production
    description: 部署到 Cloudflare 生产环境（全栈单 Worker）
    permissions:
      roles:
        - master
        - owner
```

点「部署」会触发 `.cnb.yml` 里的 `tag_deploy.production` 事件（本仓库已配好），
流水线基于当前 Tag 的代码构建，不依赖分支最新状态。

### 5. 触发一次

打一个 Tag：

```bash
git tag v0.1.0
git push origin v0.1.0
```

或者到仓库的 Tag 列表页 / 部署页点按钮。构建日志里能看到后台构建与 Worker 部署的输出。

## 部署后验收

逐条确认，任何一条不过就按提示排查：

```bash
# 1. Worker 活着
curl https://你的域名/health

# 2. 后台能打开（出现「初始化你的部署」或登录页）
curl -I https://你的域名/

# 3. 静态资源带得走（应返回 JS 的 content-type）
curl -I https://你的域名/assets/$(ls packages/web/dist/assets | grep '\.js$' | head -1)

# 4. 库表齐了 —— 应该返回大量表名
npx wrangler d1 execute dwz --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```

后台里再走一遍：

1. 建一个短链，目标填 `https://example.com`，保存后列表里能看到完整短链
2. 浏览器打开那个短链 → 应该 302 到目标地址
3. 回到「概览」刷新 → 访问数 +1
4. 到「巡检日志」点「立即巡检」→ 有记录产生（没配域名/卡密阈值时是空跳过，属正常）

## 自定义域名

Cloudflare 上把域名加进来（NS 或 CNAME 接入），然后：

- **后台 + 短链同域**：Workers & Pages → dwz-api → 设置 → 域和路由 → 添加自定义域。
  加完 `https://dwz.example.com/` 是后台、`https://dwz.example.com/abc123` 是短链，不用再配别的。
- **短链想用另一个域名**：再给同一个 Worker 加一个自定义域，并把 `SHORT_ORIGIN` 填成它，
  这样后台里展示、复制的短链才会用对域名。

域名只加一次就好 —— 已发出去的短链跟着域名走，之后换域名等于换链接。

## 常见问题

**`wrangler deploy` 报找不到 assets 目录**
`wrangler.toml` 的 `[assets].directory` 指向 `packages/web/dist`，而这个目录来自
`npm run build:web`，产物不进版本库。CI 里确认 `build:web` 排在 deploy 之前，
本地直接跑 `npm run deploy`（它已串好顺序）。

**CI 在 `migrate` 阶段报 `Invalid property: databaseId => Invalid uuid [code: 7400]`**
`wrangler.toml` 里还是 `REPLACE_WITH_*` 占位符，或者填的 id 属于另一个 Cloudflare 账号。
这个自检现在会提前拦截并给出可操作提示（见上方 `check-deploy-config`）。
更早一轮的失败原因就是这个 —— 注意本流水线**不会**替你在 Cloudflare 建 D1 / KV / Worker。

**注册 / 登录报 500（`{"code":500,"msg":"服务暂时不可用，请稍后重试"}`），或提示「数据库尚未初始化」**
D1 里还没有表 —— 迁移没跑，或者 `migrate` 用的 D1 和 Worker 绑定的不是同一个库。
症状是**所有**接口一起挂，因为每个查询都会撞上 `no such table: users`。

先跑一次迁移：

```bash
npx wrangler d1 migrations apply dwz --remote --config packages/worker/wrangler.toml
```

再确认表真的建到了 Worker 绑定的那个库上（对照 `wrangler.toml` 的 `database_id`）：

```bash
npx wrangler d1 execute dwz --remote --config packages/worker/wrangler.toml \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
```

CNB 流水线的 `migrate` 阶段已内置这步校验：迁移后查不到 `users` 表会直接让部署失败，
不会再把一个对着空库的 Worker 发到线上。它同时会把「表缺失」和「wrangler 自身失败」分开报 ——
后者（`fetch failed` 之类）常是打 Cloudflare API 时的一次网络抖动，不是配置错。

**CI 在 `migrate` / `deploy` 阶段报 `✘ [ERROR] fetch failed`**
这是 wrangler 访问 Cloudflare API 时的网络故障，不是 `wrangler.toml` 或代码的问题：
同一套配置往往几分钟前刚部署成功过。流水线已给这两个 Stage 加了 `retry: 2`（间隔 1s/2s/4s），
偶发丢包会自行重试通过。若连续两轮都挂在同一处，再按下面的方向查：

- 密钥仓库里的 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 是否有效、Token 权限是否够
  （需要 Workers Scripts:Edit、D1:Edit、Workers KV Storage:Edit、Workers R2 Storage:Edit）
- 该 Token 的账户是否与 `wrangler.toml` 里 D1 / KV id 所属账户一致
- 构建节点出口是否被代理 / 防火墙拦掉了 `api.cloudflare.com`

判断依据很简单：**只有注册 / 登录挂、其它接口（`/health`、`/api/bootstrap`）正常** —— 那就不是
库结构问题（结构缺失会让所有接口一起挂），而是口令哈希的 CPU 开销超了 Workers 免费版预算。

免费版每个请求只有 10ms CPU，而 PBKDF2-SHA256 的迭代次数直接决定算力开销：默认值按
`wrangler.toml` 的 `PASSWORD_ITERATIONS` 配置（默认 20000，本机约 2ms）。把它调低能跑通，
但不要低于 10000；付费版（30s CPU）可以调高换取更强的口令哈希：

```toml
[vars]
PASSWORD_ITERATIONS = "20000"
```

**CI 报 `ERR_MODULE_NOT_FOUND: Cannot find package 'hono'`**
`npm ci` 没跑或没装上依赖。确认流水线里 `install` 这一步在 `test` 之前，且 `package-lock.json` 与
`package.json` 同步（本地 `npm install` 后把 lockfile 一起提交）。

**`Error: no database selected` / 找不到 `DB` 绑定**
D1 的 `database_id` 还是占位符，或者建库的账号和部署的账号不是同一个。核对 `wrangler.toml` 与 Dashboard。

**后台页面 404，但 `/health` 正常**
后台页面由 Worker 的静态资源绑定提供。检查 `packages/web/dist/index.html` 是否随 Worker 上传了
（`npm run build:web` 有没有跑），以及 `wrangler.toml` 的 `[assets].directory` 是否指向 `../web/dist`。

**后台打开一片空白**
后台与接口同域，正常情况下不会撞 CORS。先看浏览器控制台的具体报错：
若是资源 404，多半是构建产物没上传；若是接口报错，看 Worker 日志。
`WEB_ORIGIN` 只在有外部域名调接口时才需要配（逗号分隔列表）。

**短链能创建但点开是「链接不存在」**
三类资源共用一个 slug 命名空间，确认建的是短链而不是活码。
如果短链 key 恰好和后台路由重名（如 `dashboard`），会被后台页面优先占用 —— 换个 key。

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
