-- 短链与私域活码平台 · 初始结构
-- 设计说明：
--   1. 主键统一使用自增整数；对外标识用唯一字符串（key/slug），避免暴露连续 ID。
--   2. 所有计数型字段放在宿主表上，热点行按业务量级可接受。
--   3. 时间戳统一存 Unix 秒（INTEGER），避免时区解析歧义。

------------------------------------------------------------------
-- 账号与权限
------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  email         TEXT,
  role          TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  remark        TEXT,
  expires_at    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);

-- 用户分组：以一组页面路径作为授权集合
CREATE TABLE IF NOT EXISTS user_groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  nav_list   TEXT    NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

ALTER TABLE users ADD COLUMN group_id INTEGER REFERENCES user_groups (id);

-- 登录会话（令牌只存哈希，明文仅返回一次）
CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT    NOT NULL UNIQUE,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  user_agent TEXT,
  ip         TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

------------------------------------------------------------------
-- 域名池
------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS domains (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  host         TEXT    NOT NULL UNIQUE,
  -- entry 入口 / landing 落地 / short 短链 / backup 备用
  kind         TEXT    NOT NULL CHECK (kind IN ('entry', 'landing', 'short', 'backup')),
  remark       TEXT,
  group_id     INTEGER REFERENCES user_groups (id),
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_domains_kind ON domains (kind);

-- 域名可用性巡检配置与其结果
CREATE TABLE IF NOT EXISTS domain_checks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  enabled       INTEGER NOT NULL DEFAULT 0,
  notify_channel TEXT,
  backup_host   TEXT,
  last_status   TEXT,
  checked_at    INTEGER
);

