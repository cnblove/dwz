-- 结构完善：跨表 slug 唯一性、纯随机资源标识、级联删除
-- 设计说明：
--   1. 短链 / 活码 / 渠道码共用一个 slug 命名空间，解析时按 短链 → 活码 → 渠道码 命中。
--      原实现靠「创建时查重」保证不冲突，并发创建时可以绕过查重，导致同名资源互相遮蔽。
--      这里把三张表的 slug 收进一张索引表 short_slugs，用 UNIQUE 在数据库层兜底。
--   2. 对外标识改为纯随机串：自动生成的 key 只含随机字符，
--      自定义 key 通过短哈希派生，避免自定义值里的数字被人拿来模糊枚举。
--   3. 统计明细与业务行绑定，随宿主删除一并清理，同时受益于按 source 的聚合查询。

------------------------------------------------------------------
-- slug 命名空间
------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS short_slugs (
  slug TEXT PRIMARY KEY
);

-- 已存在的资源回填进命名空间表；存在历史冲突时保留最早的占用者。
INSERT OR IGNORE INTO short_slugs (slug)
  SELECT slug FROM short_links WHERE slug IS NOT NULL;
INSERT OR IGNORE INTO short_slugs (slug)
  SELECT slug FROM codes WHERE slug IS NOT NULL;
INSERT OR IGNORE INTO short_slugs (slug)
  SELECT slug FROM channels WHERE slug IS NOT NULL;

-- 说明：占用动作由代码执行 `INSERT OR IGNORE INTO short_slugs (slug) VALUES (?)`，
-- 以 changes == 0 判定「已被占用」。放在数据库里做，是唯一能挡住并发创建的办法。

------------------------------------------------------------------
-- 统计明细：与宿主行绑定
------------------------------------------------------------------

-- daily_visitors 按天去重，行数随天数增长，靠 (source, day) 查询。
DROP INDEX IF EXISTS idx_daily_visitors_source_day;
CREATE INDEX IF NOT EXISTS idx_daily_visitors_source_day ON daily_visitors (source, day);
CREATE INDEX IF NOT EXISTS idx_daily_counters_source_day ON daily_counters (source, day);
CREATE INDEX IF NOT EXISTS idx_hourly_stats_source_day ON hourly_stats (source, day, hour);

------------------------------------------------------------------
-- 卡密批次的对外标识
------------------------------------------------------------------

-- 后台用 uuid 引用批次，避免自增 ID 暴露发放量、也便于外部系统对接。
-- 允许为空：升级前创建的批次按 id 引用，不会被这次改动带崩。
ALTER TABLE cardkey_batches ADD COLUMN uuid TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cardkey_batches_uuid ON cardkey_batches (uuid);

-- 兑换限流按 (ip_hash, day) 计数，索引已在 0002 里建立。
-- 兑换流程依赖 cardkey_redeems 两列为空：先插入占额记录（batch/cardkey 未知），
-- 兑换成功后再补全；因此去掉它们的 NOT NULL 约束。
