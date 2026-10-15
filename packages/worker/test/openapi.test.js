import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { canonicalString, sign } from '../src/lib/openApiCore.js';
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

/**
 * 签名辅助。
 *
 * tags 就是签名串里那三个占位（标题/访问限制/目标链接），
 * 读操作一律补空串 —— 与 README 里给调用方的说明完全一致，
 * 测试不复刻一套只有测试知道的拼接规则。
 */
async function signed(tags, apiKey, apiSecret, extra = {}) {
  const payload = {
    dv1_title: tags.title ?? '',
    dv1_type: tags.type ?? '',
    dv1_url: tags.url ?? '',
    ...extra,
    api_key: apiKey,
  };
  // 与服务端一致：签的永远是「stringify 之后的 JSON 里那三个 tag」，
  // 而不是先构造再补 `?? ''` —— 后者会漏掉调用方用 JSON null 显式表达的「空」。
  payload.sign = await sign(
    {
      dwz_title: payload.dv1_title,
      dwz_type: payload.dv1_type,
      dwz_url: payload.dv1_url,
      api_key: apiKey,
      api_secret: apiSecret,
    },
    apiSecret,
  );
  return payload;
}

/* ---------------- 凭证 ---------------- */

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

/* ---------------- 目录 ---------------- */

test('目录接口无需鉴权即可自描述', async () => {
  const res = await json('/open/v1');
  assert.equal(res.status, 200);
  assert.equal(res.body.version, 'v1');
  assert.match(res.body.signAlgorithm, /HMAC-SHA256/);
  // 签名串必须与实现里真正拼出来的那份一致，否则目录就是在骗调用方
  assert.equal(res.body.signTemplate, '<dwz_title>|<dwz_type>|<dwz_url>|<api_key>|<api_secret>');
  assert.equal(
    res.body.canonicalExample,
    canonicalString({
      dwz_title: '标题',
      dwz_type: 'any',
      dwz_url: 'https://example.com/act',
      api_key: 'dwz_xxx',
      api_secret: '<你的 secret>',
    }),
  );
  const resources = res.body.resources.map((r) => r.resource);
  assert.deepEqual(resources, ['short-links', 'codes', 'channels']);
  assert.ok(res.body.actions.some((a) => a.action === 'stats'));
});

/* ---------------- 资源动作 ---------------- */

test('签名正确时可创建短链并跳转', async () => {
  const { apiKey, apiSecret } = await setup();
  const payload = await signed({ title: '开放接口', type: 'any', url: 'https://example.com/open' }, apiKey, apiSecret);

  const res = await post('/open/v1/short-links/create', payload);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.item.slug, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(res.body.shortUrl, `https://short.test/${res.body.item.slug}`);

  const redirect = await call(`/${res.body.item.slug}`);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'https://example.com/open');
});

test('创建活码返回专属落地页地址', async () => {
  const { apiKey, apiSecret } = await setup();
  const payload = await signed({ title: '群活码', url: 'https://example.com/group' }, apiKey, apiSecret);
  const res = await post('/open/v1/codes/create', payload);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.item.kind, 'group');
  assert.equal(res.body.url, `https://short.test/${res.body.item.slug}`);
});

test('自定义 slug 会被占用校验拦下', async () => {
  const { apiKey, apiSecret } = await setup();
  const first = await post(
    '/open/v1/short-links/create',
    await signed({ title: 'A', url: 'https://example.com/a' }, apiKey, apiSecret, { dv1_slug: 'open-a1' }),
  );
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await post(
    '/open/v1/codes/create',
    await signed({ title: 'B', url: 'https://example.com/b' }, apiKey, apiSecret, { dv1_slug: 'open-a1' }),
  );
  assert.equal(second.status, 400);
  assert.match(second.body.msg, /已被占用/);
});

