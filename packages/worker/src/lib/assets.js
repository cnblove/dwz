/**
 * 后台页面与短链 key 的区分。
 *
 * 全栈单 Worker 后，后台页面和短链跳转共用一个域名，且都可能是
 * 「不带扩展名的单段路径」（后台的 `/dashboard`、短链的 `/gq2026`）。
 * 平台层的静态资源回落到这里帮不上忙 —— 它分不清两者。
 *
 * 所以由 Worker 挨个探一次真实资源：
 *   - 命中文件 → 后台静态资源
 *   - 未命中且是后台路由 → 后台入口页（SPA 子路由刷新）
 *   - 其余 → 短链 key，交回路由
 */

/**
 * 后台路由名，与 packages/web/src/main.js 的 ROUTES 保持一致。
 * 新增后台页面时这里也要加，否则该页面的直接访问会被当作短链 key。
 *
 * 副作用：短链 key 不能与这些名字重名（会被后台页面占先）。
 * 自定义 key 校验不拦这个，撞上了换个 key 即可。
 */
const PAGE_ROUTES = new Set([
  // 兑换页是 Worker 直出的 HTML（见 app.js 的 /redeem），放进来只是为了让
  // servePage 先走静态资源探测：将来若真的加了同名静态文件，它优先。
  'redeem',
  'dashboard',
  'short-links',
  'codes',
  'channels',
  'domains',
  'cardkeys',
  'assets',
  'notify-channels',
  'inspection',
  'users',
  'settings',
]);

/** 路径是不是后台页面（根路径与后台路由名）。 */
export function isPagePath(pathname) {
  const trimmed = pathname.replace(/^\/+|\/+$/g, '');
  return trimmed === '' || PAGE_ROUTES.has(trimmed);
}

/** 取后台入口页。assets 对未命中路径一律回 404，入口页要显式取。 */
function fetchEntry(assets) {
  return assets.fetch(new Request('https://assets.local/index.html'));
}

/**
 * 该请求是否属于后台页面；是就返回响应，否则返回 null 交回路由。
 */
export async function servePage(assets, request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;

  const pathname = new URL(request.url).pathname;

  const direct = await assets.fetch(request);
  if (direct.status !== 404) return direct;

  if (!isPagePath(pathname)) return null;

  const entry = await fetchEntry(assets);
  return entry.status === 200 ? entry : null;
}