------------------------------------------------------------------
-- 短链
------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS short_links (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT    NOT NULL UNIQUE,
  title         TEXT    NOT NULL,
  target_url    TEXT    NOT NULL,
  -- 访问限制：any 不限 / wechat 仅微信 / ios / android / mobile 仅手机浏览器 / desktop 仅电脑
  access_rule   TEXT    NOT NULL DEFAULT 'any'
                CHECK (access_rule IN ('any', 'wechat', 'ios', 'android', 'mobile', 'desktop')),
  -- 按设备分流的覆盖目标，为空则回退 target_url
  url_ios       TEXT,
  url_android   TEXT,
  url_desktop   TEXT,
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  rotate_domain INTEGER NOT NULL DEFAULT 0,
  expired_at    INTEGER,
  expired_jump  TEXT,
  hits          INTEGER NOT NULL DEFAULT 0,
  hits_today    INTEGER NOT NULL DEFAULT 0,
  hits_today_on TEXT,
  owner_id      INTEGER NOT NULL REFERENCES users (id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_short_links_owner ON short_links (owner_id);
CREATE INDEX IF NOT EXISTS idx_short_links_status ON short_links (status);

------------------------------------------------------------------
-- 活码：群活码 / 客服码共用一张宿主表，用 kind 区分
------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS codes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT    NOT NULL UNIQUE,
  kind          TEXT    NOT NULL CHECK (kind IN ('group', 'service')),
  title         TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  hits          INTEGER NOT NULL DEFAULT 0,
  hits_today    INTEGER NOT NULL DEFAULT 0,
  hits_today_on TEXT,
  -- 同一访客固定看到同一张子码
  sticky        INTEGER NOT NULL DEFAULT 0,
  -- 顶部安全提示
  show_safety   INTEGER NOT NULL DEFAULT 1,
  remark        TEXT,
  notify_channel TEXT,
  -- 客服码专用：展示模式 threshold 阈值 / random 随机，以及在线时段
  pick_mode     TEXT    NOT NULL DEFAULT 'threshold' CHECK (pick_mode IN ('threshold', 'random')),
  show_online   INTEGER NOT NULL DEFAULT 0,
  online_hours  TEXT,
  -- 阈值触顶后的兜底客服码
  fallback_url  TEXT,
  fallback_on   INTEGER NOT NULL DEFAULT 0,
  owner_id      INTEGER NOT NULL REFERENCES users (id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_codes_kind ON codes (kind);
CREATE INDEX IF NOT EXISTS idx_codes_owner ON codes (owner_id);

CREATE TABLE IF NOT EXISTS code_qrcodes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id       INTEGER NOT NULL REFERENCES codes (id) ON DELETE CASCADE,
  image_url     TEXT    NOT NULL,
  -- 群活码填群主微信号，客服码填客服微信号
  contact       TEXT,
  -- 展示阈值，hits 达到后不再选用
  threshold     INTEGER NOT NULL DEFAULT 200,
  hits          INTEGER NOT NULL DEFAULT 0,
  long_press    INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_code_qrcodes_code ON code_qrcodes (code_id, status);

-- 活码并流：访问「原活码」时直接导流到「并入活码」
CREATE TABLE IF NOT EXISTS code_merges (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 一个活码只能并流到一个目标，UNIQUE 同时承担幂等 upsert 的约束
  from_code_id  INTEGER NOT NULL UNIQUE REFERENCES codes (id) ON DELETE CASCADE,
  from_slug     TEXT    NOT NULL,
  to_code_id    INTEGER NOT NULL,
  merges        INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_by    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_code_merges_from ON code_merges (from_code_id);

------------------------------------------------------------------
-- 渠道码：短链 + 来源归因
------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS channels (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT    NOT NULL UNIQUE,
  title         TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  target_url    TEXT    NOT NULL,
  access_rule   TEXT    NOT NULL DEFAULT 'any'
                CHECK (access_rule IN ('any', 'wechat')),
  hits          INTEGER NOT NULL DEFAULT 0,
  hits_today    INTEGER NOT NULL DEFAULT 0,
  hits_today_on TEXT,
  owner_id      INTEGER NOT NULL REFERENCES users (id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_channels_owner ON channels (owner_id);

CREATE TABLE IF NOT EXISTS channel_visits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id   INTEGER NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  visitor_ip   TEXT,
  app          TEXT,
  os           TEXT,
  hits         INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (channel_id, visitor_ip, app, os)
);

CREATE INDEX IF NOT EXISTS idx_channel_visits_channel ON channel_visits (channel_id);

CREATE TABLE IF NOT EXISTS channel_blocks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  visitor_ip TEXT    NOT NULL,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (channel_id, visitor_ip)
);

------------------------------------------------------------------
-- 统计
------------------------------------------------------------------

-- 按小时聚合，source 对应 short_link / code / channel
CREATE TABLE IF NOT EXISTS hourly_stats (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  source   TEXT    NOT NULL,
  day      TEXT    NOT NULL,
  hour     INTEGER NOT NULL,
  hits     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source, day, hour)
);

-- 按天去重的访客计数
CREATE TABLE IF NOT EXISTS daily_visitors (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  source  TEXT    NOT NULL,
  day     TEXT    NOT NULL,
  visitor_ip TEXT NOT NULL,
  UNIQUE (source, day, visitor_ip)
);

CREATE TABLE IF NOT EXISTS daily_counters (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT    NOT NULL,
  day    TEXT    NOT NULL,
  hits   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source, day)
);

------------------------------------------------------------------
-- 通知渠道与素材
------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notify_channels (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN ('webhook', 'email', 'bark', 'wecom', 'serverchan')),
  config        TEXT    NOT NULL DEFAULT '{}',
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  filename   TEXT    NOT NULL,
  url        TEXT    NOT NULL,
  kind       TEXT    NOT NULL DEFAULT 'image' CHECK (kind IN ('image', 'doc')),
  size       INTEGER NOT NULL DEFAULT 0,
  remark     TEXT,
  owner_id   INTEGER NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assets_owner ON assets (owner_id);

------------------------------------------------------------------
-- 开放 API
------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS api_credentials (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key     TEXT    NOT NULL UNIQUE,
  api_secret  TEXT    NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  ip_allowlist TEXT,
  quota       INTEGER NOT NULL DEFAULT 100000,
  used        INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_credentials_user ON api_credentials (user_id);

------------------------------------------------------------------
-- 审计
------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  username   TEXT,
  action     TEXT    NOT NULL,
  detail     TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs (created_at DESC);
