import { nowSeconds, todayKey } from '../lib/time.js';
import { buildMessage, notify } from '../lib/notify.js';

/**
 * 定时巡检。
 *
 * 由 Cron 触发，做两件事：
 *   1. 域名可达性巡检：按 domain_checks 的配置逐个探测，异常时通过配置的渠道告警；
 *   2. 卡密库存巡检：批次剩余量低于阈值时提醒，避免兑换时才发现已经发完。
 *
 * 取舍：巡检结果一律落 inspection_logs，通知失败只标记 notified=0，
 * 不抛错、不重试——运维更愿意看到「日志里有记录」而不是「任务挂掉」。
 */
export async function runInspection(env, { fetchImpl = fetch } = {}) {
  const [domains, cardkeys] = await Promise.all([
    inspectDomains(env, fetchImpl),
    inspectCardkeys(env),
  ]);
  return { at: nowSeconds(), domains, cardkeys };
}

/* ---------------- 域名巡检 ---------------- */

async function inspectDomains(env, fetchImpl) {
  const config = await env.DB.prepare('SELECT * FROM domain_checks WHERE id = 1').first();
  if (!config || !config.enabled) return { skipped: true, reason: '未开启巡检' };

  const { results = [] } = await env.DB
    .prepare("SELECT * FROM domains WHERE kind IN ('entry', 'landing', 'short') ORDER BY id")
    .all();

  const failures = [];
  for (const domain of results) {
    // 串行探测：域名数量有限，避免瞬时打出大量外部请求。
    // eslint-disable-next-line no-await-in-loop
    const result = await probe(domain.host, fetchImpl);
    // eslint-disable-next-line no-await-in-loop
    await env.DB
      .prepare(
        `INSERT INTO inspection_logs (kind, target, ok, status, latency_ms, detail, notified, created_at)
         VALUES ('domain', ?, ?, ?, ?, ?, 0, ?)`,
      )
      .bind(domain.host, result.reachable ? 1 : 0, result.status, result.latencyMs, result.detail, nowSeconds())
      .run();
    if (!result.reachable) failures.push({ host: domain.host, ...result });
  }

  const summary = {
    checked: results.length,
    failed: failures.length,
    failures: failures.map((item) => item.host),
  };

  if (failures.length && config.notify_channel) {
    const notified = await notify(env.DB, {
      channelId: config.notify_channel,
      message: buildMessage({
        title: `【告警】${failures.length} 个域名不可达`,
        text: failures.map((item) => `${item.host}：HTTP ${item.status} ${item.detail ?? ''}`).join('\n'),
        level: 'error',
        time: new Date().toISOString(),
      }),
    });
    summary.notified = Boolean(notified.ok);
  }

  await env.DB
    .prepare('UPDATE domain_checks SET last_status = ?, checked_at = ? WHERE id = 1')
    .bind(failures.length ? `failed:${failures.length}` : 'ok', nowSeconds())
    .run();

  return summary;
}

async function probe(host, fetchImpl) {
  const started = Date.now();
  try {
    const response = await fetchImpl(`https://${host}`, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    // 3xx/4xx 也算「域名活着」：关键是 DNS 与 TLS 链路通。
    const reachable = response.status > 0 && response.status < 500;
    return {
      reachable,
      status: response.status,
      latencyMs: Date.now() - started,
      detail: reachable ? null : `服务端返回 ${response.status}`,
    };
  } catch (error) {
    return {
      reachable: false,
      status: 0,
      latencyMs: Date.now() - started,
      detail: String(error?.message ?? error).slice(0, 200),
    };
  }
}

/* ---------------- 卡密库存巡检 ---------------- */

async function inspectCardkeys(env) {
  const { results = [] } = await env.DB
    .prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM cardkeys k WHERE k.batch_id = b.id AND k.status = 'unused') AS remaining
       FROM cardkey_batches b
       WHERE b.status = 'active' AND b.low_stock > 0`,
    )
    .all();

  const low = [];
  for (const batch of results) {
    if (batch.remaining > batch.low_stock) continue;
    low.push({ id: batch.id, name: batch.name, remaining: batch.remaining, lowStock: batch.low_stock });

    // eslint-disable-next-line no-await-in-loop
    await env.DB
      .prepare(
        `INSERT INTO inspection_logs (kind, target, ok, status, latency_ms, detail, notified, created_at)
         VALUES ('cardkey', ?, 0, 0, 0, ?, 0, ?)`,
      )
      .bind(batch.name, `剩余 ${batch.remaining} 张，低于阈值 ${batch.low_stock}`, nowSeconds())
      .run();
  }

  if (low.length && results[0]?.notify_channel) {
    await notify(env.DB, {
      channelId: results[0].notify_channel,
      message: buildMessage({
        title: `【告警】${low.length} 个卡密批次库存不足`,
        text: low.map((item) => `${item.name}：剩余 ${item.remaining} / 阈值 ${item.lowStock}`).join('\n'),
        level: 'warn',
        time: new Date().toISOString(),
      }),
    });
  }

  return { low: low.length, batches: low.map((item) => item.name) };
}

/** 巡检日志分页查询，供后台「巡检日志」页面使用。 */
export async function listInspectionLogs(env, query) {
  const { page, pageSize, kind } = query;
  const params = [];
  let clause = '';
  if (kind === 'domain' || kind === 'cardkey') {
    clause = 'WHERE kind = ?';
    params.push(kind);
  }

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM inspection_logs ${clause}`).bind(...params).first();
  const { results = [] } = await env.DB
    .prepare(`SELECT * FROM inspection_logs ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all();

  return { total: totalRow?.total ?? 0, page, pageSize, items: results };
}

/** 立即执行一次巡检（后台手动触发按钮）。 */
export async function inspectNow(env) {
  return runInspection(env);
}

export { todayKey };
