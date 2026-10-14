import { allowsAccess, ACCESS_DENIED_TEXT, pickTargetUrl } from '../lib/ua.js';
import { pickRotatingDomain, pickBackupDomain, probeHost } from '../lib/domains.js';
import { bumpDailyCounter, bumpDailyVisitor, bumpHostCounters, bumpHourly } from '../lib/stats.js';
import { nowSeconds } from '../lib/time.js';

/**
 * 短链解析。
 *
 * 命中优先级：并流 → 轮询域名 → 普通跳转。
 * 每一次访问都要先记数再决策，保证计数不因后续分支提前返回而丢失。
 * 计数全部是单条原子 UPDATE，同一 slug 被并发访问时不会互相覆盖。
 */
export async function resolveShortLink(env, ctx, { slug, request }) {
  const db = env.DB;
  const now = Date.now();
  const ua = request.headers.get('user-agent') || '';
  const link = await db.prepare('SELECT * FROM short_links WHERE slug = ?').bind(slug).first();
  if (!link) return { type: 'missing', message: '链接不存在或已被删除' };
  if (link.status !== 'active') return { type: 'paused', message: '链接已被暂停使用' };

  // 到期拦截优先于跳转，避免过期链接继续放量。
  if (link.expired_at && link.expired_at <= nowSeconds(now)) {
    return link.expired_jump
      ? { type: 'redirect', url: link.expired_jump, reason: 'expired' }
      : { type: 'expired', message: '链接已过期' };
  }

  if (!allowsAccess(link.access_rule, ua)) {
    // 被限制的访问同样计入 PV，它代表真实的曝光。
    ctx.waitUntil(recordShortLinkHit(env, link, request, now));
    return {
      type: 'denied',
      rule: link.access_rule,
      message: ACCESS_DENIED_TEXT[link.access_rule] || '当前环境无法访问',
      targetUrl: link.target_url,
    };
  }

  // 入口域名轮询：把流量分散到多个短链域名上。
  // 巡检开启时先探一下候选域名，不可达就换用备用域名/入口域名，
  // 保证「轮询域名被墙」不会让整条短链失效 —— 降级路径是必须有的。
  if (link.rotate_domain) {
    const domain = await pickRotatingDomain(db);
    if (domain) {
      const check = await rotateDomainCheck(env);
      if (check.reachable || !check.checked) {
        ctx.waitUntil(recordShortLinkHit(env, link, request, now));
        return { type: 'rotate', host: domain, slug };
      }
      const fallback = await pickBackupDomain(db);
      if (fallback) {
        ctx.waitUntil(recordShortLinkHit(env, link, request, now));
        return { type: 'rotate', host: fallback, slug };
      }
    }
  }

  ctx.waitUntil(recordShortLinkHit(env, link, request, now));
  const target = pickTargetUrl(
    { rule: link.access_rule, url: link.target_url, urlIos: link.url_ios, urlAndroid: link.url_android, urlDesktop: link.url_desktop },
    ua,
  );
  return { type: 'redirect', url: target, reason: 'normal' };
}

export function recordShortLinkHit(env, link, request, now) {
  return recordHit(env, {
    table: 'short_links',
    row: link,
    source: 'short_link',
    request,
    now,
  });
}

/**
 * 活码解析（群活码 / 客服码共用）。
 *
 * 子码挑选规则：
 *   1. 并流开启时直接导到并入的活码；
 *   2. sticky 开启且访客已有记忆，稳定返回同一张子码；
 *   3. 阈值模式挑「命中数 < 阈值」的第一张，随机模式在可用集合里随机；
 *   4. 全部触顶时回落到兜底客服码。
 */
export async function resolveCode(env, ctx, { slug, request }) {
  const db = env.DB;
  const now = Date.now();
  const ua = request.headers.get('user-agent') || '';

  const code = await db.prepare('SELECT * FROM codes WHERE slug = ?').bind(slug).first();
  if (!code) return { type: 'missing', message: '链接不存在或已被删除' };
  if (code.status !== 'active') return { type: 'paused', message: '链接已被暂停使用' };

  // 并流：原活码的流量整体导走
  const merge = await db
    .prepare("SELECT * FROM code_merges WHERE from_slug = ? AND status = 'active'")
    .bind(slug)
    .first();
  if (merge) {
    const target = await db.prepare('SELECT slug FROM codes WHERE id = ?').bind(merge.to_code_id).first();
    if (target) {
      // merges + 1 交给 SQL 自增，避免并发下按旧值写回
      ctx.waitUntil(
        db.prepare('UPDATE code_merges SET merges = merges + 1 WHERE id = ?').bind(merge.id).run(),
      );
      ctx.waitUntil(recordCodeHit(env, code, request, now));
      return { type: 'merge', slug: target.slug };
    }
  }

  const picked = await pickQrcode(env, code, request, now);
  ctx.waitUntil(recordCodeHit(env, code, request, now));

  if (!picked) {
    return {
      type: 'exhausted',
      message: code.kind === 'group' ? '扫码次数已达上限' : '暂无可用的二维码',
      fallbackUrl: code.fallback_on ? code.fallback_url : null,
    };
  }

  ctx.waitUntil(bumpQrcodeHits(db, picked.id));
  return {
    type: 'render',
    code,
    qrcode: picked,
    sticky: Boolean(code.sticky),
    ua,
  };
}