test('列表与详情只返回凭证主人名下的资源', async () => {
  const { token, apiKey, apiSecret } = await setup();
  await post('/api/short-links', { title: '后台建的', targetUrl: 'https://example.com/admin' }, token);

  // 后台建的那条同样属于这个 user，所以它应当出现在开放接口的列表里 ——
  // 「开放接口看到的是本人名下资源」与后台的归属口径保持一致。
  const listed = await post(
    '/open/v1/short-links/list',
    await signed({}, apiKey, apiSecret, { dv1_page_size: 10 }),
  );
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.total, 1);
  assert.equal(listed.body.items[0].title, '后台建的');

  const created = await post(
    '/open/v1/short-links/create',
    await signed({ title: '接口建的', url: 'https://example.com/api' }, apiKey, apiSecret),
  );
  const detail = await post(
    '/open/v1/short-links/get',
    await signed({}, apiKey, apiSecret, { dv1_slug: created.body.item.slug }),
  );
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.item.title, '接口建的');
});

test('删除资源会同时归还 slug 命名空间', async () => {
  const { apiKey, apiSecret } = await setup();
  // 自定义 slug 才能构造「同一个 slug 先后被两类资源占用」的确定性场景
  const slug = 'open-reuse-1';
  const created = await post(
    '/open/v1/channels/create',
    await signed({ title: '渠道', type: 'wechat', url: 'https://example.com/ch' }, apiKey, apiSecret, { dv1_slug: slug }),
  );
  assert.equal(created.status, 200, JSON.stringify(created.body));

  // 未释放前不可复用
  const conflict = await post(
    '/open/v1/short-links/create',
    await signed({ title: '抢占', url: 'https://example.com/x' }, apiKey, apiSecret, { dv1_slug: slug }),
  );
  assert.equal(conflict.status, 400);
  assert.match(conflict.body.msg, /已被占用/);

  const removed = await post('/open/v1/channels/delete', await signed({}, apiKey, apiSecret, { dv1_slug: slug }));
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  // 归还之后同一个 slug 应该能被重新占用，否则命名空间只增不减
  const again = await post(
    '/open/v1/short-links/create',
    await signed({ title: '复用', url: 'https://example.com/reuse' }, apiKey, apiSecret, { dv1_slug: slug }),
  );
  assert.equal(again.status, 200, JSON.stringify(again.body));
});

test('渠道码不支持 wechat 以外的访问限制', async () => {
  const { apiKey, apiSecret } = await setup();
  const res = await post(
    '/open/v1/channels/create',
    await signed({ title: '渠道', type: 'ios', url: 'https://example.com/ch' }, apiKey, apiSecret),
  );
  assert.equal(res.status, 400);
  assert.match(res.body.msg, /any 或 wechat/);
});

/* ---------------- 访问分析 ---------------- */

test('统计接口给出小时分布、趋势与独立访客', async () => {
  const { token, apiKey, apiSecret } = await setup();
  const created = await post('/api/short-links', { title: 'mine', targetUrl: 'https://example.com/mine' }, token);
  const slug = created.body.item.slug;
  await call(`/${slug}`);
  await call(`/${slug}`);

  const res = await post(
    '/open/v1/stats',
    await signed({}, apiKey, apiSecret, { dv1_slug: slug, dv1_days: 7 }),
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.hits, 2);
  assert.equal(res.body.hourly.length, 24);
  assert.equal(res.body.daily.length, 7);
  assert.equal(res.body.visitors.visitorsToday, 1);
});

