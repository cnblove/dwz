-- 补齐能力：卡密分发、域名巡检日志
-- 设计说明：
--   1. 通知渠道沿用 0001 已预留的 notify_channels，这里只补巡检日志表。
--   2. 卡密分两个层次：cardkey_batches 定义「怎么发、发什么、发多少」，
--      cardkeys 是具体每一张卡。兑换时只改单行，避免热点集中在批次行。

------------------------------------------------------------------
-- 设备巡检日志
------------------------------------------------------------------

-- 每次 Cron 巡检落一行，后台按时间倒序看历史。
CREATE TABLE IF NOT EXISTS inspection_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- domain 域名巡检 / cardkey 卡密库存巡检
  kind         TEXT    NOT NULL DEFAULT 'domain',
  target       TEXT    NOT NULL,
  ok           INTEGER NOT NULL DEFAULT 1,
  status       INTEGER NOT NULL DEFAULT 0,
  latency_ms   INTEGER NOT NULL DEFAULT 0,
  detail       TEXT,
  notified     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inspection_logs_created ON inspection_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inspection_logs_kind ON inspection_logs (kind, created_at DESC);

------------------------------------------------------------------
-- 卡密分发
------------------------------------------------------------------

-- 批次：一次生成任务对应一批卡密，也是发放与统计的单位。
CREATE TABLE IF NOT EXISTS cardkey_batches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  -- 卡密承载的内容，兑换成功后返回给调用方
  content       TEXT    NOT NULL,
  total         INTEGER NOT NULL DEFAULT 0,
  used          INTEGER NOT NULL DEFAULT 0,
  -- 批次有效期，为空表示不限
  expired_at    INTEGER,
  -- 兑换后自动跳转的地址，为空则只展示内容
  redirect_url  TEXT,
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  remark        TEXT,
  -- 库存低于该值时触发通知，0 表示不告警
  low_stock     INTEGER NOT NULL DEFAULT 0,
  notify_channel TEXT,
  owner_id      INTEGER NOT NULL REFERENCES users (id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cardkey_batches_owner ON cardkey_batches (owner_id);
CREATE INDEX IF NOT EXISTS idx_cardkey_batches_status ON cardkey_batches (status);

-- 单张卡密。code 只存哈希，明文仅在生成时返回一次。
CREATE TABLE IF NOT EXISTS cardkeys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id      INTEGER NOT NULL REFERENCES cardkey_batches (id) ON DELETE CASCADE,
  code_hash     TEXT    NOT NULL UNIQUE,
  -- 便于人工核对的首尾片段，不含完整明文
  code_hint     TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'unused' CHECK (status IN ('unused', 'used', 'disabled')),
  used_at       INTEGER,
  used_ip       TEXT,
  used_ua       TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cardkeys_batch ON cardkeys (batch_id, status);

-- 兑换记录：兑换接口按 IP 限流，需要能快速查「这个 IP 今天兑了几张」。
-- 兑换记录同时承担「按 IP 每日限流」的计数职责：
-- 兑换瞬间先落一条占额记录（batch / cardkey 尚不可知，两列为 NULL），
-- 兑换成功后再补全；因此这两列允许为空，卡密被删除时置空而不连带删记录。
CREATE TABLE IF NOT EXISTS cardkey_redeems (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id    INTEGER REFERENCES cardkey_batches (id) ON DELETE CASCADE,
  cardkey_id  INTEGER REFERENCES cardkeys (id) ON DELETE SET NULL,
  ip_hash     TEXT    NOT NULL,
  ua          TEXT,
  day         TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cardkey_redeems_ip ON cardkey_redeems (ip_hash, day);
CREATE INDEX IF NOT EXISTS idx_cardkey_redeems_batch ON cardkey_redeems (batch_id, created_at DESC);
