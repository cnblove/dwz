import { badRequest, notFound, ok, readJson } from '../lib/http.js';
import { generateUniqueSlug, isValidCustomSlug, isValidKeyLength } from '../lib/keys.js';
import { nowSeconds, todayKey } from '../lib/time.js';
import { assertHttpUrl, assertOneOf, assertText } from '../lib/validate.js';
import { visitorHash } from '../lib/visitor.js';

const ACCESS_RULES = ['any', 'wechat'];

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

async function slugTaken(db, slug) {
  const row = await db
    .prepare('SELECT 1 AS hit FROM channels WHERE slug = ? UNION ALL SELECT 1 FROM short_links WHERE slug = ? LIMIT 1')
    .bind(slug, slug)
    .first();
  return Boolean(row);
}

function canAccess(ownerId, session) {
  return session.role === 'owner' || ownerId === session.id;
}

export async function listChannels(env, url, session) {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? 20)));
  const keyword = (url.searchParams.get('keyword') ?? '').trim();

  const where = [];
  const params = [];
  if (session.role !== 'owner') {
    where.push('owner_id = ?');
    params.push(session.id);
  }
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

export async function createChannel(env, request, session) {
  const db = env.DB;
  const body = await readJson(request);

  const title = assertText(body.title, '标题', { max: 100 });
  const targetUrl = assertHttpUrl(body.targetUrl, '渠道目标链接');
  const accessRule = assertOneOf(body.accessRule ?? 'any', ACCESS_RULES, '访问限制');

  let slug;
  if (body.slug) {
    if (!isValidCustomSlug(body.slug)) throw badRequest('自定义短链只允许 4~32 位字母、数字、下划线与连字符');
    if (await slugTaken(db, body.slug)) throw badRequest('该短链已被占用');
    slug = body.slug;
  } else {
    const length = Number(body.length ?? env.DEFAULT_KEY_LENGTH ?? 6);
    slug = await generateUniqueSlug((candidate) => slugTaken(db, candidate), isValidKeyLength(length) ? length : 6);
  }

  const now = nowSeconds();
  const result = await db
    .prepare(
      `INSERT INTO channels (slug, title, status, target_url, access_rule, owner_id, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`,
    )
    .bind(slug, title, targetUrl, accessRule, session.id, now, now)
    .run();

  const created = await db.prepare('SELECT * FROM channels WHERE id = ?').bind(result.meta?.last_row_id).first();
  return ok({ item: serialize(created) });
}

export async function updateChannel(env, request, id, session) {
  const db = env.DB;
  const row = await db.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first();
  if (!row || !canAccess(row.owner_id, session)) throw notFound('渠道码不存在');

  const body = await readJson(request);
  const fields = {};
  if (body.title !== undefined) fields.title = assertText(body.title, '标题', { max: 100 });
  if (body.targetUrl !== undefined) fields.target_url = assertHttpUrl(body.targetUrl, '渠道目标链接');
  if (body.accessRule !== undefined) fields.access_rule = assertOneOf(body.accessRule, ACCESS_RULES, '访问限制');
  if (body.status !== undefined) fields.status = assertOneOf(body.status, ['active', 'paused'], '状态');

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
  return ok({ message: '已删除' });
}

/** 加黑名单。前端传明文 IP，落库前统一哈希。 */
export async function blockVisitor(env, request, id, session) {
  const db = env.DB;
  const row = await db.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first();
  if (!row || !canAccess(row.owner_id, session)) throw notFound('渠道码不存在');

  const body = await readJson(request);
  const ip = assertText(body.ip, 'IP', { max: 60 });
  const hash = await visitorHash(ip, env.VISITOR_SALT);

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