test('统计看不到别人名下的资源', async () => {
  const { token, apiKey, apiSecret } = await setup();
  await post('/api/short-links', { title: '后台建的', targetUrl: 'https://example.com/admin' }, token);
  const mine = await json('/api/short-links', { headers: { authorization: `Bearer ${token}` } });
  const slug = mine.body.items.find((item) => item.title === '后台建的').slug;

  // 同一账号：凭证与后台资源同属一个 user，应当可见
  const owned = await post('/open/v1/stats', await signed({}, apiKey, apiSecret, { dv1_slug: slug }));
  assert.equal(owned.status, 200);

  // 换个账号的凭证就看不到了 —— 权限按凭证主人的 user_id 收敛，
  // 与后台「成员只看自己的资源」是同一套口径。
  await post('/api/users', { username: 'mate', password: 'supersecret2', role: 'member' }, token);
  const mate = await post('/api/auth/login', { username: 'mate', password: 'supersecret2' });
  const other = await post('/api/credentials', {}, mate.body.token);
  const stranger = await post(
    '/open/v1/stats',
    await signed({}, other.body.item.apiKey, other.body.item.apiSecret, { dv1_slug: slug }),
  );
  assert.equal(stranger.status, 404, JSON.stringify(stranger.body));
});

/* ---------------- 鉴权边界 ---------------- */

test('签名错误被拒绝', async () => {
  const { apiKey } = await setup();
  const res = await post('/open/v1/short-links/create', {
    dv1_title: '伪造',
    dv1_type: 'any',
    dv1_url: 'https://example.com/fake',
    api_key: apiKey,
    sign: 'deadbeef',
  });
  assert.equal(res.status, 403);
  assert.match(res.body.msg, /签名/);
});

test('篡改任一签名字段都会导致校验失败', async () => {
  const { apiKey, apiSecret } = await setup();
  const good = await signed({ title: '原标题', type: 'any', url: 'https://example.com/orig' }, apiKey, apiSecret);

  for (const tampered of [
    { ...good, dv1_url: 'https://evil.test' },
    { ...good, dv1_title: '被改了' },
    { ...good, dv1_type: 'wechat' },
  ]) {
    const res = await post('/open/v1/short-links/create', tampered);
    assert.equal(res.status, 403, `篡改 ${JSON.stringify(tampered)} 应被拒绝`);
  }
});

