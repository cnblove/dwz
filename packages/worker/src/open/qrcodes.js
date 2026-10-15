import { badRequest, notFound, ok } from '../lib/http.js';
import * as codes from '../routes/codes.js';
import { authorizeCall } from '../lib/openApiCore.js';
import { nowSeconds } from '../lib/time.js';
import {
  createQrcodeSchema,
  listQrcodesSchema,
  mergeRemoveSchema,
  mergeSetSchema,
  qrcodeRefSchema,
  updateQrcodeApiSchema,
} from '../schemas/openResource.js';

/**
 * 活码子码的对外增删改查。
 *
 * 为什么要单开一个文件：活码不是一个「有 slug 的跳转资源」，
 * 它是一个**容器** —— 真正决定访客扫到哪张二维码的是它底下的子码。
 * 只开放宿主的增删，等于把最需要脚本化的那半边锁在后台里。
 *
 * 定位口径刻意分两层：
 *   - 宿主用 slug：与其它资源一致，调用方不需要知道内部自增 id；
 *   - 子码用 `dv1_qrcode`：允许写数字 id，也允许写「第几张」（从 1 开始）——
 *     并流、换图这类操作里，脚本往往只知道序号，逼它先查一次 id 没有意义。
 *
 * 权限与资源动作同口径：宿主不属于该凭证的主人，就当作子码不存在。
 * 子码是宿主的附属物，不单独存在「能看到别人子码」的可能。
 */


/* ---------------- 并流 ---------------- */

/**
 * 并流：把 A 活码的访客导流到 B 活码。
 *
 * 定位方式与子码一致（宿主 slug 走 `dv1_slug`），但额外需要一个目标 ——
 * 用 `dv1_to_slug` 而不是 id：调用方拿到的永远是 slug，
 * 让它在开放接口里回头去查内部自增 id 没有意义。
 *
 * 两个活码都必须属于这张凭证的主人：并流会把 A 的访客导到 B，
 * 若 B 是别人的活码，就等于把流量送给了别人名下的落地页。
 */
export async function setMergeAction(env, body, request) {
  const { cred, input } = await authorizeCall(env, request, body, mergeSetSchema);
  const from = await loadOwner(env, cred, input.dv1_slug);

  const to = await env.DB.prepare('SELECT * FROM codes WHERE slug = ?').bind(input.dv1_to_slug).first();
  if (!to || to.owner_id !== cred.user_id) throw notFound('目标活码不存在');
  if (to.id === from.id) throw badRequest('目标活码不能是它自己');

  await codes.createMerge(env, { fromCodeId: from.id, toCodeId: to.id }, { id: cred.user_id, role: 'member' });
  return ok({ resource: 'codes', from: from.slug, to: to.slug });
}

/** 取消并流：活码本身照旧可用，只是不再把访客导去别处。 */
export async function removeMergeAction(env, body, request) {
  const { cred, input } = await authorizeCall(env, request, body, mergeRemoveSchema);
  const from = await loadOwner(env, cred, input.dv1_slug);
  const { results = [] } = await env.DB
    .prepare('SELECT id FROM code_merges WHERE from_code_id = ?')
    .bind(from.id)
    .all();
  if (!results.length) throw notFound('该活码没有设置并流');
  await codes.deleteMerge(env, from.id, { id: cred.user_id, role: 'member' });
  return ok({ resource: 'codes', slug: from.slug, removed: true });
}

