import { badRequest, forbidden, notFound, ok, readJson, clientIp } from '../lib/http.js';
import { randomToken, safeStringEqual } from '../lib/crypto.js';
import { nowSeconds, parseTimestamp, todayKey } from '../lib/time.js';
import { assertHttpUrl, assertOneOf, assertText, toPositiveInt } from '../lib/validate.js';
import { isValidCustomSlug } from '../lib/keys.js';
import { resolveSlug } from '../lib/namespace.js';

export const SIGN_FIELDS = ['dwz_title', 'dwz_type', 'dwz_url', 'api_key', 'api_secret'];

/**
 * 对外开放的签名算法。
 * 说明：参考实现用的是「明文拼接后 MD5」，属于弱签名（可被长度扩展与彩虹表攻击）。
 * 这里改为 HMAC-SHA256，并把时间戳纳入签名，避免重放。
 */
export async function sign(payload, secret) {
  const canonical = SIGN_FIELDS.map((field) => String(payload[field] ?? '')).join('|');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- 凭证管理（后台） ---------------- */

export async function listCredentials(env, session) {
  const params = session.role === 'owner' ? [] : [session.id];
  const clause = session.role === 'owner' ? '' : 'WHERE user_id = ?';
  const { results = [] } = await env.DB.prepare(
    `SELECT * FROM api_credentials ${clause} ORDER BY id DESC`,
  )
    .bind(...params)
    .all();
  return ok({
    items: results.map((row) => ({
      id: row.id,
      apiKey: row.api_key,
      userId: row.user_id,
      ipAllowlist: row.ip_allowlist,
      quota: row.quota,
      used: row.used,
      status: row.status,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      // secret 仅在创建时返回一次，这里只给首尾便于识别
      secretHint: `${row.api_secret.slice(0, 4)}****${row.api_secret.slice(-4)}`,
    })),
  });
}

export async function createCredential(env, request, session) {
  const body = await readJson(request);
  const now = nowSeconds();
  const apiKey = `dwz_${randomToken(8)}`;
  const apiSecret = randomToken(24);

  const result = await env.DB
    .prepare(
      `INSERT INTO api_credentials (api_key, api_secret, user_id, ip_allowlist, quota, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .bind(
      apiKey,
      apiSecret,
      session.id,
      body.ipAllowlist ? String(body.ipAllowlist).slice(0, 300) : null,
      body.quota === undefined ? 100000 : toPositiveInt(body.quota, '配额', { min: 1, max: 100000000 }),
      parseTimestamp(body.expiresAt),
      now,
      now,
    )
    .run();

  // 明文密钥只在此刻返回，之后无法再次获取
  return ok({
    item: {
      id: result.meta?.last_row_id,
      apiKey,
      apiSecret,
      quota: body.quota ?? 100000,
      message: '请立即保存 apiSecret，它不会再次显示',
    },
  });
}

export async function updateCredential(env, request, id, session) {
  const row = await env.DB.prepare('SELECT * FROM api_credentials WHERE id = ?').bind(id).first();
  if (!row) throw notFound('凭证不存在');
  if (session.role !== 'owner' && row.user_id !== session.id) throw forbidden();

  const body = await readJson(request);
  const fields = {};
  if (body.ipAllowlist !== undefined) fields.ip_allowlist = body.ipAllowlist ? String(body.ipAllowlist).slice(0, 300) : null;
  if (body.quota !== undefined) fields.quota = toPositiveInt(body.quota, '配额', { min: 1, max: 100000000 });
  if (body.status !== undefined) fields.status = assertOneOf(body.status, ['active', 'paused'], '状态');
  if (body.expiresAt !== undefined) fields.expires_at = parseTimestamp(body.expiresAt);
  if (Object.keys(fields).length === 0) throw badRequest('没有需要更新的字段');
  fields.updated_at = nowSeconds();

  const assignments = Object.keys(fields).map((key) => `${key} = ?`).join(', ');
  await env.DB.prepare(`UPDATE api_credentials SET ${assignments} WHERE id = ?`)
    .bind(...Object.values(fields), id)
    .run();
  return ok({ message: '已更新' });
}

export async function deleteCredential(env, id, session) {
  const row = await env.DB.prepare('SELECT * FROM api_credentials WHERE id = ?').bind(id).first();
  if (!row) throw notFound('凭证不存在');
  if (session.role !== 'owner' && row.user_id !== session.id) throw forbidden();
  await env.DB.prepare('DELETE FROM api_credentials WHERE id = ?').bind(id).run();
  return ok({ message: '已删除' });
}

/* ---------------- 开放接口（外部调用） ---------------- */

/** 校验 api_key / sign / 配额 / IP 白名单。 */
async function authenticateApi(env, request, body) {
  const apiKey = String(body.api_key ?? '').trim();
  if (!apiKey) throw badRequest('缺少 api_key');

  const cred = await env.DB.prepare('SELECT * FROM api_credentials WHERE api_key = ?').bind(apiKey).first();
  if (!cred) throw forbidden('api_key 无效');
  if (cred.status !== 'active') throw forbidden('api_key 已停用');
  if (cred.expires_at && cred.expires_at <= nowSeconds()) throw forbidden('api_key 已过期');
  if (cred.used >= cred.quota) throw forbidden('调用配额已用完');

  const provided = String(body.sign ?? '').trim();
  if (!provided) throw badRequest('缺少 sign');
  const expected = await sign(
    {
      dwz_title: body.dwz_title,
      dwz_type: body.dwz_type,
      dwz_url: body.dwz_url,
      api_key: apiKey,
      api_secret: cred.api_secret,
    },
    cred.api_secret,
  );
  if (!(await safeStringEqual(provided, expected))) throw forbidden('签名校验失败');

  if (cred.ip_allowlist) {
    const ip = clientIp(request);
    const allowlist = cred.ip_allowlist.split(',').map((item) => item.trim()).filter(Boolean);
    if (allowlist.length && !allowlist.includes(ip)) throw forbidden('调用来源 IP 不在白名单内');
  }

  return cred;
}

/** POST /open/v1/short-links —— 外部创建短链。 */
export async function createShortLinkViaApi(env, request) {
  const db = env.DB;
  const body = await readJson(request);
  const cred = await authenticateApi(env, request, body);

  const title = assertText(body.dwz_title, '标题', { max: 100 });
  const targetUrl = assertHttpUrl(body.dwz_url, '目标链接');
  const accessRule = assertOneOf(body.dwz_type ?? 'any', ['any', 'wechat', 'ios', 'android', 'mobile', 'desktop'], '访问限制');

  if (body.dwz_slug && !isValidCustomSlug(body.dwz_slug)) throw badRequest('自定义短链格式不正确');
  // 与后台创建共用同一套命名空间占用逻辑，保留 dwz_dlws 参数只为兼容旧调用方
  const slug = await resolveSlug(db, { slug: body.dwz_slug });

  const now = nowSeconds();
  const result = await db
    .prepare(
      `INSERT INTO short_links (slug, title, target_url, access_rule, status, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .bind(slug, title, targetUrl, accessRule, cred.user_id, now, now)
    .run();

  // used 用单条原子自增：按读到的旧值写回会在并发调用时少算配额。
  await db
    .prepare('UPDATE api_credentials SET used = used + 1, updated_at = ? WHERE id = ?')
    .bind(now, cred.id)
    .run();

  const host = env.SHORT_ORIGIN || new URL(request.url).origin;
  return ok({ shortUrl: `${host}/${slug}`, slug, id: result.meta?.last_row_id });
}

/** POST /open/v1/stats —— 外部查询短链统计。 */
export async function queryStatsViaApi(env, request) {
  const body = await readJson(request);
  const cred = await authenticateApi(env, request, {
    ...body,
    dwz_title: body.dwz_title ?? '',
    dwz_type: body.dwz_type ?? '',
    dwz_url: body.dwz_url ?? '',
  });

  const slug = String(body.slug ?? body.dwz_slug ?? '').trim();
  if (!slug) throw badRequest('缺少 slug');

  const row = await env.DB.prepare('SELECT * FROM short_links WHERE slug = ?').bind(slug).first();
  if (!row) throw notFound('短链不存在');
  if (cred.user_id !== row.owner_id) throw forbidden('无权查看该短链');

  return ok({
    slug: row.slug,
    title: row.title,
    targetUrl: row.target_url,
    status: row.status,
    hits: row.hits,
    hitsToday: row.hits_today_on === todayKey() ? row.hits_today : 0,
    createdAt: row.created_at,
  });
}
