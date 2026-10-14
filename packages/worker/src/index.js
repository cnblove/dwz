import app from './app.js';
import { runInspection } from './domain/inspection.js';
import { servePage } from './lib/assets.js';

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
 * Worker 入口。后台页面、短链跳转、API 全在这一个 Worker 里。
 *
 * 请求分派：
 *   1. 后台静态资源 / 后台页面 —— 交给 servePage（见 lib/assets.js）；
 *      后台路由是固定的一张表，靠它把「后台页面」和「短链 key」分开；
 *   2. 其余交给 Hono：/{slug} 跳转、/api、/open、/health …
 *
 * 静态资源也走这一层而不是交给平台的 assets 分发，是因为同域下
 * 后台页面与短链 key 都是不带扩展名的单段路径，平台分不清两者。
 */
export default {
  async fetch(request, env, ctx) {
    const ready = normalizeTrailingSlash(request);

    if (env.ASSETS) {
      const page = await servePage(env.ASSETS, ready);
      if (page) return page;
    }

    return app.fetch(ready, env, ctx);
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
