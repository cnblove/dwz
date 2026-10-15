# 通知渠道配置教程

后台「通知渠道」页负责所有对外提醒：域名巡检异常、卡密库存不足都从这里发出去。

一个渠道 = 一条配置。先选类型，再填该类型要求的字段，保存后点「测试」立刻验证连通性 ——
**不用等下一次巡检**。多个渠道可以同时建、同时启用，互不影响；发送失败只记在巡检日志里，
不会影响跳转、兑换这些主流程。

支持的渠道：

| 类型 | 用途 | 必填 | 可选 |
| --- | --- | --- | --- |
| [Webhook](#webhook) | 对接任意 HTTP 接口 | `url` | `method`、`header` |
| [邮件](#邮件) | 发到邮箱 | `to` | `from`、`subject` |
| [Bark](#bark) | iOS 推送 | `key` | `server` |
| [企业微信](#企业微信) | 群机器人 | `key` | — |
| [方糖](#方糖-server-酱) | Server 酱 | `key` | — |
| [PushPlus](#pushplus推送加) | 推送加（微信等多渠道） | `token` | `topic`、`channel`、`template` |

## 统一消息体

不管哪个渠道，dwz 都先把告警整理成同一个结构，再按渠道的格式发出去：

```json
{
  "title": "【告警】2 个域名不可达",
  "text": "dwz.example.com：HTTP 502 连接超时\ncdn.example.com：HTTP 0 DNS 解析失败",
  "level": "error",
  "time": "2026-03-27T08:30:00.000Z"
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `title` | string | 标题。域名告警是「【告警】N 个域名不可达」，卡密告警是「【告警】N 个卡密批次库存不足」 |
| `text` | string | 正文。多条内容用 `\n` 分隔，一行一个对象 |
| `level` | string | `info` 普通消息、`warn` 库存告警、`error` 域名不可达。Bark 用它决定是否强提醒 |
| `time` | string | ISO 8601 时间，由服务端生成 |

各渠道怎么用这套字段：

- **Webhook**：原样作为 JSON body 发出去（GET 时只带 header，不带动 body）。
- **Bark**：`title` → 通知标题，`text` → 正文，`level` → 是否 timeSensitive（强提醒）。
- **企业微信 / 方糖 / PushPlus**：拼成「标题 + 换行 + 正文」的纯文本。
- **邮件**：`title` → 主题，`text` → 正文。

> Webhook 是最通用的一个：任何能收 JSON 的服务都能接。下面单独细讲。

---

## Webhook

选类型 `Webhook` 后，表单里只有两个字段，但这两个字段决定它能对接多少种服务。

### `url`（必填）

接收通知的地址，**必须是 `https://` 开头** —— 明文 http 会被校验拒绝，避免通知里的告警内容裸奔。

所有参数都走 URL 查询串或 header，不需要在 dwz 侧拼 body。典型写法：

```
https://hooks.example.com/notify?token=xxxxxxxx
https://api.example.com/alert/dwz            # 鉴权放 header 里
```

### `method`（可选，默认 `POST`）

只接受 `POST` 和 `GET`，大小写不敏感，留空即 `POST`。

- `POST`：`content-type: application/json`，body 是上面的统一消息体。
- `GET`：**不带 body**，只发请求。适合那些只能用 URL 传参的老服务：
  把参数写在 query 里，dwz 只负责打过去。
  ```
  https://api.example.com/notify?msg=dwz-alert&level=error
  ```
  注意 `GET` 场景下 `title` / `text` / `level` 不会自动带上，需要你在 URL 里固定下来。

### `header`（可选）

额外的请求头，JSON 对象。用来做鉴权或对接有特殊要求的服务：

```json
{ "Authorization": "Bearer xxxxxxxxxxxx", "X-Source": "dwz" }
```

默认已经会带上 `content-type: application/json`，同名时以你填的为准。常见组合：

| 对接目标 | `header` 建议 |
| --- | --- |
| 钉钉 / 飞书机器人 | 不用填，把签名或 key 写在 `url` 里 |
| 自建告警服务 | `{ "Authorization": "Bearer <token>" }` |
| 需要区分来源 | `{ "X-Source": "dwz" }` |

> 后台表单目前只暴露 `url` 和 `method` 两个字段。`header` 需要走接口写入：
>
> ```bash
> curl -X PATCH https://你的域名/api/notify-channels/<渠道ID> \
>   -H 'content-type: application/json' \
>   -H 'authorization: Bearer <登录令牌>' \
>   -d '{"config":{"url":"https://hooks.example.com/notify","method":"POST","header":{"Authorization":"Bearer xxx"}}}'
> ```
>
> 注意 `config` 是全量覆盖：PATCH 时要把 `url` 一起带上，否则会被清掉。

### 收到什么

POST 时对方服务收到的完整请求：

```http
POST /notify HTTP/1.1
Host: hooks.example.com
content-type: application/json
authorization: Bearer xxxxxxxxxxxx

{"title":"【告警】1 个域名不可达","text":"dwz.example.com：HTTP 502","level":"error","time":"2026-03-27T08:30:00.000Z"}
```

判断成功的标准只有一个：**HTTP 状态码 2xx**。非 2xx 或超过 8 秒没响应都算失败，
失败会写进巡检日志的 `notified=0`，不会重试。

### 怎么自测

先起个能看请求的临时地址（本地、内网穿透、或任意的 request bin 都行），填进 dwz 点「测试」，
确认收到的 body 结构对得上，再接自己的业务逻辑。

### 几个坑

- 只认 `https`，本地 `http://localhost` 会被拒；用内网穿透拿个 https 地址来测。
- 超时 8 秒，对方接口慢过这个时间就会判失败。
- 不重试。「通知是尽力而为」是有意为之：重试会让告警风暴放大，真要保证送达请对接有重试能力的平台。

---

## 邮件

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `to` | 是 | 收件人，格式必须合法（`ops@example.com`），目前只发一个地址 |
| `from` | 否 | 发件人，默认 `dwz@notice.local` |
| `subject` | 否 | 主题前缀，默认「短链与活码通知」 |

邮件走 Cloudflare 的邮件发送能力，Workers 运行时没有 SMTP。**如果账号没开通这个能力，
测试会直接失败**，这时换别的渠道，或者让 Cloudflare 侧先配好邮件发送。

---

## Bark

iOS 上的免费推送 App，装好后在 App 里能看到一个 key。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `key` | 是 | Bark App 里的设备 key |
| `server` | 否 | 自建服务器地址，默认官方 `https://api.day.app` |

实际请求形如 `POST https://api.day.app/<key>`，`level=error` 会转成 Bark 的 `timeSensitive`，
锁屏时也能弹出来。

---

## 企业微信

群机器人 webhook。在企业微信群里「添加群机器人」，拿到形如下面的地址：

```
https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx-xxxx-xxxx
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `key` | 是 | 只填 `key=` 后面那串，**不要填整个地址** |

dwz 会拼回完整地址，用 `msgtype: text` 发出去。填错成整条 URL 是最常见的失败原因。

---

## 方糖（Server 酱）

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `key` | 是 | Server 酱的 SendKey，形如 `SCTxxxxxxxxxxxx` |

发送走 `https://sctapi.ftqq.com/<key>.send`，表单编码，`title` + `desp` 两个字段。

---

## PushPlus（推送加）

[pushplus](https://www.pushplus.plus/) 是一个聚合推送平台：一次请求，它可以帮你转到微信、
企业微信、钉钉、飞书、邮件、短信等渠道，网关侧的渠道在 pushplus 后台配。

官网：[www.pushplus.plus](https://www.pushplus.plus/) ·
文档：[www.pushplus.plus/doc](https://www.pushplus.plus/doc/) ·
发送接口：`https://www.pushplus.plus/send`

### 怎么拿 token

1. 用微信扫码登录 [pushplus 官网](https://www.pushplus.plus/)；
2. 关注弹出的公众号，之后推送会进这个微信；
3. 在「一对一消息 / 个人中心」页复制 **token**（32 位字符串，别和好友令牌、群组编码搞混）。

### 字段

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `token` | 是 | — | 用户 token，决定「推给谁」 |
| `topic` | 否 | 空 | 群组编码。填了就推给群组里的所有人；不填只推给自己 |
| `channel` | 否 | `wechat` | 发送渠道，决定「走哪条路」推到微信之外 |
| `template` | 否 | `html` | 内容模板，`html` / `txt` / `markdown` / `json` |

`topic` 和「好友令牌」是两回事：前者是一对多（群组），后者是一对一（指定某个人），
dwz 只用到 `topic`。

`channel` 常用取值：

| 值 | 走哪条路 |
| --- | --- |
| `wechat`（默认） | 微信公众号 |
| `webhook` | 第三方 webhook（企业微信、钉钉、飞书、Bark、Server 酱等，需先在 pushplus 后台配好并拿到渠道编码，填在 pushplus 侧的 `option`） |
| `mail` | 邮箱 |
| `cp` | 企业微信应用 |
| `app` | pushplus App |
| `sms` / `voice` | 短信 / 语音，按量扣积分 |

> 多渠道分发（一次推给多个渠道）用的是 pushplus 的 `/batchSend` 接口，
> dwz 走的是单渠道 `/send`，需要多渠道就按上面配 `channel` 或者在 pushplus 后台配好 webhook 渠道。

### dwz 实际发出去的请求

```json
POST https://www.pushplus.plus/send
{
  "token": "你的 token",
  "title": "【告警】1 个域名不可达",
  "content": "dwz.example.com：HTTP 502 连接超时",
  "template": "html",
  "topic": "可选",
  "channel": "可选"
}
```

`template` 留空时按 `html` 发送，所以正文里的 `<`、`>` 会被当标签解析；
告警正文只是普通文本，想原样展示就把 `template` 填成 `txt`。

### 返回码

pushplus 的接口是**异步**的：HTTP 200 只代表「服务端收到请求了」，不代表消息已经送达。
真正的结果在响应 body 里：

```json
{ "code": 200, "msg": "请求成功", "data": "3cbc5eab19fe512e80677540fbde332a" }
```

dwz 除了看 HTTP 状态码，还会检查 `code` 是否等于 200：
不等于就把 `msg` 当成失败原因带出来（比如 token 无效），点「测试」时能直接看到。

常见的失败：`token` 复制错、`token` 与好友令牌混淆、免费额度用超被限流、pushplus 侧渠道没配好。
完整的返回码表见 [官方返回码说明](https://www.pushplus.plus/doc/guide/code.html)。

### 想更省事

pushplus 的 `/send` 接口本身兼容「任何第三方 webhook 直接打过来」的形式：
把 `https://www.pushplus.plus/send/<你的token>` 当成一个地址，对方 POST 什么内容就推什么内容。
如果你有**别的系统**要通知到微信，用这条就够了，不需要经过 dwz。

---

## 排错

| 现象 | 先查什么 |
| --- | --- |
| 点「测试」提示 400 | 配置字段没通过校验：webhook 不是 https、邮件格式不对、必填项为空 |
| 提示「测试失败：HTTP 4xx/5xx」 | 对方服务返回了错误码，用同一个地址手动 curl 一次对比 |
| webhook 一直超时 | 对方接口慢过 8 秒，或地址不可达 |
| 企业微信提示 invalid webhook url | `key` 填成了整条 URL |
| PushPlus 提示 token 无效 | token 抄错，或与好友令牌弄混 |
| 邮件发不出去 | Cloudflare 账号没开通邮件发送能力 |
| 巡检有异常但没收到通知 | 巡检的目标没绑渠道；或渠道被停用；或发送失败（看巡检日志 `notified` 列） |

通知失败**不会**影响巡检结果本身 —— 巡检照常写 `inspection_logs`，
「通知」只是尽力而为的旁路能力。
