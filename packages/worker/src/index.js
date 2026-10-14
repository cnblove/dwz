import { AppError, badRequest, json, notFound, ok, clientIp, readJson } from './lib/http.js';
import { authenticate, extractToken, resolveSession } from './lib/auth.js';
import { resolveChannel, resolveCode, resolveShortLink } from './domain/resolve.js';
import { renderDeniedPage, renderExpiredPage, renderMessagePage } from './domain/pages.js';
import { bootstrapStatus, changePassword, loginRoute, logoutRoute, meRoute, register } from './routes/auth.js';
import * as shortLinks from './routes/shortLinks.js';
import * as codes from './routes/codes.js';
import * as channels from './routes/channels.js';
import * as domains from './routes/domains.js';
import * as stats from './routes/stats.js';
import { reportLongPress } from './routes/report.js';
import * as users from './routes/users.js';
import * as openApi from './routes/openApi.js';
import * as notify from './routes/notify.js';
import * as cardkeys from './routes/cardkeys.js';
import { inspectNow, listInspectionLogs, runInspection } from './domain/inspection.js';
import { nowSeconds } from './lib/time.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 跨域：后台与 API 不同源部署，需要放开预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      const response = await route(request, env, ctx, url);
      return withCors(response, request, env);
    } catch (error) {
      const response = errorResponse(error);
      return withCors(response, request, env);
    }
  },

  // Cron 触发：域名可达性与卡密库存巡检。通知失败不影响任务结束。
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runInspection(env).catch((error) => {
        console.error('inspection failed', error);
      }),
    );
  },
};

async function route(request, env, ctx, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/health') {
    return ok({ status: 'healthy', time: nowSeconds() });
  }

  // 短链跳转：/{slug}
  if (request.method === 'GET' && isRootLevelSlug(path)) {
    return handleRedirect(request, env, ctx, path.slice(1));
  }

  if (path.startsWith('/api/')) {
    return handleApi(request, env, url, stripPrefix(path, '/api/'));
  }

  if (path.startsWith('/open/')) {
    return handleOpenApi(request, env, stripPrefix(path, '/open/'));
  }

  // JS 长按上报：页面在子码图片上直接 fetch 这个地址
  if (path === '/report/longpress' && request.method === 'GET') {
    return reportLongPress(env, url.searchParams.get('zm_id'));
  }

  throw notFound('接口不存在');
}

/** 去掉路由前缀，保证传给下游的 path 不带前导斜杠。 */
function stripPrefix(path, prefix) {
  return path.slice(prefix.length).replace(/^\/+/, '');
}

/* ---------------- 跳转 ---------------- */

function isRootLevelSlug(path) {
  // 排除静态与已注册前缀，其余单段路径都当作短链 key
  const reserved = new Set([
    'health', 'api', 'open', 'report', 'favicon.ico', 'robots.txt', 'assets', 'index.html',
  ]);
  if (path === '/' || path.includes('.', 1)) return false;
  const segments = path.slice(1).split('/');
  if (segments.length !== 1) return false;
  return !reserved.has(segments[0]);
}

async function handleRedirect(request, env, ctx, slug) {
  const candidates = await Promise.all([
    resolveShortLink(env, ctx, { slug, request }),
    resolveCode(env, ctx, { slug, request }),
    resolveChannel(env, ctx, { slug, request }),
  ]);

  // 三类资源共用同一个命名空间，命中即用
  const hit = candidates.find((item) => !['missing'].includes(item.type));
  if (!hit) {
    return renderMessagePage({ title: '链接不存在', message: '链接不存在或已被删除' }, env, 404);
  }

  switch (hit.type) {
    case 'redirect':
      return Response.redirect(hit.url, 302);
    case 'rotate': {
      const base = env.SHORT_ORIGIN || new URL(request.url).origin;
      const target = new URL(`/${hit.slug}`, base);
      return Response.redirect(target.toString(), 302);
    }
    case 'merge': {
      const base = env.SHORT_ORIGIN || new URL(request.url).origin;
      return Response.redirect(new URL(`/${hit.slug}`, base).toString(), 302);
    }
    case 'denied':
      return renderDeniedPage(hit, env);
    case 'expired':
      return renderMessagePage({ title: '链接已过期', message: hit.message }, env, 410);
    case 'paused':
      return renderMessagePage({ title: '温馨提示', message: hit.message }, env, 403);
    case 'exhausted':
      return renderMessagePage(
        { title: '温馨提示', message: hit.message, fallbackUrl: hit.fallbackUrl },
        env,
        200,
      );
    case 'render':
      return renderCodeLanding(hit, env);
    default:
      return renderMessagePage({ title: '温馨提示', message: '链接暂时不可用' }, env, 500);
  }
}

