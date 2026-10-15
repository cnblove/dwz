import { badRequest, notFound, ok } from '../lib/http.js';
import { assertQuota } from '../lib/quota.js';
import { nowSeconds } from '../lib/time.js';
import { buildObjectKey, deleteObject, publicUrl, putObject } from '../lib/media.js';
import {
  ALLOWED_IMAGE_MIME,
  MAX_ASSET_SIZE,
} from '../schemas/assets.js';

/**
 * 素材库：图片集中托管在 R2，D1 只存元数据。
 *
 * 存在的意义：客服码 / 群码 / 渠道码都要一张图片地址，之前只能在
 * 各处手粘外链 —— 外链会失效、也没法统一管理。这里上传一次，
 * 活码子码直接选素材，地址就是稳定的 /media/{key}。
 *
 * 权限口径与其它资源一致：超管看全部，成员只看自己上传的。
 */

function serializeAsset(row) {
  return {
    id: row.id,
    filename: row.filename,
    url: row.url,
    objectKey: row.object_key,
    kind: row.kind,
    mime: row.mime,
    size: row.size,
    remark: row.remark,
    ownerId: row.owner_id,
    createdAt: row.created_at,
  };
}

function canAccess(ownerId, session) {
  return session.role === 'owner' || ownerId === session.id;
}

export async function listAssets(env, query, session) {
  const { page, pageSize, kind, keyword } = query;

  const where = [];
  const params = [];
  if (session.role !== 'owner') {
    where.push('owner_id = ?');
    params.push(session.id);
  }
  if (kind && (kind === 'image' || kind === 'doc')) {
    where.push('kind = ?');
    params.push(kind);
  }
  if (keyword) {
    where.push('(filename LIKE ? OR remark LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM assets ${clause}`)
    .bind(...params)
    .first();
  const { results = [] } = await env.DB.prepare(
    `SELECT * FROM assets ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all();

  return ok({
    total: totalRow?.total ?? 0,
    page,
    pageSize,
    items: results.map(serializeAsset),
  });
}

/**
 * 上传素材（multipart/form-data）。
 *
 * 走 form 而不是 base64 JSON：base64 会把体积撑大约 1/3，而 Worker 的
 * 请求体有硬上限，传大图时这 1/3 就是「能传」与「传不动」的差别。
 */
export async function uploadAsset(env, request, session) {
  let form;
  try {
    form = await request.formData();
  } catch {
    throw badRequest('请求体不是合法的表单数据');
  }

  const file = form.get('file');
  if (!file || typeof file === 'string') throw badRequest('缺少上传文件（file 字段）');

  // 先卡配额再落 R2：反过来会把图片留在桶里，却因为没有 assets 行而再也删不掉
  await assertQuota(env.DB, session, 'assets');

  const mime = String(file.type ?? '').toLowerCase();
  if (!ALLOWED_IMAGE_MIME.includes(mime)) {
    throw badRequest(`不支持的图片格式：${mime || '未知'}（仅支持 PNG / JPG / GIF / WebP / BMP / ICO）`);
  }

  const bytes = await file.arrayBuffer();
  const size = bytes.byteLength;
  if (size === 0) throw badRequest('文件内容为空');
  if (size > MAX_ASSET_SIZE) {
    throw badRequest(`文件超过 ${Math.floor(MAX_ASSET_SIZE / 1024 / 1024)}MB 上限`);
  }

  const filename = String(file.name ?? '').trim() || `image-${Date.now()}`;
  const key = buildObjectKey(filename);
  await putObject(env, key, bytes, { mime });

  const url = publicUrl(env, key);
  const remark = String(form.get('remark') ?? '').trim() || null;
  const now = nowSeconds();

  const result = await env.DB.prepare(
    `INSERT INTO assets (filename, object_key, url, kind, mime, size, remark, owner_id, created_at)
     VALUES (?, ?, ?, 'image', ?, ?, ?, ?, ?)`,
  )
    .bind(filename.slice(0, 120), key, url, mime, size, remark, session.id, now)
    .run();

  const created = await env.DB.prepare('SELECT * FROM assets WHERE id = ?')
    .bind(result.meta?.last_row_id)
    .first();
  return ok({ item: serializeAsset(created) });
}

export async function updateAsset(env, body, id, session) {
  const db = env.DB;
  const row = await db.prepare('SELECT * FROM assets WHERE id = ?').bind(id).first();
  if (!row || !canAccess(row.owner_id, session)) throw notFound('素材不存在');

  const fields = {};
  if (body.filename !== undefined) fields.filename = body.filename;
  if (body.remark !== undefined) fields.remark = body.remark;
  if (body.kind !== undefined) fields.kind = body.kind;
  if (Object.keys(fields).length === 0) throw badRequest('没有需要更新的字段');

  const assignments = Object.keys(fields).map((key) => `${key} = ?`).join(', ');
  await db
    .prepare(`UPDATE assets SET ${assignments} WHERE id = ?`)
    .bind(...Object.values(fields), id)
    .run();

  const updated = await db.prepare('SELECT * FROM assets WHERE id = ?').bind(id).first();
  return ok({ item: serializeAsset(updated) });
}

export async function deleteAsset(env, id, session) {
  const db = env.DB;
  const row = await db.prepare('SELECT * FROM assets WHERE id = ?').bind(id).first();
  if (!row || !canAccess(row.owner_id, session)) throw notFound('素材不存在');

  // 先删库再删对象：库里没记录却留着对象只是浪费空间，无伤大雅；
  // 反过来（删了对象库还在）会让列表里出现一批 404 的死图，更难收拾。
  await db.prepare('DELETE FROM assets WHERE id = ?').bind(id).run();
  // 升级前的历史行没有真实对象（object_key 是 legacy/ 占位），跳过删除。
  if (!String(row.object_key ?? '').startsWith('legacy/')) {
    await deleteObject(env, row.object_key).catch((error) => {
      console.error('delete r2 object failed', row.object_key, error);
    });
  }
  return ok({ message: '已删除' });
}
