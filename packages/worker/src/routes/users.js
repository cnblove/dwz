import { badRequest, notFound, ok } from '../lib/http.js';
import { hashPassword } from '../lib/crypto.js';
import { nowSeconds, parseTimestamp } from '../lib/time.js';
import { releaseSlug } from '../lib/namespace.js';

function serialize(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    status: row.status,
    remark: row.remark,
    groupId: row.group_id,
    groupName: row.group_name ?? null,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export async function listUsers(env, query) {
  const { page, pageSize, keyword } = query;

  const params = [];
  let clause = '';
  if (keyword) {
    clause = 'WHERE u.username LIKE ? OR u.email LIKE ?';
    params.push(`%${keyword}%`, `%${keyword}%`);
  }

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM users u ${clause}`).bind(...params).first();
  const { results = [] } = await env.DB.prepare(
    `SELECT u.*, g.name AS group_name FROM users u
     LEFT JOIN user_groups g ON g.id = u.group_id
     ${clause} ORDER BY u.id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all();

  return ok({ total: totalRow?.total ?? 0, page, pageSize, items: results.map(serialize) });
}

export async function createUser(env, body) {
  const { username, password } = body;

  const exists = await env.DB.prepare('SELECT 1 AS hit FROM users WHERE username = ?').bind(username).first();
  if (exists) throw badRequest('账号已存在');

  const now = nowSeconds();
  const result = await env.DB
    .prepare(
      `INSERT INTO users (username, password_hash, email, role, status, remark, group_id, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    )
    .bind(
      username,
      await hashPassword(password, env.PASSWORD_ITERATIONS),
      body.email,
      body.role,
      body.remark,
      body.groupId,
      parseTimestamp(body.expiresAt),
      now,
      now,
    )
    .run();

  const created = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(result.meta?.last_row_id).first();
  return ok({ item: serialize(created) });
}

export async function updateUser(env, body, id, session) {
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!row) throw notFound('账号不存在');

  const fields = {};
  if (body.email !== undefined) fields.email = body.email;
  if (body.remark !== undefined) fields.remark = body.remark;
  if (body.groupId !== undefined) fields.group_id = body.groupId ? Number(body.groupId) : null;
  if (body.expiresAt !== undefined) fields.expires_at = parseTimestamp(body.expiresAt);
  if (body.status !== undefined) fields.status = body.status;
  if (body.password !== undefined) {
    fields.password_hash = await hashPassword(body.password, env.PASSWORD_ITERATIONS);
  }
  if (body.role !== undefined) {
    // 不允许把自己降级，否则可能锁死整个后台
    if (id === session.id && body.role !== 'owner') throw badRequest('不能修改自己的角色');
    fields.role = body.role;
  }
  if (body.status !== undefined && id === session.id && body.status !== 'active') {
    throw badRequest('不能停用自己的账号');
  }

  if (Object.keys(fields).length === 0) throw badRequest('没有需要更新的字段');
  fields.updated_at = nowSeconds();

  const assignments = Object.keys(fields).map((key) => `${key} = ?`).join(', ');
  await env.DB.prepare(`UPDATE users SET ${assignments} WHERE id = ?`)
    .bind(...Object.values(fields), id)
    .run();

  // 改密或停用后，旧会话立即失效
  if (fields.password_hash || fields.status === 'disabled') {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
  }

  const updated = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  return ok({ item: serialize(updated) });
}

export async function deleteUser(env, id, session) {
  const db = env.DB;
  if (id === session.id) throw badRequest('不能删除自己的账号');
  const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!row) throw notFound('账号不存在');
  if (row.role === 'owner') {
    const ownerCount = await db.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'owner'").first();
    if ((ownerCount?.total ?? 0) <= 1) throw badRequest('至少需要保留一个超级管理员');
  }

  // 账号名下的短链 / 活码 / 渠道码对 users(id) 是强外键，不先清掉会因
  // 「FOREIGN KEY constraint failed」删不掉（表现为 500）。这里连 slug 命名空间一起释放，
  // 否则这些 key 会永久占位、再也没人能用。
  const owned = await db
    .prepare(
      `SELECT slug FROM short_links WHERE owner_id = ?
       UNION ALL SELECT slug FROM codes WHERE owner_id = ?
       UNION ALL SELECT slug FROM channels WHERE owner_id = ?`,
    )
    .bind(id, id, id)
    .all();

  await db.batch([
    db.prepare('DELETE FROM short_links WHERE owner_id = ?').bind(id),
    db.prepare('DELETE FROM codes WHERE owner_id = ?').bind(id),
    db.prepare('DELETE FROM channels WHERE owner_id = ?').bind(id),
    db.prepare('DELETE FROM users WHERE id = ?').bind(id),
  ]);

  for (const item of owned.results ?? []) {
    // eslint-disable-next-line no-await-in-loop
    await releaseSlug(db, item.slug);
  }
  return ok({ message: '已删除' });
}

/* ---------------- 用户组 ---------------- */

export async function listGroups(env) {
  const { results = [] } = await env.DB.prepare('SELECT * FROM user_groups ORDER BY id').all();
  return ok({
    items: results.map((row) => ({
      id: row.id,
      name: row.name,
      navList: safeJson(row.nav_list, []),
      createdAt: row.created_at,
    })),
  });
}

export async function createGroup(env, body) {
  const { name, navList } = body;
  const exists = await env.DB.prepare('SELECT 1 AS hit FROM user_groups WHERE name = ?').bind(name).first();
  if (exists) throw badRequest('用户组已存在');

  const result = await env.DB
    .prepare('INSERT INTO user_groups (name, nav_list, created_at) VALUES (?, ?, ?)')
    .bind(name, JSON.stringify(navList), nowSeconds())
    .run();

  return ok({ item: { id: result.meta?.last_row_id, name, navList } });
}

export async function updateGroup(env, body, id) {
  const row = await env.DB.prepare('SELECT * FROM user_groups WHERE id = ?').bind(id).first();
  if (!row) throw notFound('用户组不存在');

  const fields = {};
  if (body.name !== undefined) fields.name = body.name;
  if (body.navList !== undefined) fields.nav_list = JSON.stringify(body.navList);
  if (Object.keys(fields).length === 0) throw badRequest('没有需要更新的字段');

  const assignments = Object.keys(fields).map((key) => `${key} = ?`).join(', ');
  await env.DB.prepare(`UPDATE user_groups SET ${assignments} WHERE id = ?`)
    .bind(...Object.values(fields), id)
    .run();
  return ok({ message: '已更新' });
}

export async function deleteGroup(env, id) {
  const row = await env.DB.prepare('SELECT * FROM user_groups WHERE id = ?').bind(id).first();
  if (!row) throw notFound('用户组不存在');
  await env.DB.prepare('UPDATE users SET group_id = NULL WHERE group_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM user_groups WHERE id = ?').bind(id).run();
  return ok({ message: '已删除' });
}

export async function listAuditLogs(env, query) {
  const { page, pageSize } = query;
  const { results = [] } = await env.DB.prepare(
    'SELECT * FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?',
  )
    .bind(pageSize, (page - 1) * pageSize)
    .all();
  return ok({ page, pageSize, items: results });
}

function safeJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
