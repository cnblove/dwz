import { notFound, ok } from '../lib/http.js';
import { authorizeCall } from '../lib/openApiCore.js';
import { dailyBreakdown, hourlyBreakdown, visitorSummary } from '../lib/stats.js';
import { todayKey } from '../lib/time.js';
import { openStatsSchema } from '../schemas/openStats.js';

/**
 * 开放接口的「访问分析」。
 *
 * 后台「统计」页给的是全局视角，这里给的是**单条资源**视角 ——
 * 外部脚本（或 AI）最常问的就是「这条短链这两天跑了多少、哪个小时最猛」。
 * 因此返回结构与后台 detail 保持一致：小时分布 + 近 N 天趋势 + 独立访客，
 * 一份数据两种入口，不重新定义口径。
 */
const SOURCE_BY_RESOURCE = {
  'short-links': 'short_link',
  codes: 'code_group',
  channels: 'channel',
};

const TABLE_BY_SOURCE = {
  short_link: 'short_links',
  code_group: 'codes',
  channel: 'channels',
};

export async function resourceStats(env, body, request) {
  const { cred, input } = await authorizeCall(env, request, body, openStatsSchema);
  const db = env.DB;

  // 先在三个资源表里找 slug，命中哪个就用哪个统计口径 ——
  // 三类资源共用同一个 slug 命名空间，调用方不需要知道它当初建的是哪一类。
  let source = null;
  let row = null;
  for (const [candidate, table] of Object.entries(TABLE_BY_SOURCE)) {
    // eslint-disable-next-line no-await-in-loop
    const hit = await db.prepare(`SELECT * FROM ${table} WHERE slug = ?`).bind(input.dv1_slug).first();
    if (hit) {
      source = candidate;
      row = hit;
      break;
    }
  }
  if (!row) throw notFound('资源不存在');
  if (row.owner_id !== cred.user_id) throw notFound('资源不存在');

  const day = input.dv1_day || todayKey();
  const [hourly, daily, visitors] = await Promise.all([
    hourlyBreakdown(db, source, day),
    dailyBreakdown(db, source, input.dv1_days),
    visitorSummary(db, source, day),
  ]);

  return ok({
    slug: row.slug,
    title: row.title,
    source,
    day,
    days: input.dv1_days,
    hits: row.hits,
    hitsToday: row.hits_today_on === day ? row.hits_today : 0,
    status: row.status,
    hourly,
    daily,
    visitors,
  });
}

export { SOURCE_BY_RESOURCE };
