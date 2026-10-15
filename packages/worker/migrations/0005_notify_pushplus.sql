-- 通知渠道新增 pushplus（推送加）
-- 设计说明：
--   1. 0001 把渠道类型写死成 CHECK (kind IN (...))，新增渠道必须改约束，
--      所以每次扩展渠道类型都要重建一次表。
--   2. 重建前先去重：约束一旦放宽，历史脏数据（非法 kind 或重复名称）不会被拦住，
--      这里按名称去重、丢掉无法识别的 kind，避免迁移后后台出现幽灵渠道。
--   3. CHECK 里只列「代码真正实现了」的渠道，避免表单能选、发送时报 unknown kind。

CREATE TABLE notify_channels_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN ('webhook', 'email', 'bark', 'wecom', 'serverchan', 'pushplus')),
  config        TEXT    NOT NULL DEFAULT '{}',
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

INSERT INTO notify_channels_new (id, name, kind, config, enabled, created_at)
  SELECT id, name, kind, config, enabled, created_at
  FROM notify_channels
  WHERE kind IN ('webhook', 'email', 'bark', 'wecom', 'serverchan')
    AND id = (SELECT MIN(id) FROM notify_channels AS other WHERE other.name = notify_channels.name);

DROP TABLE notify_channels;
ALTER TABLE notify_channels_new RENAME TO notify_channels;