test('未知 api_key 被拒绝', async () => {
  const res = await post('/open/v1/short-links/create', {
    dv1_title: 'x',
    dv1_url: 'https://example.com/x',
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

  const res = await post(
    '/open/v1/short-links/create',
    await signed({ title: 'x', url: 'https://example.com/x' }, apiKey, apiSecret),
  );
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

  const first = await post('/open/v1/short-links/create', await signed({ title: 'x', url: 'https://example.com/x' }, apiKey, apiSecret));
  assert.equal(first.status, 200);
  const second = await post('/open/v1/short-links/create', await signed({ title: 'x', url: 'https://example.com/x' }, apiKey, apiSecret));
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

  const res = await post(
    '/open/v1/short-links/create',
    await signed({ title: 'x', url: 'https://example.com/x' }, apiKey, apiSecret),
  );
  assert.equal(res.status, 403);
  assert.match(res.body.msg, /白名单/);
});

test('签名通过后字段缺失才算参数错误', async () => {
  const { apiKey, apiSecret } = await setup();
  const res = await post(
    '/open/v1/short-links/create',
    await signed({ title: '', url: 'https://example.com/x' }, apiKey, apiSecret),
  );
  assert.equal(res.status, 400);
  assert.match(res.body.msg, /标题/);
});

test('旧版路径给出可照做的提示', async () => {
  const res = await call('/open/v1/short-links');
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 400);
  assert.match(body.msg, /\/open\/v1/);
});

test('旧版 dwz_* 参数不再参与签名（版本已推进到 dv1_*）', async () => {
  const { apiKey, apiSecret } = await setup();
  // 旧调用方把标签写在 dwz_* 上：签名按新规则算，服务端签的是空串，必然不过
  const legacy = {
    dwz_title: '旧版',
    dwz_type: 'any',
    dwz_url: 'https://example.com/legacy',
    api_key: apiKey,
  };
  legacy.sign = await sign(
    { dwz_title: '旧版', dwz_type: 'any', dwz_url: 'https://example.com/legacy', api_key: apiKey, api_secret: apiSecret },
    apiSecret,
  );
  const res = await post('/open/v1/short-links/create', legacy);
  assert.equal(res.status, 403);
  assert.match(res.body.msg, /签名/);
});

test('签名 tag 传 null 与传空串等价', async () => {
  const { apiKey, apiSecret } = await setup();
  const payload = await signed({ title: '空标签', url: 'https://example.com/null' }, apiKey, apiSecret);
  payload.dv1_type = null;
  payload.dv1_title = null;
  // 重签：null 归一成空串
  payload.sign = await sign(
    { dwz_title: '', dwz_type: '', dwz_url: payload.dv1_url, api_key: apiKey, api_secret: apiSecret },
    apiSecret,
  );
  // 标题为空 → 签名先过（顺序可观测：错签名会拿到 403 而不是 400），
  // 再由字段校验拦下。
  const res = await post('/open/v1/short-links/create', payload);
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(res.body.msg, /标题|Invalid/);
});

/* ---------------- 凭证的到期与配额口径 ---------------- */

test('创建凭证默认给 90 天有效期，不再是永不过期', async () => {
  const reg = await post('/api/auth/register', { username: 'owner', password: 'supersecret1' });
  const before = Math.floor(Date.now() / 1000);
  const created = await post('/api/credentials', {}, reg.body.token);
  const expiresAt = created.body.item.expiresAt;

  assert.ok(expiresAt, '应带默认到期时间');
  const days = (expiresAt - before) / 86400;
  assert.ok(days > 89 && days < 91, `默认有效期应约 90 天，实际 ${days.toFixed(1)}`);
});

test('显式传 null 到期才是永不过期', async () => {
  const reg = await post('/api/auth/register', { username: 'owner', password: 'supersecret1' });
  const created = await post('/api/credentials', { expiresAt: null }, reg.body.token);
  assert.equal(created.body.item.expiresAt, null);
});

test('配额留空（null）= 不限额，可以一直调', async () => {
  const reg = await post('/api/auth/register', { username: 'owner', password: 'supersecret1' });
  const cred = await post('/api/credentials', { quota: null }, reg.body.token);
  const { apiKey, apiSecret } = cred.body.item;

  // 先打满一个「有限配额」会拦下的次数，确认不限额不会被拦
  const list = await json('/api/credentials', { headers: { authorization: `Bearer ${reg.body.token}` } });
  const row = list.body.items.find((item) => item.apiKey === apiKey);
  assert.equal(row.quota, null, '列表里配额应回传 null');

  for (let i = 0; i < 3; i += 1) {
    const res = await post(
      '/open/v1/short-links/create',
      await signed({ title: `不限-${i}`, url: `https://example.com/u${i}` }, apiKey, apiSecret),
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
});

test('默认创建即带配额，超限后拒绝', async () => {
  const reg = await post('/api/auth/register', { username: 'owner', password: 'supersecret1' });
  const cred = await post('/api/credentials', { quota: 1 }, reg.body.token);
  const { apiKey, apiSecret } = cred.body.item;

  const first = await post('/open/v1/short-links/create', await signed({ title: 'a', url: 'https://example.com/a' }, apiKey, apiSecret));
  assert.equal(first.status, 200);
  const second = await post('/open/v1/short-links/create', await signed({ title: 'b', url: 'https://example.com/b' }, apiKey, apiSecret));
  assert.equal(second.status, 403);
  assert.match(second.body.msg, /配额/);
});

test('配额非法值被拒（0 不是「不限」的表达方式）', async () => {
  const reg = await post('/api/auth/register', { username: 'owner', password: 'supersecret1' });
  const res = await post('/api/credentials', { quota: 0 }, reg.body.token);
  assert.equal(res.status, 400);
});

/* ---------------- 活码子码 ---------------- */

/** 建一个活码宿主，返回 slug。 */
async function newCode(apiKey, apiSecret, title = '群活码') {
  const res = await post(
    '/open/v1/codes/create',
    await signed({ title, url: 'https://example.com/fallback' }, apiKey, apiSecret),
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.item.slug;
}

test('子码：可以通过开放接口新增、列出、改动、删除', async () => {
  const { apiKey, apiSecret } = await setup();
  const slug = await newCode(apiKey, apiSecret);

  // 目录里要能看到这些动作，否则调用方根本不知道该往哪打
  const catalog = await json('/open/v1');
  const codes = catalog.body.resources.find((r) => r.resource === 'codes');
  const paths = codes.actions.map((a) => a.path);
  for (const name of ['create', 'update', 'delete', 'reset']) {
    assert.ok(paths.includes(`/open/v1/codes/qrcodes/${name}`), `目录应包含子码 ${name}`);
  }

  const created = await post(
    '/open/v1/codes/qrcodes/create',
    await signed({}, apiKey, apiSecret, {
      dv1_slug: slug,
      dv1_image_url: '/media/assets/202610/qr-1.png',
      dv1_contact: 'kefu001',
    }),
  );
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.item.index, 1, JSON.stringify(created.body));
  // 群活码不传阈值时的默认值与后台一致
  assert.equal(created.body.item.threshold, 200);
  assert.equal(created.body.code.slug, slug);

  const second = await post(
    '/open/v1/codes/qrcodes/create',
    await signed({}, apiKey, apiSecret, {
      dv1_slug: slug,
      dv1_image_url: 'https://cdn.example.com/qr-2.png',
      dv1_threshold: 50,
    }),
  );
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.item.index, 2);
  const secondId = second.body.item.id;

  const listed = await post('/open/v1/codes/qrcodes/list', await signed({}, apiKey, apiSecret, { dv1_slug: slug }));
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.total, 2);
  assert.deepEqual(listed.body.items.map((item) => item.index), [1, 2]);

  // 序号定位：改第 1 张
  const updated = await post(
    '/open/v1/codes/qrcodes/update',
    await signed({}, apiKey, apiSecret, { dv1_slug: slug, dv1_qrcode: 1, dv1_status: 'disabled', dv1_threshold: 9 }),
  );
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.item.status, 'disabled');
  assert.equal(updated.body.item.threshold, 9);

  // 空 patch 要被拦下，而不是静默成功
  const empty = await post(
    '/open/v1/codes/qrcodes/update',
    await signed({}, apiKey, apiSecret, { dv1_slug: slug, dv1_qrcode: 1 }),
  );
  assert.equal(empty.status, 400);

  const removed = await post(
    '/open/v1/codes/qrcodes/delete',
    await signed({}, apiKey, apiSecret, { dv1_slug: slug, dv1_qrcode: secondId }),
  );
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.deleted.id, secondId);
  assert.equal(removed.body.total, 1);

  const after = await post('/open/v1/codes/qrcodes/list', await signed({}, apiKey, apiSecret, { dv1_slug: slug }));
  assert.equal(after.body.total, 1);
  assert.equal(after.body.items[0].id !== secondId, true);
});

