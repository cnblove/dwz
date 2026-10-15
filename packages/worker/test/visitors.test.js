import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createCtx, createEnv, makeRequest } from './helpers.js';
import { listVisits, pruneVisits, recordVisit, visitLogSetting } from '../src/lib/visitors.js';
import { todayKey } from '../src/lib/time.js';

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

async function ownerToken() {
  const res = await post('/api/auth/register', { username: 'owner', password: 'supersecret1' });
  return res.body.token;
}

const WECHAT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 MicroMessenger/8.0.42';

/** 建一条短链并访问一次，返回 slug。 */
async function visitShortLink(token, slug = 'promo01', hits = 1) {
  await post('/api/short-links', { slug, title: '活动页', targetUrl: 'https://example.com' }, token);
  for (let i = 0; i < hits; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await call(`/${slug}`, {
      headers: { 'user-agent': WECHAT_UA, 'cf-connecting-ip': '203.0.113.7', 'cf-ipcountry': 'CN' },
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
  }
  return slug;
}

test('短链访问会写入最近访客明细，且保留原始 IP', async () => {
  const token = await ownerToken();
  await visitShortLink(token);

  const { results } = await env.DB.prepare('SELECT * FROM visit_logs').bind().all();
  assert.equal(results.length, 1);
  const row = results[0];
  assert.equal(row.ip, '203.0.113.7');
  assert.equal(row.source, 'short_link');
  assert.equal(row.slug, 'promo01');
  assert.equal(row.title, '活动页');
  assert.equal(row.country, 'CN');
  assert.equal(row.os, 'iOS');
  assert.equal(row.platform, '微信');
  assert.equal(row.device, '移动端');
  assert.equal(row.day, todayKey());
});

test('同一访客当天重复访问只累加次数，不堆行', async () => {
  const token = await ownerToken();
  await visitShortLink(token, 'promo01', 3);

  const { results } = await env.DB.prepare('SELECT hits FROM visit_logs').bind().all();
  assert.equal(results.length, 1);
  assert.equal(results[0].hits, 3);
});

test('不同 IP 视为不同访客', async () => {
  const token = await ownerToken();
  await post('/api/short-links', { slug: 'promo02', title: '活动页', targetUrl: 'https://example.com' }, token);
  for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.2']) {
    // eslint-disable-next-line no-await-in-loop
    await call('/promo02', { headers: { 'cf-connecting-ip': ip, 'user-agent': WECHAT_UA }, redirect: 'manual' });
  }

  const list = await listVisits(env.DB, { page: 1, pageSize: 10 });
  assert.equal(list.total, 2);
});

test('活码与渠道码访问同样进入明细，来源标签可区分', async () => {
  const token = await ownerToken();
  await post('/api/codes', { slug: 'qun001', kind: 'group', title: '群活码' }, token);
  await post('/api/channels', { slug: 'chan01', title: '渠道码', targetUrl: 'https://example.com' }, token);

  await call('/qun001', { headers: { 'cf-connecting-ip': '203.0.113.9', 'user-agent': WECHAT_UA }, redirect: 'manual' });
  await call('/chan01', { headers: { 'cf-connecting-ip': '203.0.113.9', 'user-agent': WECHAT_UA }, redirect: 'manual' });

  const list = await listVisits(env.DB, { page: 1, pageSize: 10 });
  assert.equal(list.total, 2);
  // 两条明细落在同一秒，排序不定，比集合而不是顺序
  assert.deepEqual(list.items.map((item) => item.sourceLabel).sort(), ['渠道码', '群活码'].sort());
});

test('最近访客接口按时间倒序返回，并给出保留口径', async () => {
  const token = await ownerToken();
  await visitShortLink(token);

  const res = await json('/api/stats/visitors', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.items[0].ip, '203.0.113.7');
  assert.equal(res.body.items[0].sourceLabel, '短链');
  assert.equal(res.body.keepDays, 7);
  assert.match(res.body.note, /仅保留最近 7 天/);
});

test('未登录不能读取访客明文 IP', async () => {
  const res = await json('/api/stats/visitors');
  assert.equal(res.status, 401);
});

test('保留天数越界截断到 1~365', async () => {
  const token = await ownerToken();

  const tooSmall = await json('/api/stats/visitors', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ keepDays: 0 }),
  });
  assert.equal(tooSmall.body.keepDays, 1);
  assert.equal(await visitLogSetting(env.DB), 1);

  const tooBig = await json('/api/stats/visitors', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ keepDays: 9999 }),
  });
  assert.equal(tooBig.body.keepDays, 365);
});

