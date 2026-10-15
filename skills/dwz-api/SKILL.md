---
name: dwz-api
description: 用 dwz 短链平台的开放 API 创建短链、活码、渠道码，增删改活码子码（二维码图片），并分析访问数据。当用户提到「短链」「活码」「客服码」「群二维码」「子码」「渠道码」「扫码统计」「dwz」，或要求用 API 建链接 / 换二维码 / 看某个码的访问情况时使用。也适用于把短链能力接进脚本或 CI。
---

# dwz 开放 API

dwz 是一个自托管的短链 / 私域活码系统。这个 skill 让你（AI 或脚本）
直接调它的开放 API：建短链、建活码、建渠道码，给活码加删子码（二维码图片），
并把访问数据捞回来做分析。

**先决条件**：用户手里有一对 `api_key` / `api_secret`（在 dwz 后台
「设置 → 个人 API Key」自助创建，密钥只显示一次）以及平台地址。

## 最快的用法

```bash
cd <这个 skill 的目录>

# 只需要给一次，之后所有命令都能直接跑
export DWZ_ORIGIN=https://你的域名
export DWZ_API_KEY=dwz_xxxxxxxxxxxxxxxx
export DWZ_API_SECRET=<secret>

node scripts/dwz.mjs check                    # 验证凭据与平台地址
node scripts/dwz.mjs short-links create --title "双十一" --url https://example.com/act
node scripts/dwz.mjs short-links list
node scripts/dwz.mjs codes create --title "运营群" --url https://example.com/fallback
node scripts/dwz.mjs qrcodes create --code <活码 slug> --image /media/xxx.png
node scripts/dwz.mjs stats --slug <slug> --days 7
```

不带参数运行 `node scripts/dwz.mjs` 会打印全部命令（也可以 `--help`）。

## 先看平台自己怎么说

接口是**自描述**的，不确定有哪些动作时别猜，直接问平台：

```bash
node scripts/dwz.mjs catalog        # 等价于 GET {DWZ_ORIGIN}/open/v1，无需鉴权
```

返回里有每个资源可用动作、参与签名的字段名、参数说明与示例。

## 三个资源

| 资源 | 建出来是什么 | 适合 |
| --- | --- | --- |
| `short-links` | `{域名}/{slug}` 302 跳到目标 | 推广链接、活动页、落地页 |
| `codes` | `{域名}/{slug}` 直出一个二维码落地页 | 微信群活码、客服码；宿主本身只有设置，二维码靠子码 |
| `channels` | `{域名}/{slug}` 跳转 + 来源归因 | 需要按 App / 系统看转化来源的入口 |

三类共用同一个 slug 命名空间，所以跳转时按 短链 → 活码 → 渠道码 顺序命中，
建的时候也别指望同一个 slug 能建两次。

动作：`create` / `list` / `get` / `delete`，路径形如
`POST /open/v1/{资源}/{动作}`。另有 `POST /open/v1/stats` 做访问分析。

**活码子码**（真正的二维码图片）是单独一组动作，挂在 codes 下：
`list` / `create` / `update` / `delete` / `reset`，
路径 `POST /open/v1/codes/qrcodes/{动作}`。定位子码用
「宿主 slug + `dv1_qrcode`」，后者既可以写子码的数字 id，也可以写它在宿主下的
序号（从 1 开始）。CLI 里对应 `qrcodes` 子命令，用 `--code` 指定宿主。

> 别把子码当成「第四种资源」：它没有自己的 slug，也不占命名空间。
> 想给活码配二维码，先 `codes create` 建宿主，再往宿主里加子码。

## 签名（脚本已封装，手动调用时才需要看）

每个请求都要签名，算法是 HMAC-SHA256：

```
signString = dwz_title + "|" + dwz_type + "|" + dwz_url + "|" + api_key + "|" + api_secret
sign       = hex(HMAC-SHA256(api_secret, signString))
```

`scripts/dwz.mjs` 已经把这件事做完了，你只要填 `api_key` / `api_secret` 对应的
内容进 JSON 体。用 `--dry-run` 可以只看它生成的请求。**手动调用时容易踩的三个坑**：

- `api_secret` 既要当 HMAC 的 key，又要当签名串里最后一段 —— 两处都要，别只做一处。
- 这三个 tag 位是**按位置**参与签名的：`create` 时填标题 / 访问限制 / 目标链接，
  `list` / `get` / `delete` / `stats` 一律补空串（`""`），不要顺手把 slug 填进 `dwz_url`。
