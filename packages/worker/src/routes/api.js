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
import * as assets from './assets.js';
import { inspectNow, listInspectionLogs } from '../domain/inspection.js';
import { validateBody, validateQuery } from '../lib/validation.js';
import * as schemas from '../schemas/index.js';

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

// 前端运行时配置。公开无鉴权：只回后台展示用的公开域名，不含任何密钥。
// 后台与短链不同域时，界面里的短链前缀必须取自这里，而不是后台自己的域名。
api.get('/config', (c) =>
  ok({
    shortOrigin: c.env.SHORT_ORIGIN || new URL(c.req.url).origin,
  }));
api.post('/auth/register', validateBody(schemas.registerSchema), (c) =>
  auth.register(c.env, c.req.valid('json'), c.req.raw));
api.post('/auth/login', validateBody(schemas.loginSchema), (c) =>
  auth.loginRoute(c.env, c.req.valid('json'), c.req.raw));
api.post('/auth/logout', (c) => auth.logoutRoute(c.env, c.req.raw));

// 卡密兑换面向访客，不需要登录；内部按 IP 做每日限流
api.post('/cardkeys/redeem', validateBody(schemas.redeemSchema), (c) =>
  cardkeys.redeem(c.env, c.req.valid('json'), c.req.raw));

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
secured.post('/auth/password', validateBody(schemas.changePasswordSchema), (c) =>
  auth.changePassword(c.env, c.req.valid('json'), c.get('session')));

/* 短链 */
secured.get('/short-links', validateQuery(schemas.pageQuery), (c) =>
  shortLinks.listShortLinks(c.env, c.req.valid('query'), c.get('session')));
secured.post('/short-links', validateBody(schemas.createShortLinkSchema), (c) =>
  shortLinks.createShortLink(c.env, c.req.valid('json'), c.get('session')));
secured.get('/short-links/:id', (c) => shortLinks.getShortLink(c.env, idOf(c), c.get('session')));
secured.patch('/short-links/:id', validateBody(schemas.updateShortLinkSchema), (c) =>
  shortLinks.updateShortLink(c.env, c.req.valid('json'), idOf(c), c.get('session')));
secured.delete('/short-links/:id', (c) => shortLinks.deleteShortLink(c.env, idOf(c), c.get('session')));
secured.post('/short-links/:id/reset', (c) => shortLinks.resetShortLinkStats(c.env, idOf(c), c.get('session')));

/* 活码与子码 */
secured.get('/codes', validateQuery(schemas.listCodesQuery), (c) =>
  codes.listCodes(c.env, c.req.valid('query'), c.get('session')));
secured.post('/codes', validateBody(schemas.createCodeSchema), (c) =>
  codes.createCode(c.env, c.req.valid('json'), c.get('session')));
secured.get('/codes/:id', (c) => codes.getCode(c.env, idOf(c), c.get('session')));
secured.patch('/codes/:id', validateBody(schemas.updateCodeSchema), (c) =>
  codes.updateCode(c.env, c.req.valid('json'), idOf(c), c.get('session')));
secured.delete('/codes/:id', (c) => codes.deleteCode(c.env, idOf(c), c.get('session')));
// 给指定活码新增子码
secured.post('/codes/:id', validateBody(schemas.addQrcodeSchema), (c) =>
  codes.addQrcode(c.env, c.req.valid('json'), idOf(c), c.get('session')));

secured.patch('/qrcodes/:id', validateBody(schemas.updateQrcodeSchema), (c) =>
  codes.updateQrcode(c.env, c.req.valid('json'), idOf(c), c.get('session')));
secured.delete('/qrcodes/:id', (c) => codes.deleteQrcode(c.env, idOf(c), c.get('session')));
secured.post('/qrcodes/:id/reset', (c) => codes.resetQrcodeHits(c.env, idOf(c), c.get('session')));

