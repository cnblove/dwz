import { ok } from '../lib/http.js';
import { dailyBreakdown, hourlyBreakdown, visitorSummary } from '../lib/stats.js';
import { todayKey, nowSeconds } from '../lib/time.js';

/** 后台首页概览：总量 + 今日 + 近 7 天趋势。 */
export async function overview(env, session) {
  const db = env.DB;
  const day = todayKey();
  const scope = session.role === 'owner' ? '' : 'AND owner_id = ?';
  const params = session.role === 'owner' ? [] : [session.id];

  const [links, codes, channels, domains] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(hits), 0) AS hits,
              COALESCE(SUM(CASE WHEN hits_today_on = ? THEN hits_today ELSE 0 END), 0) AS hits_today
       FROM short_links WHERE 1 = 1 ${scope}`,
    ).bind(day, ...params).first(),
    db.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(hits), 0) AS hits,
              COALESCE(SUM(CASE WHEN hits_today_on = ? THEN hits_today ELSE 0 END), 0) AS hits_today
       FROM codes WHERE 1 = 1 ${scope}`,
    ).bind(day, ...params).first(),
    db.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(hits), 0) AS hits,
              COALESCE(SUM(CASE WHEN hits_today_on = ? THEN hits_today ELSE 0 END), 0) AS hits_today
       FROM channels WHERE 1 = 1 ${scope}`,
    ).bind(day, ...params).first(),
    db.prepare('SELECT COUNT(*) AS total FROM domains').first(),
  ]);

  return ok({
    day,
    links: { total: links?.total ?? 0, hits: links?.hits ?? 0, hitsToday: links?.hits_today ?? 0 },
    codes: { total: codes?.total ?? 0, hits: codes?.hits ?? 0, hitsToday: codes?.hits_today ?? 0 },
    channels: { total: channels?.total ?? 0, hits: channels?.hits ?? 0, hitsToday: channels?.hits_today ?? 0 },
    domains: { total: domains?.total ?? 0 },
  });
}

/** 单类资源的统计明细：小时分布 + 近 7 天 + 独立访客。 */
export async function detail(env, url, source) {
  const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days') ?? 7)));
  const day = url.searchParams.get('day') || todayKey();
  const [hourly, daily, visitors] = await Promise.all([
    hourlyBreakdown(env.DB, source, day),
    dailyBreakdown(env.DB, source, days),
    visitorSummary(env.DB, source, day),
  ]);
  return ok({ source, day, hourly, daily, visitors });
}

/** 灰度清理：删除历史访问明细，保留聚合结果。 */
export async function prune(env, request) {
  const body = await import('../lib/http.js').then((m) => m.readJson(request));
  const keepDays = Math.min(365, Math.max(1, Number(body.keepDays ?? 90)));
  const cutoff = new Date(Date.now() - keepDays * 86400_000).toISOString().slice(0, 10);
  const result = await env.DB.prepare('DELETE FROM daily_visitors WHERE day < ?').bind(cutoff).run();
  return ok({ deleted: result.meta?.changes ?? 0, cutoff, at: nowSeconds() });
}
