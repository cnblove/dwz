import { badRequest, notFound, ok } from '../lib/http.js';
import { nowSeconds } from '../lib/time.js';
import { CHANNEL_KIND_LABELS, send, buildMessage } from '../lib/notify.js';
import { CONFIG_SCHEMAS } from '../schemas/notifyConfig.js';
import { formatZodError } from '../lib/validation.js';

/**
 * 通知渠道管理。
 *
 * config 里含密钥（webhook url、Bark key 等），列表接口不回传明文，
 * 只给出「是否已配置」与脱敏提示，避免密钥在页面上被随手复制走。
 */
function serialize(row, { withConfig = false } = {}) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    kindLabel: CHANNEL_KIND_LABELS[row.kind] ?? row.kind,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    configured: Boolean(row.config && row.config !== '{}'),
    configHint: withConfig ? parseConfigObject(row.config) : maskConfig(row.config),
  };
}

function parseConfigObject(config) {
  if (!config) return {};
  try {
    const parsed = JSON.parse(config);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 把配置里的敏感值换成首尾片段，仅用于展示。 */
function maskConfig(config) {
  if (!config) return '{}';
  let parsed;
  try {
    parsed = JSON.parse(config);
  } catch {
    return '{}';
  }
  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    const text = String(value ?? '');
    out[key] = /key|secret|token|url|to|from/i.test(key) && text.length > 8
      ? `${text.slice(0, 4)}****${text.slice(-4)}`
      : text;
  }
  return JSON.stringify(out);
}

export async function listNotifyChannels(env) {
  const { results = [] } = await env.DB.prepare('SELECT * FROM notify_channels ORDER BY id DESC').all();
  return ok({ items: results.map((row) => serialize(row)) });
}

export async function createNotifyChannel(env, body) {
  const config = await normalizeConfig(env, body.kind, body.config);

  const result = await env.DB
    .prepare('INSERT INTO notify_channels (name, kind, config, enabled, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(body.name, body.kind, JSON.stringify(config), body.enabled, nowSeconds())
    .run();

  const created = await env.DB.prepare('SELECT * FROM notify_channels WHERE id = ?').bind(result.meta?.last_row_id).first();
  return ok({ item: serialize(created, { withConfig: true }) });
}

export async function updateNotifyChannel(env, body, id) {
  const row = await env.DB.prepare('SELECT * FROM notify_channels WHERE id = ?').bind(id).first();
  if (!row) throw notFound('通知渠道不存在');

  const fields = {};
  if (body.name !== undefined) fields.name = body.name;
  if (body.enabled !== undefined) fields.enabled = body.enabled;
  if (body.config !== undefined) {
    fields.config = JSON.stringify(await normalizeConfig(env, row.kind, body.config));
  }
  if (Object.keys(fields).length === 0) throw badRequest('没有需要更新的字段');

  const assignments = Object.keys(fields).map((key) => `${key} = ?`).join(', ');
  await env.DB.prepare(`UPDATE notify_channels SET ${assignments} WHERE id = ?`)
    .bind(...Object.values(fields), id)
    .run();

  const updated = await env.DB.prepare('SELECT * FROM notify_channels WHERE id = ?').bind(id).first();
  return ok({ item: serialize(updated, { withConfig: true }) });
}

export async function deleteNotifyChannel(env, id) {
  const row = await env.DB.prepare('SELECT * FROM notify_channels WHERE id = ?').bind(id).first();
  if (!row) throw notFound('通知渠道不存在');
  await env.DB.prepare('DELETE FROM notify_channels WHERE id = ?').bind(id).run();
  return ok({ message: '已删除' });
}

/** 测试发送，用于后台点「测试」时立刻验证配置是否可用。 */
export async function testNotifyChannel(env, id) {
  const row = await env.DB.prepare('SELECT * FROM notify_channels WHERE id = ?').bind(id).first();
  if (!row) throw notFound('通知渠道不存在');

  const message = buildMessage({
    title: '【短链与活码】通知测试',
    text: `渠道「${row.name}」配置连通，这是一条测试消息。`,
    level: 'info',
    time: new Date().toISOString(),
  });
  const result = await send(row, message);
  if (!result.ok) throw badRequest(`测试失败：${result.error ?? `HTTP ${result.status}`}`);
  return ok({ message: `测试消息已发送（HTTP ${result.status ?? 200}）` });
}

/**
 * 校验并收敛各渠道的配置字段，避免把无关键写进库。
 *
 * 校验规则本身在 schemas/notifyConfig.js 里按渠道路由，
 * 这里只负责取对应的 schema、跑一遍、把 ZodError 转成业务错误。
 */
async function normalizeConfig(env, kind, raw) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const schema = CONFIG_SCHEMAS[kind];
  if (!schema) throw badRequest('渠道类型不合法');

  const result = schema.safeParse(config);
  if (!result.success) throw badRequest(formatZodError(result.error));
  return result.data;
}