secured.post('/merges', validateBody(schemas.createMergeSchema), (c) =>
  codes.createMerge(c.env, c.req.valid('json'), c.get('session')));
secured.delete('/merges/:id', (c) => codes.deleteMerge(c.env, idOf(c), c.get('session')));

/* 渠道码 */
secured.get('/channels', validateQuery(schemas.listChannelsQuery), (c) =>
  channels.listChannels(c.env, c.req.valid('query'), c.get('session')));
secured.post('/channels', validateBody(schemas.createChannelSchema), (c) =>
  channels.createChannel(c.env, c.req.valid('json'), c.get('session')));
secured.get('/channels/:id', (c) => channels.getChannel(c.env, idOf(c), c.get('session')));
secured.patch('/channels/:id', validateBody(schemas.updateChannelSchema), (c) =>
  channels.updateChannel(c.env, c.req.valid('json'), idOf(c), c.get('session')));
secured.delete('/channels/:id', (c) => channels.deleteChannel(c.env, idOf(c), c.get('session')));
secured.post('/channels/:id/blocks', validateBody(schemas.blockVisitorSchema), (c) =>
  channels.blockVisitor(c.env, c.req.valid('json'), idOf(c), c.get('session')));
secured.delete('/blocks/:id', (c) => channels.unblockVisitor(c.env, idOf(c), c.get('session')));

/* 域名 */
secured.get('/domains', validateQuery(schemas.listDomainsQuery), (c) =>
  domains.listDomains(c.env, c.req.valid('query')));
secured.post('/domains', validateBody(schemas.createDomainSchema), (c) =>
  domains.createDomain(c.env, c.req.valid('json')));
secured.patch('/domains/:id', validateBody(schemas.updateDomainSchema), (c) =>
  domains.updateDomain(c.env, c.req.valid('json'), idOf(c)));
secured.delete('/domains/:id', (c) => domains.deleteDomain(c.env, idOf(c)));
secured.post('/domains/probe', validateBody(schemas.probeDomainSchema), (c) =>
  domains.probeDomain(c.env, c.req.valid('json')));
secured.get('/domain-check', (c) => domains.getDomainCheck(c.env));
secured.patch('/domain-check', validateBody(schemas.updateDomainCheckSchema), (c) =>
  domains.updateDomainCheck(c.env, c.req.valid('json')));

/* 统计 */
secured.get('/stats', (c) => stats.overview(c.env, c.get('session')));
secured.get('/stats/detail', validateQuery(schemas.statsDetailQuery), (c) =>
  stats.detail(c.env, c.req.valid('query'), c.req.valid('query').source || 'short_link'));
secured.post('/stats/prune', validateBody(schemas.pruneStatsSchema), (c) => {
  requireOwner(c);
  return stats.prune(c.env, c.req.valid('json'));
});

/* 用户与分组，仅超级管理员 */
secured.use('/users/*', requireOwnerMiddleware);
secured.use('/users', requireOwnerMiddleware);
secured.get('/users', validateQuery(schemas.listUsersQuery), (c) =>
  users.listUsers(c.env, c.req.valid('query')));
secured.post('/users', validateBody(schemas.createUserSchema), (c) =>
  users.createUser(c.env, c.req.valid('json')));
secured.patch('/users/:id', validateBody(schemas.updateUserSchema), (c) =>
  users.updateUser(c.env, c.req.valid('json'), idOf(c), c.get('session')));
secured.delete('/users/:id', (c) => users.deleteUser(c.env, idOf(c), c.get('session')));

secured.use('/groups/*', requireOwnerMiddleware);
secured.use('/groups', requireOwnerMiddleware);
secured.get('/groups', (c) => users.listGroups(c.env));
secured.post('/groups', validateBody(schemas.createGroupSchema), (c) =>
  users.createGroup(c.env, c.req.valid('json')));
secured.patch('/groups/:id', validateBody(schemas.updateGroupSchema), (c) =>
  users.updateGroup(c.env, c.req.valid('json'), idOf(c)));
