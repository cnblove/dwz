import { Hono } from 'hono';
import { AppError, ok } from '../lib/http.js';
import { authenticate } from '../lib/auth.js';
import * as auth from './auth.js';
import * as shortLinks from './shortLinks.js';
import * as codes from './codes.js';
import * as channels from './channels.js';
import * as domains from './domains.js';
import * as stats from './stats.js';
import * as users from './users.js';
import * as openApi from './openApi.js';
import * as notify from './notify.js';
import * as cardkeys from './cardkeys.js';
import { inspectNow, listInspectionLogs } from '../domain/inspection.js';

/**
 * 后台 API。
 *
 * 拆成两张表：公开路由（无需登录）与受保护路由。
 * 受保护路由挂在一个子应用上，鉴权中间件只作用于它，
 * 避免在每个 handler 里重复解会话。
 */
const api = new Hono();

/* ---------------- 公开接口 ---------------- */

api.get('/bootstrap', (c) => auth.bootstrapStatus(c.env).then(ok));
api.post('/auth/register', (c) => auth.register(c.env, c.req.raw));
api.post('/auth/login', (c) => auth.loginRoute(c.env, c.req.raw));
api.post('/auth/logout', (c) => auth.logoutRoute(c.env, c.req.raw));

// 卡密兑换面向访客，不需要登录；内部按 IP 做每日限流
api.post('/cardkeys/redeem', (c) => cardkeys.redeem(c.env, c.req.raw));

/* ---------------- 受保护接口 ---------------- */

const secured = new Hono();

// 会话挂在 context 上，后续 handler 通过 c.get('session') 取。
secured.use('*', async (c, next) => {
  const session = await authenticate(c.env.DB, c.req.raw);
  if (!session) throw new AppError('未登录或登录已过期', 401);
  c.set('session', session);
  await next();
});

secured.get('/auth/me', (c) => auth.meRoute(c.env, c.get('session')));
secured.post('/auth/password', (c) => auth.changePassword(c.env, c.req.raw, c.get('session')));

/* 短链 */
secured.get('/short-links', (c) => shortLinks.listShortLinks(c.env, urlOf(c), c.get('session')));
secured.post('/short-links', (c) => shortLinks.createShortLink(c.env, c.req.raw, c.get('session')));
secured.get('/short-links/:id', (c) => shortLinks.getShortLink(c.env, idOf(c), c.get('session')));
secured.patch('/short-links/:id', (c) => shortLinks.updateShortLink(c.env, c.req.raw, idOf(c), c.get('session')));
secured.delete('/short-links/:id', (c) => shortLinks.deleteShortLink(c.env, idOf(c), c.get('session')));
secured.post('/short-links/:id/reset', (c) => shortLinks.resetShortLinkStats(c.env, idOf(c), c.get('session')));

/* 活码与子码 */
secured.get('/codes', (c) => codes.listCodes(c.env, urlOf(c), c.get('session')));
secured.post('/codes', (c) => codes.createCode(c.env, c.req.raw, c.get('session')));
secured.get('/codes/:id', (c) => codes.getCode(c.env, idOf(c), c.get('session')));
secured.patch('/codes/:id', (c) => codes.updateCode(c.env, c.req.raw, idOf(c), c.get('session')));
secured.delete('/codes/:id', (c) => codes.deleteCode(c.env, idOf(c), c.get('session')));
// 给指定活码新增子码
secured.post('/codes/:id', (c) => codes.addQrcode(c.env, c.req.raw, idOf(c), c.get('session')));

secured.patch('/qrcodes/:id', (c) => codes.updateQrcode(c.env, c.req.raw, idOf(c), c.get('session')));
secured.delete('/qrcodes/:id', (c) => codes.deleteQrcode(c.env, idOf(c), c.get('session')));
secured.post('/qrcodes/:id/reset', (c) => codes.resetQrcodeHits(c.env, idOf(c), c.get('session')));

secured.post('/merges', (c) => codes.createMerge(c.env, c.req.raw, c.get('session')));
secured.delete('/merges/:id', (c) => codes.deleteMerge(c.env, idOf(c), c.get('session')));

/* 渠道码 */
secured.get('/channels', (c) => channels.listChannels(c.env, urlOf(c), c.get('session')));
secured.post('/channels', (c) => channels.createChannel(c.env, c.req.raw, c.get('session')));
secured.get('/channels/:id', (c) => channels.getChannel(c.env, idOf(c), c.get('session')));
secured.patch('/channels/:id', (c) => channels.updateChannel(c.env, c.req.raw, idOf(c), c.get('session')));
secured.delete('/channels/:id', (c) => channels.deleteChannel(c.env, idOf(c), c.get('session')));
secured.post('/channels/:id/blocks', (c) => channels.blockVisitor(c.env, c.req.raw, idOf(c), c.get('session')));
secured.delete('/blocks/:id', (c) => channels.unblockVisitor(c.env, idOf(c), c.get('session')));

