import { badRequest, notFound, ok, readJson } from '../lib/http.js';
import { generateUniqueSlug, isValidCustomSlug, isValidKeyLength } from '../lib/keys.js';
import { nowSeconds, todayKey } from '../lib/time.js';
import { assertHttpUrl, assertOneOf, assertText, optionalHttpUrl, optionalText, toBoolInt, toPositiveInt } from '../lib/validate.js';

const KINDS = ['group', 'service'];
const PICK_MODES = ['threshold', 'random'];

function serializeCode(row) {
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    title: row.title,
    status: row.status,
    hits: row.hits,
    hitsToday: row.hits_today_on === todayKey() ? row.hits_today : 0,
    sticky: Boolean(row.sticky),
    showSafety: Boolean(row.show_safety),
    remark: row.remark,
    pickMode: row.pick_mode,
    showOnline: Boolean(row.show_online),
    onlineHours: safeJson(row.online_hours, null),
    fallbackUrl: row.fallback_url,
    fallbackOn: Boolean(row.fallback_on),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeQrcode(row) {
  return {
    id: row.id,
    imageUrl: row.image_url,
    contact: row.contact,
    threshold: row.threshold,
    hits: row.hits,
    longPress: row.long_press,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

async function slugTaken(db, slug) {
  const row = await db
    .prepare('SELECT 1 AS hit FROM codes WHERE slug = ? UNION ALL SELECT 1 FROM short_links WHERE slug = ? LIMIT 1')
    .bind(slug, slug)
    .first();
  return Boolean(row);
}

function canAccess(ownerId, session) {
  return session.role === 'owner' || ownerId === session.id;
}

export async function listCodes(env, url, session) {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? 20)));
  const kind = url.searchParams.get('kind');
  const keyword = (url.searchParams.get('keyword') ?? '').trim();

  const where = [];
  const params = [];
  if (session.role !== 'owner') {
    where.push('owner_id = ?');
    params.push(session.id);
  }
  if (kind && KINDS.includes(kind)) {
    where.push('kind = ?');
    params.push(kind);
  }
  if (keyword) {
    where.push('(title LIKE ? OR slug LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM codes ${clause}`).bind(...params).first();
  const { results = [] } = await env.DB.prepare(
    `SELECT * FROM codes ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all();

  // 列表页顺带带上子码数量与已用阈值，省去前端再发一轮请求
  const items = [];
  for (const row of results) {
    const agg = await env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
              COALESCE(SUM(hits), 0) AS hits
       FROM code_qrcodes WHERE code_id = ?`,
    )
      .bind(row.id)
      .first();
    items.push({ ...serializeCode(row), qrcodeCount: agg?.total ?? 0, qrcodeActive: agg?.active_count ?? 0 });
  }

  return ok({ total: totalRow?.total ?? 0, page, pageSize, items });
}

export async function getCode(env, id, session) {
  const row = await env.DB.prepare('SELECT * FROM codes WHERE id = ?').bind(id).first();
  if (!row || !canAccess(row.owner_id, session)) throw notFound('活码不存在');
  const { results = [] } = await env.DB.prepare(
    'SELECT * FROM code_qrcodes WHERE code_id = ? ORDER BY id',
  )
    .bind(id)
    .all();
  return ok({ item: serializeCode(row), qrcodes: results.map(serializeQrcode) });
}

export async function createCode(env, request, session) {
  const db = env.DB;
  const body = await readJson(request);

  const kind = assertOneOf(body.kind, KINDS, '活码类型');
  const title = assertText(body.title, '标题', { max: 100 });
  const pickMode = assertOneOf(body.pickMode ?? 'threshold', PICK_MODES, '选取模式');

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
      `INSERT INTO codes
       (slug, kind, title, status, sticky, show_safety, remark, notify_channel, pick_mode,
        show_online, online_hours, fallback_url, fallback_on, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      slug,
      kind,
      title,
      toBoolInt(body.sticky),
      toBoolInt(body.showSafety, 1),
      optionalText(body.remark, 500),
      optionalText(body.notifyChannel, 100),
      pickMode,
      toBoolInt(body.showOnline),
      body.onlineHours ? JSON.stringify(normalizeOnlineHours(body.onlineHours)) : null,
      optionalHttpUrl(body.fallbackUrl, '兜底客服码'),
      toBoolInt(body.fallbackOn),
      session.id,
      now,
      now,
    )
    .run();

  const created = await db.prepare('SELECT * FROM codes WHERE id = ?').bind(result.meta?.last_row_id).first();
  return ok({ item: serializeCode(created) });
}

export async function updateCode(env, request, id, session) {
  const db = env.DB;
  const row = await db.prepare('SELECT * FROM codes WHERE id = ?').bind(id).first();
  if (!row || !canAccess(row.owner_id, session)) throw notFound('活码不存在');

  const body = await readJson(request);
  const fields = {};
  if (body.title !== undefined) fields.title = assertText(body.title, '标题', { max: 100 });
  if (body.status !== undefined) fields.status = assertOneOf(body.status, ['active', 'paused'], '状态');
  if (body.sticky !== undefined) fields.sticky = toBoolInt(body.sticky);
  if (body.showSafety !== undefined) fields.show_safety = toBoolInt(body.showSafety);
  if (body.remark !== undefined) fields.remark = optionalText(body.remark, 500);
  if (body.notifyChannel !== undefined) fields.notify_channel = optionalText(body.notifyChannel, 100);
  if (body.pickMode !== undefined) fields.pick_mode = assertOneOf(body.pickMode, PICK_MODES, '选取模式');
  if (body.showOnline !== undefined) fields.show_online = toBoolInt(body.showOnline);
  if (body.onlineHours !== undefined) {
    fields.online_hours = body.onlineHours ? JSON.stringify(normalizeOnlineHours(body.onlineHours)) : null;
  }
  if (body.fallbackUrl !== undefined) fields.fallback_url = optionalHttpUrl(body.fallbackUrl, '兜底客服码');
  if (body.fallbackOn !== undefined) fields.fallback_on = toBoolInt(body.fallbackOn);

  if (Object.keys(fields).length === 0) throw badRequest('没有需要更新的字段');
  fields.updated_at = nowSeconds();

  const assignments = Object.keys(fields).map((key) => `${key} = ?`).join(', ');
  await db
    .prepare(`UPDATE codes SET ${assignments} WHERE id = ?`)
    .bind(...Object.values(fields), id)
    .run();

  const updated = await db.prepare('SELECT * FROM codes WHERE id = ?').bind(id).first();
  return ok({ item: serializeCode(updated) });
}

export async function deleteCode(env, id, session) {
  const row = await env.DB.prepare('SELECT * FROM codes WHERE id = ?').bind(id).first();
  if (!row || !canAccess(row.owner_id, session)) throw notFound('活码不存在');
  await env.DB.prepare('DELETE FROM codes WHERE id = ?').bind(id).run();
  return ok({ message: '已删除' });
}

/* ---------------- 子码 ---------------- */

export async function addQrcode(env, request, codeId, session) {
  const db = env.DB;
  const code = await db.prepare('SELECT * FROM codes WHERE id = ?').bind(codeId).first();
  if (!code || !canAccess(code.owner_id, session)) throw notFound('活码不存在');

  const body = await readJson(request);
  const imageUrl = assertHttpUrl(body.imageUrl, '二维码地址');
  const threshold = body.threshold === undefined
    ? (code.kind === 'group' ? 200 : 0)
    : toPositiveInt(body.threshold, '阈值', { min: 0, max: 1000000 });

  const now = nowSeconds();
  const result = await db
    .prepare(
      `INSERT INTO code_qrcodes (code_id, image_url, contact, threshold, status, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    )
    .bind(codeId, imageUrl, optionalText(body.contact, 100), threshold, now)
    .run();

  const created = await db.prepare('SELECT * FROM code_qrcodes WHERE id = ?').bind(result.meta?.last_row_id).first();
  return ok({ item: serializeQrcode(created) });
}

export async function updateQrcode(env, request, qrcodeId, session) {
  const db = env.DB;
  const row = await db.prepare('SELECT * FROM code_qrcodes WHERE id = ?').bind(qrcodeId).first();
  if (!row) throw notFound('子码不存在');
  const code = await db.prepare('SELECT * FROM codes WHERE id = ?').bind(row.code_id).first();
  if (!code || !canAccess(code.owner_id, session)) throw notFound('子码不存在');

  const body = await readJson(request);
  const fields = {};
  if (body.imageUrl !== undefined) fields.image_url = assertHttpUrl(body.imageUrl, '二维码地址');
  if (body.contact !== undefined) fields.contact = optionalText(body.contact, 100);
  if (body.threshold !== undefined) fields.threshold = toPositiveInt(body.threshold, '阈值', { min: 0, max: 1000000 });
  if (body.status !== undefined) fields.status = assertOneOf(body.status, ['active', 'disabled'], '状态');

  if (Object.keys(fields).length === 0) throw badRequest('没有需要更新的字段');
  fields.updated_at = nowSeconds();

  const assignments = Object.keys(fields).map((key) => `${key} = ?`).join(', ');
  await db
    .prepare(`UPDATE code_qrcodes SET ${assignments} WHERE id = ?`)
    .bind(...Object.values(fields), qrcodeId)
    .run();

  const updated = await db.prepare('SELECT * FROM code_qrcodes WHERE id = ?').bind(qrcodeId).first();
  return ok({ item: serializeQrcode(updated) });
}

export async function deleteQrcode(env, qrcodeId, session) {
  const db = env.DB;
  const row = await db.prepare('SELECT * FROM code_qrcodes WHERE id = ?').bind(qrcodeId).first();
  if (!row) throw notFound('子码不存在');
  const code = await db.prepare('SELECT * FROM codes WHERE id = ?').bind(row.code_id).first();
  if (!code || !canAccess(code.owner_id, session)) throw notFound('子码不存在');
  await db.prepare('DELETE FROM code_qrcodes WHERE id = ?').bind(qrcodeId).run();
  return ok({ message: '已删除' });
}

export async function resetQrcodeHits(env, qrcodeId, session) {
  const db = env.DB;
  const row = await db.prepare('SELECT * FROM code_qrcodes WHERE id = ?').bind(qrcodeId).first();
  if (!row) throw notFound('子码不存在');
  const code = await db.prepare('SELECT * FROM codes WHERE id = ?').bind(row.code_id).first();
  if (!code || !canAccess(code.owner_id, session)) throw notFound('子码不存在');
  await db.prepare('UPDATE code_qrcodes SET hits = 0 WHERE id = ?').bind(qrcodeId).run();
  return ok({ message: '统计已重置' });
}

export async function createMerge(env, request, session) {
  const db = env.DB;
  const body = await readJson(request);
  const fromId = toPositiveInt(body.fromCodeId, '原活码 ID', { min: 1, max: Number.MAX_SAFE_INTEGER });
  const toId = toPositiveInt(body.toCodeId, '并入活码 ID', { min: 1, max: Number.MAX_SAFE_INTEGER });
  if (fromId === toId) throw badRequest('不能并入自身');

  const [from, to] = await Promise.all([
    db.prepare('SELECT * FROM codes WHERE id = ?').bind(fromId).first(),
    db.prepare('SELECT * FROM codes WHERE id = ?').bind(toId).first(),
  ]);
  if (!from || !canAccess(from.owner_id, session)) throw notFound('原活码不存在');
  if (!to) throw notFound('目标活码不存在');
  if (from.kind !== 'group' || to.kind !== 'group') throw badRequest('并流仅支持群活码');

  const now = nowSeconds();
  await db
    .prepare(
      `INSERT INTO code_merges (from_code_id, from_slug, to_code_id, status, created_by, created_at)
       VALUES (?, ?, ?, 'active', ?, ?)
       ON CONFLICT (from_code_id) DO UPDATE SET to_code_id = excluded.to_code_id, status = 'active'`,
    )
    .bind(fromId, from.slug, toId, session.id, now)
    .run();

  return ok({ message: '并流已设置' });
}

export async function deleteMerge(env, codeId, session) {
  const db = env.DB;
  const code = await db.prepare('SELECT * FROM codes WHERE id = ?').bind(codeId).first();
  if (!code || !canAccess(code.owner_id, session)) throw notFound('活码不存在');
  await db.prepare('DELETE FROM code_merges WHERE from_code_id = ?').bind(codeId).run();
  return ok({ message: '已取消并流' });
}

/** 在线时段配置容错：过滤掉格式不对的项，避免一处脏数据导致整段渲染失败。 */
function normalizeOnlineHours(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const [day, ranges] of Object.entries(input)) {
    const dayNum = Number(day);
    if (!Number.isInteger(dayNum) || dayNum < 1 || dayNum > 7) continue;
    if (!Array.isArray(ranges)) continue;
    const cleaned = ranges
      .map((range) => String(range ?? '').trim())
      .filter((range) => /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(range));
    if (cleaned.length) out[String(dayNum)] = cleaned;
  }
  return out;
}

function safeJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
