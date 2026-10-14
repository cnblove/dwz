import { badRequest, notFound, ok } from '../lib/http.js';
import { nowSeconds } from '../lib/time.js';

const KINDS = ['entry', 'landing', 'short', 'backup'];

function serialize(row) {
  return {
    id: row.id,
    host: row.host,
    kind: row.kind,
    remark: row.remark,
    groupId: row.group_id,
    createdAt: row.created_at,
  };
}

export async function listDomains(env, query) {
  const kind = query.kind;
  const params = [];
  let clause = '';
  if (kind && KINDS.includes(kind)) {
    clause = 'WHERE kind = ?';
    params.push(kind);
  }
  const { results = [] } = await env.DB.prepare(`SELECT * FROM domains ${clause} ORDER BY kind, id`)
    .bind(...params)
    .all();
  return ok({ items: results.map(serialize) });
}

export async function createDomain(env, body) {
  const { host, kind, remark } = body;

  const exists = await env.DB.prepare('SELECT 1 AS hit FROM domains WHERE host = ?').bind(host).first();
  if (exists) throw badRequest('该域名已存在');

  const result = await env.DB
    .prepare('INSERT INTO domains (host, kind, remark, created_at) VALUES (?, ?, ?, ?)')
    .bind(host, kind, remark, nowSeconds())
    .run();

  const created = await env.DB.prepare('SELECT * FROM domains WHERE id = ?').bind(result.meta?.last_row_id).first();
  return ok({ item: serialize(created) });
}

export async function updateDomain(env, body, id) {
  const row = await env.DB.prepare('SELECT * FROM domains WHERE id = ?').bind(id).first();
  if (!row) throw notFound('域名不存在');

  const fields = {};
  if (body.host !== undefined) fields.host = body.host;
  if (body.kind !== undefined) fields.kind = body.kind;
  if (body.remark !== undefined) fields.remark = body.remark;

  if (Object.keys(fields).length === 0) throw badRequest('没有需要更新的字段');

  if (fields.host) {
    const exists = await env.DB.prepare('SELECT 1 AS hit FROM domains WHERE host = ? AND id != ?')
      .bind(fields.host, id)
      .first();
    if (exists) throw badRequest('该域名已存在');
  }

  const assignments = Object.keys(fields).map((key) => `${key} = ?`).join(', ');
  await env.DB.prepare(`UPDATE domains SET ${assignments} WHERE id = ?`)
    .bind(...Object.values(fields), id)
    .run();

  const updated = await env.DB.prepare('SELECT * FROM domains WHERE id = ?').bind(id).first();
  return ok({ item: serialize(updated) });
}

export async function deleteDomain(env, id) {
  const row = await env.DB.prepare('SELECT * FROM domains WHERE id = ?').bind(id).first();
  if (!row) throw notFound('域名不存在');
  await env.DB.prepare('DELETE FROM domains WHERE id = ?').bind(id).run();
  return ok({ message: '已删除' });
}

/* ---------------- 域名巡检 ---------------- */

export async function getDomainCheck(env) {
  let row = await env.DB.prepare('SELECT * FROM domain_checks WHERE id = 1').first();
  if (!row) {
    await env.DB.prepare(
      'INSERT INTO domain_checks (id, enabled, notify_channel, backup_host) VALUES (1, 0, NULL, NULL)',
    ).run();
    row = await env.DB.prepare('SELECT * FROM domain_checks WHERE id = 1').first();
  }
  return ok({
    item: {
      enabled: Boolean(row.enabled),
      notifyChannel: row.notify_channel,
      backupHost: row.backup_host,
      lastStatus: row.last_status,
      checkedAt: row.checked_at,
    },
  });
}

export async function updateDomainCheck(env, body) {
  const fields = {};
  if (body.enabled !== undefined) fields.enabled = body.enabled;
  if (body.notifyChannel !== undefined) fields.notify_channel = body.notifyChannel;
  if (body.backupHost !== undefined) {
    fields.backup_host = body.backupHost;
  }
  if (Object.keys(fields).length === 0) throw badRequest('没有需要更新的字段');

  const existing = await env.DB.prepare('SELECT 1 AS hit FROM domain_checks WHERE id = 1').first();
  if (!existing) {
    await env.DB.prepare('INSERT INTO domain_checks (id) VALUES (1)').run();
  }

  const assignments = Object.keys(fields).map((key) => `${key} = ?`).join(', ');
  await env.DB.prepare(`UPDATE domain_checks SET ${assignments} WHERE id = 1`)
    .bind(...Object.values(fields))
    .run();

  return getDomainCheck(env);
}

/** 按需探测：只判断域名是否可解析并可建立连接，不解析内容。 */
export async function probeDomain(env, body) {
  const host = body.host;
  const target = `https://${host}`;
  const started = Date.now();
  try {
    const response = await fetch(target, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    return ok({
      host,
      reachable: true,
      status: response.status,
      latencyMs: Date.now() - started,
    });
  } catch (error) {
    return ok({
      host,
      reachable: false,
      status: 0,
      latencyMs: Date.now() - started,
      error: String(error?.message ?? error),
    });
  }
}