test('子码：落地页真的用上了接口加的二维码', async () => {
  const { token, apiKey, apiSecret } = await setup();
  // 走后台建宿主 + 传图，确认与开放接口加的子码是同一份数据
  const created = await post('/api/codes', { kind: 'group', title: '落地页用', pickMode: 'threshold' }, token);
  const codeId = created.body.item.id;
  const slug = created.body.item.slug;

  const added = await post(
    '/open/v1/codes/qrcodes/create',
    await signed({}, apiKey, apiSecret, { dv1_slug: slug, dv1_image_url: '/media/assets/202610/live.png' }),
  );
  assert.equal(added.status, 200, JSON.stringify(added.body));

  const page = await call(`/${slug}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /live\.png/);

  // 删掉之后落地页就没有可用子码了
  await post(
    '/open/v1/codes/qrcodes/delete',
    await signed({}, apiKey, apiSecret, { dv1_slug: slug, dv1_qrcode: added.body.item.id }),
  );
  assert.equal((await call(`/${slug}`)).status, 200);
  assert.equal(codeId, created.body.item.id);
});

test('子码：禁用后不再被访客选中，计数可重置', async () => {
  const { token, apiKey, apiSecret } = await setup();
  const created = await post('/api/codes', { kind: 'group', title: '阈值轮换', pickMode: 'threshold' }, token);
  const slug = created.body.item.slug;

  const first = await post(
    '/open/v1/codes/qrcodes/create',
    await signed({}, apiKey, apiSecret, { dv1_slug: slug, dv1_image_url: '/media/one.png' }),
  );
  const second = await post(
    '/open/v1/codes/qrcodes/create',
    await signed({}, apiKey, apiSecret, { dv1_slug: slug, dv1_image_url: '/media/two.png' }),
  );

  // 第一张禁用后，访客应该落到第二张
  await post(
    '/open/v1/codes/qrcodes/update',
    await signed({}, apiKey, apiSecret, {
      dv1_slug: slug,
      dv1_qrcode: first.body.item.id,
      dv1_status: 'disabled',
    }),
  );
  const page = await call(`/${slug}`);
  const html = await page.text();
  assert.match(html, /two\.png/);
  assert.doesNotMatch(html, /one\.png/);

  // 手写一次计数，再用 reset 清掉
  env.DB.raw.prepare('UPDATE code_qrcodes SET hits = 7 WHERE id = ?').run(second.body.item.id);
  const reset = await post(
    '/open/v1/codes/qrcodes/reset',
    await signed({}, apiKey, apiSecret, { dv1_slug: slug, dv1_qrcode: second.body.item.id }),
  );
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal(reset.body.item.hits, 0);
});

test('子码：别人的活码动不了，缺参数时报得清楚', async () => {
  const { token, apiKey, apiSecret } = await setup();
  const slug = await newCode(apiKey, apiSecret, '我的');

  // 另一个账号建的活码：注册口已收口，得由 owner 带 token 建号
  const other = await post(
    '/api/auth/register',
    { username: 'other', password: 'supersecret1' },
    token,
  );
  assert.equal(other.status, 200, JSON.stringify(other.body));
  const otherCode = await post('/api/codes', { kind: 'group', title: '别人的' }, other.body.token);
  const otherSlug = otherCode.body.item.slug;

  const foreign = await post(
    '/open/v1/codes/qrcodes/create',
    await signed({}, apiKey, apiSecret, { dv1_slug: otherSlug, dv1_image_url: '/media/x.png' }),
  );
  assert.equal(foreign.status, 404);
  assert.match(foreign.body.msg, /活码不存在/);

  const missingImage = await post(
    '/open/v1/codes/qrcodes/create',
    await signed({}, apiKey, apiSecret, { dv1_slug: slug }),
  );
  assert.equal(missingImage.status, 400);
  assert.match(missingImage.body.msg, /dv1_image_url/);

  const missingRef = await post(
    '/open/v1/codes/qrcodes/delete',
    await signed({}, apiKey, apiSecret, { dv1_slug: slug }),
  );
  assert.equal(missingRef.status, 400);
  assert.match(missingRef.body.msg, /dv1_qrcode/);

  const outOfRange = await post(
    '/open/v1/codes/qrcodes/delete',
    await signed({}, apiKey, apiSecret, { dv1_slug: slug, dv1_qrcode: 99 }),
  );
  assert.equal(outOfRange.status, 404);

  // 非法图片地址（协议不对）也要在签名之后被字段校验拦下
  const badImage = await post(
    '/open/v1/codes/qrcodes/create',
    await signed({}, apiKey, apiSecret, { dv1_slug: slug, dv1_image_url: 'javascript:alert(1)' }),
  );
  assert.equal(badImage.status, 400);
  // 站内相对地址必须允许，素材库给的就是这种
  const relative = await post(
    '/open/v1/codes/qrcodes/create',
    await signed({}, apiKey, apiSecret, { dv1_slug: slug, dv1_image_url: '/media/ok.png' }),
  );
  assert.equal(relative.status, 200, JSON.stringify(relative.body));
});
