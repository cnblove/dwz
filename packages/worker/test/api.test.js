import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createCtx, createEnv, makeRequest } from './helpers.js';

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
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function post(path, body, token) {
  return json(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function bootstrapOwner() {
  const res = await post('/api/auth/register', {
    username: 'owner',
    password: 'supersecret1',
    email: 'owner@test.dev',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.token;
}

test('健康检查可用', async () => {
  const res = await json('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'healthy');
});

test('未初始化时可注册首个账号，且成为 owner', async () => {
  const status = await json('/api/bootstrap');
  assert.equal(status.body.initialized, false);

  const res = await post('/api/auth/register', { username: 'owner', password: 'supersecret1' });
  assert.equal(res.body.role, 'owner');

  const after = await json('/api/bootstrap');
  assert.equal(after.body.initialized, true);
});

test('已初始化后不能匿名注册', async () => {
  await bootstrapOwner();
  const res = await post('/api/auth/register', { username: 'intruder', password: 'supersecret1' });
  assert.equal(res.status, 403);
});

test('弱密码与非法账号被拒绝', async () => {
  const short = await post('/api/auth/register', { username: 'owner', password: '123' });
  assert.equal(short.status, 400);
  const bad = await post('/api/auth/register', { username: '有中文', password: 'supersecret1' });
  assert.equal(bad.status, 400);
});

test('登录成功后可用令牌访问 /auth/me', async () => {
  await bootstrapOwner();
  const login = await post('/api/auth/login', { username: 'owner', password: 'supersecret1' });
  assert.equal(login.status, 200);
  const token = login.body.token;

  const me = await json('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, 'owner');
  assert.equal(me.body.user.role, 'owner');
});

test('密码错误与账号不存在返回同一提示，不泄露账号是否存在', async () => {
  await bootstrapOwner();
  const wrongPass = await post('/api/auth/login', { username: 'owner', password: 'nope-nope-nope' });
  const noUser = await post('/api/auth/login', { username: 'ghost', password: 'nope-nope-nope' });
  assert.equal(wrongPass.status, 401);
  assert.equal(noUser.status, 401);
  assert.equal(wrongPass.body.msg, noUser.body.msg);
});

test('未带令牌访问受保护接口返回 401', async () => {
  const res = await json('/api/short-links');
  assert.equal(res.status, 401);
});

test('短链创建后可跳转，并累计统计', async () => {
  const token = await bootstrapOwner();
  const created = await post('/api/short-links', { title: '示例', targetUrl: 'https://example.com/a' }, token);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const slug = created.body.item.slug;
  // 自动生成的 slug 是 UUID v4：公开在 URL 上，必须不可枚举、不可连号
  assert.match(slug, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  const redirect = await call(`/${slug}`, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0)' } });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'https://example.com/a');

  const detail = await json(`/api/short-links/${created.body.item.id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(detail.body.item.hits, 1);
  assert.equal(detail.body.item.hitsToday, 1);
});

test('目标链接只接受 http/https，挡掉 javascript 协议', async () => {
  const token = await bootstrapOwner();
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'ftp://x.test', 'not a url']) {
    const res = await post('/api/short-links', { title: 'x', targetUrl: bad }, token);
    assert.equal(res.status, 400, `应拒绝 ${bad}`);
  }
});

test('不存在的短链返回 404 页面而非跳转', async () => {
  const res = await call('/noSuchKey');
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.match(html, /链接不存在/);
});

test('访问限制会把非微信访客挡在提示页', async () => {
  const token = await bootstrapOwner();
  const created = await post(
    '/api/short-links',
    { title: 'wechat only', targetUrl: 'https://example.com/wx', accessRule: 'wechat' },
    token,
  );
  const res = await call(`/${created.body.item.slug}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0)' },
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /仅限微信内访问/);
});

test('过期短链按配置跳转或提示', async () => {
  const token = await bootstrapOwner();
  const past = new Date(Date.now() - 86400_000).toISOString();
  const withJump = await post(
    '/api/short-links',
    { title: 'expired', targetUrl: 'https://example.com/x', expiredAt: past, expiredJump: 'https://example.com/gone' },
    token,
  );
  const r1 = await call(`/${withJump.body.item.slug}`);
  assert.equal(r1.status, 302);
  assert.equal(r1.headers.get('location'), 'https://example.com/gone');

  const noJump = await post(
    '/api/short-links',
    { title: 'expired2', targetUrl: 'https://example.com/x', expiredAt: past },
    token,
  );
  const r2 = await call(`/${noJump.body.item.slug}`);
  assert.equal(r2.status, 410);
});

test('暂停的短链不再跳转', async () => {
  const token = await bootstrapOwner();
  const created = await post('/api/short-links', { title: 'p', targetUrl: 'https://example.com/p' }, token);
  const id = created.body.item.id;
  await json(`/api/short-links/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ status: 'paused' }),
  });
  const res = await call(`/${created.body.item.slug}`);
  assert.equal(res.status, 403);
});

test('自定义短链冲突会被拒绝', async () => {
  const token = await bootstrapOwner();
  const first = await post('/api/short-links', { title: 'a', targetUrl: 'https://a.test', slug: 'custom1' }, token);
  assert.equal(first.status, 200);
  const dup = await post('/api/short-links', { title: 'b', targetUrl: 'https://b.test', slug: 'custom1' }, token);
  assert.equal(dup.status, 400);
});

test('普通成员只能看到自己的短链', async () => {
  const ownerToken = await bootstrapOwner();
  await post('/api/short-links', { title: 'owner link', targetUrl: 'https://owner.test' }, ownerToken);
  await post('/api/users', { username: 'member1', password: 'memberpass1' }, ownerToken);
  const memberLogin = await post('/api/auth/login', { username: 'member1', password: 'memberpass1' });
  const memberToken = memberLogin.body.token;

  const list = await json('/api/short-links', { headers: { authorization: `Bearer ${memberToken}` } });
  assert.equal(list.body.total, 0);

  await post('/api/short-links', { title: 'member link', targetUrl: 'https://member.test' }, memberToken);
  const list2 = await json('/api/short-links', { headers: { authorization: `Bearer ${memberToken}` } });
  assert.equal(list2.body.total, 1);
});

test('普通成员访问用户管理接口被拒绝', async () => {
  const ownerToken = await bootstrapOwner();
  await post('/api/users', { username: 'member1', password: 'memberpass1' }, ownerToken);
  const memberLogin = await post('/api/auth/login', { username: 'member1', password: 'memberpass1' });
  const res = await json('/api/users', { headers: { authorization: `Bearer ${memberLogin.body.token}` } });
  assert.equal(res.status, 403);
});

test('管理员不能删除自己，也不能停用自己', async () => {
  const token = await bootstrapOwner();
  const me = await json('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
  const id = me.body.user.id;
  const del = await json(`/api/users/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  assert.equal(del.status, 400);
  const disable = await json(`/api/users/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ status: 'disabled' }),
  });
  assert.equal(disable.status, 400);
});

test('改密后旧令牌失效', async () => {
  const token = await bootstrapOwner();
  const changed = await post(
    '/api/auth/password',
    { currentPassword: 'supersecret1', newPassword: 'brandnewpass1' },
    token,
  );
  assert.equal(changed.status, 200);
  const reuse = await json('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(reuse.status, 401);
});

test('退出登录后令牌不可再用', async () => {
  const token = await bootstrapOwner();
  await post('/api/auth/logout', {}, token);
  const res = await json('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 401);
});

test('/api/config 公开返回后台展示短链所需的前缀', async () => {
  const res = await json('/api/config');
  assert.equal(res.status, 200);
  assert.equal(res.body.shortOrigin, 'https://short.test');
});

test('/api/config 未配置 SHORT_ORIGIN 时回落到请求自身的 origin', async () => {
  const local = createEnv({ SHORT_ORIGIN: '' });
  const response = await worker.fetch(makeRequest('https://api.test/api/config'), local, createCtx());
  const body = await response.json();
  assert.equal(body.shortOrigin, 'https://api.test');
});

/* ---------------- 全栈单 Worker：静态资源与路由的边界 ---------------- */

/** 静态资源绑定替身：模拟「产物里有 index.html、assets/、favicon」的目录。 */
function createAssets() {
  const files = new Map([
    ['/index.html', '<!doctype html><title>后台</title>'],
    ['/assets/index-abc.js', 'console.log(1)'],
    ['/favicon.svg', '<svg/>'],
  ]);
  // 真实 assets 绑定对未命中路径一律回 404，SPA 回落只作用于平台自身的
  // 分发流程、不会替 Worker 代答 —— 照抄这一点才测得出短链被吞的回归。
  return {
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      const body = files.get(pathname);
      return new Response(body ?? 'not found', { status: body ? 200 : 404 });
    },
  };
}

test('根路径与后台路由返回后台页面', async () => {
  env = createEnv({ ASSETS: createAssets() });
  for (const path of ['/', '/dashboard', '/short-links', '/cardkeys']) {
    const res = await call(path);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /后台/);
  }
});

test('静态资源直接命中，不经过路由', async () => {
  env = createEnv({ ASSETS: createAssets() });
  for (const [path, body] of [['/assets/index-abc.js', 'console.log(1)'], ['/favicon.svg', '<svg/>']]) {
    const res = await call(path);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), body);
  }
});

test('短链 key 不被后台页面吞掉', async () => {
  env = createEnv({ ASSETS: createAssets() });
  const created = await post('/api/short-links', {
    title: '落地',
    targetUrl: 'https://example.com/target',
    slug: 'gq2026',
  }, await bootstrapOwner());
  assert.equal(created.status, 200, JSON.stringify(created.body));

  const res = await call('/gq2026');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://example.com/target');
});

test('不存在的短链 key 走「链接不存在」页，而不是后台首页', async () => {
  env = createEnv({ ASSETS: createAssets() });
  const res = await call('/notexist');
  assert.equal(res.status, 404);
  assert.match(await res.text(), /链接不存在/);
});

test('后台路由与短链共存时各归各的', async () => {
  env = createEnv({ ASSETS: createAssets() });
  const token = await bootstrapOwner();
  await post('/api/short-links', { title: 'x', targetUrl: 'https://example.com/a', slug: 'dashboard' }, token);

  // 后台路由优先：/dashboard 仍是后台页面
  const page = await call('/dashboard');
  assert.match(await page.text(), /后台/);
});

test('没有静态资源绑定时路由照常（本地直接调 Worker 也走这条）', async () => {
  const res = await call('/health');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'healthy');
});

test('后台路由名与短链 key 冲突时，后台优先', async () => {
  env = createEnv({ ASSETS: createAssets() });
  const res = await call('/settings');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /后台/);
});

test('带扩展名的路径不会被当成后台页面（自定义 key 不允许点号，但静态资源探测先挡住）', async () => {
  env = createEnv({ ASSETS: createAssets() });
  const res = await call('/whatever.png');
  assert.equal(res.status, 404);
  assert.doesNotMatch(await res.text(), /后台/);
});

test('自定义短链 key 不允许点号，避免与静态资源抢路径', async () => {
  env = createEnv({ ASSETS: createAssets() });
  const res = await post('/api/short-links', {
    title: 'x',
    targetUrl: 'https://example.com/dot',
    slug: 'abc.png',
  }, await bootstrapOwner());
  assert.equal(res.status, 400);
});


test('库结构缺失（迁移没跑）时返回可诊断的 503，而不是笼统的 500', async () => {
  // 模拟 D1 还没有任何表：任意查询都抛 "no such table"。
  const missingSchemaDb = {
    prepare() {
      const err = () => {
        throw new Error('D1_ERROR: no such table: users: SQLITE_ERROR');
      };
      return {
        bind() { return this; },
        first: err,
        all: err,
        run: err,
      };
    },
  };
  env = createEnv({ DB: missingSchemaDb });

  const res = await json('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'supersecret1' }),
  });

  assert.equal(res.status, 503);
  assert.match(res.body.msg, /迁移|migrations/i);
});

test('注册写入的哈希迭代次数受 env 控制，不会回落成高 CPU 的重活儿', async () => {
  // 免费版 Worker 每请求只有 10ms CPU，过高的 PBKDF2 迭代数会让注册直接 500。
  // 这里守住「落库的哈希串里记录的迭代数与 env 一致」。
  const res = await post('/api/auth/register', {
    username: 'iterguy',
    password: 'supersecret1',
    email: '',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const row = env.DB.raw.prepare('SELECT password_hash FROM users WHERE username = ?').get('iterguy');
  assert.match(row.password_hash, /^pbkdf2\$20000\$/);
});
