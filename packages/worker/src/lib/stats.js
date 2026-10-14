import { hourOfDay, todayKey } from './time.js';
import { visitorHash } from './visitor.js';

/**
 * 访问统计。
 *
 * 设计取舍：跳转路径上不能为了「精确」而付出多轮写库的代价，
 * 所以热点计数直接打在宿主表的 hits / hits_today 上，
 * 小时维度与去重访客单独落表，且都支持失败不影响跳转。
 */

/** 宿主表自增访问量 + 当天访问量（跨天自动归零）。 */
export async function bumpHostCounters(db, table, id, currentRow, now = Date.now()) {
  const day = todayKey(now);
  const sameDay = currentRow.hits_today_on === day;
  const nextToday = sameDay ? (currentRow.hits_today ?? 0) + 1 : 1;
  const nextTotal = (currentRow.hits ?? 0) + 1;

  await db
    .prepare(`UPDATE ${table} SET hits = ?, hits_today = ?, hits_today_on = ?, updated_at = ? WHERE id = ?`)
    .bind(nextTotal, nextToday, day, Math.floor(now / 1000), id)
    .run();

  return { hits: nextTotal, hitsToday: nextToday, day };
}

/** 小时聚合，UPSERT 一条即可，不需要先查后写。 */
export async function bumpHourly(db, source, now = Date.now()) {
  const day = todayKey(now);
  const hour = hourOfDay(now);
  await db
    .prepare(
      `INSERT INTO hourly_stats (source, day, hour, hits) VALUES (?, ?, ?, 1)
       ON CONFLICT (source, day, hour) DO UPDATE SET hits = hits + 1`,
    )
    .bind(source, day, hour)
    .run();
}

/** 按天去重的独立访客数。首次出现才 +1。 */
export async function bumpDailyVisitor(db, source, ip, salt, now = Date.now()) {
  const day = todayKey(now);
  const hash = await visitorHash(ip, salt);
  const result = await db
    .prepare(
      `INSERT INTO daily_visitors (source, day, visitor_ip) VALUES (?, ?, ?)
       ON CONFLICT (source, day, visitor_ip) DO NOTHING`,
    )
    .bind(source, day, hash)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function bumpDailyCounter(db, source, now = Date.now()) {
  const day = todayKey(now);
  await db
    .prepare(
      `INSERT INTO daily_counters (source, day, hits) VALUES (?, ?, 1)
       ON CONFLICT (source, day) DO UPDATE SET hits = hits + 1`,
    )
    .bind(source, day)
    .run();
}


export async function hourlyBreakdown(db, source, day) {
  const { results = [] } = await db
    .prepare('SELECT hour, hits FROM hourly_stats WHERE source = ? AND day = ? ORDER BY hour')
    .bind(source, day)
    .all();
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, hits: 0 }));
  for (const row of results) {
    if (buckets[row.hour]) buckets[row.hour].hits = row.hits;
  }
  return buckets;
}


/** 近 N 天的访问量趋势，缺失的日期补 0，前端直接画图。 */
export async function dailyBreakdown(db, source, days = 7, now = Date.now()) {
  const today = todayKey(now);
  const { results = [] } = await db
    .prepare('SELECT day, hits FROM daily_counters WHERE source = ? AND day <= ? ORDER BY day DESC LIMIT ?')
    .bind(source, today, days)
    .all();

  const byDay = new Map(results.map((row) => [row.day, row.hits]));
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = todayKey(now - i * 86400_000);
    out.push({ day, hits: byDay.get(day) ?? 0 });
  }
  return out;
}

/** 独立访客汇总：总去重数、当日去重数、当日 PV。 */
export async function visitorSummary(db, source, day, now = Date.now()) {
  const target = day || todayKey(now);
  const [total, todayRow, counter] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS total FROM daily_visitors WHERE source = ?').bind(source).first(),
    db.prepare('SELECT COUNT(*) AS total FROM daily_visitors WHERE source = ? AND day = ?').bind(source, target).first(),
    db.prepare('SELECT hits FROM daily_counters WHERE source = ? AND day = ?').bind(source, target).first(),
  ]);
  return {
    visitorsTotal: total?.total ?? 0,
    visitorsToday: todayRow?.total ?? 0,
    hitsToday: counter?.hits ?? 0,
  };
}
