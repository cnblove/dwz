import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createCtx, createEnv, makeRequest } from './helpers.js';

/**
 * 成员创建配额。
 *
 * 配额的实质是「超管的两个身份之间的切换」：他既是限制的制定者（管用户组），
 * 又是唯一不受限制的人（避免把自己锁死在门外）。所以这里两边都要测到 ——
 * 只测「成员被挡住」会漏掉最危险的那种回归：某天顺手把 assertQuota 挂到
 * 超管头上，配一个 0 就让整个后台建不出东西。
 */

let env;
let ctx;

beforeEach(() => {
  env = createEnv();
  ctx = createCtx();
});

async function json(path, init = {}) {
  const response = await worker.fetch(makeRequest(`https://api.test${path}`, init), env, ctx);
  await ctx.settle();
  return { status: response.status, body: await response.json() };
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

async function makeOwner() {
  const res = await post('/api/auth/register', { username: 'owner', password: 'supersecret1' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.token;
}

/** 建一个组 + 一个组内成员，返回成员的令牌。 */
async function makeMember(ownerToken, quota = {}) {
  const group = await post('/api/groups', { name: `g${Math.random().toString(36).slice(2, 8)}`, ...quota }, ownerToken);
  assert.equal(group.status, 200, JSON.stringify(group.body));

  const username = `m${Math.random().toString(36).slice(2, 8)}`;
  const created = await post(
    '/api/users',
    { username, password: 'supersecret1', groupId: group.body.item.id },
    ownerToken,
  );
  assert.equal(created.status, 200, JSON.stringify(created.body));

  const login = await post('/api/auth/login', { username, password: 'supersecret1' });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { token: login.body.token, username, groupId: group.body.item.id };
}

test('用户组配额可写入、可读出，未填的项是不限额', async () => {
  const owner = await makeOwner();
  const created = await post('/api/groups', { name: '运营', quotaShortLinks: 2, quotaCodes: 1 }, owner);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.deepEqual(created.body.item.quota, {
    shortLinks: 2,
    codes: 1,
    qrcodes: null,
    channels: null,
    assets: null,
  });

  const listed = await json('/api/groups', { headers: { authorization: `Bearer ${owner}` } });
  const same = listed.body.items.find((g) => g.id === created.body.item.id);
  assert.deepEqual(same.quota, created.body.item.quota);
});

test('成员的创建量达到配额后被拒，删掉一条即恢复', async () => {
  const owner = await makeOwner();
  const { token } = await makeMember(owner, { quotaShortLinks: 2 });

  for (let i = 0; i < 2; i += 1) {
    const res = await post('/api/short-links', { title: `t${i}`, targetUrl: 'https://example.com' }, token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }

  const blocked = await post('/api/short-links', { title: 'overflow', targetUrl: 'https://example.com' }, token);
  assert.equal(blocked.status, 403);
  assert.match(blocked.body.msg, /配额/);

  // 配额看的是「名下有多少」而不是「累计建过多少」：删一条就能腾出位置。
  // 否则总量满了就没人能再建，也没人知道该删谁的。
  const list = await json('/api/short-links', { headers: { authorization: `Bearer ${token}` } });
  const first = list.body.items.at(-1);
  const removed = await json(`/api/short-links/${first.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  const again = await post('/api/short-links', { title: 'retry', targetUrl: 'https://example.com' }, token);
  assert.equal(again.status, 200, JSON.stringify(again.body));
});

test('超管不受配额约束，配额为 0 也建得出来', async () => {
  const owner = await makeOwner();
  const created = await post('/api/groups', { name: '锁死组', quotaCodes: 0 }, owner);
  assert.equal(created.status, 200);

  // 超管自己的账号没有用户组，配额恒为不限
  const res = await post('/api/codes', { kind: 'group', title: '超管的码' }, owner);
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

test('活码配额只算活码，子码配额另算', async () => {
  const owner = await makeOwner();
  const { token } = await makeMember(owner, { quotaCodes: 1, quotaQrcodes: 2 });

  const code = await post('/api/codes', { kind: 'group', title: '群码' }, token);
  assert.equal(code.status, 200, JSON.stringify(code.body));

  const overflow = await post('/api/codes', { kind: 'group', title: '再来一个' }, token);
  assert.equal(overflow.status, 403);

  const codeId = code.body.item.id;
  for (let i = 0; i < 2; i += 1) {
    const res = await post(`/api/codes/${codeId}`, { imageUrl: `https://cdn.test/${i}.png` }, token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  const blocked = await post(`/api/codes/${codeId}`, { imageUrl: 'https://cdn.test/x.png' }, token);
  assert.equal(blocked.status, 403);
  assert.match(blocked.body.msg, /子码/);
});

test('渠道码配额独立生效', async () => {
  const owner = await makeOwner();
  const { token } = await makeMember(owner, { quotaChannels: 1 });

  assert.equal((await post('/api/channels', { title: 'a', targetUrl: 'https://example.com' }, token)).status, 200);
  assert.equal((await post('/api/channels', { title: 'b', targetUrl: 'https://example.com' }, token)).status, 403);
});

test('素材上传在配额用满时被拒，且不落下 R2 对象', async () => {
  const owner = await makeOwner();
  const { token } = await makeMember(owner, { quotaAssets: 1 });

  const form = () => {
    const data = new FormData();
    data.append('file', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'a.png');
    return data;
  };

  const first = await worker.fetch(
    makeRequest('https://api.test/api/assets', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form(),
    }),
    env,
    ctx,
  );
  assert.equal(first.status, 200, await first.text());
  const sizeAfterFirst = env.MEDIA.store.size;

  const second = await worker.fetch(
    makeRequest('https://api.test/api/assets', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form(),
    }),
    env,
    ctx,
  );
  assert.equal(second.status, 403);
  // 先卡配额再落桶：否则图片会留在 R2 里，却没有 assets 行能把它删掉
  assert.equal(env.MEDIA.store.size, sizeAfterFirst, '被拒的上传不应写入 R2');
});

test('改用户组配额对组内成员立即生效', async () => {
  const owner = await makeOwner();
  const { token, groupId } = await makeMember(owner, { quotaShortLinks: 0 });

  const blocked = await post('/api/short-links', { title: 'x', targetUrl: 'https://example.com' }, token);
  assert.equal(blocked.status, 403);

  const updated = await json(`/api/groups/${groupId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
    body: JSON.stringify({ quotaShortLinks: 5 }),
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));

  // 会话里的配额是每次请求重新加载的，不需要重新登录
  const allowed = await post('/api/short-links', { title: 'x', targetUrl: 'https://example.com' }, token);
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
});

test('部分更新只改传入的配额项，不清空其它项', async () => {
  const owner = await makeOwner();
  const created = await post('/api/groups', { name: '部分更新', quotaShortLinks: 3, quotaCodes: 4 }, owner);

  const patched = await json(`/api/groups/${created.body.item.id}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
    body: JSON.stringify({ quotaCodes: null }),
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.item.quota.shortLinks, 3, '未传的短链配额应保持原值');
  assert.equal(patched.body.item.quota.codes, null, '显式传 null 才是改成不限额');
});

test('配额字段拒绝负数与非法值', async () => {
  const owner = await makeOwner();
  const bad = await post('/api/groups', { name: '非法', quotaShortLinks: -1 }, owner);
  assert.equal(bad.status, 400);
});
