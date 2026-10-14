import { badRequest, notFound, ok, readJson, clientIp } from '../lib/http.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { newUuid } from '../lib/ids.js';
import { nowSeconds, parseTimestamp, todayKey } from '../lib/time.js';
import { visitorHash } from '../lib/visitor.js';
import { assertText, optionalHttpUrl, optionalText, toBoolInt, toPositiveInt } from '../lib/validate.js';

/**
 * 卡密分发。
 *
 * 明文只在生成时返回一次，库里存哈希——和登录令牌同样的理由：
 * 库被拖走也不等于卡密被拖走。批次是统计与发放的单位。
 *
 * 兑换接口对同一 IP 做每日限流（默认 5 次），避免有人拿脚本刷库存。
 */
const DEFAULT_REDEEM_LIMIT = 5;
const MAX_BATCH_SIZE = 5000;

function serializeBatch(row, remaining) {
  return {
    id: row.id,
    uuid: row.uuid,
    name: row.name,
    content: row.content,
    total: row.total,
    used: row.used,
    remaining: remaining ?? Math.max(0, row.total - row.used),
    expiredAt: row.expired_at,
    redirectUrl: row.redirect_url,
    status: row.status,
    remark: row.remark,
    lowStock: row.low_stock,
    notifyChannel: row.notify_channel,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function canAccess(ownerId, session) {
  return session.role === 'owner' || ownerId === session.id;
}

export async function listBatches(env, url, session) {
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
    where.push('name LIKE ?');
    params.push(`%${keyword}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM cardkey_batches ${clause}`).bind(...params).first();
  const { results = [] } = await env.DB
    .prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM cardkeys k WHERE k.batch_id = b.id AND k.status = 'unused') AS remaining
       FROM cardkey_batches b ${clause} ORDER BY b.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all();

  return ok({
    total: totalRow?.total ?? 0,
    page,
    pageSize,
    items: results.map((row) => serializeBatch(row, row.remaining)),
  });
}

/** 生成一批卡密。明文在本次响应里返回，之后不可再取。 */
export async function createBatch(env, request, session) {
  const body = await readJson(request);
  const name = assertText(body.name, '批次名称', { max: 80 });
  const content = assertText(body.content, '卡密内容', { max: 500 });
  const count = toPositiveInt(body.count ?? 1, '生成数量', { min: 1, max: MAX_BATCH_SIZE });
  const expiredAt = parseTimestamp(body.expiredAt);
  const redirectUrl = optionalHttpUrl(body.redirectUrl, '兑换后跳转地址');
  const lowStock = toPositiveInt(body.lowStock ?? 0, '库存告警阈值', { min: 0, max: MAX_BATCH_SIZE });
  const notifyChannel = body.notifyChannel ? Number(body.notifyChannel) : null;

  const now = nowSeconds();
  // 导入模式：调用方自带明文（CSV 粘贴），数量以实际解析结果为准
  const provided = parseProvidedCodes(body.codeList ?? body.codes);
  const total = provided.length ? provided.length : count;

  const result = await env.DB
    .prepare(
      `INSERT INTO cardkey_batches (uuid, name, content, total, used, expired_at, redirect_url, status, remark, low_stock, notify_channel, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(newUuid(), name, content, total, expiredAt, redirectUrl, optionalText(body.remark, 100), lowStock, notifyChannel, session.id, now, now)
    .run();

  const batchId = result.meta?.last_row_id;
  const plaintext = await insertKeys(env.DB, batchId, total, now, provided);

  const created = await env.DB.prepare('SELECT * FROM cardkey_batches WHERE id = ?').bind(batchId).first();
  return ok({
    item: serializeBatch(created, total),
    // 明文只出现这一次，前端需要提示用户立即保存
    codes: plaintext,
    message: '卡密明文仅显示一次，请立即保存',
  });
}

/**
 * 批量写入卡密，库里只留哈希与首尾提示。
 *
 * 优先使用调用方提供的明文（CSV 导入，运营自己准备好了卡号），
 * 没有就现场随机生成。两种情况都要在批内去重、跨批靠 code_hash 的 UNIQUE 兜底。
 */
async function insertKeys(db, batchId, count, now, provided = null) {
  const plaintext = provided ? provided.slice(0, count) : [];
  const seen = new Set(plaintext);
  while (plaintext.length < count) {
    const code = `DWZ-${randomToken(4).toUpperCase()}-${randomToken(4).toUpperCase()}-${randomToken(4).toUpperCase()}`;
    if (seen.has(code)) continue;
    seen.add(code);
    plaintext.push(code);
  }

  const statements = [];
  for (const code of plaintext) {
    // eslint-disable-next-line no-await-in-loop
    statements.push(
      db
        .prepare('INSERT INTO cardkeys (batch_id, code_hash, code_hint, status, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(batchId, await sha256Hex(code), hintOf(code), 'unused', now),
    );
  }
  await db.batch(statements);
  return plaintext;
}

/**
 * 解析导入的卡密明文。
 * 支持一行一个，也容忍「卡密,有效期,备注」这类 CSV 行 —— 只取第一列。
 * 空行、重复行直接丢掉，避免生成一堆无效卡密。
 */
export function parseProvidedCodes(raw) {
  const text = String(raw ?? '');
  if (!text.trim()) return [];
  const out = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    let value = line.trim();
    if (!value || value.startsWith('#')) continue;
    if (value.includes(',')) value = value.split(',')[0].trim();
    value = value.replace(/^"|"$/g, '').trim();
    if (!value) continue;
    const key = value.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= MAX_BATCH_SIZE) break;
  }
  return out;
}

function hintOf(code) {
  return `${code.slice(0, 8)}****${code.slice(-4)}`;
}

export async function getBatch(env, id, session) {
  const row = await env.DB.prepare('SELECT * FROM cardkey_batches WHERE id = ?').bind(id).first();
  if (!row) throw notFound('批次不存在');
  if (!canAccess(row.owner_id, session)) throw notFound('批次不存在');

  const remainRow = await env.DB
    .prepare("SELECT COUNT(*) AS total FROM cardkeys WHERE batch_id = ? AND status = 'unused'")
    .bind(id)
    .first();
  const { results = [] } = await env.DB
    .prepare('SELECT * FROM cardkey_redeems WHERE batch_id = ? ORDER BY id DESC LIMIT 50')
    .bind(id)
    .all();

  return ok({
    item: serializeBatch(row, remainRow?.total ?? 0),
    redeems: results.map((item) => ({
      id: item.id,
      ipHint: item.ip_hash.slice(0, 8),
      ua: item.ua,
      day: item.day,
      createdAt: item.created_at,
    })),
  });
}

export async function updateBatch(env, request, id, session) {
  const row = await env.DB.prepare('SELECT * FROM cardkey_batches WHERE id = ?').bind(id).first();
  if (!row) throw notFound('批次不存在');
  if (!canAccess(row.owner_id, session)) throw notFound('批次不存在');

  const body = await readJson(request);
  const fields = {};
  if (body.name !== undefined) fields.name = assertText(body.name, '批次名称', { max: 80 });
  if (body.content !== undefined) fields.content = assertText(body.content, '卡密内容', { max: 500 });
  if (body.status !== undefined) fields.status = body.status === 'paused' ? 'paused' : 'active';
  if (body.expiredAt !== undefined) fields.expired_at = parseTimestamp(body.expiredAt);
  if (body.redirectUrl !== undefined) fields.redirect_url = optionalHttpUrl(body.redirectUrl, '兑换后跳转地址');
  if (body.remark !== undefined) fields.remark = optionalText(body.remark, 100);
  if (body.lowStock !== undefined) fields.low_stock = toPositiveInt(body.lowStock, '库存告警阈值', { min: 0, max: MAX_BATCH_SIZE });
  if (body.notifyChannel !== undefined) fields.notify_channel = body.notifyChannel ? Number(body.notifyChannel) : null;

  if (Object.keys(fields).length === 0) throw badRequest('没有需要更新的字段');
  fields.updated_at = nowSeconds();

  const assignments = Object.keys(fields).map((key) => `${key} = ?`).join(', ');
  await env.DB.prepare(`UPDATE cardkey_batches SET ${assignments} WHERE id = ?`)
    .bind(...Object.values(fields), id)
    .run();

  const updated = await env.DB.prepare('SELECT * FROM cardkey_batches WHERE id = ?').bind(id).first();
  return ok({ item: serializeBatch(updated) });
}

/** 删除批次：卡密与兑换记录随外键级联删除。 */
export async function deleteBatch(env, id, session) {
  const row = await env.DB.prepare('SELECT * FROM cardkey_batches WHERE id = ?').bind(id).first();
  if (!row) throw notFound('批次不存在');
  if (!canAccess(row.owner_id, session)) throw notFound('批次不存在');
  await env.DB.prepare('DELETE FROM cardkey_batches WHERE id = ?').bind(id).run();
  return ok({ message: '已删除' });
}

/** 追加生成：给已有批次补充卡密，返回明文。 */
export async function appendKeys(env, request, id, session) {
  const row = await env.DB.prepare('SELECT * FROM cardkey_batches WHERE id = ?').bind(id).first();
  if (!row) throw notFound('批次不存在');
  if (!canAccess(row.owner_id, session)) throw notFound('批次不存在');

  const body = await readJson(request);
  const requested = toPositiveInt(body.count ?? 1, '生成数量', { min: 1, max: MAX_BATCH_SIZE });
  const provided = parseProvidedCodes(body.codeList ?? body.codes);
  const count = provided.length ? provided.length : requested;

  const now = nowSeconds();
  const plaintext = await insertKeys(env.DB, id, count, now, provided);

  await env.DB
    .prepare('UPDATE cardkey_batches SET total = total + ?, updated_at = ? WHERE id = ?')
    .bind(count, now, id)
    .run();

  return ok({ codes: plaintext, count, message: '卡密明文仅显示一次，请立即保存' });
}

/* ---------------- 兑换（对外） ---------------- */

/**
 * 兑换。不需要登录，但有限流：
 * 同一 IP 每天最多兑换 REDEEM_DAILY_LIMIT 次，超限直接拒绝。
 */
export async function redeem(env, request, { limit = DEFAULT_REDEEM_LIMIT } = {}) {
  const body = await readJson(request);
  const code = assertText(body.code ?? body.cardkey, '卡密', { max: 80 }).toUpperCase();

  const ip = clientIp(request);
  const day = todayKey();
  const ipHash = await visitorHash(ip, env.VISITOR_SALT);

  // 限流用一条「先占额度」的写入完成：
  // 先 COUNT 再兑换的写法在并发下会被绕过（多个请求同时读到未超限），
  // 这里先把本次尝试记成一条占位记录，再判断是否超额，超额就删掉自己那条。
  const quota = await env.DB
    .prepare(
      `INSERT INTO cardkey_redeems (batch_id, cardkey_id, ip_hash, ua, day, created_at)
       SELECT NULL, NULL, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM cardkey_redeems WHERE ip_hash = ? AND day = ?) < ?`,
    )
    .bind(ipHash, (request.headers.get('user-agent') || '').slice(0, 300), day, nowSeconds(), ipHash, day, limit)
    .run();
  if (!quota.meta?.changes) {
    throw badRequest('今天的兑换次数已达上限，请明天再试');
  }
  const slotId = quota.meta?.last_row_id;

  try {
    const hash = await sha256Hex(code);
    const key = await env.DB.prepare('SELECT * FROM cardkeys WHERE code_hash = ?').bind(hash).first();
    if (!key) throw notFound('卡密不存在或已被使用');
    if (key.status === 'used') throw badRequest('该卡密已被使用');
    if (key.status === 'disabled') throw badRequest('该卡密已被禁用');

    const batch = await env.DB.prepare('SELECT * FROM cardkey_batches WHERE id = ?').bind(key.batch_id).first();
    if (!batch) throw notFound('卡密对应的批次不存在');
    if (batch.status !== 'active') throw badRequest('该批次已暂停发放');
    if (batch.expired_at && batch.expired_at <= nowSeconds()) throw badRequest('该批次已过期');

    const now = nowSeconds();
    // 抢单保护：只有把状态从 unused 改成 used 的那次请求才算成功。
    const updated = await env.DB
      .prepare("UPDATE cardkeys SET status = 'used', used_at = ?, used_ip = ?, used_ua = ? WHERE id = ? AND status = 'unused'")
      .bind(now, ipHash, (request.headers.get('user-agent') || '').slice(0, 300), key.id)
      .run();
    if (!updated.meta?.changes) throw badRequest('该卡密已被使用');

    // 候补记录补全为真实兑换记录；批次已用数用原子自增，避免与剩余量对不上。
    await env.DB
      .prepare('UPDATE cardkey_redeems SET batch_id = ?, cardkey_id = ? WHERE id = ?')
      .bind(batch.id, key.id, slotId)
      .run();
    await env.DB
      .prepare('UPDATE cardkey_batches SET used = used + 1, updated_at = ? WHERE id = ?')
      .bind(now, batch.id)
      .run();

    return ok({
      content: batch.content,
      redirectUrl: batch.redirect_url,
      batchName: batch.name,
      redeemedAt: now,
    });
  } catch (error) {
    // 失败不占用当日额度，否则用户被「卡密已被使用」挡一次就少一次机会。
    await env.DB
      .prepare('DELETE FROM cardkey_redeems WHERE id = ? AND cardkey_id IS NULL')
      .bind(slotId)
      .run();
    throw error;
  }
}
