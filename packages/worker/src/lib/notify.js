/**
 * 通知发送。
 *
 * 设计取舍：通知是「尽力而为」的旁路能力，任何渠道失败都不能影响主流程
 * （跳转、巡检、兑换）。因此 send 从不抛错，只返回结果，由调用方决定是否记日志。
 *
 * 渠道配置统一存 notify_channels.config（JSON 字符串），各渠道字段如下：
 *   webhook    { url, method?, secret?, header? }
 *   email      { to, from?, subject? }          —— 经 Cloudflare 的邮件发送 API 转发
 *   bark       { key, server? }                 —— iOS 推送
 *   wecom      { key }                          —— 企业微信机器人 webhook key
 *   serverchan { key }                          —— 方糖 Server 酱 SendKey
 */

const TIMEOUT_MS = 8000;

/** 各渠道的可读名称，后台展示与日志复用。 */
export const CHANNEL_KINDS = ['webhook', 'email', 'bark', 'wecom', 'serverchan'];

export const CHANNEL_KIND_LABELS = {
  webhook: 'Webhook',
  email: '邮件',
  bark: 'Bark',
  wecom: '企业微信',
  serverchan: '方糖',
};

function parseConfig(config) {
  if (!config) return {};
  if (typeof config === 'object') return config;
  try {
    const parsed = JSON.parse(config);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 发送一条通知。
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
export async function send(channel, message, { fetchImpl = fetch } = {}) {
  if (!channel || channel.enabled === 0) return { ok: false, error: '渠道未启用' };
  const config = parseConfig(channel.config);
  try {
    switch (channel.kind) {
      case 'webhook':
        return await sendWebhook(config, message, fetchImpl);
      case 'wecom':
        return await sendWecom(config, message, fetchImpl);
      case 'bark':
        return await sendBark(config, message, fetchImpl);
      case 'serverchan':
        return await sendServerChan(config, message, fetchImpl);
      case 'email':
        return await sendEmail(config, message, fetchImpl);
      default:
        return { ok: false, error: `不支持的通知渠道：${channel.kind}` };
    }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 按 id 或名称取渠道并发通知。渠道不存在或停用时静默跳过，不算失败。 */
export async function notify(db, { channelId, message }) {
  if (!channelId) return { ok: false, error: '未配置通知渠道' };
  const channel = await db.prepare('SELECT * FROM notify_channels WHERE id = ?').bind(Number(channelId)).first();
  if (!channel) return { ok: false, error: '通知渠道不存在' };
  return send(channel, message);
}

function postJson(url, body, fetchImpl, headers = {}) {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function sendWebhook(config, message, fetchImpl) {
  if (!config.url) return { ok: false, error: 'webhook 缺少 url' };
  const method = String(config.method ?? 'POST').toUpperCase();
  const headers = config.header && typeof config.header === 'object' ? config.header : {};
  const payload = { title: message.title, text: message.text, level: message.level ?? 'info', time: message.time };

  const init = { method, headers: { 'content-type': 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (method !== 'GET') init.body = JSON.stringify(payload);

  const response = await fetchImpl(config.url, init);
  return { ok: response.ok, status: response.status };
}

async function sendWecom(config, message, fetchImpl) {
  if (!config.key) return { ok: false, error: '企业微信缺少 key' };
  const url = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(config.key)}`;
  const response = await postJson(url, { msgtype: 'text', text: { content: `${message.title}\n${message.text}` } }, fetchImpl);
  return { ok: response.ok, status: response.status };
}

async function sendBark(config, message, fetchImpl) {
  if (!config.key) return { ok: false, error: 'Bark 缺少 key' };
  const server = (config.server || 'https://api.day.app').replace(/\/+$/, '');
  const body = { title: message.title, body: message.text, level: message.level === 'error' ? 'timeSensitive' : 'active' };
  const response = await postJson(`${server}/${encodeURIComponent(config.key)}`, body, fetchImpl);
  return { ok: response.ok, status: response.status };
}

async function sendServerChan(config, message, fetchImpl) {
  if (!config.key) return { ok: false, error: '方糖缺少 SendKey' };
  const response = await fetchImpl(`https://sctapi.ftqq.com/${encodeURIComponent(config.key)}.send`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ title: message.title, desp: message.text }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { ok: response.ok, status: response.status };
}

/**
 * 邮件：Workers 运行时没有 SMTP，统一走 Cloudflare 的邮件发送端点。
 * 未绑定该能力时直接返回失败，不影响其它渠道。
 */
async function sendEmail(config, message, fetchImpl) {
  if (!config.to) return { ok: false, error: '邮件缺少收件人' };
  const endpoint = config.endpoint || 'https://api.cloudflare.com/client/v4/accounts/self/email/send';
  const response = await postJson(
    endpoint,
    {
      from: config.from || 'dwz@notice.local',
      to: config.to,
      subject: `${config.subject || message.title}`,
      text: message.text,
    },
    fetchImpl,
  );
  return { ok: response.ok, status: response.status };
}

/** 组装标准消息体，保证各渠道拿到的结构一致。 */
export function buildMessage({ title, text, level = 'info', time = '' }) {
  return { title, text, level, time };
}

export { parseConfig };
