import { Hono } from 'hono';
import { AppError, json, notFound, ok } from './lib/http.js';
import { resolveChannel, resolveCode, resolveShortLink } from './domain/resolve.js';
import { renderDeniedPage, renderMessagePage } from './domain/pages.js';
import { reportLongPress } from './routes/report.js';
import { validateQuery } from './lib/validation.js';
import { longPressQuery } from './schemas/index.js';
import { nowSeconds } from './lib/time.js';
import api from './routes/api.js';
import open from './routes/open.js';

/**
 * Hono 应用装配。
 *
 * 结构：
 *   - 全局中间件：CORS、错误归一
 *   - /api  → 后台接口子应用
 *   - /open → 开放接口子应用
 *   - /health、/report/longpress、/:slug → 根级路由
 *
 * 注意：后台静态资源由 Worker 入口（src/index.js）的 assets 绑定处理，
 * 这里只管动态路由；两者的先后顺序在入口处决定。
 */
const app = new Hono();

/* ---------------- 中间件 ---------------- */

// 跨域：后台与 API 默认同源（同一个 Worker）；保留 CORS 是为了让
// 自建后台、脚本调用方这类非同源客户端也能直接用
app.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(c.req.raw, c.env) });
  }
  await next();
  c.res = withCors(c.res, c.req.raw, c.env);
});

app.onError((error, c) => {
  if (error instanceof AppError) {
    return json({ code: error.code, msg: error.message }, { status: error.code });
  }
  // 未预期异常：不把内部细节抛给调用方，日志留在平台侧
  console.error('unhandled error', error);
  return json({ code: 500, msg: '服务暂时不可用，请稍后重试' }, { status: 500 });
});

app.notFound(() => json({ code: 404, msg: '接口不存在' }, { status: 404 }));

/* ---------------- 根级路由 ---------------- */

app.get('/health', (c) => ok({ status: 'healthy', time: nowSeconds() }));

// JS 长按上报：页面在子码图片上直接 fetch 这个地址
app.get('/report/longpress', validateQuery(longPressQuery), (c) =>
  reportLongPress(c.env, c.req.valid('query').zm_id));

// 短链跳转：/{slug}，必须放在最后，避免吞掉上面的固定路径
app.get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!isRootLevelSlug(slug)) throw notFound('接口不存在');
  return handleRedirect(c);
});

/* ---------------- 子应用 ---------------- */

app.route('/api', api);
app.route('/open', open);

/* ---------------- 跳转 ---------------- */

/**
 * 排除已注册前缀与资源路径，其余单段路径都当作短链 key。
 * 静态文件的识别交给入口的静态资源探测，这里只挡固定前缀，
 * 免得以后新增接口时还要同步维护一张清单。
 */
function isRootLevelSlug(slug) {
  const reserved = new Set(['health', 'api', 'open', 'report']);
  if (!slug || slug.includes('.')) return false;
  return !reserved.has(slug);
}

async function handleRedirect(c) {
  const slug = c.req.param('slug');
  const env = c.env;
  const ctx = c.executionCtx;

  const candidates = await Promise.all([
    resolveShortLink(env, ctx, { slug, request: c.req.raw }),
    resolveCode(env, ctx, { slug, request: c.req.raw }),
    resolveChannel(env, ctx, { slug, request: c.req.raw }),
  ]);

  // 三类资源共用同一个命名空间，命中即用
  const hit = candidates.find((item) => !['missing'].includes(item.type));
  if (!hit) {
    return renderMessagePage({ title: '链接不存在', message: '链接不存在或已被删除' }, env, 404);
  }

  const origin = env.SHORT_ORIGIN || new URL(c.req.url).origin;
  switch (hit.type) {
    case 'redirect':
      return Response.redirect(hit.url, 302);
    case 'rotate':
    case 'merge':
      return Response.redirect(new URL(`/${hit.slug}`, origin).toString(), 302);
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

/* ---------------- CORS ---------------- */

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') ?? '';
  const allowed = (env.WEB_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const allowOrigin = allowed.length === 0 || allowed.includes(origin) ? (origin || '*') : allowed[0];
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    // 实际会出现在跨域请求里的头都要列上，少一个就会让预检失败
    'access-control-allow-headers': 'content-type,authorization,x-requested-with',
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

export default app;
export { corsHeaders, withCors };