function serializeQrcode(row) {
  return {
    id: row.id,
    index: row.idx,
    imageUrl: row.image_url,
    contact: row.contact,
    threshold: row.threshold,
    hits: row.hits,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

function serializeOwner(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    status: row.status,
    pickMode: row.pick_mode,
    fallbackUrl: row.fallback_url,
    qrcodeCount: row.qrcode_count ?? 0,
  };
}

/** 按 slug 取宿主，顺带把「不是我的」折叠成「不存在」。 */
async function loadOwner(env, cred, slug) {
  const row = await env.DB.prepare('SELECT * FROM codes WHERE slug = ?').bind(slug).first();
  if (!row || row.owner_id !== cred.user_id) throw notFound('活码不存在');
  return row;
}

/** 取子码列表，`idx` 是它在该宿主下的序号（从 1 开始）。 */
async function listQrcodes(env, codeId) {
  const { results = [] } = await env.DB
    .prepare('SELECT *, ROW_NUMBER() OVER (ORDER BY id) AS idx FROM code_qrcodes WHERE code_id = ? ORDER BY id')
    .bind(codeId)
    .all();
  return results;
}

/**
 * 把 `dv1_qrcode` 解成一行子码（带 `idx`）。
 *
 * 数字 id 优先：序号会随删除而变，而 id 不会 —— 同一个数字两种含义时，
 * 认 id 至少不会「刚才删的那张，第二次却删了别的」。
 */
async function findQrcode(env, codeId, ref) {
  // 一次 SQL 同时按 id 与序号找：序号靠 `id <= 自身` 的行数算出来，
  // 不依赖「先读全表再取第 n 个」——那在并发的增删下会算错。
  const row = await env.DB
    .prepare(
      `SELECT q.*, (SELECT COUNT(*) FROM code_qrcodes WHERE code_id = q.code_id AND id <= q.id) AS idx
         FROM code_qrcodes q
        WHERE q.code_id = ?
          AND (q.id = ? OR (? >= 1 AND (SELECT COUNT(*) FROM code_qrcodes WHERE code_id = q.code_id AND id <= q.id) = ?))
        ORDER BY q.id
        LIMIT 1`,
    )
    .bind(codeId, Number(ref), Number(ref), Number(ref))
    .first();
  return row ?? null;
}

export async function listQrcodesAction(env, body, request) {
  const { cred, input } = await authorizeCall(env, request, body, listQrcodesSchema);
  const owner = await loadOwner(env, cred, input.dv1_slug);
  const rows = await listQrcodes(env, owner.id);
  return ok({
    resource: 'codes',
    type: '子码',
    code: serializeOwner({ ...owner, qrcode_count: rows.length }),
    total: rows.length,
    items: rows.map(serializeQrcode),
  });
}

export async function createQrcodeAction(env, body, request) {
  const { cred, input } = await authorizeCall(env, request, body, createQrcodeSchema);
  const owner = await loadOwner(env, cred, input.dv1_slug);

  // 未传阈值时按活码类型给默认值，与后台口径一致：群活码 200，客服码 0。
  const threshold = input.dv1_threshold === undefined ? (owner.kind === 'group' ? 200 : 0) : input.dv1_threshold;
  const now = nowSeconds();
  const result = await env.DB
    .prepare(
      `INSERT INTO code_qrcodes (code_id, image_url, contact, threshold, status, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    )
    .bind(owner.id, input.dv1_image_url, input.dv1_contact, threshold, now)
    .run();

  // 回读并补上序号：调用方拿到的结构必须与列表里的一模一样，
  // 否则「创建后用返回的 id 再查一次」会得到两种形状。
  const created = await findQrcode(env, owner.id, String(result.meta?.last_row_id));
  return ok({ resource: 'codes', type: '子码', code: serializeOwner(owner), item: serializeQrcode(created) });
}

export async function updateQrcodeAction(env, body, request) {
  const { cred, input } = await authorizeCall(env, request, body, updateQrcodeApiSchema);
  const owner = await loadOwner(env, cred, input.dv1_slug);
  const row = await findQrcode(env, owner.id, input.dv1_qrcode);
  if (!row) throw notFound('子码不存在');

  const fields = {};
  if (input.dv1_image_url !== undefined) fields.image_url = input.dv1_image_url;
  if (input.dv1_contact !== undefined) fields.contact = input.dv1_contact;
  if (input.dv1_threshold !== undefined) fields.threshold = input.dv1_threshold;
  if (input.dv1_status !== undefined) fields.status = input.dv1_status;
  if (Object.keys(fields).length === 0) throw badRequest('没有需要更新的字段');
  fields.updated_at = nowSeconds();

  const assignments = Object.keys(fields).map((key) => `${key} = ?`).join(', ');
  await env.DB
    .prepare(`UPDATE code_qrcodes SET ${assignments} WHERE id = ?`)
    .bind(...Object.values(fields), row.id)
    .run();

  const updated = await findQrcode(env, owner.id, String(row.id));
  return ok({ resource: 'codes', type: '子码', code: serializeOwner(owner), item: serializeQrcode(updated) });
}

export async function deleteQrcodeAction(env, body, request) {
  const { cred, input } = await authorizeCall(env, request, body, qrcodeRefSchema);
  const owner = await loadOwner(env, cred, input.dv1_slug);
  const row = await findQrcode(env, owner.id, input.dv1_qrcode);
  if (!row) throw notFound('子码不存在');

  await env.DB.prepare('DELETE FROM code_qrcodes WHERE id = ?').bind(row.id).run();
  const remaining = await listQrcodes(env, owner.id);
  return ok({
    resource: 'codes',
    type: '子码',
    code: serializeOwner({ ...owner, qrcode_count: remaining.length }),
    deleted: { id: row.id, index: row.idx ?? null, imageUrl: row.image_url },
    total: remaining.length,
  });
}

/**
 * 重置子码的已用次数。
 *
 * 单独给一个动作而不是「update 时把 hits 传 0」：hits 是访问累计值，
 * 让它出现在通用的更新参数里，迟早会有人用它「修数据」而不自知。
 */
export async function resetQrcodeAction(env, body, request) {
  const { cred, input } = await authorizeCall(env, request, body, qrcodeRefSchema);
  const owner = await loadOwner(env, cred, input.dv1_slug);
  const row = await findQrcode(env, owner.id, input.dv1_qrcode);
  if (!row) throw notFound('子码不存在');

  await env.DB.prepare('UPDATE code_qrcodes SET hits = 0, updated_at = ? WHERE id = ?')
    .bind(nowSeconds(), row.id)
    .run();

  const updated = await findQrcode(env, owner.id, String(row.id));
  return ok({ resource: 'codes', type: '子码', code: serializeOwner(owner), item: serializeQrcode(updated) });
}
