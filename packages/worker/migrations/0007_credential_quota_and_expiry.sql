-- 凭证的「配额」与「到期」口径调整
--
-- 背景：配额原本是 NOT NULL DEFAULT 100000，等于默认不开限流；
-- 用户看到「配额」一栏只填个巨大数字，会以为这个功能没意义。
-- 同时创建接口此前不暴露到期时间，用户没机会填，只能拿到永不过期的 key。
--
-- 调整两件事：
--   1. quota 允许为 NULL = 不限额。用 NULL 显式表达「不限」，
--      而不是让人在界面上填一个「大到像没限制」的数字（两者长得一样）。
--   2. 默认值下调，并让创建接口带上默认到期时间（见 openApiCore.createCredential）。
--
-- SQLite 改列约束只能重建表。api_credentials 允许一条记录被外部引用（无外键指向它），
-- 所以直接建新表、搬数据、换名即可。

CREATE TABLE api_credentials_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key      TEXT    NOT NULL UNIQUE,
  api_secret   TEXT    NOT NULL,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  ip_allowlist TEXT,
  -- NULL = 不限额；非 NULL 时是本次调用的总预算
  quota        INTEGER,
  used         INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  expires_at   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

INSERT INTO api_credentials_new (id, api_key, api_secret, user_id, ip_allowlist, quota, used, status, expires_at, created_at, updated_at)
  SELECT id, api_key, api_secret, user_id, ip_allowlist, quota, used, status, expires_at, created_at, updated_at
  FROM api_credentials;

DROP TABLE api_credentials;
ALTER TABLE api_credentials_new RENAME TO api_credentials;

CREATE INDEX IF NOT EXISTS idx_api_credentials_user ON api_credentials (user_id);
