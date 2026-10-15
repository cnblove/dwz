import { Hono } from 'hono';
import { badRequest } from '../lib/http.js';
import { OPEN_API_VERSION, catalog } from '../open/catalog.js';
import { dispatchOpen } from '../open/router.js';

/**
 * 对外开放接口。
 *
 * 与其他路由不同，这里**不挂 zod 中间件**：签名要用原始 body 计算 HMAC，
 * 必须在任何字段校验之前完成。字段校验因此下沉到
 * `openApiCore.authorizeCall`，顺序是「签名 → 字段」。
 *
 * 路由形状就两条：
 *   GET  /open/v1                自描述目录（无需鉴权）
 *   POST /open/v1/{资源}/{动作}   所有动作
 *
 * 用一条通配路由而不是给每个动作注册一条，是因为动作清单有几十个：
 * 逐个注册不仅冗长，还会让「实现里有、目录里没有」这种不一致
 * 长期存在（上一轮缺的 `update` 就是这么漏掉的）。清单的唯一来源
 * 见 schemas/openApi.js 的 OPEN_API_ACTIONS。
 *
 * 统一用 POST + JSON body，包括读操作：签名是请求体的一部分，
 * 放进 query 会让密钥出现在 URL 与访问日志里，也会被平台按 URL 缓存。
 */
const open = new Hono();

open.get('/v1', (c) => catalog(c.env, c.req.raw));

open.post('/v1/*', async (c) => {
  const path = c.req.path.replace(/^\/open\/v1\/?/, '');
  // 素材上传是唯一收二进制的动作，body 得留在 raw request 里给 handler
  // 自己去 formData()。在这里先 text() 掉会把上传正文读空 ——
  // 而且报出来的错是「请求体不是合法的 JSON」，与真正的原因相距甚远。
  const body = isMultipart(c.req.raw) ? {} : await readBody(c);
  return dispatchOpen(c.env, body, c.req.raw, path);
});

function isMultipart(request) {
  return String(request.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data');
}

open.all('*', () => {
  throw badRequest(`接口不存在，当前版本 ${OPEN_API_VERSION}，可先 GET /open/v1 查看目录`);
});

/**
 * 读请求体。
 *
 * 空 body 归一成 `{}`，非法 JSON 明确报错 —— 开放接口的调用方多半是脚本，
 * 「静默当成空对象」会把一次写错 JSON 的请求变成一次字段缺失的报错，
 * 提示反而更远。
 */
async function readBody(c) {
  const text = await c.req.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw badRequest('请求体不是合法的 JSON');
  }
}

export default open;
