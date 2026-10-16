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

/**
 * 最近访客分页列表。
 *
 * `ownerId` 为 null 表示看全部（超管）；给了值就只返回该账号名下资源产生的访问。
 *
 * 为什么必须在这里收敛而不是在 handler 里过滤：`visit_logs` 存的是**原始 IP**，
 * 是全库最敏感的一张表。之前这个函数不带任何归属条件，于是任何登录用户
 * `GET /api/stats/visitors` 就能把全站访客的 IP、归属地、设备逐页翻完 ——
 * 分页参数还任由调用方指定。这类「读接口忘了收敛」比写接口越权更隐蔽，
 * 因为它不留痕迹。
 *
 * 归属靠 `page_id + source` 回查资源表：明细刻意冗余了 slug / title，
 * 就是为了资源删除后还能回溯，所以这里不能用 slug 关联（已删的行会漏掉），
 * 只能按 id 归属。三类资源的来源标识与表名一一对应，见 SOURCE_TABLES。
 */
export async function listVisits(db, { page = 1, pageSize = 10, source = null, ownerId = null } = {}) {
  const where = [];
  const params = [];

  if (ownerId !== null && ownerId !== undefined) {
    // 三类资源各一张表，用三个 EXISTS 拼出「这条明细的宿主是不是我的」。
    //
    // 刻意不用 `(source, page_id) IN (SELECT ...)` 那种行值写法：SQLite 在
    // 子查询里比对行值时用不上索引，实测在 node:sqlite 上直接返回空集 ——
    // 一个「看起来对、实际把所有明细都过滤掉」的静默错误。EXISTS 每个分支
    // 只探一次主键，行为与代价都确定。
    where.push(`(${SOURCE_TABLES.map(({ table, sources }) => {
      const list = sources.map(() => '?').join(', ');
      return `EXISTS (SELECT 1 FROM ${table} t WHERE t.id = visit_logs.page_id AND t.owner_id = ? AND visit_logs.source IN (${list}))`;
    }).join(' OR ')})`);
    for (const { sources } of SOURCE_TABLES) {
      params.push(ownerId, ...sources);
    }
  }
  if (source) {
    where.push('source = ?');
    params.push(source);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = await db.prepare(`SELECT COUNT(*) AS total FROM visit_logs ${clause}`).bind(...params).first();
  const { results = [] } = await db
    .prepare(`SELECT * FROM visit_logs ${clause} ORDER BY last_seen_at DESC, id DESC LIMIT ? OFFSET ?`)
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
 * 来源标识 ↔ 资源表。
 *
 * `visit_logs.source` 用的是「短链 / 群活码 / 客服码 / 渠道码」这四种来源名，
 * 而归属信息（owner_id）在资源表上。按 ownerId 收敛时必须把两者对上，
 * 所以这张映射是唯一的连接点 —— 新增一种来源时只改这里。
 *
 * 群活码与客服码落在同一张 codes 表（kind 区分），所以它们共用一条分支，
 * `sources` 是数组。
 */
export const SOURCE_TABLES = [
  { table: 'short_links', sources: ['short_link'] },
  { table: 'codes', sources: ['code_group', 'code_service'] },
  { table: 'channels', sources: ['channel'] },
];

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
