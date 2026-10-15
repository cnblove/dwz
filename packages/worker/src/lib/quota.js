import { forbidden } from './http.js';

/**
 * 成员创建配额。
 *
 * 配额的粒度是「用户组 × 资源类型」，存在 user_groups 的 quota_* 列上，
 * NULL 表示不限额（沿用模块内既有口径：不限用 NULL 表达，而不是一个巨大的数字）。
 *
 * 两条口径必须说清楚，否则实现很容易走偏：
 *
 *   1. **只对成员生效。** 超管的账号就是「兜底账号」：限制一旦也压在超管身上，
 *      配错一个数字（比如 0）就会让整个后台再也建不出东西，而且没有第二个人能改回来。
 *      给成员设限是为了防手滑，防的是别人，不是管理员自己。
 *   2. **配额看的是「用户名下有多少」，不是「这个用户组里有多少」。**
 *      统计的是 count(资源 WHERE owner_id = 该用户)，所以它是「人均上限」。
 *      好处是删掉资源就能腾出位置，不会出现「总数满了，谁都不能再建，
 *      但谁都不知道该删谁的」这种死局。
 *
 * 总量与增量都在这里算：调用方拿着 `remaining` 去拼提示文案，
 * 不重复查一次库，也就不存在两处口径对不上的问题。
 */
export const QUOTA_RESOURCES = {
  shortLinks: {
    column: 'quota_short_links',
    label: '短链',
    count: (db, userId) =>
      db.prepare('SELECT COUNT(*) AS total FROM short_links WHERE owner_id = ?').bind(userId).first(),
  },
  codes: {
    column: 'quota_codes',
    label: '活码',
    count: (db, userId) =>
      db.prepare('SELECT COUNT(*) AS total FROM codes WHERE owner_id = ?').bind(userId).first(),
  },
  qrcodes: {
    column: 'quota_qrcodes',
    label: '子码',
    // 子码没有 owner_id，归属跟着活码走（见 0002 的表结构）
    count: (db, userId) =>
      db
        .prepare(
          `SELECT COUNT(*) AS total FROM code_qrcodes q
           JOIN codes c ON c.id = q.code_id
           WHERE c.owner_id = ?`,
        )
        .bind(userId)
        .first(),
  },
  channels: {
    column: 'quota_channels',
    label: '渠道码',
    count: (db, userId) =>
      db.prepare('SELECT COUNT(*) AS total FROM channels WHERE owner_id = ?').bind(userId).first(),
  },
  assets: {
    column: 'quota_assets',
    label: '素材',
    count: (db, userId) =>
      db.prepare('SELECT COUNT(*) AS total FROM assets WHERE owner_id = ?').bind(userId).first(),
  },
};

/**
 * 取某个账号的配额表：以它的用户组为准，没分组 = 全不限。
 *
 * 返回值形如 `{ shortLinks: 10, codes: null, ... }`，查询结果直接缓存进 session
 * （见 lib/auth.js），所以每个请求只在鉴权时查这一次。
 */
export async function loadQuota(db, groupId) {
  const empty = Object.fromEntries(Object.keys(QUOTA_RESOURCES).map((key) => [key, null]));
  if (!groupId) return empty;

  const columns = Object.values(QUOTA_RESOURCES).map((item) => item.column).join(', ');
  const row = await db.prepare(`SELECT ${columns} FROM user_groups WHERE id = ?`).bind(groupId).first();
  if (!row) return empty;

  const quota = {};
  for (const [key, item] of Object.entries(QUOTA_RESOURCES)) {
    const limit = row[item.column];
    quota[key] = typeof limit === 'number' ? limit : null;
  }
  return quota;
}

/**
 * 创建前的闸门：超管直接放行；成员超出配额抛 403。
 *
 * 用 403 而不是 400：这不是「参数写错了」，是「当前账号没这个额度」，
 * 前端据此显示升级/联系管理员，而不是提示用户改参数。
 */
export async function assertQuota(db, session, key, { add = 1 } = {}) {
  if (session.role === 'owner') return null;

  const resource = QUOTA_RESOURCES[key];
  const limit = session.quota?.[key] ?? null;
  if (limit === null) return null;

  const row = await resource.count(db, session.id);
  const used = row?.total ?? 0;
  if (used + add <= limit) return null;

  const remaining = Math.max(0, limit - used);
  throw forbidden(
    `${resource.label}已达配额上限（${used} / ${limit}），还需 ${add} 个额度，请联系超级管理员调整用户组配额`,
  );
}
