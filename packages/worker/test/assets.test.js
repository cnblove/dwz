import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createBucket, createCtx, createEnv, makeRequest } from './helpers.js';

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
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.token;
}

/** 造一个最小的 PNG 字节序列：签名块足够骗过 MIME 白名单（我们只按 content-type 判）。 */
function pngFile(name = 'qr.png', type = 'image/png') {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  return new File([bytes], name, { type });
}

function uploadRequest(file, token, extra = {}) {
  const form = new FormData();
  form.append('file', file);
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  };
}

test('上传图片后能列表、回源并删除', async () => {
  const token = await bootstrapOwner();

  const uploaded = await json('/api/assets', uploadRequest(pngFile('kefu.png'), token, { remark: '客服码' }));
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  const item = uploaded.body.item;
  assert.equal(item.filename, 'kefu.png');
  assert.equal(item.mime, 'image/png');
  assert.match(item.objectKey, /^assets\/\d{6}\/[0-9a-f-]{36}\.png$/);
  assert.equal(item.url, `/media/${item.objectKey}`);

  // 列表：默认按 id 倒序，带 remark
  const list = await json('/api/assets', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(list.body.total, 1);
  assert.equal(list.body.items[0].id, item.id);

  // 回源：/media/{key} 从桶里读出来，content-type 与长缓存都要在
  const media = await call(`/media/${item.objectKey}`);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get('content-type'), 'image/png');
  assert.match(media.headers.get('cache-control'), /immutable/);

  // 删除：库里没了，桶里也没了
  const deleted = await json(`/api/assets/${item.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(deleted.status, 200);
  assert.equal(env.MEDIA.store.has(item.objectKey), false);

  const after = await json('/api/assets', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(after.body.total, 0);
});

test('上传按 MIME 白名单拦截非图片', async () => {
  const token = await bootstrapOwner();

  const bad = await json('/api/assets', uploadRequest(new File(['<html>'], 'x.html', { type: 'text/html' }), token));
  assert.equal(bad.status, 400);
  assert.match(bad.body.msg, /不支持的图片格式/);

  const svg = await json('/api/assets', uploadRequest(new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }), token));
  assert.equal(svg.status, 400, 'SVG 可执行脚本，必须挡掉');
});

test('缺少文件字段时返回 400', async () => {
  const token = await bootstrapOwner();
  const form = new FormData();
  const res = await json('/api/assets', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  assert.equal(res.status, 400);
  assert.match(res.body.msg, /缺少上传文件/);
});

test('空文件被拒绝', async () => {
  const token = await bootstrapOwner();
  const res = await json('/api/assets', uploadRequest(new File([], 'empty.png', { type: 'image/png' }), token));
  assert.equal(res.status, 400);
  assert.match(res.body.msg, /为空/);
});

test('未登录不能访问素材接口', async () => {
  const res = await json('/api/assets');
  assert.equal(res.status, 401);
});

test('MEDIA_ORIGIN 配置后素材链接走自定义域名', async () => {
  env = createEnv({ MEDIA_ORIGIN: 'https://cdn.example.com/' });
  const token = await bootstrapOwner();
  const uploaded = await json('/api/assets', uploadRequest(pngFile('a.png'), token));
  assert.match(uploaded.body.item.url, /^https:\/\/cdn\.example\.com\/assets\//);
  assert.equal(uploaded.body.item.url.endsWith('\n'), false);
});

test('R2 未绑定时给出可读的 503', async () => {
  env = createEnv({ MEDIA: undefined });
  const token = await bootstrapOwner();
  const res = await json('/api/assets', uploadRequest(pngFile('a.png'), token));
  assert.equal(res.status, 503);
  assert.match(res.body.msg, /R2/);
});

test('成员之间素材互不可见，超管可见全部', async () => {
  const ownerToken = await bootstrapOwner();

  // 超管建一个成员
  const created = await json('/api/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ username: 'member1', password: 'supersecret1' }),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));

  const login = await json('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'member1', password: 'supersecret1' }),
  });
  const memberToken = login.body.token;

  const mine = await json('/api/assets', uploadRequest(pngFile('mine.png'), memberToken));
  assert.equal(mine.status, 200);

  const memberList = await json('/api/assets', { headers: { authorization: `Bearer ${memberToken}` } });
  assert.equal(memberList.body.total, 1);

  const ownerList = await json('/api/assets', { headers: { authorization: `Bearer ${ownerToken}` } });
  assert.equal(ownerList.body.total, 1);

  // 成员删别人的素材 → 404（不暴露存在性）
  const stolen = await json(`/api/assets/${mine.body.item.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(stolen.status, 200, '超管可以删成员的素材');
});

test('编辑只改文件名与备注，URL 不变', async () => {
  const token = await bootstrapOwner();
  const uploaded = await json('/api/assets', uploadRequest(pngFile('old.png'), token));
  const item = uploaded.body.item;

  const patched = await json(`/api/assets/${item.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ filename: 'new.png', remark: '双十一' }),
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.item.filename, 'new.png');
  assert.equal(patched.body.item.remark, '双十一');
  assert.equal(patched.body.item.url, item.url);
});

test('createBucket 替身本身可存取', async () => {
  const bucket = createBucket();
  await bucket.put('a/b.png', new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: 'image/png' } });
  const object = await bucket.get('a/b.png');
  assert.equal(object.size, 3);
  assert.equal(object.httpMetadata.contentType, 'image/png');
  await bucket.delete('a/b.png');
  assert.equal(await bucket.get('a/b.png'), null);
});
