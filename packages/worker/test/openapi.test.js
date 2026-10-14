import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { sign } from '../src/routes/openApi.js';
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
  return { status: response.status, body: await response.json() };
}

async function post(path, body, token) {
  return json(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

async function setup() {
  const reg = await post('/api/auth/register', { username: 'owner', password: 'supersecret1' });
  const token = reg.body.token;
  const cred = await post('/api/credentials', {}, token);
  return { token, apiKey: cred.body.item.apiKey, apiSecret: cred.body.item.apiSecret };
}

function signed(payload, apiKey, apiSecret) {
  return async () => ({
    ...payload,
    api_key: apiKey,
    sign: await sign(
      {
        dwz_title: payload.dwz_title,
        dwz_type: payload.dwz_type,
        dwz_url: payload.dwz_url,
        api_key: apiKey,
        api_secret: apiSecret,
      },
      apiSecret,
    ),
  });
}

test('创建凭证时一次性返回 secret', async () => {
  const { apiKey, apiSecret } = await setup();
  assert.match(apiKey, /^dwz_[0-9a-f]{16}$/);
  assert.equal(apiSecret.length, 48);
});

test('凭证列表不再暴露 secret 明文', async () => {
  const { token } = await setup();
  const list = await json('/api/credentials', { headers: { authorization: `Bearer ${token}` } });
  const item = list.body.items[0];
  assert.ok(item.secretHint.includes('****'));
  assert.equal(item.apiSecret, undefined);
});

test('签名正确时可通过开放接口创建短链', async () => {
  const { apiKey, apiSecret } = await setup();
  const payload = await signed(
    { dwz_title: '开放接口', dwz_type: 'any', dwz_url: 'https://example.com/open' },
    apiKey,
    apiSecret,
  )();

  const res = await post('/open/v1/short-links', payload);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.slug, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(res.body.shortUrl, `https://short.test/${res.body.slug}`);

  const redirect = await call(`/${res.body.slug}`);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'https://example.com/open');
});

test('签名错误被拒绝', async () => {
  const { apiKey } = await setup();
  const res = await post('/open/v1/short-links', {
    dwz_title: '伪造',
    dwz_type: 'any',
    dwz_url: 'https://example.com/fake',
    api_key: apiKey,
    sign: 'deadbeef',
  });
  assert.equal(res.status, 403);
  assert.match(res.body.msg, /签名/);
});

test('篡改任一签名字段都会导致校验失败', async () => {
  const { apiKey, apiSecret } = await setup();
  const base = { dwz_title: '原标题', dwz_type: 'any', dwz_url: 'https://example.com/orig' };
  const goodSign = await sign({ ...base, api_key: apiKey, api_secret: apiSecret }, apiSecret);

  for (const tampered of [
    { ...base, dwz_url: 'https://evil.test' },
    { ...base, dwz_title: '被改了' },
    { ...base, dwz_type: 'wechat' },
  ]) {
    const res = await post('/open/v1/short-links', { ...tampered, api_key: apiKey, sign: goodSign });
    assert.equal(res.status, 403, `篡改 ${JSON.stringify(tampered)} 应被拒绝`);
  }
});

test('未知 api_key 被拒绝', async () => {
  const res = await post('/open/v1/short-links', {
    dwz_title: 'x',
    dwz_type: 'any',
    dwz_url: 'https://example.com/x',
    api_key: 'dwz_ffffffffffffffff',
    sign: 'x',
  });
  assert.equal(res.status, 403);
});

test('停用的凭证不能再调用', async () => {
  const { token, apiKey, apiSecret } = await setup();
  const list = await json('/api/credentials', { headers: { authorization: `Bearer ${token}` } });
  await json(`/api/credentials/${list.body.items[0].id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ status: 'paused' }),
  });

  const payload = await signed(
    { dwz_title: 'x', dwz_type: 'any', dwz_url: 'https://example.com/x' },
    apiKey,
    apiSecret,
  )();
  const res = await post('/open/v1/short-links', payload);
  assert.equal(res.status, 403);
});

test('配额用尽后拒绝调用', async () => {
  const { token, apiKey, apiSecret } = await setup();
  const list = await json('/api/credentials', { headers: { authorization: `Bearer ${token}` } });
  await json(`/api/credentials/${list.body.items[0].id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ quota: 1 }),
  });

  const make = signed({ dwz_title: 'x', dwz_type: 'any', dwz_url: 'https://example.com/x' }, apiKey, apiSecret);
  const first = await post('/open/v1/short-links', await make());
  assert.equal(first.status, 200);
  const second = await post('/open/v1/short-links', await make());
  assert.equal(second.status, 403);
  assert.match(second.body.msg, /配额/);
});

test('IP 白名单不匹配时拒绝', async () => {
  const { token, apiKey, apiSecret } = await setup();
  const list = await json('/api/credentials', { headers: { authorization: `Bearer ${token}` } });
  await json(`/api/credentials/${list.body.items[0].id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ ipAllowlist: '198.51.100.7' }),
  });

  const payload = await signed(
    { dwz_title: 'x', dwz_type: 'any', dwz_url: 'https://example.com/x' },
    apiKey,
    apiSecret,
  )();
  const res = await post('/open/v1/short-links', payload);
  assert.equal(res.status, 403);
  assert.match(res.body.msg, /白名单/);
});

test('开放接口只接受 POST', async () => {
  const res = await call('/open/v1/short-links');
  assert.equal(res.status, 400);
});

test('查询统计只能看自己创建的短链', async () => {
  const { token, apiKey, apiSecret } = await setup();
  const created = await post('/api/short-links', { title: 'mine', targetUrl: 'https://example.com/mine' }, token);
  await call(`/${created.body.item.slug}`);

  const payload = await signed(
    { dwz_title: '', dwz_type: '', dwz_url: '', slug: created.body.item.slug },
    apiKey,
    apiSecret,
  )();
  const res = await post('/open/v1/stats', payload);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.hits, 1);
});
