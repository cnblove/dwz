import { Hono } from 'hono';
import { badRequest, notFound } from '../lib/http.js';
import * as openApi from './openApi.js';

/**
 * 对外开放接口。
 *
 * 与其他路由不同，这里**不挂 zod 中间件**：签名要用原始 body 计算 HMAC，
 * 必须在任何字段校验之前完成。字段校验因此下沉到 handler 内部
 * （见 openApi.createShortLinkViaApi），顺序是「签名 → 字段」。
 */
const open = new Hono();

open.use('*', async (c, next) => {
  if (c.req.method !== 'POST') throw badRequest('开放接口仅接受 POST');
  await next();
});

open.post('/v1/short-links', async (c) => openApi.createShortLinkViaApi(c.env, await c.req.json(), c.req.raw));
open.post('/v1/stats', async (c) => openApi.queryStatsViaApi(c.env, await c.req.json(), c.req.raw));

open.all('*', () => {
  throw notFound('开放接口不存在');
});

export default open;