test('调整保留天数会顺带清掉超期明细', async () => {
  await recordVisit(env.DB, {
    source: 'short_link',
    pageId: 1,
    slug: 'old',
    ip: '198.51.100.9',
    now: Date.now() - 3 * 86400_000,
  });
  await recordVisit(env.DB, { source: 'short_link', pageId: 1, slug: 'new', ip: '198.51.100.9' });

  const token = await ownerToken();
  const res = await json('/api/stats/visitors', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ keepDays: 1 }),
  });
  assert.equal(res.body.keepDays, 1);
  assert.equal(res.body.pruned, 1);

  const list = await listVisits(env.DB, { page: 1, pageSize: 10 });
  assert.equal(list.total, 1);
  assert.equal(list.items[0].slug, 'new');
});

test('清空明细只删明细，不动聚合统计', async () => {
  const token = await ownerToken();
  await visitShortLink(token);

  const res = await json('/api/stats/visitors', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.body.deleted, 1);

  const list = await listVisits(env.DB, { page: 1, pageSize: 10 });
  assert.equal(list.total, 0);
  // 独立访客聚合仍在
  const summary = await json('/api/stats/detail?source=short_link', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(summary.body.visitors.visitorsToday, 1);
});

test('pruneVisits 按保留天数滚动清理', async () => {
  await recordVisit(env.DB, { source: 'short_link', pageId: 1, ip: 'a', now: Date.now() - 10 * 86400_000 });
  await recordVisit(env.DB, { source: 'short_link', pageId: 1, ip: 'b' });

  const result = await pruneVisits(env.DB, 7);
  assert.equal(result.deleted, 1);
  assert.equal(result.keepDays, 7);

  const list = await listVisits(env.DB, { page: 1, pageSize: 10 });
  assert.equal(list.total, 1);
});

test('页面不存在时不写明细', async () => {
  await call('/nope', { headers: { 'cf-connecting-ip': '203.0.113.30' }, redirect: 'manual' });
  await ctx.settle();
  const { results } = await env.DB.prepare('SELECT * FROM visit_logs').bind().all();
  assert.equal(results.length, 0);
});

test('分页按 pageSize 截断且上限 50', async () => {
  const token = await ownerToken();
  await post('/api/short-links', { slug: 'promo03', title: 'x', targetUrl: 'https://example.com' }, token);
  for (let i = 1; i <= 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await call('/promo03', { headers: { 'cf-connecting-ip': `198.51.100.${i}` }, redirect: 'manual' });
  }

  const first = await json('/api/stats/visitors?page=1&pageSize=2', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(first.body.items.length, 2);
  assert.equal(first.body.total, 3);

  const second = await json('/api/stats/visitors?page=2&pageSize=2', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(second.body.items.length, 1);

  const huge = await json('/api/stats/visitors?pageSize=5000', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(huge.body.pageSize, 50);
});

test('被拉黑的访客不再进入最近访客明细', async () => {
  const token = await ownerToken();
  await post('/api/channels', { slug: 'chan02', title: '渠道码', targetUrl: 'https://example.com' }, token);

  const visit = () =>
    call('/chan02', {
      headers: { 'cf-connecting-ip': '203.0.113.50', 'user-agent': WECHAT_UA },
      redirect: 'manual',
    });

  await visit();
  assert.equal((await listVisits(env.DB, { page: 1, pageSize: 10 })).total, 1);

  // 明文 IP 进黑名单，库里存的是哈希
  await post('/api/channels/1/blocks', { ip: '203.0.113.50' }, token);
  await visit();

  assert.equal((await listVisits(env.DB, { page: 1, pageSize: 10 })).total, 0);
  const { results } = await env.DB.prepare('SELECT visitor_ip FROM channel_visits').bind().all();
  assert.equal(results.length, 1);
  assert.notEqual(results[0].visitor_ip, '203.0.113.50');
});

test('detectPlatform 优先认 App 容器，其次回落浏览器', async () => {
  const { detectPlatform } = await import('../src/lib/ua.js');
  assert.equal(detectPlatform(WECHAT_UA), '微信');
  assert.equal(detectPlatform('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36'), 'Chrome');
  assert.equal(detectPlatform(''), '其它');
});

test('pruneVisits 保留天数截断到 1~365', async () => {
  assert.equal((await pruneVisits(env.DB, 0)).keepDays, 1);
  assert.equal((await pruneVisits(env.DB, 9999)).keepDays, 365);
  assert.equal((await pruneVisits(env.DB, 'abc')).keepDays, 7);
});
