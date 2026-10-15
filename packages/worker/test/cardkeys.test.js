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

async function createBatch(token, overrides = {}) {
  const res = await json('/api/cardkeys', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ name: '内测码', content: '会员兑换码 30 天', count: 3, ...overrides }),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

test('生成批次后返回明文卡密，且库里只存哈希', async () => {
  const token = await bootstrapOwner();
  const created = await createBatch(token);
  assert.equal(created.codes.length, 3);
  assert.equal(created.item.total, 3);
  assert.equal(created.item.remaining, 3);

  const rows = env.DB.raw.prepare('SELECT code_hash, code_hint FROM cardkeys').all();
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.match(row.code_hash, /^[0-9a-f]{64}$/);
    // hint 含掩码，不含完整明文
    assert.match(row.code_hint, /\*\*\*\*/);
  }
  // 明文不应出现在库里的任何一列
  const dumped = JSON.stringify(rows);
  for (const code of created.codes) assert.ok(!dumped.includes(code));
});

test('生成的卡密互不重复', async () => {
  const token = await bootstrapOwner();
  const created = await createBatch(token, { count: 50 });
  assert.equal(new Set(created.codes).size, 50);
});

test('兑换成功后返回内容，且不可重复兑换', async () => {
  const token = await bootstrapOwner();
  const { codes } = await createBatch(token, { content: 'VIP-30' });

  const first = await json('/api/cardkeys/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: codes[0] }),
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.content, 'VIP-30');

  const second = await json('/api/cardkeys/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: codes[0] }),
  });
  assert.equal(second.status, 400);
});

test('卡密大小写不敏感', async () => {
  const token = await bootstrapOwner();
  const { codes } = await createBatch(token);
  const res = await json('/api/cardkeys/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: codes[0].toLowerCase() }),
  });
  assert.equal(res.status, 200);
});

test('不存在的卡密返回 404，不泄露是否有效', async () => {
  const res = await json('/api/cardkeys/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'DWZ-AAAA-BBBB-CCCC' }),
  });
  assert.equal(res.status, 404);
});

test('批次暂停后不能再兑换', async () => {
  const token = await bootstrapOwner();
  const { item, codes } = await createBatch(token);
  await json(`/api/cardkeys/${item.id}`, {
    method: 'PATCH',
    headers: auth(token),
    body: JSON.stringify({ status: 'paused' }),
  });
  const res = await json('/api/cardkeys/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: codes[0] }),
  });
  assert.equal(res.status, 400);
  assert.match(res.body.msg, /暂停/);
});

test('过期批次拒绝兑换', async () => {
  const token = await bootstrapOwner();
  const { codes } = await createBatch(token, { expiredAt: '2020-01-01 00:00:00' });
  const res = await json('/api/cardkeys/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: codes[0] }),
  });
  assert.equal(res.status, 400);
  assert.match(res.body.msg, /过期/);
});

test('兑换后批次已用数量与剩余量同步更新', async () => {
  const token = await bootstrapOwner();
  const { item, codes } = await createBatch(token);
  await json('/api/cardkeys/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: codes[0] }),
  });

  const detail = await json(`/api/cardkeys/${item.id}`, { headers: auth(token) });
  assert.equal(detail.body.item.used, 1);
  assert.equal(detail.body.item.remaining, 2);
  assert.equal(detail.body.redeems.length, 1);
});

test('同一 IP 每日兑换次数超限后被拦截', async () => {
  const token = await bootstrapOwner();
  const { codes } = await createBatch(token, { count: 8 });
  let blocked = 0;
  for (const code of codes) {
    // eslint-disable-next-line no-await-in-loop
    const res = await json('/api/cardkeys/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '9.9.9.9' },
      body: JSON.stringify({ code }),
    });
    if (res.status === 400 && /上限/.test(res.body.msg)) blocked += 1;
  }
  // 默认限流 5 次，8 张里应有 3 张被拦
  assert.equal(blocked, 3);
});

test('追加卡密会累加总数并返回新明文', async () => {
  const token = await bootstrapOwner();
  const { item } = await createBatch(token);
  const res = await json(`/api/cardkeys/${item.id}/append`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ count: 2 }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.codes.length, 2);

  const detail = await json(`/api/cardkeys/${item.id}`, { headers: auth(token) });
  assert.equal(detail.body.item.total, 5);
  assert.equal(detail.body.item.remaining, 5);
});

test('删除批次级联清理卡密', async () => {
  const token = await bootstrapOwner();
  const { item } = await createBatch(token);
  await json(`/api/cardkeys/${item.id}`, { method: 'DELETE', headers: auth(token) });
  const rows = env.DB.raw.prepare('SELECT COUNT(*) AS n FROM cardkeys WHERE batch_id = ?').get(item.id);
  assert.equal(rows.n, 0);
});

test('成员看不到他人的批次', async () => {
  const ownerToken = await bootstrapOwner();
  const { item } = await createBatch(ownerToken, { name: 'owner 的批次' });

  // owner 再建一个成员
  const member = await json('/api/users', {
    method: 'POST',
    headers: auth(ownerToken),
    body: JSON.stringify({ username: 'member1', password: 'supersecret1' }),
  });
  assert.equal(member.status, 200);

  const login = await json('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'member1', password: 'supersecret1' }),
  });
  const memberToken = login.body.token;

  const list = await json('/api/cardkeys', { headers: auth(memberToken) });
  assert.equal(list.body.items.length, 0);

  const detail = await json(`/api/cardkeys/${item.id}`, { headers: auth(memberToken) });
  assert.equal(detail.status, 404);
});

test('未登录不能生成卡密', async () => {
  const res = await json('/api/cardkeys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x', content: 'y', count: 1 }),
  });
  assert.equal(res.status, 401);
});

test('生成数量超出上限被拒绝', async () => {
  const token = await bootstrapOwner();
  const res = await json('/api/cardkeys', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ name: 'x', content: 'y', count: 999999 }),
  });
  assert.equal(res.status, 400);
});

test('兑换页可直接访问，并带出批次名做标题', async () => {
  const token = await bootstrapOwner();
  const { item } = await createBatch(token, { name: '双十一福利' });

  const html = await call('/redeem');
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  const body = await html.text();
  assert.match(body, /卡密兑换/);
  assert.match(body, /\/api\/cardkeys\/redeem/);

  // 带批次 id 时用批次名当标题；明文卡密不该出现在页面里
  const named = await (await call(`/redeem?k=${item.id}`)).text();
  assert.match(named, /双十一福利/);

  // 非数字的 k 参数不报错，落回默认标题
  const fallback = await call('/redeem?k=abc');
  assert.equal(fallback.status, 200);
  assert.match(await fallback.text(), /卡密兑换/);
});

test('redeem 被保留，不会被当成短链 key 吞掉', async () => {
  // 兑换页优先于短链解析：不先探一眼数据库就直接 404 也不影响，
  // 这里校验的是 /redeem 一定回 HTML，而不是「链接不存在」的提示页。
  const res = await call('/redeem');
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!body.includes('链接不存在'));
});
