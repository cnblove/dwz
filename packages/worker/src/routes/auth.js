import {
  clearSessionCookie,
  createSession,
  destroySession,
  extractToken,
  login,
  resolveSession,
  sessionCookie,
  SESSION_TTL_SECONDS,
} from '../lib/auth.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { badRequest, clientIp, ok, unauthorized, forbidden } from '../lib/http.js';
import { nowSeconds } from '../lib/time.js';

/** 首次部署后若库中没有任何账号，允许引导创建一个 owner。 */
export async function bootstrapStatus(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM users').first();
  return { initialized: (row?.total ?? 0) > 0 };
}

/** 注册。body 已由 registerSchema 校验：账号/密码格式、邮箱可选且合法。 */
export async function register(env, body, request) {
  const db = env.DB;
  const status = await bootstrapStatus(env);
  const { username, password, email } = body;

  // 已初始化后只允许 owner 建号，避免公开注册口子。
  if (status.initialized) {
    const session = await resolveSession(db, extractToken(request));
    if (!session || session.role !== 'owner') {
      throw forbidden('系统已初始化，请联系管理员创建账号');
    }
  }

  const exists = await db.prepare('SELECT 1 AS hit FROM users WHERE username = ?').bind(username).first();
  if (exists) throw badRequest('账号已存在');

  const now = nowSeconds();
  const passwordHash = await hashPassword(password);
  const result = await db
    .prepare(
      `INSERT INTO users (username, password_hash, email, role, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .bind(username, passwordHash, email, status.initialized ? 'member' : 'owner', null, now, now)
    .run();

  const userId = result.meta?.last_row_id;
  const ctx = { userAgent: request.headers.get('user-agent') || '', ip: clientIp(request) };
  const { token, expiresAt } = await createSession(db, userId, ctx);

  return ok({ token, expiresAt, username, role: status.initialized ? 'member' : 'owner' });
}

/** 登录。body 已由 loginSchema 校验：账号非空、密码非空。 */
export async function loginRoute(env, body, request) {
  const { username, password } = body;

  const ctx = { userAgent: request.headers.get('user-agent') || '', ip: clientIp(request) };
  const { token, expiresAt } = await login(env.DB, username, password, ctx);

  await env.DB.prepare(
    'INSERT INTO audit_logs (user_id, username, action, detail, ip, created_at) VALUES (NULL, ?, ?, ?, ?, ?)',
  )
    .bind(username, 'login', '登录成功', ctx.ip, nowSeconds())
    .run();

  return ok(
    { token, expiresAt, username },
    { headers: { 'set-cookie': sessionCookie(token, SESSION_TTL_SECONDS) } },
  );
}

export async function logoutRoute(env, request) {
  const token = extractToken(request);
  await destroySession(env.DB, token);
  return ok({}, { headers: { 'set-cookie': clearSessionCookie() } });
}

export async function meRoute(env, session) {
  if (!session) throw unauthorized();
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.email, u.role, u.status, u.expires_at, u.group_id,
            g.name AS group_name, g.nav_list
     FROM users u LEFT JOIN user_groups g ON g.id = u.group_id
     WHERE u.id = ?`,
  )
    .bind(session.id)
    .first();
  if (!row) throw unauthorized();

  return ok({
    user: {
      id: row.id,
      username: row.username,
      email: row.email,
      role: row.role,
      status: row.status,
      expiresAt: row.expires_at,
      groupId: row.group_id,
      groupName: row.group_name,
      navList: safeJson(row.nav_list, []),
    },
  });
}

/** 改密。body 已由 changePasswordSchema 校验：新密码至少 8 位。 */
export async function changePassword(env, body, session) {
  if (!session) throw unauthorized();
  const current = body.currentPassword;
  const next = body.newPassword;

  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(session.id).first();
  const matched = await verifyPassword(current, row?.password_hash ?? '');
  if (!matched) throw badRequest('当前密码不正确');

  const now = nowSeconds();
  await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(await hashPassword(next), now, session.id)
    .run();

  // 改密后踢掉其它会话，当前会话保留由前端重新登录
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(session.id).run();

  return ok({ message: '密码已更新，请重新登录' });
}

function safeJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