- 跳转类接口不参与签名，签的永远是 tag 位那三个值，不是业务参数。

签名串里不能出现 slug、时间戳这类「服务端才知道」的值 —— 版本号一旦拼进签名串，
就需要额外的字段传递，这类设计是坑。

## 典型任务

### 建一条短链并确认它真的能跳

```bash
node scripts/dwz.mjs short-links create --title "活动" --url https://example.com/act --json
# 拿返回里的 url，实际访问一次确认 302 落到目标
```

### 建一个群活码，配上多张子码做阈值轮换

宿主与子码分两步：先建宿主，再往里加二维码图片。

```bash
node scripts/dwz.mjs codes create --title "运营群" --url https://example.com/fallback
# 拿到 slug 之后，把三张群二维码挂上去
node scripts/dwz.mjs qrcodes create --code <活码 slug> --image /media/assets/202610/q1.png
node scripts/dwz.mjs qrcodes create --code <活码 slug> --image /media/assets/202610/q2.png --threshold 300
node scripts/dwz.mjs qrcodes list  --code <活码 slug>          # 看阈值用了多少
```

- `--image` 要的是图片地址：站内 `/media/...`（素材库给的就是这种）或外链 http/https 都行。
- 不传 `--threshold` 时按活码类型取默认值：群活码 200，客服码 0。
- 换图 / 停用某张：`qrcodes update --code <slug> --qrcode <id 或序号> --image ... --status disabled`。
  禁用后访客不再被分到这张，但记录还在，可以再启用回来。
- 删除：`qrcodes delete --code <slug> --qrcode <id 或序号>`。
- 想把某张的已用次数清零（比如换了新群）：`qrcodes reset --code <slug> --qrcode <id>`。

子码全部触顶（或全被禁用 / 删光）后，会回落到 `--url` 指定的兜底客服码 ——
建宿主的时候把兜底给上，比事后再补要省事。

**图片从哪来**：素材库（后台「素材库」页）上传后会得到 `/media/{key}` 地址，
直接把它当 `--image` 用即可，不必自己找图床。

### 分析某条链接的访问

```bash
node scripts/dwz.mjs stats --slug <slug> --days 7        # 人体可读
node scripts/dwz.mjs stats --slug <slug> --days 7 --json # 拿原始数据自己算
```

返回三块：`hourly`（当天 24 小时分布）、`daily`（近 N 天趋势）、
`visitors`（累计独立访客 / 今日独立访客 / 今日 PV）。

**口径说明**：`visitors` 里的「独立访客」是按天去重的加盐哈希，
答的是「今天大概多少人」；平台后台另有一份带原始 IP 的明细（保留 7 天，可调），
那是给运营看「谁来过」的。开放 API 只暴露前者 —— 别把两个数字混着解释。

## 常见错误对照

| 报错 | 真正的原因 |
| --- | --- |
| `签名校验失败` | 签名串拼错（多/少了一段，或读了 slug 而不是 tag 位）。先 `--dry-run` 看拼出来的串 |
| `缺少 api_key` / `api_key 无效` | key 没传，或环境变量没导出到当前 shell |
| `调用配额已用完` | 该凭证的配额到顶；换凭证或让管理员调高 |
| `调用来源 IP 不在白名单内` | 凭证配了 IP 白名单，当前出口 IP 不在里面 |
| `该短链已被占用` | slug 是三类资源共用的，换个值或留空让平台随机生成 |
| `活码不存在` | 子码动作的 `--code` 写错了；它要的是**宿主活码**的 slug，不是子码的 |
| `子码不存在` | `--qrcode` 既不是有效的 id，也不是有效的序号（序号从 1 开始） |
| `没有需要更新的字段` | `qrcodes update` 至少要给 `--image` / `--contact` / `--threshold` / `--status` 之一 |
| `二维码图片地址需为 http/https` | `--image` 只接受 http/https 或 `/` 开头的站内地址 |
| `接口不存在，当前版本 v1` | 路径写错了。`GET /open/v1` 看目录 |

## 注意

- 子码的 `--image` 优先用素材库给的 `/media/{key}`：外链会失效，站内地址不会。
- 域名与凭据**不要写进这个 skill 目录**：那是用户自己的东西，放在环境变量里。
- 别把 `api_secret` 打进日志或提交进仓库。脚本默认只打印结果，不打印请求头。
- 平台配额按凭证计数，每次成功鉴权扣 1。批量建链接前先想清楚要建多少。