async function pickQrcode(env, code, request, now) {
  const db = env.DB;

  if (code.pick_mode === 'random') {
    const row = await db
      .prepare(
        `SELECT * FROM code_qrcodes
         WHERE code_id = ? AND status = 'active'
         ORDER BY RANDOM() LIMIT 1`,
      )
      .bind(code.id)
      .first();
    return row ?? null;
  }

  return db
    .prepare(
      `SELECT * FROM code_qrcodes
       WHERE code_id = ? AND status = 'active' AND hits < threshold
       ORDER BY id LIMIT 1`,
    )
    .bind(code.id)
    .first();
}

export function recordCodeHit(env, code, request, now) {
  return recordHit(env, {
    table: 'codes',
    row: code,
    source: code.kind === 'group' ? 'code_group' : 'code_service',
    request,
    now,
  });
}

/**
 * 子码命中计数：必须用原子的 hits + 1。
 * 若按「读到旧值再写回」的方式更新，同一张子码被并发访问时后写的会覆盖先写的，
 * 阈值很快被打满的情况下会造成漏计，进而让「阈值轮换」提前切码。
 */
function bumpQrcodeHits(db, qrcodeId) {
  return db
    .prepare('UPDATE code_qrcodes SET hits = hits + 1, updated_at = ? WHERE id = ?')
    .bind(Math.floor(Date.now() / 1000), qrcodeId)
    .run();
}

/**
 * 渠道码解析：短链 + 来源归因。
 * 同一 (渠道, IP, App, 系统) 只维护一行并累加，便于后台按来源看转化。
 */
export async function resolveChannel(env, ctx, { slug, request }) {
  const db = env.DB;
  const now = Date.now();
  const ua = request.headers.get('user-agent') || '';
  const channel = await db.prepare('SELECT * FROM channels WHERE slug = ?').bind(slug).first();
  if (!channel) return { type: 'missing', message: '页面不存在或已被删除' };
  if (channel.status !== 'active') return { type: 'paused', message: '页面已被暂停使用' };

  ctx.waitUntil(recordChannelHit(env, channel, request, now));

  if (!allowsAccess(channel.access_rule, ua)) {
    return {
      type: 'denied',
      rule: channel.access_rule,
      message: ACCESS_DENIED_TEXT[channel.access_rule] || '当前环境无法访问',
      targetUrl: channel.target_url,
    };
  }

  return { type: 'redirect', url: channel.target_url, reason: 'channel' };
}

/** 渠道访问落库：黑名单优先，其次按来源聚合。 */
async function recordChannelHit(env, channel, request, now) {
  const db = env.DB;
  const { detectApp, detectOs } = await import('../lib/ua.js');
  const { clientIp } = await import('../lib/http.js');
  const ip = clientIp(request);
  const ipHash = await (await import('../lib/visitor.js')).visitorHash(ip, env.VISITOR_SALT);
  const ua = request.headers.get('user-agent') || '';

  await bumpHostCounters(db, 'channels', channel.id, channel, now);

  const blocked = await db
    .prepare('SELECT 1 AS hit FROM channel_blocks WHERE channel_id = ? AND visitor_ip = ?')
    .bind(channel.id, ipHash)
    .first();
  if (blocked) return;

  const app = detectApp(ua);
  const os = detectOs(ua);
  await db
    .prepare(
      `INSERT INTO channel_visits (channel_id, visitor_ip, app, os, hits, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (channel_id, visitor_ip, app, os)
       DO UPDATE SET hits = hits + 1, last_seen_at = excluded.last_seen_at`,
    )
    .bind(channel.id, ipHash, app, os, Math.floor(now / 1000), Math.floor(now / 1000))
    .run();
}

/** 公共计数逻辑：宿主表 + 小时 + 独立访客。 */
export async function recordHit(env, { table, row, source, request, now }) {
  const db = env.DB;
  const { clientIp } = await import('../lib/http.js');
  await bumpHostCounters(db, table, row.id, row, now);
  await bumpHourly(db, source, now);
  await bumpDailyCounter(db, source, now);
  await bumpDailyVisitor(db, source, clientIp(request), env.VISITOR_SALT, now);
}

/**
 * 轮询前是否要探活：只在后台开启了域名巡检时才做，
 * 巡检关闭时按原样放行，不额外增加一次外部请求。
 */
async function rotateDomainCheck(env) {
  const config = await env.DB.prepare('SELECT * FROM domain_checks WHERE id = 1').first();
  if (!config || !config.enabled) return { checked: false, reachable: true };
  const domain = await pickRotatingDomain(env.DB);
  if (!domain) return { checked: false, reachable: true };
  const result = await probeHost(domain);
  return { checked: true, reachable: result.reachable };
}
