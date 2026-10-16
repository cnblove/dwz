import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createCtx, createEnv, makeRequest } from './helpers.js';

/**
 * 权限边界回归。
 *
 * 触发这次补丁的是一个很具体的现象：成员在「概览」里看到了全站访客明细。
 * 顺着它查下去发现根因不是「漏了一个判断」，而是**同一类判断散落在各处**：
 *   1. 有的接口写在路由层（`requireOwnerMiddleware`），有的写在 handler 里；
 *   2. 有的压根没写（域名、访客明细、统计）；
 *   3. 前端导航栏另有一份「谁能看到哪个页面」的清单。
 *
 * 三份口径各走各的，就必然出现「导航藏了、接口还开着」这种半吊子状态 ——
 * 藏导航只挡得住点鼠标的人，挡不住直接 curl。
 *
 * 所以这里不逐个函数补 `if (role !== 'owner')`，而是：
 *   - 路由层的门槛统一收进 `OWNER_ONLY` 一份清单（api.js），
 *     新增路由时「忘了挂」会在测试里红；
 *   - 业务层需要收敛数据范围的地方用 `ownerScope()` 表达，
 *     避免每处各写一遍 `role === 'owner' ? [] : [id]`（写漏一个参数就是越权）。
 */

let env;
let ctx;

beforeEach(() => {
  env = createEnv();
  ctx = createCtx();
});

async function call(path, init = {}) {
  const response = await worker.fetch(makeRequest(`https://api.test${path}`, init), env, ctx);
  await ctx.settle();
  return response;
}

async function json(path, init = {}) {
  const response = await call(path, init);
  return { status: response.status, body: await response.json() };
}

