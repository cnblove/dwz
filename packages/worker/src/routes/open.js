import { Hono } from 'hono';
import { badRequest, notFound } from '../lib/http.js';
import { OPEN_API_VERSION, catalog } from '../open/catalog.js';
import { OPEN_API_RESOURCES } from '../schemas/openApi.js';
import { createResource, deleteResource, getResource, listResources } from '../open/resources.js';
import { resourceStats } from '../open/stats.js';

/**
 * 对外开放接口。
 *
 * 与其他路由不同，这里**不挂 zod 中间件**：签名要用原始 body 计算 HMAC，
 * 必须在任何字段校验之前完成。字段校验因此下沉到 openApiCore.authorizeCall，
 * 顺序是「签名 → 字段」。
 *
 * 路由形状：
 *   GET  /open/v1                              自描述目录（无需鉴权）
 *   POST /open/v1/{资源}/{动作}                 资源动作
 *   POST /open/v1/stats                        访问分析
 *
 * 统一用 POST + JSON body，包括读操作：签名是请求体的一部分，
 * 放进 query 会让密钥出现在 URL 与访问日志里，也会被平台按 URL 缓存。
 */
const open = new Hono();

/* ---------------- 自描述目录 ---------------- */

// 无需鉴权：它是「怎么调」的说明书，不含任何用户数据。
// AI 客户端靠它发现有哪些动作、每个动作要签哪些字段。
open.get('/v1', (c) => catalog(c.env, c.req.raw));

/* ---------------- 资源动作 ---------------- */

function parseTarget(target) {
  const [resource, action] = String(target ?? '').split('/');
  if (!OPEN_API_RESOURCES.includes(resource)) throw notFound(`资源不存在：${resource ?? ''}`);
  return { resource, action };
}

open.post('/v1/:resource/:action', async (c) => {
  const { resource, action } = parseTarget(c.req.param('resource') + '/' + c.req.param('action'));
  const body = await readBody(c);
  return dispatch(c, resource, action, body);
});

// 末尾斜杠：入口已经会归一化（见 index.js 的 normalizeTrailingSlash），
// 但直接调 app.fetch 的场景（测试、本地脚本）绕过了那一层，这里顺手也认一下。
open.post('/v1/:resource/:action/', async (c) => {
  const { resource, action } = parseTarget(`${c.req.param('resource')}/${c.req.param('action')}`);
  return dispatch(c, resource, action, await readBody(c));
});

open.post('/v1/stats', async (c) => resourceStats(c.env, await readBody(c), c.req.raw));

open.all('*', () => {
  throw badRequest(`接口不存在，当前版本 ${OPEN_API_VERSION}，可先 GET /open/v1 查看目录`);
});

/* ---------------- 分发 ---------------- */

async function dispatch(c, resource, action, body) {
  switch (action) {
    case 'create':
      return createResource(c.env, resource, body, c.req.raw);
    case 'list':
      return listResources(c.env, resource, body, c.req.raw);
    case 'get':
      return getResource(c.env, resource, body, c.req.raw);
    case 'delete':
      return deleteResource(c.env, resource, body, c.req.raw);
    default:
      throw notFound(`动作不存在：${action ?? ''}，当前版本 ${OPEN_API_VERSION}`);
  }
}

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
