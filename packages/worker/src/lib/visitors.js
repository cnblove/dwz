import { todayKey } from './time.js';
import { detectApp, detectOs, detectPlatform } from './ua.js';

/**
 * 最近访客明细。
 *
 * 与 `daily_visitors` 的分工：
 *   - `daily_visitors` 存加盐哈希，只够回答「今天有多少独立访客」；
 *   - `visit_logs` 存原始 IP，回答「谁来过、什么时候来、从哪个入口来」。
 *
 * 原始 IP 是个人信息，所以这张表**不是流水账**：
 *   1. 同一 (来源, 页面, IP) 在同一天只保留一行，重复访问累加 hits；
 *   2. 保留天数可配置（默认 7 天），由 Cron 滚动清理；
 *   3. 写入失败不影响跳转 —— 明细是运营视角的附加信息，不是主链路。
 */

/**
 * 明细保留天数的上下界。
 * 下界 1 天是「至少能看今天」，上界 365 天是为了不让人把它当永久档案用 ——
 * 真要为合规留档，应该走单独的数据导出，而不是让跳转链路无上限存 IP。
 */
export const KEEP_DAYS_MIN = 1;
export const KEEP_DAYS_MAX = 365;
export const DEFAULT_KEEP_DAYS = 7;

export function normalizeKeepDays(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_KEEP_DAYS;
  return Math.min(KEEP_DAYS_MAX, Math.max(KEEP_DAYS_MIN, n));
}

/** 设备形态：运营看的是「手机还是电脑」，而不是具体机型。 */
function detectDevice(ua, os) {
  if (/iPhone|iPad|iOS|Android/i.test(os)) return '移动端';
  if (/MicroMessenger|WeChat/i.test(ua)) return '移动端';
  return 'PC';
}

/**
 * 记录一条访客明细。
 *
 * UPSERT 而不是 INSERT：同一访客当天反复刷同一个页面时，
 * 我们要的是「次数 +1、时间刷新」，而不是往表里堆同义行。
 */
export async function recordVisit(db, { source, pageId, slug, title, ip, ua = '', country = null, now = Date.now() }) {
  if (!source || !pageId) return false;
  const day = todayKey(now);
  const ts = Math.floor(now / 1000);
  const os = detectOs(ua);
  const platform = detectPlatform(ua);
  const result = await db
    .prepare(
      `INSERT INTO visit_logs
         (source, page_id, slug, title, ip, country, os, app, platform, device, first_seen_at, last_seen_at, hits, day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (source, page_id, ip, day)
       DO UPDATE SET hits = hits + 1,
                     last_seen_at = excluded.last_seen_at,
                     os = excluded.os,
                     app = excluded.app,
                     platform = excluded.platform,
                     device = excluded.device,
                     title = excluded.title,
                     country = COALESCE(excluded.country, visit_logs.country)`,
    )
    .bind(
      source,
      pageId,
      slug ?? null,
      title ?? null,
      ip || 'unknown',
      country || null,
      os,
      detectApp(ua),
      platform,
      detectDevice(ua, os),
      ts,
      ts,
      day,
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/** 最近访客分页列表。 */
export async function listVisits(db, { page = 1, pageSize = 10, source = null } = {}) {
  const where = source ? 'WHERE source = ?' : '';
  const params = source ? [source] : [];
  const totalRow = await db.prepare(`SELECT COUNT(*) AS total FROM visit_logs ${where}`).bind(...params).first();
  const { results = [] } = await db
    .prepare(`SELECT * FROM visit_logs ${where} ORDER BY last_seen_at DESC, id DESC LIMIT ? OFFSET ?`)
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all();

  return {
    total: totalRow?.total ?? 0,
    page,
    pageSize,
    items: results.map((row) => ({
      id: row.id,
      source: row.source,
      sourceLabel: SOURCE_LABELS[row.source] ?? row.source,
      pageId: row.page_id,
      slug: row.slug,
      title: row.title,
      ip: row.ip,
      country: row.country,
      os: row.os,
      app: row.app,
      platform: row.platform,
      device: row.device,
      hits: row.hits,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      day: row.day,
    })),
  };
}

/** 来源标签：列表里直接给中文，免得前端再维护一份映射。 */
export const SOURCE_LABELS = {
  short_link: '短链',
  code_group: '群活码',
  code_service: '客服码',
  channel: '渠道码',
};

/**
 * 按天滚动清理。
 * 保留「今天在内的最近 keepDays 天」，用日期字符串比较即可 ——
 * day 是北京时间切天后的 'YYYY-MM-DD'，字典序与时间序一致。
 */
export async function pruneVisits(db, keepDays = DEFAULT_KEEP_DAYS, now = Date.now()) {
  const days = normalizeKeepDays(keepDays);
  const cutoff = todayKey(now - (days - 1) * 86400_000);
  const result = await db.prepare('DELETE FROM visit_logs WHERE day < ?').bind(cutoff).run();
  return { deleted: result.meta?.changes ?? 0, cutoff, keepDays: days };
}

/**
 * 明细保留天数，读自单行配置表。
 *
 * domain_checks 是「用到才建行」的配置表：全新部署时里面一行都没有，
 * 所以读不到时回落到默认值，写的时候再真的插行（见 saveKeepDays）。
 */
export async function visitLogSetting(db) {
  const row = await db.prepare('SELECT visit_log_keep_days FROM domain_checks WHERE id = 1').first();
  if (row?.visit_log_keep_days === null || row?.visit_log_keep_days === undefined) return DEFAULT_KEEP_DAYS;
  return normalizeKeepDays(row.visit_log_keep_days);
}

/**
 * 写入保留天数。
 *
 * 必须 UPSERT：domain_checks 的第一行由「域名页保存」或「首次访问明细设置」创建，
 * 只写 UPDATE 的话，在没配过域名的部署上会静默改不动任何东西 ——
 * 界面上看着存了，实际还是默认值。
 */
export async function saveKeepDays(db, keepDays) {
  const days = normalizeKeepDays(keepDays);
  await db
    .prepare(
      `INSERT INTO domain_checks (id, visit_log_keep_days) VALUES (1, ?)
       ON CONFLICT (id) DO UPDATE SET visit_log_keep_days = excluded.visit_log_keep_days`,
    )
    .bind(days)
    .run();
  return days;
}
