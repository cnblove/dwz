# 开放 API

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

## 形状

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

## 改（update）

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

**改自定义短链（slug）** 用 `dv1_new_slug`：与 `dv1_slug` 同一套手法 ——
`dv1_slug` 是定位用的旧值，`dv1_new_slug` 才是新值。新旧值相同视为无操作，
新值已被占用则报 400（此时旧地址照旧可用）。改名后旧地址立即失效，
已发出去的链接就废了，谨慎用：

```bash
curl -X POST https://你的域名/open/v1/short-links/update \
  -H 'content-type: application/json' \
  -d '{
    "dv1_title": "", "dv1_type": "", "dv1_url": "",
    "dv1_slug": "<旧 slug>",
    "dv1_new_slug": "<新 slug>",
    "api_key": "dwz_xxxxxxxxxxxxxxxx",
    "sign": "<签名 tag 位补空串>"
  }'
```

## 授权（后台类动作）

后台类动作要在 body 里加 `dv1_grant: "owner"`，它**参与签名**：

```
signString = 标题 + "|" + 访问限制 + "|" + 目标链接 + "|" + dv1_grant + "|" + api_key + "|" + api_secret
```

这个位置缺省补空串。

**声明不等于权限**：`dv1_grant` 只是「打开本来就属于这个人的视图」，
真正的身份仍取决于**凭证主人是不是超管**。一个成员账号发出来的 key，
就算写了 `dv1_grant: "owner"`，调后台类动作照样 403。

## 活码子码

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

## 素材库

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

## 签名

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

## 建一条短链

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

## 看访问数据

```bash
curl -X POST https://你的域名/open/v1/stats \
  -H 'content-type: application/json' \
  -d '{"dv1_slug":"<slug>","dv1_days":7,"api_key":"dwz_...","sign":"<签名 tag 位补空串>"}'
```

返回三块：`hourly`（当天 24 小时分布）、`daily`（近 N 天趋势）、
`visitors`（累计独立访客 / 今日独立访客 / 今日 PV）。
独立访客是按天去重的加盐哈希 —— 它回答「今天大概多少人」，
带原始 IP 的明细只在后台保留（默认 7 天），不进开放接口。

## 配套的 skill

仓库里的 [`skills/dwz-api`](../skills/dwz-api/) 是对这套接口的封装，两种用法：

- **给 AI 用**：`SKILL.md` 是给模型看的说明书（触发条件、签名规则、典型任务、
  常见错误对照），把目录交给 Claude Code / CodeBuddy 之类的助手即可。
- **给脚本用**：`scripts/dwz.mjs` 是零依赖 CLI（只用 Node 内置能力），签名已经封装好。

**一键安装到本机助手**（脚本源码 [`skills/install.sh`](../skills/install.sh)）：

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
