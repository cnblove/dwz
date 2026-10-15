import { badRequest, forbidden, notFound, ok, clientIp } from './http.js';
import { randomToken, safeStringEqual } from './crypto.js';
import { nowSeconds, parseTimestamp } from './time.js';
import { formatZodError } from './validation.js';
import { loadQuota } from './quota.js';

/**
 * 开放 API 的公共底座：签名、鉴权、参数校验、错误归一。
 *
 * 对外开放的接口按资源拆在 `src/open/` 下（resources / stats / catalog），
 * 但它们共享同一条链路，链路的顺序不能各写一遍：
 *
 *   读原始 body → 取 api_key 找凭证 → 校验状态/有效期/配额/IP
 *   → 用原始 body 重算 HMAC 比对 → 字段校验（zod）→ 业务逻辑
 *
 * 签名必须走**原始** body，所以这里刻意不挂 body 校验中间件：
 * 一旦有中间件先解析/改写 payload，签名就会对不上，而调用方看到的
 * 却是「参数不合法」，排查方向会被彻底带偏。字段校验因此下沉到签名之后。
 *
 * 另一条设计约束：签名串里只放**调用方自己提供的**字段。
 * 一旦把 slug、时间戳这类业务参数也拼进去，签名就会依赖「请求体的某几段」，
 * 封装稍微漂一点就对不上，而错误还表现为笼统的「签名校验失败」。
 */

/**
 * 参与签名的字段，顺序即拼接顺序。
 *
 * 这是对外契约：加字段等于破坏兼容，只能新增一个版本前缀，
 * 不能中途往这里塞东西。所以下面这些 `dwz_*` 的语义也不要轻易改。
 */
export const SIGN_FIELDS = ['dwz_title', 'dwz_type', 'dwz_url', 'dv1_grant', 'api_key', 'api_secret'];

/** 签名规范串：字段值按 SIGN_FIELDS 顺序用 | 连接，缺省补空串。 */
export function canonicalString(payload) {
  return SIGN_FIELDS.map((field) => String(payload?.[field] ?? '')).join('|');
}

/**
 * 读取授权声明。
 *
 * 这是一个**声明**，不是一个权限：后台里「超管能看全部、成员只看自己的」
 * 是会话给的权利，而开放接口持的是一张凭证 —— 凭证不该因为自己在 body 里
 * 写了 `owner` 就变成管理员。所以这个值只用来「打开」本来就属于这个人的
 * 全局视图（见 grantSession），永远不能「产生」权限。
 */
export function hasOwnerGrant(body) {
  return body?.dv1_grant === 'owner';
}

/** HMAC-SHA256(api_secret, 规范串)，hex 输出。 */
export async function sign(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonicalString(payload)));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 校验 api_key / sign / 配额 / IP 白名单，返回凭证行。
 *
 * 校验顺序固定为「凭证 → 状态 → 有效期 → 配额 → 签名 → 白名单」：
 * 先确认「你是谁」再确认「这次请求可不可信」，最后才看「从哪来」。
 * 对调用方来说，错误信息越靠前越容易定位问题。
 */
