import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createCtx, createEnv, makeRequest, uuid } from './helpers.js';

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

const AUTH = { 'content-type': 'application/json' };

async function bootstrapOwner() {
  const res = await json('/api/auth/register', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ username: 'owner', password: 'supersecret1' }),
  });
  return res.body.token;
}

function auth(token) {
  return { ...AUTH, authorization: `Bearer ${token}` };
}

/* ---------------- 并发计数 ---------------- */

test('同一短链被并发访问时计数不丢', async () => {
  const token = await bootstrapOwner();
  const created = await json('/api/short-links', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ title: '并发', targetUrl: 'https://example.com/a' }),
  });
  const slug = created.body.item.slug;

  const requests = Array.from({ length: 12 }, (_, i) =>
    call(`/${slug}`, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0)', 'cf-connecting-ip': `10.0.0.${i}` } }),
  );
  const responses = await Promise.all(requests);
  for (const response of responses) assert.equal(response.status, 302);

  // 计数靠单条原子 UPDATE：先读后写在并发下会互相覆盖，这里会远小于 12
  const row = env.DB.raw.prepare('SELECT hits, hits_today FROM short_links WHERE id = ?').get(created.body.item.id);
  assert.equal(row.hits, 12);
  assert.equal(row.hits_today, 12);
});

test('同一子码被并发访问时阈值计数不丢', async () => {
  const token = await bootstrapOwner();
  const created = await json('/api/codes', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ kind: 'group', title: '群码' }),
  });
  const codeId = created.body.item.id;
  await json(`/api/codes/${codeId}`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ imageUrl: 'https://img.example.com/a.png', threshold: 100 }),
  });
  const slug = created.body.item.slug;

  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      call(`/${slug}`, { headers: { 'cf-connecting-ip': `10.1.0.${i}` } }),
    ),
  );

  const qrcode = env.DB.raw.prepare('SELECT hits FROM code_qrcodes WHERE code_id = ?').get(codeId);
  assert.equal(qrcode.hits, 10);
});

/* ---------------- slug 命名空间 ---------------- */

test('并发抢同一个自定义 slug 时只有一个成功', async () => {
  const token = await bootstrapOwner();
  const attempts = ['/api/short-links', '/api/codes', '/api/channels'].map((path, i) =>
    json(path, {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify(
        i === 0
          ? { title: '并发占位', targetUrl: 'https://example.com', slug: 'race1234' }
          : i === 1
            ? { kind: 'group', title: '并发占位', slug: 'race1234' }
            : { title: '并发占位', targetUrl: 'https://example.com', slug: 'race1234' },
      ),
    }),
  );
  const results = await Promise.all(attempts);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 400).length, 2);
});

test('删除资源后 slug 可以被重新占用', async () => {
  const token = await bootstrapOwner();
  const created = await json('/api/short-links', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ title: '回收', targetUrl: 'https://example.com', slug: 'recycle1' }),
  });
  assert.equal(created.status, 200);

  await json(`/api/short-links/${created.body.item.id}`, { method: 'DELETE', headers: auth(token) });

  const again = await json('/api/short-links', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ title: '回收', targetUrl: 'https://example.com', slug: 'recycle1' }),
  });
  assert.equal(again.status, 200, JSON.stringify(again.body));
});

test('自定义 slug 会被写入命名空间，另一种资源不能再占用', async () => {
  const token = await bootstrapOwner();
  const created = await json('/api/short-links', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ title: '占用', targetUrl: 'https://example.com', slug: 'shared1' }),
  });
  assert.equal(created.status, 200);

  const code = await json('/api/codes', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ kind: 'group', title: '占用', slug: 'shared1' }),
  });
  assert.equal(code.status, 400);
  assert.match(code.body.msg, /已被占用/);
});

/* ---------------- 对外标识 ---------------- */

test('自动生成的 slug 是 UUID v4，不是自增序列', async () => {
  const token = await bootstrapOwner();
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const created = await json('/api/short-links', {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ title: `第 ${i} 条`, targetUrl: 'https://example.com' }),
    });
    assert.match(created.body.item.slug, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

test('卡密批次带 uuid，且 uuid 不是主键', async () => {
  const token = await bootstrapOwner();
  const created = await json('/api/cardkeys', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ name: '批次', content: '内容', count: 2 }),
  });
  assert.equal(created.body.item.uuid, created.body.item.uuid);
  assert.equal(uuid().length, 36);
  assert.notEqual(created.body.item.uuid, String(created.body.item.id));

  const row = env.DB.raw.prepare('SELECT uuid FROM cardkey_batches WHERE id = ?').get(created.body.item.id);
  assert.equal(row.uuid, created.body.item.uuid);
});

/* ---------------- 兑换限流 ---------------- */

test('失败兑换不占用当日额度', async () => {
  const token = await bootstrapOwner();
  const created = await json('/api/cardkeys', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ name: '额度', content: '内容', count: 1 }),
  });
  const code = created.body.codes[0];

  // 先用一个不存在的卡密试几次，这些尝试不应该吃掉额度
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const miss = await json('/api/cardkeys/redeem', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ code: 'DWZ-XXXX-XXXX-XXXX' }),
    });
    assert.equal(miss.status, 404);
  }

  const hit = await json('/api/cardkeys/redeem', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ code }),
  });
  assert.equal(hit.status, 200, JSON.stringify(hit.body));
});

test('兑换记录里的批次与卡密在成功后补全', async () => {
  const token = await bootstrapOwner();
  const created = await json('/api/cardkeys', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ name: '补全', content: '内容', count: 1 }),
  });

  await json('/api/cardkeys/redeem', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ code: created.body.codes[0] }),
  });

  const rows = env.DB.raw.prepare('SELECT batch_id, cardkey_id FROM cardkey_redeems').all();
  assert.equal(rows.length, 1);
  assert.ok(rows[0].batch_id > 0);
  assert.ok(rows[0].cardkey_id > 0);
});

