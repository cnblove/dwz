import { Hono } from 'hono';
import { badRequest, notFound } from '../lib/http.js';
import * as openApi from './openApi.js';

/**
 * 对外开放接口：签名校验在各 handler 内完成。
 * 这里只约束方法——全站仅接受 POST。
 */
const open = new Hono();

open.use('*', async (c, next) => {
  if (c.req.method !== 'POST') throw badRequest('开放接口仅接受 POST');
  await next();
});

open.post('/v1/short-links', (c) => openApi.createShortLinkViaApi(c.env, c.req.raw));
open.post('/v1/stats', (c) => openApi.queryStatsViaApi(c.env, c.req.raw));

open.all('*', () => {
  throw notFound('开放接口不存在');
});

export default open;
