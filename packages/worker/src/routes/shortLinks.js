import { badRequest, notFound, ok } from '../lib/http.js';
import { resolveSlug, releaseSlug, renameSlug } from '../lib/namespace.js';
import { canAccess, ownerScope } from '../lib/scope.js';
import { assertQuota } from '../lib/quota.js';
import { nowSeconds, parseTimestamp, todayKey } from '../lib/time.js';

function serialize(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    targetUrl: row.target_url,
    accessRule: row.access_rule,
    urlIos: row.url_ios,
    urlAndroid: row.url_android,
    urlDesktop: row.url_desktop,
    status: row.status,
    rotateDomain: Boolean(row.rotate_domain),
    expiredAt: row.expired_at,
    expiredJump: row.expired_jump,
    hits: row.hits,
    // hits_today 只在当天有效，跨天后视为 0，避免展示上一轮的残留值
    hitsToday: row.hits_today_on === todayKey() ? row.hits_today : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 短链列表。
 * query 已由 pageQuery 校验：page/pageSize 已裁到合法区间，
 * keyword 已 trim，status 原样透传（非法值在下面被忽略，保持宽容）。
 */
export async function listShortLinks(env, query, session) {
  const { page, pageSize, keyword, status } = query;

  // 超管看全部、成员只看自己的：口径收在 lib/scope.js，不再各处手写
  const scope = ownerScope(session);
  const where = [];
  const params = [...scope.params];
  if (scope.clause) where.push(scope.clause.replace(/^AND /, ''));
  if (keyword) {
    where.push('(title LIKE ? OR slug LIKE ? OR target_url LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (status === 'active' || status === 'paused') {
    where.push('status = ?');
    params.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM short_links ${clause}`).bind(...params).first();
  const { results = [] } = await env.DB.prepare(
    `SELECT * FROM short_links ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all();

  return ok({ total: totalRow?.total ?? 0, page, pageSize, items: results.map(serialize) });
}

export async function getShortLink(env, id, session) {
  const row = await env.DB.prepare('SELECT * FROM short_links WHERE id = ?').bind(id).first();
  if (!row || !canAccess(row.owner_id, session)) throw notFound('短链不存在');
  return ok({ item: serialize(row) });
}

/**
 * 创建短链。
 * body 已由路由层的 zod schema 校验并归一化：必填项有值、可选项为 null 或 undefined、
 * 布尔已转 0/1。这里只处理业务规则（配额、命名空间、落库）。
 */
export async function createShortLink(env, body, session) {
  const db = env.DB;

  // 上限统一由用户组配额表达（超管不设限，成员默认不限）：
  // 原先写死的「单账号 5000 条」是一刀切，既挡不住想按组限紧的人，
  // 也让想放宽的人只能改代码。现在改成配额里的一个默认值，见 0008 迁移。
  await assertQuota(db, session, 'shortLinks');

  // 自定义 key 已过格式校验；未传时走 UUID，保证不可枚举
  const slug = await resolveSlug(db, { slug: body.slug });

  const now = nowSeconds();
  const result = await db
    .prepare(
      `INSERT INTO short_links
       (slug, title, target_url, access_rule, url_ios, url_android, url_desktop, status,
        rotate_domain, expired_at, expired_jump, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      slug,
      body.title,
      body.targetUrl,
      body.accessRule,
      body.urlIos,
      body.urlAndroid,
      body.urlDesktop,
      body.rotateDomain,
      parseTimestamp(body.expiredAt),
      body.expiredJump,
      session.id,
      now,
      now,
    )
    .run();

  const created = await db
    .prepare('SELECT * FROM short_links WHERE id = ?')
    .bind(result.meta?.last_row_id)
    .first();
  return ok({ item: serialize(created) });
}

/**
 * 部分更新短链。
 * schema 只对「显式传入的字段」做校验，未传的键不会出现在 body 里，
 * 因此这里能直接按 `!== undefined` 判断是否需要落库。
 */
export async function updateShortLink(env, body, id, session) {
  const db = env.DB;
  const row = await db.prepare('SELECT * FROM short_links WHERE id = ?').bind(id).first();
  if (!row || !canAccess(row.owner_id, session)) throw notFound('短链不存在');

  const fields = {};
  // slug 走命名空间：先抢新值、再放旧值，避免「改坏了就再也跳不到」
  if (body.slug !== undefined) fields.slug = await renameSlug(db, { from: row.slug, to: body.slug });
  if (body.title !== undefined) fields.title = body.title;
  if (body.targetUrl !== undefined) fields.target_url = body.targetUrl;
  if (body.accessRule !== undefined) fields.access_rule = body.accessRule;
  if (body.urlIos !== undefined) fields.url_ios = body.urlIos;
  if (body.urlAndroid !== undefined) fields.url_android = body.urlAndroid;
  if (body.urlDesktop !== undefined) fields.url_desktop = body.urlDesktop;
  if (body.expiredAt !== undefined) fields.expired_at = parseTimestamp(body.expiredAt);
  if (body.expiredJump !== undefined) fields.expired_jump = body.expiredJump;
  if (body.status !== undefined) fields.status = body.status;
  if (body.rotateDomain !== undefined) fields.rotate_domain = body.rotateDomain;

  if (Object.keys(fields).length === 0) throw badRequest('没有需要更新的字段');
  fields.updated_at = nowSeconds();

  const assignments = Object.keys(fields).map((key) => `${key} = ?`).join(', ');
  await db
    .prepare(`UPDATE short_links SET ${assignments} WHERE id = ?`)
    .bind(...Object.values(fields), id)
    .run();

  const updated = await db.prepare('SELECT * FROM short_links WHERE id = ?').bind(id).first();
  return ok({ item: serialize(updated) });
}

export async function deleteShortLink(env, id, session) {
  const row = await env.DB.prepare('SELECT * FROM short_links WHERE id = ?').bind(id).first();
  if (!row || !canAccess(row.owner_id, session)) throw notFound('短链不存在');
  await env.DB.prepare('DELETE FROM short_links WHERE id = ?').bind(id).run();
  // 释放命名空间，否则这个 slug 再也无法被任何资源使用
  await releaseSlug(env.DB, row.slug);
  return ok({ message: '已删除' });
}

export async function resetShortLinkStats(env, id, session) {
  const row = await env.DB.prepare('SELECT * FROM short_links WHERE id = ?').bind(id).first();
  if (!row || !canAccess(row.owner_id, session)) throw notFound('短链不存在');
  await env.DB.prepare('UPDATE short_links SET hits = 0, hits_today = 0, hits_today_on = NULL WHERE id = ?')
    .bind(id)
    .run();
  return ok({ message: '统计已重置' });
}