secured.delete('/groups/:id', (c) => users.deleteGroup(c.env, idOf(c)));

secured.use('/audit-logs', requireOwnerMiddleware);
secured.get('/audit-logs', validateQuery(schemas.auditLogsQuery), (c) =>
  users.listAuditLogs(c.env, c.req.valid('query')));

/* 开放接口凭证 */
secured.get('/credentials', (c) => openApi.listCredentials(c.env, c.get('session')));
secured.post('/credentials', validateBody(schemas.createCredentialSchema), (c) =>
  openApi.createCredential(c.env, c.req.valid('json'), c.get('session')));
secured.patch('/credentials/:id', validateBody(schemas.updateCredentialSchema), (c) =>
  openApi.updateCredential(c.env, c.req.valid('json'), idOf(c), c.get('session')));
secured.delete('/credentials/:id', (c) => openApi.deleteCredential(c.env, idOf(c), c.get('session')));

/* 通知渠道，仅超级管理员 */
secured.use('/notify-channels/*', requireOwnerMiddleware);
secured.use('/notify-channels', requireOwnerMiddleware);
secured.get('/notify-channels', (c) => notify.listNotifyChannels(c.env));
secured.post('/notify-channels', validateBody(schemas.createNotifyChannelSchema), (c) =>
  notify.createNotifyChannel(c.env, c.req.valid('json')));
secured.patch('/notify-channels/:id', validateBody(schemas.updateNotifyChannelSchema), (c) =>
  notify.updateNotifyChannel(c.env, c.req.valid('json'), idOf(c)));
secured.delete('/notify-channels/:id', (c) => notify.deleteNotifyChannel(c.env, idOf(c)));
secured.post('/notify-channels/:id/test', (c) => notify.testNotifyChannel(c.env, idOf(c)));

/* 卡密批次 */
secured.get('/cardkeys', validateQuery(schemas.listBatchesQuery), (c) =>
  cardkeys.listBatches(c.env, c.req.valid('query'), c.get('session')));
secured.post('/cardkeys', validateBody(schemas.createBatchSchema), (c) =>
  cardkeys.createBatch(c.env, c.req.valid('json'), c.get('session')));
secured.get('/cardkeys/:id', (c) => cardkeys.getBatch(c.env, idOf(c), c.get('session')));
secured.patch('/cardkeys/:id', validateBody(schemas.updateBatchSchema), (c) =>
  cardkeys.updateBatch(c.env, c.req.valid('json'), idOf(c), c.get('session')));
secured.delete('/cardkeys/:id', (c) => cardkeys.deleteBatch(c.env, idOf(c), c.get('session')));
secured.post('/cardkeys/:id/append', validateBody(schemas.appendKeysSchema), (c) =>
  cardkeys.appendKeys(c.env, c.req.valid('json'), idOf(c), c.get('session')));

/* 素材库：图片托管在 R2 */
secured.get('/assets', validateQuery(schemas.listAssetsQuery), (c) =>
  assets.listAssets(c.env, c.req.valid('query'), c.get('session')));
// 上传走 multipart/form-data，body 由 handler 自己解析（校验在 handler 内做，错误码保持 400）
secured.post('/assets', (c) => assets.uploadAsset(c.env, c.req.raw, c.get('session')));
secured.patch('/assets/:id', validateBody(schemas.updateAssetSchema), (c) =>
  assets.updateAsset(c.env, c.req.valid('json'), idOf(c), c.get('session')));
secured.delete('/assets/:id', (c) => assets.deleteAsset(c.env, idOf(c), c.get('session')));

/* 巡检，仅超级管理员 */
secured.use('/inspection/*', requireOwnerMiddleware);
secured.use('/inspection', requireOwnerMiddleware);
secured.get('/inspection', validateQuery(schemas.inspectionQuery), async (c) =>
  ok(await listInspectionLogs(c.env, c.req.valid('query'))));
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