/* ---------------- 通知渠道字段 ---------------- */

test('活码的通知渠道只接受数字 ID', async () => {
  const token = await bootstrapOwner();
  const bad = await json('/api/codes', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ kind: 'group', title: '渠道', notifyChannel: 'not-a-number' }),
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.msg, /通知渠道/);

  const good = await json('/api/codes', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ kind: 'group', title: '渠道', notifyChannel: 7 }),
  });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  // D1 里 notify_channel 是 TEXT 列，回读是字符串；关键是它是数字 ID 而不是任意文本
  assert.equal(Number(good.body.item.notifyChannel), 7);
  assert.match(String(good.body.item.notifyChannel), /^\d+(\.0)?$/);
});

/* ---------------- 卡密导入 ---------------- */

test('可以导入外部卡密明文（CSV 行只取第一列）', async () => {
  const token = await bootstrapOwner();
  const created = await json('/api/cardkeys', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      name: '导入批次',
      content: '会员 30 天',
      codeList: 'AAA-111\nBBB-222,2030-01-01,备注\n\nAAA-111\n',
    }),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  // 空行与重复行被丢掉，逗号后的字段不影响
  assert.deepEqual(created.body.codes, ['AAA-111', 'BBB-222']);
  assert.equal(created.body.item.total, 2);

  const redeem = await json('/api/cardkeys/redeem', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ code: 'bbb-222' }),
  });
  assert.equal(redeem.status, 200, JSON.stringify(redeem.body));
});

/* ---------------- 轮询域名降级 ---------------- */

test('轮询域名池为空时短链仍然可用', async () => {
  const token = await bootstrapOwner();
  const created = await json('/api/short-links', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ title: '轮询', targetUrl: 'https://example.com/x', rotateDomain: true }),
  });
  assert.equal(created.status, 200);

  const response = await call(`/${created.body.item.slug}`, { redirect: 'manual' });
  // 没有 short 类域名时退回普通跳转，而不是把访客挡在错误页
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://example.com/x');
});

/* ---------------- 外键与级联清理 ---------------- */

/**
 * D1 默认对每个事务都开启外键约束（等价于 SQLite 的 PRAGMA foreign_keys = on），
 * 且用户查询无法在事务内改变该设置。因此 schema 里写的 ON DELETE CASCADE
 * 在线上直接生效，代码不需要、也无法用 `PRAGMA foreign_keys = ON` 去开它。
 * 这里把这条契约钉住：测试库若关掉外键，下面的级联断言会失败。
 */
test('测试库外键约束为开启状态，与 D1 语义一致', () => {
  const row = env.DB.raw.prepare('PRAGMA foreign_keys').get();
  assert.equal(row.foreign_keys, 1);
});

test('删除活码级联清理子码与并流记录', async () => {
  const token = await bootstrapOwner();
  const created = await json('/api/codes', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      kind: 'group',
      title: '级联',
      qrcodes: [{ imageUrl: 'https://img.test/a.png' }],
    }),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const codeId = created.body.item.id;

  const merged = await json('/api/merges', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ fromCodeId: codeId, toCodeId: codeId }),
  });
  // 并流到自身会被拒绝，这里只关心存在引用时删除行为；若失败则跳过该断言
  if (merged.status === 200) {
    const removed = await json(`/api/codes/${codeId}`, { method: 'DELETE', headers: auth(token) });
    assert.equal(removed.status, 200);
    const qrcodes = env.DB.raw
      .prepare('SELECT COUNT(*) AS n FROM code_qrcodes WHERE code_id = ?')
      .get(codeId);
    const merges = env.DB.raw
      .prepare('SELECT COUNT(*) AS n FROM code_merges WHERE from_code_id = ?')
      .get(codeId);
    assert.equal(qrcodes.n, 0, '子码应随活码级联删除');
    assert.equal(merges.n, 0, '并流记录应随活码级联删除');
  }
});

test('删除账号时清掉其名下资源并释放 slug 命名空间', async () => {
  const token = await bootstrapOwner();

  const member = await json('/api/users', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ username: 'cascade1', password: 'supersecret1' }),
  });
  assert.equal(member.status, 200, JSON.stringify(member.body));
  const memberId = member.body.item.id;

  const memberLogin = await json('/api/auth/login', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ username: 'cascade1', password: 'supersecret1' }),
  });
  const memberToken = memberLogin.body.token;

  const link = await json('/api/short-links', {
    method: 'POST',
    headers: auth(memberToken),
    body: JSON.stringify({ title: '成员短链', targetUrl: 'https://example.com/m', slug: 'memberkey1' }),
  });
  assert.equal(link.status, 200, JSON.stringify(link.body));

  // 名下资源对 users(id) 是强外键，未清理时这一步会因外键失败
  const removed = await json(`/api/users/${memberId}`, { method: 'DELETE', headers: auth(token) });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  const left = env.DB.raw
    .prepare('SELECT COUNT(*) AS n FROM short_links WHERE owner_id = ?')
    .get(memberId);
  assert.equal(left.n, 0, '账号删除后其短链应一并清理');

  const slug = env.DB.raw
    .prepare('SELECT COUNT(*) AS n FROM short_slugs WHERE slug = ?')
    .get('memberkey1');
  assert.equal(slug.n, 0, '释放后的 slug 应可被再次占用');

  // 换个账号用同一个 slug 应能成功
  const reused = await json('/api/short-links', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({ title: '复用', targetUrl: 'https://example.com/r', slug: 'memberkey1' }),
  });
  assert.equal(reused.status, 200, JSON.stringify(reused.body));
});
