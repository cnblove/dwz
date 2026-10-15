# dwz-api skill

给 AI 客户端（Claude Code / CodeBuddy / 其它支持 skill 的代理）以及普通脚本用的
dwz 开放 API 封装。

- [`SKILL.md`](SKILL.md) —— 给模型看的说明书（触发条件、签名规则、典型任务）
- [`scripts/dwz.mjs`](scripts/dwz.mjs) —— 零依赖 CLI，封装签名与全部动作
  （短链 / 活码 / 渠道码、活码子码、活码并流，以及后台类设施）

## 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/cnblove/dwz/main/skills/install.sh | sh
```

脚本（源码 [`../../skills/install.sh`](../install.sh)）会把本目录装到
`~/.agents/skills/dwz-api`，再软链进 `~/.claude/skills`、`~/.codebuddy/skills`
（存在的目录才链）。已存在的同名 skill 会跳过，不覆盖。

开源地址：<https://github.com/cnblove/dwz>

## 用起来

```bash
export DWZ_ORIGIN=https://你的域名
export DWZ_API_KEY=dwz_xxxxxxxxxxxxxxxx
export DWZ_API_SECRET=<secret>

node scripts/dwz.mjs check
node scripts/dwz.mjs short-links create --title "活动" --url https://example.com/act
node scripts/dwz.mjs qrcodes create --code <活码 slug> --image /media/xxx.png
node scripts/dwz.mjs merges set --code <被并流的活码 slug> --to-code <目标活码 slug>
node scripts/dwz.mjs stats --slug <slug> --days 7
```

`api_key` / `api_secret` 在 dwz 后台「设置 → 个人 API Key」创建。
CLI 也接受 `--key` / `--secret` / `--origin` 覆盖环境变量，方便只跑一次的场景。

依赖：Node 18+（只用了内置的 `fetch` 与 `node:crypto`）。没有 npm 依赖。
