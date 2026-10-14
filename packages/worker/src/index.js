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

/**
 * 迁移脚本显式开启 `PRAGMA foreign_keys = ON`。
 * D1 的连接默认不启用外键，不打开的话「卡密随批次级联删除」「统计明细随宿主清理」
 * 这些写在 schema 里的约束在线上不会生效。
 */
async function ensureForeignKeys(env) {
  try {
    await env.DB.prepare('PRAGMA foreign_keys = ON').run();
  } catch (error) {
    // 少数客户端不支持通过 prepare 执行 PRAGMA，此时按默认行为继续
    console.error('enable foreign_keys failed', error);
  }
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
