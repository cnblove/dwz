import { badRequest, ok } from '../lib/http.js';
import { dailyBreakdown, hourlyBreakdown, visitorSummary } from '../lib/stats.js';
import { listVisits, normalizeKeepDays, pruneVisits, saveKeepDays, visitLogSetting } from '../lib/visitors.js';
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
export async function detail(env, query, source) {
  const days = Math.min(30, Math.max(1, Number(query.days ?? 7)));
  const day = query.day || todayKey();
  const [hourly, daily, visitors] = await Promise.all([
    hourlyBreakdown(env.DB, source, day),
    dailyBreakdown(env.DB, source, days),
    visitorSummary(env.DB, source, day),
  ]);
  return ok({ source, day, hourly, daily, visitors });
}

/**
 * 最近访客明细。
 *
 * 与「独立访客」的区别是这里带原始 IP、归属地、设备与访问时间 ——
 * 私域运营要靠它判断「哪条入口拉来了人」，聚合口径答不了这个问题。
 * 因此这张表保留原始 IP，但只保留最近 N 天（见 visitLogKeepDays）。
 */
export async function visitors(env, query, session) {
  const db = env.DB;
  const page = Math.max(1, Math.trunc(Number(query.page ?? 1)) || 1);
  const pageSize = Math.min(50, Math.max(1, Math.trunc(Number(query.pageSize ?? 10)) || 10));
  const keepDays = await visitLogSetting(db);
  const list = await listVisits(db, { page, pageSize });
  return ok({
    ...list,
    keepDays,
    // 只有超管能改保留天数与清库，普通成员看得到但改不了
    canManage: session.role === 'owner',
    note: `原始 IP 仅保留最近 ${keepDays} 天，超期由定时任务自动清理。`,
  });
}

/** 灰度清理：删除历史访问明细，保留聚合结果。 */
export async function prune(env, query) {
  const keepDays = Math.min(365, Math.max(1, Number(query.keepDays ?? 90)));
  const cutoff = new Date(Date.now() - keepDays * 86400_000).toISOString().slice(0, 10);
  const result = await env.DB.prepare('DELETE FROM daily_visitors WHERE day < ?').bind(cutoff).run();
  return ok({ deleted: result.meta?.changes ?? 0, cutoff, at: nowSeconds() });
}

/**
 * 修改访客明细保留天数。
 *
 * 「保留原始 IP」这件事必须能被人调紧调松：默认 7 天是运营与合规之间的默认解，
 * 但一个只想看两天的团队，应该能一行配置改掉，而不是去改代码。
 * 顺带立即清理一次，免得界面上显示「保留 1 天」而库里还躺着 7 天的数据。
 */
export async function updateVisitorSetting(env, body) {
  if (!Number.isFinite(Number(body.keepDays))) throw badRequest('保留天数必须是数字');
  const days = await saveKeepDays(env.DB, normalizeKeepDays(body.keepDays));
  const pruned = await pruneVisits(env.DB, days);
  return ok({ keepDays: days, pruned: pruned.deleted });
}

export async function clearVisits(env) {
  const result = await env.DB.prepare('DELETE FROM visit_logs').run();
  return ok({ deleted: result.meta?.changes ?? 0 });
}
