#!/usr/bin/env sh
#
# dwz-api skill 一键安装
#
# 用途：把仓库里的 skills/dwz-api 装进本机 AI 助手（Claude Code / CodeBuddy 等）
# 的 skill 目录，装完助手就能自己建短链、活码、渠道码，并拉访问数据做分析。
#
# 用法（二选一）：
#
#   1) 从远端仓库直接装（推荐，免 clone）：
#        curl -fsSL https://raw.githubusercontent.com/cnblove/dwz/main/skills/install.sh | sh
#
#   2) 在已 clone 的仓库里装：
#        sh skills/install.sh
#
# 开源地址：
#   GitHub  https://github.com/cnblove/dwz
#   CNB     https://cnb.cool/cnblove/dwz
#
# 环境变量：
#   DWZ_SKILL_SOURCE   指定仓库地址（git 或 tar 都能用），默认 GitHub
#   DWZ_SKILL_REF      指定分支 / tag，默认 main
#
# 这个脚本只做两件事：拿到 skill 目录、软链到助手的 skills 目录。
# 不改任何现有文件 —— 已存在的同名 skill 会被跳过并提示，而不是被覆盖。

set -eu

REPO_OWNER="cnblove"
REPO_NAME="dwz"
REPO_REF="${DWZ_SKILL_REF:-main}"
REPO_URL="${DWZ_SKILL_SOURCE:-https://github.com/${REPO_OWNER}/${REPO_NAME}.git}"
RAW_BASE="https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_REF}"

SKILL_NAME="dwz-api"

# 助手们的 skill 目录。装到哪个由「谁存在」决定，而不是猜。
# 找不到任何目录时给出提示并退出，不擅自创建 ~/.claude ——
# 用户可能压根没装那个助手。
TARGETS="$HOME/.claude/skills $HOME/.codebuddy/skills $HOME/.agents/skills"

log() { printf '%s\n' "$*"; }
warn() { printf '⚠️  %s\n' "$*" >&2; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }

# 1) 定位 skill 源目录：
#    在仓库里跑 → 直接用当前目录的 skills/dwz-api
#    从远端跑   → 先 clone（有 git 用 git，没有则退化成下载 tar）
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || echo "")
LOCAL_SKILL=""

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/$SKILL_NAME/SKILL.md" ]; then
  LOCAL_SKILL="$SCRIPT_DIR/$SKILL_NAME"
  log "📦 使用本仓库内的 skill：$LOCAL_SKILL"
fi

TMP_DIR=""
cleanup() { if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi; }
trap cleanup EXIT INT TERM

if [ -z "$LOCAL_SKILL" ]; then
  TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t dwz-skill)
  if command -v git >/dev/null 2>&1; then
    log "⏳ 从 $REPO_URL 拉取 skill（分支 $REPO_REF）…"
    git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$TMP_DIR/repo" >/dev/null 2>&1 \
      || die "拉取失败。检查网络，或用 DWZ_SKILL_REF 指定其它分支。"
    LOCAL_SKILL="$TMP_DIR/repo/skills/$SKILL_NAME"
  elif command -v curl >/dev/null 2>&1; then
    log "⏳ 没有 git，改用下载 tar 包…"
    curl -fsSL "https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/heads/${REPO_REF}.tar.gz" \
      | tar -xz -C "$TMP_DIR" >/dev/null 2>&1 \
      || die "下载失败。请确认分支 $REPO_REF 存在。"
    LOCAL_SKILL="$TMP_DIR/${REPO_NAME}-${REPO_REF}/skills/$SKILL_NAME"
  else
    die "需要 git 或 curl 之一，都没有就手动 clone：$REPO_URL"
  fi
fi

[ -f "$LOCAL_SKILL/SKILL.md" ] || die "没找到 SKILL.md，源目录可能不对：$LOCAL_SKILL"

# 2) 落到一个稳定目录，再软链过去。
#    直接链到 clone 目录会让 skill 随临时目录一起消失，
#    所以先复制到 ~/.agents/skills（本机复用口径，见多处 skill 目录的布局）。
STORE="$HOME/.agents/skills"
mkdir -p "$STORE"
DEST="$STORE/$SKILL_NAME"

if [ -d "$DEST" ] && [ "${DWZ_SKILL_FORCE:-}" != "1" ]; then
  log "↻ 已存在 $DEST，先备份为 ${DEST}.bak"
  rm -rf "${DEST}.bak"
  mv "$DEST" "${DEST}.bak"
fi

rm -rf "$DEST"
cp -R "$LOCAL_SKILL" "$DEST"
log "✅ skill 已就位：$DEST"

# 3) 链进各个助手目录。已存在的非本 skill 链接会被跳过，避免误删别人的。
INSTALLED=0
for dir in $TARGETS; do
  parent=$(dirname "$dir")
  [ -d "$parent" ] || continue
  # 跳过 skill 本体所在的目录，它的内容不是「要链过去的目标」
  if [ "$dir" = "$STORE" ]; then continue; fi
  mkdir -p "$dir"
  link="$dir/$SKILL_NAME"

  if [ -e "$link" ] || [ -L "$link" ]; then
    if [ -L "$link" ] && [ "$(readlink "$link")" = "$DEST" ]; then
      log "✓ $dir 已链好，跳过"
      INSTALLED=1
      continue
    fi
    warn "$link 已存在且不是本 skill，跳过（先手动处理它）"
    continue
  fi

  ln -s "$DEST" "$link"
  log "🔗 已链入 $dir"
  INSTALLED=1
done

if [ "$INSTALLED" -eq 0 ]; then
  warn "没找到可用的助手 skill 目录（找了：$TARGETS）。"
  warn "skill 本体已在 $DEST，手动软链到你助手的 skills 目录即可。"
fi

# 4) 打印下一步：光装好不会用，得配地址和密钥。
cat <<'TIP'

──────────────────────────────────────────────
装好了。接下来两步：

  1. 在 dwz 后台「设置 → 个人 API Key」创建一对密钥（密钥只显示一次）
  2. 把环境和密钥交给 skill：

     export DWZ_ORIGIN=https://你的域名
     export DWZ_API_KEY=dwz_xxxxxxxxxxxxxxxx
     export DWZ_API_SECRET=<secret>

     node ~/.agents/skills/dwz-api/scripts/dwz.mjs check

  之后直接对你的 AI 助手说「帮我建一条活动短链」就行。

文档：https://github.com/cnblove/dwz#配套的-skill
──────────────────────────────────────────────
TIP
