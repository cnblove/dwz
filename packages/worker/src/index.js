import app from './app.js';
import { runInspection } from './domain/inspection.js';

/**
 * 末尾斜杠不影响命中（`/health/` 等价于 `/health`）。
 * 在进入路由前把路径归一，避免 Hono 按原样匹配时 404 —— 与原实现语义一致。
 */
function normalizeTrailingSlash(request) {
  const url = new URL(request.url);
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
    return new Request(url, request);
  }
  return request;
}

/** Worker 入口：Hono 处理 HTTP，scheduled 处理 Cron 巡检。 */
export default {
  fetch(request, env, ctx) {
    return app.fetch(normalizeTrailingSlash(request), env, ctx);
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

export { clientIp, readJson } from './lib/http.js';
export { resolveSession, extractToken } from './lib/auth.js';
