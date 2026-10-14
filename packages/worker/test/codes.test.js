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
  return { status: response.status, body: await response.json() };
}

async function post(path, body, token) {
  return json(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

async function patch(path, body, token) {
  return json(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function ownerToken() {
  const res = await post('/api/auth/register', { username: 'owner', password: 'supersecret1' });
  return res.body.token;
}

async function addQrcode(token, codeId, overrides = {}) {
  const res = await post(
    `/api/codes/${codeId}`,
    { imageUrl: 'https://img.test/qr.png', threshold: 2, contact: 'wxid_demo', ...overrides },
    token,
  );
  return res;
}

test('群活码：阈值未满时返回第一张可用子码', async () => {
  const token = await ownerToken();
  const created = await post('/api/codes', { kind: 'group', title: '测试群' }, token);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const codeId = created.body.item.id;
  await addQrcode(token, codeId, { threshold: 2 });

  const detail = await json(`/api/codes/${codeId}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(detail.body.qrcodes.length, 1);

  const res = await call(`/${created.body.item.slug}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (iPhone) MicroMessenger/8.0' },
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /请长按下方二维码进群/);
  assert.match(html, /img\.test\/qr\.png/);
});

test('群活码：阈值用尽后提示已达上限', async () => {
  const token = await ownerToken();
  const created = await post('/api/codes', { kind: 'group', title: '阈值群' }, token);
  const codeId = created.body.item.id;
  await addQrcode(token, codeId, { threshold: 1 });

  // 第一次消费掉唯一一个额度
  await call(`/${created.body.item.slug}`, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' } });
  const second = await call(`/${created.body.item.slug}`, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' } });
  const html = await second.text();
  assert.match(html, /扫码次数已达上限/);
});

test('群活码：阈值触顶后展示兜底客服码', async () => {
  const token = await ownerToken();
  const created = await post(
    '/api/codes',
    { kind: 'group', title: '兜底群', fallbackOn: true, fallbackUrl: 'https://img.test/service.png' },
    token,
  );
  const codeId = created.body.item.id;
  await addQrcode(token, codeId, { threshold: 1 });
  await call(`/${created.body.item.slug}`);

  const res = await call(`/${created.body.item.slug}`);
  const html = await res.text();
  assert.match(html, /扫码次数已达上限/);
  assert.match(html, /img\.test\/service\.png/);
});

test('客服码：随机模式也会给出子码', async () => {
  const token = await ownerToken();
  const created = await post('/api/codes', { kind: 'service', title: '客服', pickMode: 'random' }, token);
  const codeId = created.body.item.id;
  await addQrcode(token, codeId, { threshold: 0, contact: 'kefu_01' });

  const res = await call(`/${created.body.item.slug}`, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' } });
  const html = await res.text();
  assert.match(html, /请长按识别二维码添加微信/);
  assert.match(html, /kefu_01/);
});

test('客服码：在线时段内外的文案不同', async () => {
  const token = await ownerToken();
  // 覆盖一周七天全天，保证不论何时跑测试都判为在线
  const hours = {};
  for (let day = 1; day <= 7; day += 1) hours[String(day)] = ['00:00-23:59'];

  const online = await post(
    '/api/codes',
    { kind: 'service', title: '在线客服', showOnline: true, onlineHours: hours },
    token,
  );
  await addQrcode(token, online.body.item.id, {});
  const html = await (await call(`/${online.body.item.slug}`)).text();
  assert.match(html, /当前在线/);

  const offline = await post(
    '/api/codes',
    { kind: 'service', title: '离线客服', showOnline: true, onlineHours: {} },
    token,
  );
  await addQrcode(token, offline.body.item.id, {});
  const html2 = await (await call(`/${offline.body.item.slug}`)).text();
  assert.match(html2, /当前不在线/);
});

test('并流：原活码的访问被导向并入的活码', async () => {
  const token = await ownerToken();
  const from = await post('/api/codes', { kind: 'group', title: '旧群' }, token);
  const to = await post('/api/codes', { kind: 'group', title: '新群' }, token);
  await addQrcode(token, from.body.item.id, { threshold: 100 });
  await addQrcode(token, to.body.item.id, { threshold: 100 });

  const merged = await post(
    '/api/merges',
    { fromCodeId: from.body.item.id, toCodeId: to.body.item.id },
    token,
  );
  assert.equal(merged.status, 200);

  const res = await call(`/${from.body.item.slug}`, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' } });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), new RegExp(`/${to.body.item.slug}$`));
});

test('并流：不能并入自身，且仅支持群活码', async () => {
  const token = await ownerToken();
  const group = await post('/api/codes', { kind: 'group', title: '群' }, token);
  const service = await post('/api/codes', { kind: 'service', title: '客服' }, token);

  const self = await post('/api/merges', { fromCodeId: group.body.item.id, toCodeId: group.body.item.id }, token);
  assert.equal(self.status, 400);

  const crossKind = await post(
    '/api/merges',
    { fromCodeId: service.body.item.id, toCodeId: group.body.item.id },
    token,
  );
  assert.equal(crossKind.status, 400);
});

test('长按上报累加计数，非法参数被拒绝', async () => {
  const token = await ownerToken();
  const created = await post('/api/codes', { kind: 'group', title: '长按群' }, token);
  const qr = await addQrcode(token, created.body.item.id, {});

  await call(`/report/longpress?zm_id=${qr.body.item.id}`);
  await call(`/report/longpress?zm_id=${qr.body.item.id}`);

  const detail = await json(`/api/codes/${created.body.item.id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(detail.body.qrcodes[0].longPress, 2);

  const bad = await call('/report/longpress?zm_id=abc');
  assert.equal(bad.status, 400);
});

test('子码可以被禁用，禁用后不再被选中', async () => {
  const token = await ownerToken();
  const created = await post('/api/codes', { kind: 'group', title: '停用子码' }, token);
  const qr = await addQrcode(token, created.body.item.id, { threshold: 10 });
  await patch(`/api/qrcodes/${qr.body.item.id}`, { status: 'disabled' }, token);

  const res = await call(`/${created.body.item.slug}`);
  const html = await res.text();
  assert.match(html, /扫码次数已达上限/);
});

test('渠道码记录来源并支持封禁访客', async () => {
  const token = await ownerToken();
  const created = await post(
    '/api/channels',
    { title: '渠道A', targetUrl: 'https://example.com/ch' },
    token,
  );
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const channelId = created.body.item.id;

  const redirect = await call(`/${created.body.item.slug}`, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Linux; Android 14) MicroMessenger/8.0',
      'CF-Connecting-IP': '203.0.113.9',
    },
  });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'https://example.com/ch');

  const detail = await json(`/api/channels/${channelId}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(detail.body.item.hits, 1);
  assert.equal(detail.body.breakdown.length, 1);
  assert.equal(detail.body.breakdown[0].app, '微信');
  assert.equal(detail.body.breakdown[0].os, 'Android');

  // 同一访客再次访问应累加到同一行，而不是新增来源
  await call(`/${created.body.item.slug}`, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Linux; Android 14) MicroMessenger/8.0',
      'CF-Connecting-IP': '203.0.113.9',
    },
  });
  const detail2 = await json(`/api/channels/${channelId}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(detail2.body.breakdown.length, 1);
  assert.equal(detail2.body.breakdown[0].hits, 2);
});

test('渠道码访问限制为仅微信时，其它环境被挡下', async () => {
  const token = await ownerToken();
  const created = await post(
    '/api/channels',
    { title: '微信渠道', targetUrl: 'https://example.com/wx', accessRule: 'wechat' },
    token,
  );
  const res = await call(`/${created.body.item.slug}`, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0)' } });
  const html = await res.text();
  assert.match(html, /仅限微信内访问/);
});

test('域名管理：只存 host，且去重', async () => {
  const token = await ownerToken();
  const created = await post('/api/domains', { host: 'https://Go.Example.COM/', kind: 'short' }, token);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.item.host, 'go.example.com');

  const dup = await post('/api/domains', { host: 'go.example.com', kind: 'entry' }, token);
  assert.equal(dup.status, 400);

  const bad = await post('/api/domains', { host: 'not a host!!', kind: 'short' }, token);
  assert.equal(bad.status, 400);
});