function headers(token, json = true) {
  return { ...(json ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` };
}

const post = (path, body, token) =>
  json(path, { method: 'POST', headers: headers(token), body: JSON.stringify(body) });
const patch = (path, body, token) =>
  json(path, { method: 'PATCH', headers: headers(token), body: JSON.stringify(body) });
const del = (path, token) => json(path, { method: 'DELETE', headers: headers(token) });

/** 建一个超管 + 一个无用户组的成员，返回两边令牌。 */
async function makePair() {
  const created = await post('/api/auth/register', { username: 'owner', password: 'supersecret1' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const owner = created.body.token;

  const user = await post('/api/users', { username: 'member', password: 'supersecret1' }, owner);
  assert.equal(user.status, 200, JSON.stringify(user.body));

  const login = await post('/api/auth/login', { username: 'member', password: 'supersecret1' });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { owner, member: login.body.token };
}

/** 用 owner 造一条被访问过的短链，返回 slug。 */
async function seedVisitedLink(owner, slug = 'ownerlink') {
  await post('/api/short-links', { slug, title: '超管的链接', targetUrl: 'https://example.com' }, owner);
  await call(`/${slug}`, {
    headers: { 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'Mozilla/5.0' },
    redirect: 'manual',
  });
  return slug;
}

/* ---------------- 概览与访客明细 ---------------- */

test('成员在概览里只看得到自己的访客明细，别人的 IP 不出现', async () => {
  const { owner, member } = await makePair();
  await seedVisitedLink(owner);

  // 成员自己的链接 + 一次访问
  await post('/api/short-links', { slug: 'mylink01', title: '我的链接', targetUrl: 'https://example.com' }, member);
  await call('/mylink01', {
    headers: { 'cf-connecting-ip': '198.51.100.9', 'user-agent': 'Mozilla/5.0' },
    redirect: 'manual',
  });

  const res = await json('/api/stats/visitors', { headers: headers(member, false) });
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 1, '成员不该看到超管那条记录');
  assert.deepEqual(res.body.items.map((item) => item.ip), ['198.51.100.9']);
  assert.equal(res.body.canManage, false);
});

test('超管仍然看得到全部访客明细并可清空', async () => {
  const { owner, member } = await makePair();
  await seedVisitedLink(owner);
  await post('/api/short-links', { slug: 'mylink01', title: '我的', targetUrl: 'https://example.com' }, member);

  const res = await json('/api/stats/visitors', { headers: headers(owner, false) });
  assert.equal(res.body.total, 1);
  assert.equal(res.body.canManage, true);
});

test('成员不能改访客保留天数，也不能清空访客明细', async () => {
  const { owner, member } = await makePair();
  await seedVisitedLink(owner);

  const changed = await patch('/api/stats/visitors', { keepDays: 1 }, member);
  assert.equal(changed.status, 403);

  const cleared = await del('/api/stats/visitors', member);
  assert.equal(cleared.status, 403);

  // 明细还在，说明两次拒绝都是真的没执行
  const res = await json('/api/stats/visitors', { headers: headers(owner, false) });
  assert.equal(res.body.total, 1);
});

test('成员不能裁剪聚合统计', async () => {
  const { member } = await makePair();
  const res = await post('/api/stats/prune', { keepDays: 1 }, member);
  assert.equal(res.status, 403);
});

test('概览卡片只统计成员自己的资源', async () => {
  const { owner, member } = await makePair();
  await seedVisitedLink(owner);

  const mine = await json('/api/stats', { headers: headers(member, false) });
  assert.equal(mine.body.links.total, 0, '成员不该把超管的短链算进自己的概览');
  assert.equal(mine.body.links.hits, 0);

  const all = await json('/api/stats', { headers: headers(owner, false) });
  assert.equal(all.body.links.total, 1);
});

test('概览不把域名池的总数透露给成员', async () => {
  const { owner, member } = await makePair();
  await post('/api/domains', { host: 'a.example.com', kind: 'short' }, owner);

  assert.equal((await json('/api/stats', { headers: headers(member, false) })).body.domains.total, 0);
  assert.equal((await json('/api/stats', { headers: headers(owner, false) })).body.domains.total, 1);
});

test('成员看访问分析时只认自己的短链', async () => {
  const { owner, member } = await makePair();
  await seedVisitedLink(owner);

  const res = await json('/api/short-links', { headers: headers(member, false) });
  assert.equal(res.body.total, 0, '别人的短链不该出现在列表里');
});

test('访问分析（聚合曲线）仅超管可读', async () => {
  const { owner, member } = await makePair();
  await seedVisitedLink(owner);

  assert.equal((await json('/api/stats/detail?source=short_link', { headers: headers(member, false) })).status, 403);
  assert.equal((await json('/api/stats/detail?source=short_link', { headers: headers(owner, false) })).status, 200);
});

test('素材列表不回传别人的归属信息', async () => {
  const { member } = await makePair();
  const res = await json('/api/assets', { headers: headers(member, false) });
  assert.equal(res.status, 200);
  for (const item of res.body.items) {
    assert.equal(item.ownerId, undefined, '成员能看到的本来只有自己的，不该再给出归属字段');
  }
});

/* ---------------- 域名 ---------------- */

test('域名管理仅超管可读可写', async () => {
  const { owner, member } = await makePair();
  assert.equal((await post('/api/domains', { host: 'a.example.com', kind: 'short' }, owner)).status, 200);

  assert.equal((await json('/api/domains', { headers: headers(member, false) })).status, 403);
  assert.equal((await post('/api/domains', { host: 'evil.example.com', kind: 'short' }, member)).status, 403);
  assert.equal((await patch('/api/domains/1', { remark: 'x' }, member)).status, 403);
  assert.equal((await del('/api/domains/1', member)).status, 403);
  assert.equal((await post('/api/domains/probe', { host: 'a.example.com' }, member)).status, 403);
});

test('域名巡检配置仅超管可读可写', async () => {
  const { member } = await makePair();
  assert.equal((await json('/api/domain-check', { headers: headers(member, false) })).status, 403);
  assert.equal((await patch('/api/domain-check', { enabled: true }, member)).status, 403);
});

/* ---------------- 逐条过一遍受保护路由 ---------------- */

/**
 * 「成员碰不到的接口」清单。
 *
 * 写成清单而不是逐个 test，是因为这类回归的形态永远一样：
 * 新增了一条 owner 路由、忘了挂中间件。清单能让「忘了挂」在测试里立刻现形。
 */
const OWNER_DENIED = [
  ['GET', '/api/users', null],
  ['POST', '/api/users', { username: 'x1', password: 'supersecret1' }],
  ['PATCH', '/api/users/1', { remark: 'x' }],
  ['DELETE', '/api/users/1', null],
  ['GET', '/api/groups', null],
  ['POST', '/api/groups', { name: 'g' }],
  ['PATCH', '/api/groups/1', { name: 'g2' }],
  ['DELETE', '/api/groups/1', null],
  ['GET', '/api/audit-logs', null],
  ['GET', '/api/notify-channels', null],
  ['POST', '/api/notify-channels', { name: 'n', kind: 'bark', config: { url: 'https://x/y' }, enabled: true }],
  ['PATCH', '/api/notify-channels/1', { name: 'n2' }],
  ['DELETE', '/api/notify-channels/1', null],
  ['POST', '/api/notify-channels/1/test', {}],
  ['GET', '/api/inspection', null],
  ['POST', '/api/inspection/run', {}],
  ['GET', '/api/domains', null],
  ['POST /domains', '/api/domains', { host: 'b.example.com', kind: 'short' }],
];

test('成员访问超管专属接口一律 403', async () => {
  const { member } = await makePair();

  for (const [method, path, body] of OWNER_DENIED) {
    const [verb, realPath] = method.includes(' ') ? method.split(' ') : [method, path];
    const target = method.includes(' ') ? path : path;
    // eslint-disable-next-line no-await-in-loop
    const res = await json(target, {
      method: verb,
      headers: headers(member),
      body: body === null ? undefined : JSON.stringify(body),
    });
    assert.equal(res.status, 403, `${verb} ${target} 应拒绝成员，实际 ${res.status}`);
  }
});

test('未登录访问受保护接口一律 401（不是 403、更不是 200）', async () => {
  await makePair();
  const paths = ['/api/users', '/api/groups', '/api/domains', '/api/stats/visitors', '/api/notify-channels'];
  for (const path of paths) {
    // eslint-disable-next-line no-await-in-loop
    const res = await json(path, {});
    assert.equal(res.status, 401, `${path} 未登录应 401，实际 ${res.status}`);
  }
});

/* ---------------- 卡密 / 素材：成员可用，但只看自己的 ---------------- */

test('卡密与素材对成员开放，但列表只含自己的批次', async () => {
  const { owner, member } = await makePair();
  await post('/api/cardkeys', { name: '超管批次', content: 'c', count: 1 }, owner);
  await post('/api/cardkeys', { name: '成员批次', content: 'c', count: 1 }, member);

  const mine = await json('/api/cardkeys', { headers: headers(member, false) });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.items.map((item) => item.name), ['成员批次']);

  const all = await json('/api/cardkeys', { headers: headers(owner, false) });
  assert.equal(all.body.items.length, 2);
});

test('成员拿不到别人批次的详情', async () => {
  const { owner, member } = await makePair();
  const created = await post('/api/cardkeys', { name: '超管批次', content: 'c', count: 1 }, owner);
  const id = created.body.item.id;

  const res = await json(`/api/cardkeys/${id}`, { headers: headers(member, false) });
  assert.equal(res.status, 404);
});

/* ---------------- 开放接口 ---------------- */

test('成员凭证走开放接口也读不到全站访客明细', async () => {
  const { owner, member } = await makePair();
  await seedVisitedLink(owner);

  const cred = await post('/api/credentials', {}, member);
  assert.equal(cred.status, 200, JSON.stringify(cred.body));

  const { sign } = await import('../src/lib/openApiCore.js');
  const { apiKey, apiSecret } = cred.body.item;
  const body = { dwz_title: '', dwz_type: '', dwz_url: '', api_key: apiKey };
  body.sign = await sign({ ...body, api_secret: apiSecret }, apiSecret);

  const res = await json('/open/v1/stats-admin/visitors', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // 成员的凭证没有全局视图，这个动作必须被挡在门外
  assert.equal(res.status, 403, JSON.stringify(res.body));
});

test('凭证不能靠声明 dv1_grant 把自己变成超管', async () => {
  const { owner, member } = await makePair();
  const cred = await post('/api/credentials', {}, member);
  const { apiKey, apiSecret } = cred.body.item;

  const { sign } = await import('../src/lib/openApiCore.js');
  const body = { dwz_title: '', dwz_type: '', dwz_url: '', dv1_grant: 'owner', api_key: apiKey };
  body.sign = await sign({ ...body, api_secret: apiSecret }, apiSecret);

  const res = await json('/open/v1/users/list', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 403, JSON.stringify(res.body));
});