export async function authenticateApi(env, request, body) {
  const apiKey = String(body?.api_key ?? '').trim();
  if (!apiKey) throw badRequest('缺少 api_key');

  const cred = await env.DB.prepare('SELECT * FROM api_credentials WHERE api_key = ?').bind(apiKey).first();
  if (!cred) throw forbidden('api_key 无效');
  if (cred.status !== 'active') throw forbidden('api_key 已停用');
  if (cred.expires_at && cred.expires_at <= nowSeconds()) throw forbidden('api_key 已过期');
  // quota 为 NULL = 不限额；只有设了预算才拦
  if (cred.quota !== null && cred.quota !== undefined && cred.used >= cred.quota) {
    throw forbidden('调用配额已用完');
  }

  const provided = String(body?.sign ?? '').trim();
  if (!provided) throw badRequest('缺少 sign');
  // 先归一再计算：调用方多传/少传一个签名 tag、或把标签传成 `null` 时，
  // 服务端拼出来的串必须与「stringify 后的 JSON 所见」一致，否则会得到
  // 难以定位的「签名校验失败」。归一化只做类型收敛，不补默认值 ——
  // 补默认值等于替调用方填空，那就不是校验了。
  const expected = await sign(
    {
      dwz_title: tagValue(body.dv1_title),
      dwz_type: tagValue(body.dv1_type),
      dwz_url: tagValue(body.dv1_url),
      dv1_grant: tagValue(body.dv1_grant),
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

/**
 * 一次调用的完整前置流程：鉴权 + 业务字段校验。
 *
 * 调用方的 handler 只需要写业务逻辑 —— 配额自增也在这里做，
 * 让「没走完前置流程的请求不会消耗配额」成为结构上的保证，而不是约定。
 */
export async function authorizeCall(env, request, body, schema) {
  const cred = await authenticateApi(env, request, body ?? {});

  let input = body ?? {};
  if (schema) {
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) throw badRequest(formatZodError(parsed.error));
    input = parsed.data;
  }

  await env.DB.prepare('UPDATE api_credentials SET used = used + 1, updated_at = ? WHERE id = ?')
    .bind(nowSeconds(), cred.id)
    .run();

  return { cred, input };
}

/**
 * 会话形状的授权主体。
 *
 * 开放接口的 handler 与后台 handler 共用同一批业务函数，那些函数收的是
 * session（`{ id, role, quota }`）。这里把凭证翻译成同一个形状，
 * 于是「后台能做的事」不需要为开放接口再写一份 —— 少了第二份就少了漂移。
 *
 * 角色的口径：凭证天生属于某个账号，所以它**天然就是一个成员**；
 * 只有显式声明 `dv1_grant: "owner"` 才升级成超管，而这个声明本身就是
 * 调用方能改的字段，等于「自证清白」—— 一张泄露的 key 不会因为
 * 声明了一句 owner 就多出任何它本来没有的权利。
 */
export async function grantSession(env, cred, body, { owner = false } = {}) {
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(cred.user_id).first();
  if (!row) throw forbidden('凭证所属账号已不存在');

  // 授权的**两个条件必须同时成立**：证书主人本身是超管，且本次调用显式
  // 声明 `dv1_grant: "owner"`。
  //
  // 这里最容易写错的是只看声明：`dv1_grant` 是调用方能自由填的字段，
  // 拿它当权限依据等于让请求自己给自己发权限 —— 一个成员账号发出来的 key
  // 会直接读到全站用户列表。声明只用来「打开」本来就属于这个人的视图，
  // 永远不能「产生」权限。
  const elevated = owner && hasOwnerGrant(body) && row.role === 'owner';

  return {
    id: row.id,
    username: row.username,
    role: elevated ? 'owner' : 'member',
    groupId: row.group_id,
    quota: await loadQuota(env.DB, row.group_id),
  };
}

/**
 * 签名 tag 归一化：null / undefined / 非字符串统一成空串。
 *
 * 不 trim：签名必须逐字复现调用方交上来的值，服务端偷偷 trim
 * 会让「值看起来一样却签不过」，这类问题在联调里最耗时间。
 */
function tagValue(value) {
  return value === null || value === undefined ? '' : String(value);
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

/**
 * 未指定到期时间时的默认有效期（天）。
 *
 * 不能用「永不过期」当默认：一张建完就忘的长期 key 一旦泄露，
 * 伤害会一直持续到有人想起来去删它。默认 90 天，想长期用可以显式改成 null。
 */
const DEFAULT_EXPIRY_DAYS = 90;

export async function createCredential(env, body, session) {
  const now = nowSeconds();
  const apiKey = `dwz_${randomToken(8)}`;
  const apiSecret = randomToken(24);

  // 只有显式传 null 才是「永不过期」；缺省按 90 天算，
  // 否则「用户没填」和「用户明确要不限期」在库里会长得一样。
  const expiresAt =
    body.expiresAt === undefined
      ? now + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60
      : parseTimestamp(body.expiresAt);

  const result = await env.DB
    .prepare(
      `INSERT INTO api_credentials (api_key, api_secret, user_id, ip_allowlist, quota, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .bind(
      apiKey,
      apiSecret,
      session.id,
      body.ipAllowlist,
      body.quota,
      expiresAt,
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
      quota: body.quota,
      expiresAt,
      message: '请立即保存 apiSecret，它不会再次显示',
    },
  });
}

export async function updateCredential(env, body, id, session) {
  const row = await env.DB.prepare('SELECT * FROM api_credentials WHERE id = ?').bind(id).first();
  if (!row) throw notFound('凭证不存在');
  if (session.role !== 'owner' && row.user_id !== session.id) throw forbidden();

  const fields = {};
  if (body.ipAllowlist !== undefined) fields.ip_allowlist = body.ipAllowlist;
  if (body.quota !== undefined) fields.quota = body.quota;
  if (body.status !== undefined) fields.status = body.status;
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
