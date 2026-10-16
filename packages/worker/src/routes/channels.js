import { badRequest, notFound, ok } from '../lib/http.js';
import { resolveSlug, releaseSlug } from '../lib/namespace.js';
import { canAccess, ownerScope } from '../lib/scope.js';
import { assertQuota } from '../lib/quota.js';
import { nowSeconds, todayKey } from '../lib/time.js';
import { visitorHash } from '../lib/visitor.js';

function serialize(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    targetUrl: row.target_url,
    accessRule: row.access_rule,
    hits: row.hits,
    hitsToday: row.hits_today_on === todayKey() ? row.hits_today : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}


export async function listChannels(env, query, session) {
  const { page, pageSize, keyword } = query;

  // 超管看全部、成员只看自己的：口径收在 lib/scope.js，不再各处手写
  const scope = ownerScope(session);
  const where = [];
  const params = [...scope.params];
  if (scope.clause) where.push(scope.clause.replace(/^AND /, ''));
  if (keyword) {
    where.push('(title LIKE ? OR slug LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM channels ${clause}`).bind(...params).first();
  const { results = [] } = await env.DB.prepare(
    `SELECT * FROM channels ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all();

  return ok({ total: totalRow?.total ?? 0, page, pageSize, items: results.map(serialize) });
}

export async function getChannel(env, id, session) {
  const row = await env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first();
  if (!row || !canAccess(row.owner_id, session)) throw notFound('渠道码不存在');

  const { results = [] } = await env.DB.prepare(
    `SELECT app, os, SUM(hits) AS hits, COUNT(*) AS sources, MAX(last_seen_at) AS last_seen_at
     FROM channel_visits WHERE channel_id = ?
     GROUP BY app, os ORDER BY hits DESC LIMIT 50`,
  )
    .bind(id)
    .all();

  const blocked = await env.DB.prepare(
    'SELECT id, visitor_ip, created_at FROM channel_blocks WHERE channel_id = ? ORDER BY id DESC LIMIT 100',
  )
    .bind(id)
    .all();

  return ok({
    item: serialize(row),
    breakdown: results.map((r) => ({
      app: r.app,
      os: r.os,
      hits: r.hits,
      sources: r.sources,
      lastSeenAt: r.last_seen_at,
    })),
    blocks: (blocked.results ?? []).map((b) => ({ id: b.id, ipHash: b.visitor_ip, createdAt: b.created_at })),
  });
}

export async function createChannel(env, body, session) {
  const db = env.DB;
  await assertQuota(db, session, 'channels');
  const slug = await resolveSlug(db, { slug: body.slug });

  const now = nowSeconds();
  const result = await db
    .prepare(
      `INSERT INTO channels (slug, title, status, target_url, access_rule, owner_id, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`,
    )
    .bind(slug, body.title, body.targetUrl, body.accessRule, session.id, now, now)
    .run();

  const created = await db.prepare('SELECT * FROM channels WHERE id = ?').bind(result.meta?.last_row_id).first();
  return ok({ item: serialize(created) });
}

export async function updateChannel(env, body, id, session) {
  const db = env.DB;
  const row = await db.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first();
  if (!row || !canAccess(row.owner_id, session)) throw notFound('渠道码不存在');

  const fields = {};
  if (body.title !== undefined) fields.title = body.title;
  if (body.targetUrl !== undefined) fields.target_url = body.targetUrl;
  if (body.accessRule !== undefined) fields.access_rule = body.accessRule;
  if (body.status !== undefined) fields.status = body.status;

  if (Object.keys(fields).length === 0) throw badRequest('没有需要更新的字段');
  fields.updated_at = nowSeconds();

  const assignments = Object.keys(fields).map((key) => `${key} = ?`).join(', ');
  await db
    .prepare(`UPDATE channels SET ${assignments} WHERE id = ?`)
    .bind(...Object.values(fields), id)
    .run();

  const updated = await db.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first();
  return ok({ item: serialize(updated) });
}

export async function deleteChannel(env, id, session) {
  const row = await env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first();
  if (!row || !canAccess(row.owner_id, session)) throw notFound('渠道码不存在');
  await env.DB.prepare('DELETE FROM channels WHERE id = ?').bind(id).run();
  await releaseSlug(env.DB, row.slug);
  return ok({ message: '已删除' });
}

/** 加黑名单。前端传明文 IP，落库前统一哈希。 */
export async function blockVisitor(env, body, id, session) {
  const db = env.DB;
  const row = await db.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first();
  if (!row || !canAccess(row.owner_id, session)) throw notFound('渠道码不存在');

  const hash = await visitorHash(body.ip, env.VISITOR_SALT);

  await db
    .prepare(
      `INSERT INTO channel_blocks (channel_id, visitor_ip, created_by, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (channel_id, visitor_ip) DO NOTHING`,
    )
    .bind(id, hash, session.id, nowSeconds())
    .run();

  return ok({ message: '已加入黑名单' });
}

export async function unblockVisitor(env, blockId, session) {
  const db = env.DB;
  const row = await db
    .prepare(
      `SELECT b.*, c.owner_id FROM channel_blocks b
       JOIN channels c ON c.id = b.channel_id WHERE b.id = ?`,
    )
    .bind(blockId)
    .first();
  if (!row || !canAccess(row.owner_id, session)) throw notFound('记录不存在');
  await db.prepare('DELETE FROM channel_blocks WHERE id = ?').bind(blockId).run();
  return ok({ message: '已移出黑名单' });
}
