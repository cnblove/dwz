-- 素材库：图片托管在 Cloudflare R2，D1 只存元数据
-- 设计说明：
--   1. 文件本体进 R2（binding MEDIA），D1 的 assets 表只存索引：object_key 指向桶内对象。
--      这样列表页不碰对象存储，删除时用 object_key 精确删对象，不依赖 URL 反解。
--   2. url 落库保存「公开访问地址」，默认是同域的 /media/{key}（由 Worker 从 R2 读出），
--      也可以配 MEDIA_ORIGIN 指向自定义域名（R2 公开桶 / CDN），两者互不影响。
--   3. object_key 全局唯一：上传时按 `assets/{yyyymm}/{uuid}{ext}` 生成，天然不会撞。
--   4. 0001 里的 assets 表结构过于简略（只有 url/size），这里补齐上传所需的列。
--      由于 SQLite 的 ALTER TABLE 无法加 NOT NULL 无默认值的列，且需要回填，
--      采用「建新表 → 拷数据 → 换名」的常规做法，保留历史行。

CREATE TABLE IF NOT EXISTS assets_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 展示用文件名（用户可改）
  filename     TEXT    NOT NULL,
  -- 桶内对象键，全局唯一
  object_key   TEXT    NOT NULL UNIQUE,
  -- 公开访问地址（默认 /media/{object_key}，可配 MEDIA_ORIGIN 覆盖）
  url          TEXT    NOT NULL,
  -- image 图片 / doc 文档，目前主要用 image
  kind         TEXT    NOT NULL DEFAULT 'image' CHECK (kind IN ('image', 'doc')),
  -- 对象 MIME 与字节数，服务端在回源时用于设置 content-type
  mime         TEXT    NOT NULL DEFAULT 'application/octet-stream',
  size         INTEGER NOT NULL DEFAULT 0,
  remark       TEXT,
  owner_id     INTEGER NOT NULL REFERENCES users (id),
  created_at   INTEGER NOT NULL
);

-- 回填历史素材行：老表没有 object_key/mime，用 id 派生一个占位 key，
-- 这些对象并不在 R2 里（属于升级前的裸链接），列表仍可展示，删不掉对象也不报错。
INSERT INTO assets_new (id, filename, object_key, url, kind, mime, size, remark, owner_id, created_at)
  SELECT id,
         filename,
         'legacy/' || id,
         url,
         kind,
         'application/octet-stream',
         size,
         remark,
         owner_id,
         created_at
  FROM assets;

DROP TABLE assets;
ALTER TABLE assets_new RENAME TO assets;

CREATE INDEX IF NOT EXISTS idx_assets_owner ON assets (owner_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_assets_kind ON assets (kind, id DESC);
