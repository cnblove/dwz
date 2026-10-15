import { forbidden, unauthorized } from './http.js';
import { DEFAULT_PBKDF2_ITERATIONS, randomToken, sha256Hex, verifyPassword } from './crypto.js';
import { loadQuota } from './quota.js';
import { nowSeconds } from './time.js';

export const SESSION_TTL_SECONDS = 7 * 24 * 3600;
export const SESSION_COOKIE = 'dwz_session';

/** 创建会话，返回明文令牌；库里只保留哈希。 */
export async function createSession(db, userId, { userAgent = '', ip = '' } = {}) {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = nowSeconds();
  await db
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, user_agent, ip, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(tokenHash, userId, userAgent.slice(0, 300), ip, now + SESSION_TTL_SECONDS, now)
    .run();
  return { token, expiresAt: now + SESSION_TTL_SECONDS };
}

export async function resolveSession(db, token) {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT s.id AS session_id, s.expires_at, u.id, u.username, u.role, u.status, u.group_id, u.expires_at AS user_expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .bind(tokenHash)
    .first();
  if (!row) return null;
  if (row.expires_at <= nowSeconds()) {
    await db.prepare('DELETE FROM sessions WHERE id = ?').bind(row.session_id).run();
    return null;
  }
  if (row.status !== 'active') return null;
  if (row.user_expires_at && row.user_expires_at <= nowSeconds()) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    groupId: row.group_id,
    sessionId: row.session_id,
    // 配额在这里读一次并挂在会话上：创建接口的判断不再各查一次库，
    // 也保证同一次请求里前后用的是同一份额度。
    quota: await loadQuota(db, row.group_id),
  };
}

export async function destroySession(db, token) {
  if (!token) return;
  const tokenHash = await sha256Hex(token);
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

export async function authenticate(db, request) {
  const bearer = extractBearer(request);
  const cookie = readCookie(request, SESSION_COOKIE);
  return resolveSession(db, bearer || cookie);
}

/** 从 Cookie 或 Authorization 头取令牌。 */
export function extractToken(request) {
  return extractBearer(request) || readCookie(request, SESSION_COOKIE);
}

function extractBearer(request) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : '';
}

export function readCookie(request, name) {
  const raw = request.headers.get('cookie');
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.split('=');
    if (key.trim() === name) return decodeURIComponent(rest.join('=').trim());
  }
  return '';
}

export function sessionCookie(token, maxAge = SESSION_TTL_SECONDS) {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function login(db, username, password, ctx) {
  const user = await db
    .prepare('SELECT * FROM users WHERE username = ?')
    .bind(String(username ?? '').trim())
    .first();

  // 账号不存在时也走一次同量级的哈希校验，避免用响应耗时枚举账号。
  // 迭代数与默认值对齐，否则「账号存在」与「不存在」的耗时差反而更明显。
  const stored = user?.password_hash ?? `pbkdf2$${DEFAULT_PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;
  const matched = await verifyPassword(String(password ?? ''), stored);
  if (!user || !matched) {
    throw unauthorized('账号或密码错误');
  }
  if (user.status !== 'active') {
    throw forbidden('账号已被停用');
  }
  if (user.expires_at && user.expires_at <= nowSeconds()) {
    throw forbidden('账号已到期');
  }
  return createSession(db, user.id, ctx);
}

/** 仅 owner 可执行的操作。 */
export function requireOwner(session) {
  if (!session || session.role !== 'owner') {
    throw forbidden('仅超级管理员可执行该操作');
  }
}