/* 域名 */
secured.get('/domains', (c) => domains.listDomains(c.env, urlOf(c)));
secured.post('/domains', (c) => domains.createDomain(c.env, c.req.raw));
secured.patch('/domains/:id', (c) => domains.updateDomain(c.env, c.req.raw, idOf(c)));
secured.delete('/domains/:id', (c) => domains.deleteDomain(c.env, idOf(c)));
secured.post('/domains/probe', (c) => domains.probeDomain(c.env, c.req.raw));
secured.get('/domain-check', (c) => domains.getDomainCheck(c.env));
secured.patch('/domain-check', (c) => domains.updateDomainCheck(c.env, c.req.raw));

/* 统计 */
secured.get('/stats', (c) => stats.overview(c.env, c.get('session')));
secured.get('/stats/detail', (c) => stats.detail(c.env, urlOf(c), c.req.query('source') ?? 'short_link'));
secured.post('/stats/prune', (c) => {
  requireOwner(c);
  return stats.prune(c.env, c.req.raw);
});

/* 用户与分组，仅超级管理员 */
secured.use('/users/*', requireOwnerMiddleware);
secured.use('/users', requireOwnerMiddleware);
secured.get('/users', (c) => users.listUsers(c.env, urlOf(c)));
secured.post('/users', (c) => users.createUser(c.env, c.req.raw));
secured.patch('/users/:id', (c) => users.updateUser(c.env, c.req.raw, idOf(c), c.get('session')));
secured.delete('/users/:id', (c) => users.deleteUser(c.env, idOf(c), c.get('session')));

secured.use('/groups/*', requireOwnerMiddleware);
secured.use('/groups', requireOwnerMiddleware);
secured.get('/groups', (c) => users.listGroups(c.env));
secured.post('/groups', (c) => users.createGroup(c.env, c.req.raw));
secured.patch('/groups/:id', (c) => users.updateGroup(c.env, c.req.raw, idOf(c)));
secured.delete('/groups/:id', (c) => users.deleteGroup(c.env, idOf(c)));

secured.use('/audit-logs', requireOwnerMiddleware);
secured.get('/audit-logs', (c) => users.listAuditLogs(c.env, urlOf(c)));

/* 开放接口凭证 */
secured.get('/credentials', (c) => openApi.listCredentials(c.env, c.get('session')));
secured.post('/credentials', (c) => openApi.createCredential(c.env, c.req.raw, c.get('session')));
secured.patch('/credentials/:id', (c) => openApi.updateCredential(c.env, c.req.raw, idOf(c), c.get('session')));
secured.delete('/credentials/:id', (c) => openApi.deleteCredential(c.env, idOf(c), c.get('session')));

/* 通知渠道，仅超级管理员 */
secured.use('/notify-channels/*', requireOwnerMiddleware);
secured.use('/notify-channels', requireOwnerMiddleware);
secured.get('/notify-channels', (c) => notify.listNotifyChannels(c.env));
secured.post('/notify-channels', (c) => notify.createNotifyChannel(c.env, c.req.raw));
secured.patch('/notify-channels/:id', (c) => notify.updateNotifyChannel(c.env, c.req.raw, idOf(c)));
secured.delete('/notify-channels/:id', (c) => notify.deleteNotifyChannel(c.env, idOf(c)));
secured.post('/notify-channels/:id/test', (c) => notify.testNotifyChannel(c.env, idOf(c)));

/* 卡密批次 */
secured.get('/cardkeys', (c) => cardkeys.listBatches(c.env, urlOf(c), c.get('session')));
secured.post('/cardkeys', (c) => cardkeys.createBatch(c.env, c.req.raw, c.get('session')));
secured.get('/cardkeys/:id', (c) => cardkeys.getBatch(c.env, idOf(c), c.get('session')));
secured.patch('/cardkeys/:id', (c) => cardkeys.updateBatch(c.env, c.req.raw, idOf(c), c.get('session')));
secured.delete('/cardkeys/:id', (c) => cardkeys.deleteBatch(c.env, idOf(c), c.get('session')));
secured.post('/cardkeys/:id/append', (c) => cardkeys.appendKeys(c.env, c.req.raw, idOf(c), c.get('session')));

/* 巡检，仅超级管理员 */
secured.use('/inspection/*', requireOwnerMiddleware);
secured.use('/inspection', requireOwnerMiddleware);
secured.get('/inspection', async (c) => ok(await listInspectionLogs(c.env, urlOf(c))));
secured.post('/inspection/run', async (c) => ok({ result: await inspectNow(c.env) }));

api.route('/', secured);

/** Handlers 收 URL 对象（用 searchParams 分页），Hono 只给字符串，这里转一次。 */
function urlOf(c) {
  return new URL(c.req.url);
}

/** 路径参数统一转成数字 id，非法值交给下游校验。 */
function idOf(c) {
  const raw = c.req.param('id');
  return raw === undefined ? null : Number(raw);
}

function requireOwner(c) {
  if (c.get('session')?.role !== 'owner') throw new AppError('仅超级管理员可执行该操作', 403);
}

/** 路由级中间件：作用于整段路径（如 /users 与其子路径）。 */
async function requireOwnerMiddleware(c, next) {
  requireOwner(c);
  await next();
}

export default api;