/**
 * 活码落地页由后端直接吐 HTML。
 * 原因：访客打开链接的第一跳不能依赖前端 hydration，
 * 否则在微信内置浏览器里会出现可见的空白闪烁。
 */
function renderCodeLanding(hit, env) {
  const { code, qrcode, sticky } = hit;
  return import('./domain/pages.js').then((mod) => mod.renderCodePage(code, qrcode, { env, sticky }));
}

/* ---------------- 后台 API ---------------- */

async function handleApi(request, env, url, path) {
  const db = env.DB;

  // 无鉴权接口
  if (path === 'bootstrap') {
    return ok(await bootstrapStatus(env));
  }
  if (path === 'auth/register' && request.method === 'POST') {
    return register(env, request);
  }
  if (path === 'auth/login' && request.method === 'POST') {
    return loginRoute(env, request);
  }
  if (path === 'auth/logout' && request.method === 'POST') {
    return logoutRoute(env, request);
  }
  // 卡密兑换面向访客，不需要登录；内部按 IP 做每日限流
  if (path === 'cardkeys/redeem' && request.method === 'POST') {
    return cardkeys.redeem(env, request);
  }

  const session = await authenticate(db, request);
  if (!session) throw new AppError('未登录或登录已过期', 401);

  if (path === 'auth/me') return meRoute(env, session);
  if (path === 'auth/password' && request.method === 'POST') {
    return changePassword(env, request, session);
  }

  const segments = path.split('/');
  const resource = segments[0];
  const id = segments[1] ? Number(segments[1]) : null;
  const sub = segments[2];

  switch (resource) {
    case 'short-links':
      if (request.method === 'GET' && !id) return shortLinks.listShortLinks(env, url, session);
      if (request.method === 'POST' && !id) return shortLinks.createShortLink(env, request, session);
      if (request.method === 'GET' && id) return shortLinks.getShortLink(env, id, session);
      if (request.method === 'PATCH' && id) return shortLinks.updateShortLink(env, request, id, session);
      if (request.method === 'DELETE' && id) return shortLinks.deleteShortLink(env, id, session);
      if (request.method === 'POST' && id && sub === 'reset') {
        return shortLinks.resetShortLinkStats(env, id, session);
      }
      break;

    case 'codes':
      if (request.method === 'GET' && !id) return codes.listCodes(env, url, session);
      if (request.method === 'POST' && !id) return codes.createCode(env, request, session);
      if (request.method === 'GET' && id) return codes.getCode(env, id, session);
      if (request.method === 'PATCH' && id) return codes.updateCode(env, request, id, session);
      if (request.method === 'DELETE' && id) return codes.deleteCode(env, id, session);
      // 给指定活码新增子码
      if (request.method === 'POST' && id) return codes.addQrcode(env, request, id, session);
      break;

    case 'qrcodes':
      if (request.method === 'PATCH' && id) return codes.updateQrcode(env, request, id, session);
      if (request.method === 'DELETE' && id) return codes.deleteQrcode(env, id, session);
      if (request.method === 'POST' && id && sub === 'reset') {
        return codes.resetQrcodeHits(env, id, session);
      }
      break;

    case 'merges':
      if (request.method === 'POST') return codes.createMerge(env, request, session);
      if (request.method === 'DELETE' && id) return codes.deleteMerge(env, id, session);
      break;

    case 'channels':
      if (request.method === 'GET' && !id) return channels.listChannels(env, url, session);
      if (request.method === 'POST' && !id) return channels.createChannel(env, request, session);
      if (request.method === 'GET' && id) return channels.getChannel(env, id, session);
      if (request.method === 'PATCH' && id) return channels.updateChannel(env, request, id, session);
      if (request.method === 'DELETE' && id) return channels.deleteChannel(env, id, session);
      if (request.method === 'POST' && id && sub === 'blocks') {
        return channels.blockVisitor(env, request, id, session);
      }
      break;

    case 'blocks':
      if (request.method === 'DELETE' && id) return channels.unblockVisitor(env, id, session);
      break;

    case 'domains':
      if (request.method === 'GET' && !id) return domains.listDomains(env, url);
      if (request.method === 'POST' && !id) return domains.createDomain(env, request);
      if (request.method === 'PATCH' && id) return domains.updateDomain(env, request, id);
      if (request.method === 'DELETE' && id) return domains.deleteDomain(env, id);
      if (request.method === 'POST' && sub === 'probe') return domains.probeDomain(env, request);
      break;

    case 'domain-check':
      if (request.method === 'GET') return domains.getDomainCheck(env);
      if (request.method === 'PATCH') return domains.updateDomainCheck(env, request);
      break;

    case 'stats':
      if (!id) return stats.overview(env, session);
      if (id === 'detail') return stats.detail(env, url, url.searchParams.get('source') ?? 'short_link');
      if (id === 'prune' && request.method === 'POST') {
        requireOwnerRole(session);
        return stats.prune(env, request);
      }
      break;

    case 'users':
      requireOwnerRole(session);
      if (request.method === 'GET' && !id) return users.listUsers(env, url);
      if (request.method === 'POST' && !id) return users.createUser(env, request);
      if (request.method === 'PATCH' && id) return users.updateUser(env, request, id, session);
      if (request.method === 'DELETE' && id) return users.deleteUser(env, id, session);
      break;

    case 'groups':
      requireOwnerRole(session);
      if (request.method === 'GET') return users.listGroups(env);
      if (request.method === 'POST') return users.createGroup(env, request);
      if (request.method === 'PATCH' && id) return users.updateGroup(env, request, id);
      if (request.method === 'DELETE' && id) return users.deleteGroup(env, id);
      break;

    case 'audit-logs':
      requireOwnerRole(session);
      if (request.method === 'GET') return users.listAuditLogs(env, url);
      break;

    case 'credentials':
      if (request.method === 'GET') return openApi.listCredentials(env, session);
      if (request.method === 'POST') return openApi.createCredential(env, request, session);
      if (request.method === 'PATCH' && id) return openApi.updateCredential(env, request, id, session);
      if (request.method === 'DELETE' && id) return openApi.deleteCredential(env, id, session);
      break;

    case 'notify-channels':
      requireOwnerRole(session);
      if (request.method === 'GET' && !id) return notify.listNotifyChannels(env);
      if (request.method === 'POST' && !id) return notify.createNotifyChannel(env, request);
      if (request.method === 'PATCH' && id) return notify.updateNotifyChannel(env, request, id);
      if (request.method === 'DELETE' && id) return notify.deleteNotifyChannel(env, id);
      if (request.method === 'POST' && id && sub === 'test') return notify.testNotifyChannel(env, id);
      break;

    case 'cardkeys':
      if (request.method === 'GET' && !id) return cardkeys.listBatches(env, url, session);
      if (request.method === 'POST' && !id) return cardkeys.createBatch(env, request, session);
      if (request.method === 'GET' && id) return cardkeys.getBatch(env, id, session);
      if (request.method === 'PATCH' && id) return cardkeys.updateBatch(env, request, id, session);
      if (request.method === 'DELETE' && id) return cardkeys.deleteBatch(env, id, session);
      if (request.method === 'POST' && id && sub === 'append') return cardkeys.appendKeys(env, request, id, session);
      break;

    case 'inspection':
      requireOwnerRole(session);
      if (request.method === 'GET' && !id) {
        return ok(await listInspectionLogs(env, url));
      }
      if (request.method === 'POST' && segments[1] === 'run') {
        return ok({ result: await inspectNow(env) });
      }
      break;

    default:
      break;
  }

  throw notFound('接口不存在');
}

function requireOwnerRole(session) {
  if (session.role !== 'owner') throw new AppError('仅超级管理员可执行该操作', 403);
}

/* ---------------- 开放 API ---------------- */

async function handleOpenApi(request, env, path) {
  if (request.method !== 'POST') throw badRequest('开放接口仅接受 POST');
  switch (path) {
    case 'v1/short-links':
      return openApi.createShortLinkViaApi(env, request);
    case 'v1/stats':
      return openApi.queryStatsViaApi(env, request);
    default:
      throw notFound('开放接口不存在');
  }
}

/* ---------------- 公共 ---------------- */

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') ?? '';
  const allowed = (env.WEB_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const allowOrigin = allowed.length === 0 || allowed.includes(origin) ? (origin || '*') : allowed[0];
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-allow-credentials': 'true',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, env))) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function errorResponse(error) {
  if (error instanceof AppError) {
    return json({ code: error.code, msg: error.message }, { status: error.code });
  }
  // 未预期异常：不把内部细节抛给调用方，日志留在平台侧
  console.error('unhandled error', error);
  return json({ code: 500, msg: '服务暂时不可用，请稍后重试' }, { status: 500 });
}

export { clientIp, readJson, resolveSession, extractToken };
