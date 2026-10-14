import { badRequest, notFound, ok, readJson } from '../lib/http.js';
import { isValidCustomSlug } from '../lib/keys.js';
import { resolveSlug, releaseSlug } from '../lib/namespace.js';
import { nowSeconds, parseTimestamp, todayKey } from '../lib/time.js';
import { assertHttpUrl, assertOneOf, assertText, optionalHttpUrl, toBoolInt } from '../lib/validate.js';

const ACCESS_RULES = ['any', 'wechat', 'ios', 'android', 'mobile', 'desktop'];
const MAX_LINKS_PER_USER = 5000;

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

export async function listShortLinks(env, url, session) {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? 20)));
  const keyword = (url.searchParams.get('keyword') ?? '').trim();
  const status = url.searchParams.get('status');

  const where = [];
  const params = [];
  // 普通成员只能看到自己的资源
  if (session.role !== 'owner') {
    where.push('owner_id = ?');
    params.push(session.id);
  }
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

export async function createShortLink(env, request, session) {
  const db = env.DB;
  const body = await readJson(request);

  const count = await db
    .prepare('SELECT COUNT(*) AS total FROM short_links WHERE owner_id = ?')
    .bind(session.id)
    .first();
  if ((count?.total ?? 0) >= MAX_LINKS_PER_USER) {
    throw badRequest(`单账号最多创建 ${MAX_LINKS_PER_USER} 条短链`);
  }

  const title = assertText(body.title, '标题', { max: 100 });
  const targetUrl = assertHttpUrl(body.targetUrl, '目标链接');
  const accessRule = assertOneOf(body.accessRule ?? 'any', ACCESS_RULES, '访问限制');

  // 自定义 key 同样要过格式校验；自动生成走 UUID，保证不可枚举。
  if (body.slug && !isValidCustomSlug(body.slug)) {
    throw badRequest('自定义短链只允许 4~32 位字母、数字、下划线与连字符');
  }
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
      title,
      targetUrl,
      accessRule,
      optionalHttpUrl(body.urlIos, 'iOS 目标链接'),
      optionalHttpUrl(body.urlAndroid, 'Android 目标链接'),
      optionalHttpUrl(body.urlDesktop, '桌面端目标链接'),
      toBoolInt(body.rotateDomain),
      parseTimestamp(body.expiredAt),
      optionalHttpUrl(body.expiredJump, '过期跳转链接'),
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

export async function updateShortLink(env, request, id, session) {
  const db = env.DB;
  const row = await db.prepare('SELECT * FROM short_links WHERE id = ?').bind(id).first();
  if (!row || !canAccess(row.owner_id, session)) throw notFound('短链不存在');

  const body = await readJson(request);
  const fields = {};
  if (body.title !== undefined) fields.title = assertText(body.title, '标题', { max: 100 });
  if (body.targetUrl !== undefined) fields.target_url = assertHttpUrl(body.targetUrl, '目标链接');
  if (body.accessRule !== undefined) fields.access_rule = assertOneOf(body.accessRule, ACCESS_RULES, '访问限制');
  if (body.urlIos !== undefined) fields.url_ios = optionalHttpUrl(body.urlIos, 'iOS 目标链接');
  if (body.urlAndroid !== undefined) fields.url_android = optionalHttpUrl(body.urlAndroid, 'Android 目标链接');
  if (body.urlDesktop !== undefined) fields.url_desktop = optionalHttpUrl(body.urlDesktop, '桌面端目标链接');
  if (body.expiredAt !== undefined) fields.expired_at = parseTimestamp(body.expiredAt);
  if (body.expiredJump !== undefined) fields.expired_jump = optionalHttpUrl(body.expiredJump, '过期跳转链接');
  if (body.status !== undefined) fields.status = assertOneOf(body.status, ['active', 'paused'], '状态');
  if (body.rotateDomain !== undefined) fields.rotate_domain = toBoolInt(body.rotateDomain);

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

function canAccess(ownerId, session) {
  return session.role === 'owner' || ownerId === session.id;
}
