import { badRequest, notFound, ok } from '../lib/http.js';
import { resolveSlug, releaseSlug, renameSlug } from '../lib/namespace.js';
import { canAccess, ownerScope } from '../lib/scope.js';
import { assertQuota } from '../lib/quota.js';
import { nowSeconds, todayKey } from '../lib/time.js';


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
    notifyChannel: row.notify_channel,
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


export async function listCodes(env, query, session) {
  const { page, pageSize, kind, keyword } = query;

  // 超管看全部、成员只看自己的：口径收在 lib/scope.js，不再各处手写
  const scope = ownerScope(session);
  const where = [];
  const params = [...scope.params];
  if (scope.clause) where.push(scope.clause.replace(/^AND /, ''));
  if (kind && (kind === 'group' || kind === 'service')) {
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

export async function createCode(env, body, session) {
  const db = env.DB;
  await assertQuota(db, session, 'codes');
  const slug = await resolveSlug(db, { slug: body.slug });

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
      body.kind,
      body.title,
      body.sticky,
      body.showSafety,
      body.remark,
      body.notifyChannel,
      body.pickMode,
      body.showOnline,
      body.onlineHours,
      body.fallbackUrl,
      body.fallbackOn,
      session.id,
      now,
      now,
    )
    .run();

  const created = await db.prepare('SELECT * FROM codes WHERE id = ?').bind(result.meta?.last_row_id).first();
  return ok({ item: serializeCode(created) });
}

export async function updateCode(env, body, id, session) {
  const db = env.DB;
  const row = await db.prepare('SELECT * FROM codes WHERE id = ?').bind(id).first();
  if (!row || !canAccess(row.owner_id, session)) throw notFound('活码不存在');

  const fields = {};
  if (body.slug !== undefined) fields.slug = await renameSlug(db, { from: row.slug, to: body.slug });
  if (body.title !== undefined) fields.title = body.title;
  if (body.status !== undefined) fields.status = body.status;
  if (body.sticky !== undefined) fields.sticky = body.sticky;
  if (body.showSafety !== undefined) fields.show_safety = body.showSafety;
  if (body.remark !== undefined) fields.remark = body.remark;
  if (body.notifyChannel !== undefined) fields.notify_channel = body.notifyChannel;
  if (body.pickMode !== undefined) fields.pick_mode = body.pickMode;
  if (body.showOnline !== undefined) fields.show_online = body.showOnline;
  if (body.onlineHours !== undefined) fields.online_hours = body.onlineHours;
  if (body.fallbackUrl !== undefined) fields.fallback_url = body.fallbackUrl;
  if (body.fallbackOn !== undefined) fields.fallback_on = body.fallbackOn;

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
  await releaseSlug(env.DB, row.slug);
  return ok({ message: '已删除' });
}

/* ---------------- 子码 ---------------- */

export async function addQrcode(env, body, codeId, session) {
  const db = env.DB;
  const code = await db.prepare('SELECT * FROM codes WHERE id = ?').bind(codeId).first();
  if (!code || !canAccess(code.owner_id, session)) throw notFound('活码不存在');

  // 子码配额按「该账号名下所有活码的子码总数」算：一个群码塞 200 张图
  // 才是真正撑不住的那种用法，按单个活码卡反而管不到。
  await assertQuota(db, session, 'qrcodes');

  // 未传阈值时按活码类型给默认值：群活码 200，客服码 0
  const threshold = body.threshold === undefined
    ? (code.kind === 'group' ? 200 : 0)
    : body.threshold;

  const now = nowSeconds();
  const result = await db
    .prepare(
      `INSERT INTO code_qrcodes (code_id, image_url, contact, threshold, status, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    )
    .bind(codeId, body.imageUrl, body.contact, threshold, now)
    .run();

  const created = await db.prepare('SELECT * FROM code_qrcodes WHERE id = ?').bind(result.meta?.last_row_id).first();
  return ok({ item: serializeQrcode(created) });
}

export async function updateQrcode(env, body, qrcodeId, session) {
  const db = env.DB;
  const row = await db.prepare('SELECT * FROM code_qrcodes WHERE id = ?').bind(qrcodeId).first();
  if (!row) throw notFound('子码不存在');
  const code = await db.prepare('SELECT * FROM codes WHERE id = ?').bind(row.code_id).first();
  if (!code || !canAccess(code.owner_id, session)) throw notFound('子码不存在');

  const fields = {};
  if (body.imageUrl !== undefined) fields.image_url = body.imageUrl;
  if (body.contact !== undefined) fields.contact = body.contact;
  if (body.threshold !== undefined) fields.threshold = body.threshold;
  if (body.status !== undefined) fields.status = body.status;

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

export async function createMerge(env, body, session) {
  const db = env.DB;
  const { fromCodeId: fromId, toCodeId: toId } = body;

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

function safeJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
