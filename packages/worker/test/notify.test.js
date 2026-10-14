import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createCtx, createEnv, makeRequest } from './helpers.js';
import { send, buildMessage, CHANNEL_KINDS } from '../src/lib/notify.js';

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

async function bootstrapOwner() {
  const res = await json('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'supersecret1' }),
  });
  return res.body.token;
}

function auth(token) {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
}

test('渠道类型枚举包含五种', () => {
  assert.deepEqual(CHANNEL_KINDS.sort(), ['bark', 'email', 'serverchan', 'webhook', 'wecom'].sort());
});

test('webhook 发送走 POST 并带上标准消息体', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return new Response('', { status: 200 });
  };
  const result = await send(
    { kind: 'webhook', config: JSON.stringify({ url: 'https://hook.test/x' }), enabled: 1 },
    buildMessage({ title: '标题', text: '正文', level: 'error' }),
    { fetchImpl },
  );
  assert.equal(result.ok, true);
  assert.equal(captured.url, 'https://hook.test/x');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.body.title, '标题');
  assert.equal(captured.body.level, 'error');
});

test('Bark 使用自定义服务器拼接 key 路径', async () => {
  let url = '';
  const fetchImpl = async (target) => {
    url = target;
    return new Response('', { status: 200 });
  };
  const result = await send(
    { kind: 'bark', config: JSON.stringify({ key: 'abc123', server: 'https://bark.test/' }), enabled: 1 },
    buildMessage({ title: 't', text: 'b' }),
    { fetchImpl },
  );
  assert.equal(result.ok, true);
  assert.equal(url, 'https://bark.test/abc123');
});

test('企业微信缺少 key 时返回失败而不是抛错', async () => {
  const result = await send(
    { kind: 'wecom', config: '{}', enabled: 1 },
    buildMessage({ title: 't', text: 'b' }),
    { fetchImpl: async () => new Response('', { status: 200 }) },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /缺少 key/);
});

test('方糖使用表单编码发送', async () => {
  let contentType = '';
  const fetchImpl = async (_url, init) => {
    contentType = init.headers['content-type'];
    return new Response('', { status: 200 });
  };
  const result = await send(
    { kind: 'serverchan', config: JSON.stringify({ key: 'SCT123' }), enabled: 1 },
    buildMessage({ title: 't', text: 'b' }),
    { fetchImpl },
  );
  assert.equal(result.ok, true);
  assert.match(contentType, /x-www-form-urlencoded/);
});

test('未启用的渠道直接跳过', async () => {
  const result = await send(
    { kind: 'webhook', config: JSON.stringify({ url: 'https://hook.test/x' }), enabled: 0 },
    buildMessage({ title: 't', text: 'b' }),
    { fetchImpl: async () => new Response('', { status: 200 }) },
  );
  assert.equal(result.ok, false);
});

test('渠道增删改查：密钥在列表里被脱敏', async () => {
  const token = await bootstrapOwner();
  const created = await json('/api/notify-channels', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ name: '运维群', kind: 'wecom', config: { key: 'abcd12345678wxyz' } }),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  // 创建响应回传完整配置，便于确认
  assert.equal(created.body.item.configHint.key, 'abcd12345678wxyz');

  const list = await json('/api/notify-channels', { headers: auth(token) });
  assert.equal(list.body.items.length, 1);
  assert.match(list.body.items[0].configHint, /abcd\*\*\*\*wxyz/);
});

test('webhook 必须 https', async () => {
  const token = await bootstrapOwner();
  const res = await json('/api/notify-channels', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ name: 'x', kind: 'webhook', config: { url: 'http://insecure.test' } }),
  });
  assert.equal(res.status, 400);
});

test('邮件收件人格式会被校验', async () => {
  const token = await bootstrapOwner();
  const res = await json('/api/notify-channels', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ name: 'x', kind: 'email', config: { to: 'not-an-email' } }),
  });
  assert.equal(res.status, 400);
});

test('非 owner 不能访问通知渠道管理', async () => {
  const res = await json('/api/notify-channels');
  assert.equal(res.status, 401);
});

test('测试发送失败时返回可读错误', async () => {
  const token = await bootstrapOwner();
  const created = await json('/api/notify-channels', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ name: 'x', kind: 'webhook', config: { url: 'https://hook.test/x' } }),
  });
  const id = created.body.item.id;
  // 真实 fetch 会失败（测试环境无外网），应返回 400 而不是 500
  const res = await json(`/api/notify-channels/${id}/test`, { method: 'POST', headers: auth(token) });
  assert.equal(res.status, 400);
  assert.match(res.body.msg, /测试失败/);
});
