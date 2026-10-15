-- 访问明细：保留原始 IP 的「最近访客记录」
-- 设计说明：
--   1. 0001 起，访客去重只落一份加盐哈希（daily_visitors.visitor_ip），
--      能回答「今天有多少人」但不能回答「谁来过」。私域运营要的是后者，
--      所以这里单独开一张明细表，原样保留 IP。
--   2. 原始 IP 属于个人信息，保留口径必须显式：只保留最近 N 天（默认 7 天），
--      Cron 巡检时按天滚动清理，不做「永久留档」。
--   3. 数据源仍然只有一处：跳转与落地页的 `ctx.waitUntil(recordHit(...))`，
--      明细写失败不影响跳转。
--   4. 明细按 (source, page_id) 聚合而非一次访问一行：
--      同一访客对同一页面多次访问只累加 hits，行数由「访客数」而不是「PV」驱动。
--      否则一条命中的短链一晚上就能把 D1 撑出几万行。

CREATE TABLE IF NOT EXISTS visit_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 资源类型：short_link / code_group / code_service / channel
  source        TEXT    NOT NULL,
  -- 命中的资源行 id；资源被删除后明细仍在，用来回溯「谁访问过已删的链接」
  page_id       INTEGER NOT NULL,
  -- 资源在跳转时的 slug。冗余一份，是为了资源删除后列表里还能看出访问的是什么
  slug          TEXT,
  title         TEXT,
  -- 原始 IP，不加哈希
  ip            TEXT    NOT NULL,
  -- 仅做展示用的粗略归属地（CF-IPCountry），Workers 免费额度拿不到城市级信息
  country       TEXT,
  os            TEXT,
  app           TEXT,
  -- 承载页面的容器：微信 / 企业微信 / 抖音 / Chrome ...
  platform      TEXT,
  device        TEXT,
  -- 首次/最后一次访问，均为 Unix 秒
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  hits          INTEGER NOT NULL DEFAULT 1,
  day           TEXT    NOT NULL,
  UNIQUE (source, page_id, ip, day)
);

-- 「最近访客」列表按时间倒序翻页
CREATE INDEX IF NOT EXISTS idx_visit_logs_last_seen ON visit_logs (last_seen_at DESC);
-- 按天清理 + 按天统计
CREATE INDEX IF NOT EXISTS idx_visit_logs_day ON visit_logs (day);
-- 按资源回溯某条短链/活码的访客
CREATE INDEX IF NOT EXISTS idx_visit_logs_source_page ON visit_logs (source, page_id);

-- 明细保留天数（1~365）。Cron 每 30 分钟跑一次清理，
-- 开关放在域名巡检同一张单行配置表里，避免为一行配置再开一张表。
ALTER TABLE domain_checks ADD COLUMN visit_log_keep_days INTEGER NOT NULL DEFAULT 7;
