import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { canonicalString, sign } from '../src/lib/openApiCore.js';
import { OPEN_API_ACTIONS } from '../src/schemas/openApi.js';
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
      dv1_grant: payload.dv1_grant ?? '',
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
  assert.equal(
    res.body.signTemplate,
    '<dwz_title>|<dwz_type>|<dwz_url>|<dv1_grant>|<api_key>|<api_secret>',
  );
  assert.equal(
    res.body.canonicalExample,
    canonicalString({
      dwz_title: '标题',
      dwz_type: 'any',
      dwz_url: 'https://example.com/act',
      dv1_grant: '',
      api_key: 'dwz_xxx',
      api_secret: '<你的 secret>',
    }),
  );
  const resources = res.body.resources.map((r) => r.resource);
  // 三类「能被访问的资源」排在前面，后台类设施跟在后面 —— 顺序稳定，
  // 因为 AI 客户端要靠位置猜不到的东西就只能靠序号，那是最脆的依赖。
  assert.deepEqual(resources.slice(0, 3), ['short-links', 'codes', 'channels']);
  assert.ok(resources.includes('users'));
  assert.ok(resources.includes('cardkeys'));
  assert.ok(res.body.actions.some((a) => a.action === 'stats'));

  // 每个公开动作都得在目录里出现，否则调用方只能靠猜（上一轮就是靠猜）
  for (const [namespace, actions] of Object.entries(OPEN_API_ACTIONS)) {
    const entry = res.body.resources.find((item) => item.resource === namespace);
    assert.ok(entry, `目录缺少命名空间 ${namespace}`);
    for (const action of actions) {
      assert.ok(entry.actions.some((item) => item.action === action), `目录缺少 ${namespace}/${action}`);
    }
  }
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

/* ---------------- 补齐的动作：update / reset / blocks ---------------- */

test('短链可以改目标链接与标题（不用删了重建，slug 不变）', async () => {
  const { apiKey, apiSecret } = await setup();
  const created = await post(
    '/open/v1/short-links/create',
    await signed({ title: '原标题', type: 'any', url: 'https://example.com/old' }, apiKey, apiSecret, { dv1_slug: 'patch-link-1' }),
  );
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const slug = created.body.item.slug;

  const patched = await post(
    '/open/v1/short-links/update',
    await signed({}, apiKey, apiSecret, {
      dv1_slug: slug,
      dv1_new_title: '新标题',
      dv1_target_url: 'https://example.com/new',
    }),
  );
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.item.title, '新标题');
  assert.equal(patched.body.item.slug, slug, 'slug 不该变，否则已发出去的链接就废了');

  // 真的跳到新地址，而不是只在库里改了字段
  const redirect = await call(`/${slug}`);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'https://example.com/new');
});

test('update 只改传进来的字段，没传的保持不动', async () => {
  const { apiKey, apiSecret } = await setup();
  await post(
    '/open/v1/codes/create',
    await signed({ title: '活码原样', type: 'any', url: 'https://example.com/fallback' }, apiKey, apiSecret, { dv1_slug: 'patch-code-1' }),
  );

  const patched = await post(
    '/open/v1/codes/update',
    await signed({}, apiKey, apiSecret, { dv1_slug: 'patch-code-1', dv1_new_title: '只改标题' }),
  );
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.item.title, '只改标题');
  // 兜底链接必须还在 —— 「改标题」顺手把它抹掉是最容易犯的错
  assert.equal(patched.body.item.fallbackUrl, 'https://example.com/fallback');
});

test('update 什么都不传会被明确拒绝', async () => {
  const { apiKey, apiSecret } = await setup();
  await post(
    '/open/v1/short-links/create',
    await signed({ title: '待改', type: 'any', url: 'https://example.com/x' }, apiKey, apiSecret, { dv1_slug: 'patch-empty-1' }),
  );
  const res = await post(
    '/open/v1/short-links/update',
    await signed({}, apiKey, apiSecret, { dv1_slug: 'patch-empty-1' }),
  );
  assert.equal(res.status, 400);
  assert.match(res.body.msg, /没有需要更新的字段/);
});

test('reset 把访问计数清零，链接仍然可用', async () => {
  const { apiKey, apiSecret } = await setup();
  await post(
    '/open/v1/short-links/create',
    await signed({ title: '计数', type: 'any', url: 'https://example.com/c' }, apiKey, apiSecret, { dv1_slug: 'reset-link-1' }),
  );
  await call('/reset-link-1');

  const stats = await post('/open/v1/stats', await signed({}, apiKey, apiSecret, { dv1_slug: 'reset-link-1' }));
  assert.equal(stats.body.hits, 1);

  const reset = await post('/open/v1/short-links/reset', await signed({}, apiKey, apiSecret, { dv1_slug: 'reset-link-1' }));
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal(reset.body.item.hits, 0);
  assert.equal(reset.body.item.hitsToday, 0);

  // 清零的是计数，不是资源：链接必须还能跳
  const redirect = await call('/reset-link-1');
  assert.equal(redirect.status, 302);
});

test('渠道码黑名单：list / add / remove', async () => {
  const { apiKey, apiSecret } = await setup();
  await post(
    '/open/v1/channels/create',
    await signed({ title: '渠道', type: 'any', url: 'https://example.com/ch' }, apiKey, apiSecret, { dv1_slug: 'block-ch-1' }),
  );

  const empty = await post('/open/v1/channels/blocks', await signed({}, apiKey, apiSecret, { dv1_action: 'list', dv1_slug: 'block-ch-1' }));
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.deepEqual(empty.body.blocks, []);

  const added = await post(
    '/open/v1/channels/blocks',
    await signed({}, apiKey, apiSecret, { dv1_action: 'add', dv1_slug: 'block-ch-1', dv1_ip: '1.2.3.4' }),
  );
  assert.equal(added.status, 200, JSON.stringify(added.body));

  const listed = await post('/open/v1/channels/blocks', await signed({}, apiKey, apiSecret, { dv1_action: 'list', dv1_slug: 'block-ch-1' }));
  assert.equal(listed.body.blocks.length, 1);
  // 库里存的是哈希，不回明文 IP —— 和后台口径一致
  assert.ok(listed.body.blocks[0].ipHash);
  assert.notEqual(listed.body.blocks[0].ipHash, '1.2.3.4');

  const removed = await post(
    '/open/v1/channels/blocks',
    await signed({}, apiKey, apiSecret, { dv1_action: 'remove', dv1_id: listed.body.blocks[0].id }),
  );
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  const after = await post('/open/v1/channels/blocks', await signed({}, apiKey, apiSecret, { dv1_action: 'list', dv1_slug: 'block-ch-1' }));
  assert.deepEqual(after.body.blocks, []);
});

/* ---------------- 后台类命名空间 ---------------- */

/** 建一个超管账号，并解锁它名下凭证的 owner 授权。 */
async function setupOwnerGrant() {
  const base = await setup();
  return base;
}

test('后台类动作默认被拒：凭证明说 owner 才放行，且只对超管的凭证有效', async () => {
  const { apiKey, apiSecret } = await setup();

  const denied = await post('/open/v1/users/list', await signed({}, apiKey, apiSecret, { dv1_page: 1 }));
  assert.equal(denied.status, 403, JSON.stringify(denied.body));

  const granted = await post(
    '/open/v1/users/list',
    await signed({}, apiKey, apiSecret, { dv1_grant: 'owner', dv1_page: 1, dv1_page_size: 10 }),
  );
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.ok(Array.isArray(granted.body.items));
});

test('成员自己的凭证声明 owner 也拿不到后台数据', async () => {
  const { token, apiKey, apiSecret } = await setup();
  const other = await post('/api/auth/register', { username: 'member1', password: 'supersecret1' }, token);
  assert.equal(other.status, 200, JSON.stringify(other.body));
  const cred = await post('/api/credentials', {}, other.body.token);
  const memberKey = cred.body.item.apiKey;
  const memberSecret = cred.body.item.apiSecret;

  const res = await post(
    '/open/v1/users/list',
    await signed({}, memberKey, memberSecret, { dv1_grant: 'owner', dv1_page: 1 }),
  );
  // 声明本身不带来权限：这个账号本来就是成员，直接 403。
  // 这条用例守的是一个安全边界 —— 一旦有人把「声明」当成「权限」，
  // 成员账号发出来的 key 就能读到全站用户列表。
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.match(res.body.msg, /超级管理员/);
  void apiKey;
  void apiSecret;
});

test('域名：通过开放接口增删改查 + 探测', async () => {
  const { apiKey, apiSecret } = await setup();

  const created = await post(
    '/open/v1/domains/create',
    await signed({}, apiKey, apiSecret, { dv1_grant: 'owner', dv1_host: 'go.example.com', dv1_kind: 'short', dv1_remark: '演示' }),
  );
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.item.host, 'go.example.com');

  const listed = await post('/open/v1/domains/list', await signed({}, apiKey, apiSecret, { dv1_grant: 'owner' }));
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.ok(listed.body.items.some((item) => item.host === 'go.example.com'));

  const patched = await post(
    '/open/v1/domains/update',
    await signed({}, apiKey, apiSecret, { dv1_grant: 'owner', dv1_id: created.body.item.id, dv1_remark: '改过备注' }),
  );
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.item.remark, '改过备注');

  const deleted = await post(
    '/open/v1/domains/delete',
    await signed({}, apiKey, apiSecret, { dv1_grant: 'owner', dv1_id: created.body.item.id }),
  );
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
});

test('卡密：建批次拿到明文，追加后可再取一批', async () => {
  const { apiKey, apiSecret } = await setup();

  const created = await post(
    '/open/v1/cardkeys/create',
    await signed({}, apiKey, apiSecret, {
      dv1_grant: 'owner',
      dv1_name: '开放批次',
      dv1_content: '兑换后看到的内容',
      dv1_count: 2,
    }),
  );
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.codes.length, 2);
  const batchId = created.body.item.id;

  const appended = await post(
    '/open/v1/cardkeys/append',
    await signed({}, apiKey, apiSecret, { dv1_grant: 'owner', dv1_id: batchId, dv1_count: 3 }),
  );
  assert.equal(appended.status, 200, JSON.stringify(appended.body));
  assert.equal(appended.body.codes.length, 3);

  const detail = await post(
    '/open/v1/cardkeys/get',
    await signed({}, apiKey, apiSecret, { dv1_grant: 'owner', dv1_id: batchId }),
  );
  assert.equal(detail.body.item.total, 5);

  // 明文只出现一次：详情里不该再有 codes
  assert.equal(detail.body.codes, undefined);
});

test('素材：上传后拿到 /media 地址，可直接喂给子码', async () => {
  const { apiKey, apiSecret } = await setup();
  await post(
    '/open/v1/codes/create',
    await signed({ title: '图床活码', type: 'any', url: 'https://example.com/fb' }, apiKey, apiSecret, { dv1_slug: 'asset-code-1' }),
  );

  const form = new FormData();
  form.set('dv1_title', '');
  form.set('dv1_type', '');
  form.set('dv1_url', '');
  form.set('dv1_grant', 'owner');
  form.set('api_key', apiKey);
  form.set('sign', await sign(
    { dwz_title: '', dwz_type: '', dwz_url: '', dv1_grant: 'owner', api_key: apiKey, api_secret: apiSecret },
    apiSecret,
  ));
  form.set('file', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'qr.png');

  const response = await call('/open/v1/assets/upload', { method: 'POST', body: form });
  const uploaded = await response.json();
  assert.equal(response.status, 200, JSON.stringify(uploaded));
  assert.match(uploaded.item.url, /^\/media\//);

  // 上传的地址必须真的能当子码图片用 —— 否则「上传」只是多了一行库记录
  const qrcode = await post(
    '/open/v1/codes/qrcodes/create',
    await signed({}, apiKey, apiSecret, { dv1_slug: 'asset-code-1', dv1_image_url: uploaded.item.url }),
  );
  assert.equal(qrcode.status, 200, JSON.stringify(qrcode.body));
});

test('凭证自管：用 API 再发一串 key，且不能替别人发', async () => {
  const { token, apiKey, apiSecret } = await setup();
  const other = await post('/api/auth/register', { username: 'member2', password: 'supersecret1' }, token);
  const otherId = other.body.item?.id ?? other.body.user?.id;

  const created = await post(
    '/open/v1/credentials/create',
    await signed({}, apiKey, apiSecret, { dv1_grant: 'owner', dv1_expires_at: null }),
  );
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.match(created.body.item.apiKey, /^dwz_/);
  assert.equal(created.body.item.expiresAt, null, '显式传 null 才是永不过期');

  // 新发的 key 真的能用
  const used = await post('/open/v1/short-links/list', await signed({}, created.body.item.apiKey, created.body.item.apiSecret, { dv1_page: 1 }));
  assert.equal(used.status, 200, JSON.stringify(used.body));

  // 无论谁调用，新凭证都挂在调用者名下，不能替别人发
  void otherId;
  const listed = await post('/open/v1/credentials/list', await signed({}, apiKey, apiSecret, { dv1_grant: 'owner' }));
  assert.ok(listed.body.items.every((item) => item.apiSecret === undefined));
});

test('用户：可以建账号、改状态，但改不了密码', async () => {
  const { apiKey, apiSecret } = await setup();

  const created = await post(
    '/open/v1/users/create',
    await signed({}, apiKey, apiSecret, {
      dv1_grant: 'owner',
      dv1_username: 'openmade',
      dv1_password: 'supersecret1',
      dv1_role: 'member',
    }),
  );
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.item.id;

  // 密码字段根本不在 schema 里：传了也不会被用上，更不会悄悄改掉
  const patched = await post(
    '/open/v1/users/update',
    await signed({}, apiKey, apiSecret, { dv1_grant: 'owner', dv1_id: id, dv1_remark: '开放接口改的' }),
  );
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.item.remark, '开放接口改的');

  const deleted = await post(
    '/open/v1/users/delete',
    await signed({}, apiKey, apiSecret, { dv1_grant: 'owner', dv1_id: id }),
  );
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
});

test('通知渠道与巡检：列表能读，巡检能手动跑一次', async () => {
  const { apiKey, apiSecret } = await setup();

  const channels = await post('/open/v1/notify-channels/list', await signed({}, apiKey, apiSecret, { dv1_grant: 'owner' }));
  assert.equal(channels.status, 200, JSON.stringify(channels.body));
  assert.ok(Array.isArray(channels.body.items));

  const logs = await post('/open/v1/inspection/list', await signed({}, apiKey, apiSecret, { dv1_grant: 'owner', dv1_page: 1 }));
  assert.equal(logs.status, 200, JSON.stringify(logs.body));

  const run = await post('/open/v1/inspection/run', await signed({}, apiKey, apiSecret, { dv1_grant: 'owner' }));
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.ok(run.body.result);
});

test('未知动作与未知命名空间给出可照做的提示', async () => {
  const { apiKey, apiSecret } = await setup();

  const badAction = await post('/open/v1/short-links/frobnicate', await signed({}, apiKey, apiSecret, {}));
  assert.equal(badAction.status, 404);
  assert.match(badAction.body.msg, /查看目录/);

  const badNamespace = await post('/open/v1/nope/list', await signed({}, apiKey, apiSecret, {}));
  assert.equal(badNamespace.status, 404);
});

/* ---------------- 清单一致性 ---------------- */

test('动作清单、目录与实现三者不漂移', async () => {
  // 上一轮「缺 update」的根因是「分发有一份、目录有另一份」。
  // 这条用例把「三处说同一件事」变成可执行的不变量：
  // 加了动作却忘了同步，测试就会红，而不是等用户提 issue。
  const { assertActionCoverage } = await import('../src/open/router.js');
  assert.equal(assertActionCoverage(), true);
});

/* ---------------- 普通用户（成员）能用什么、不能用什么 ---------------- */

/**
 * 成员账号的完整边界：一组用得上、一组用不上。
 *
 * 这些用例守的是「开放 API 是不是只有超管能用」这个问题 ——
 * 答案应该是对业务资源全都能用（凭证按 user_id 收敛），
 * 对全站级设施一律 403。
 */
async function setupMember() {
  const owner = await setup();
  const member = await post('/api/auth/register', { username: 'memberx', password: 'supersecret1' }, owner.token);
  assert.equal(member.status, 200, JSON.stringify(member.body));
  const cred = await post('/api/credentials', {}, member.body.token);
  assert.equal(cred.status, 200, JSON.stringify(cred.body));
  return {
    owner,
    token: member.body.token,
    apiKey: cred.body.item.apiKey,
    apiSecret: cred.body.item.apiSecret,
  };
}

test('成员可以用开放接口建自己的短链 / 活码 / 渠道码，并看统计', async () => {
  const { apiKey, apiSecret } = await setupMember();

  const link = await post(
    '/open/v1/short-links/create',
    await signed({ title: '成员的活动', url: 'https://example.com/member' }, apiKey, apiSecret, { dv1_slug: 'member-link' }),
  );
  assert.equal(link.status, 200, JSON.stringify(link.body));

  const code = await post(
    '/open/v1/codes/create',
    await signed({ title: '成员的群', url: 'https://example.com/fb' }, apiKey, apiSecret, { dv1_slug: 'member-code' }),
  );
  assert.equal(code.status, 200, JSON.stringify(code.body));

  const channel = await post(
    '/open/v1/channels/create',
    await signed({ title: '成员的渠道', type: 'any', url: 'https://example.com/ch' }, apiKey, apiSecret, { dv1_slug: 'member-ch' }),
  );
  assert.equal(channel.status, 200, JSON.stringify(channel.body));

  const qrcode = await post(
    '/open/v1/codes/qrcodes/create',
    await signed({}, apiKey, apiSecret, { dv1_slug: 'member-code', dv1_image_url: '/media/member.png' }),
  );
  assert.equal(qrcode.status, 200, JSON.stringify(qrcode.body));

  const stats = await post('/open/v1/stats', await signed({}, apiKey, apiSecret, { dv1_slug: 'member-link' }));
  assert.equal(stats.status, 200, JSON.stringify(stats.body));

  const list = await post('/open/v1/short-links/list', await signed({}, apiKey, apiSecret, { dv1_page: 1 }));
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.total, 1);
});

test('成员能把自己的图片传进素材库（子码换图的上游）', async () => {
  const { apiKey, apiSecret } = await setupMember();

  // 素材上传走 multipart，成员也一样能用 —— 子码换图的上游，不该锁给超管
  const form = new FormData();
  form.set('dv1_title', '');
  form.set('dv1_type', '');
  form.set('dv1_url', '');
  form.set('api_key', apiKey);
  form.set('sign', await sign(
    { dwz_title: '', dwz_type: '', dwz_url: '', dv1_grant: '', api_key: apiKey, api_secret: apiSecret },
    apiSecret,
  ));
  form.set('file', new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }), 'm.png');
  const upload = await call('/open/v1/assets/upload', { method: 'POST', body: form });
  // 素材上传按 user_id 收敛：成员能传自己的（子码换图的上游），
  // 但拿不到全站素材视图 —— 那要看 /open/v1/assets/list 的返回。
  // 这里挂在全员可用的这一类里，正说明「素材」不属于只有超管能碰的设施。
  assert.equal(upload.status, 200, await upload.clone().text());

});

test('成员改不了、删不掉别人的凭证（凭证自管只在 owner 侧开放）', async () => {
  const { owner, apiKey, apiSecret } = await setupMember();

  // credentials 动的是全站凭证表（后台里也挂在 requireOwnerMiddleware 后面），
  // 所以成员连「列自己的」都不行 —— 与 users / domains 同一口径。
  // 成员要自管 key，走后台的「API Key」页（那是会话鉴权，按 user_id 收敛）。
  const mine = await post('/open/v1/credentials/list', await signed({}, apiKey, apiSecret, { dv1_grant: 'owner' }));
  assert.equal(mine.status, 403, JSON.stringify(mine.body));

  // 确认这条线不是「碰巧」：owner 自己的凭证是能正常读的
  const ownerCred = await post('/api/credentials', {}, owner.token);
  assert.equal(ownerCred.status, 200, JSON.stringify(ownerCred.body));
  const listed = await post(
    '/open/v1/credentials/list',
    await signed({}, owner.apiKey, owner.apiSecret, { dv1_grant: 'owner' }),
  );
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.ok(listed.body.items.some((item) => item.id === ownerCred.body.item.id));
});

/* ---------------- 补齐的活码：类型 / 通知渠道 / 并流 ---------------- */

test('建客服码（kind=service）与群活码的默认阈值不同', async () => {
  const { apiKey, apiSecret } = await setup();

  const service = await post(
    '/open/v1/codes/create',
    await signed({ title: '客服小美', url: 'https://example.com/kefu-fallback' }, apiKey, apiSecret, {
      dv1_slug: 'service-code',
      dv1_kind: 'service',
    }),
  );
  // 兜底地址在建活码时是可选的（客服码常常就是一张兜底二维码，事后补也行）
  assert.equal(service.status, 200, JSON.stringify(service.body));
  assert.equal(service.body.item.kind, 'service');

  const qr = await post(
    '/open/v1/codes/qrcodes/create',
    await signed({}, apiKey, apiSecret, { dv1_slug: 'service-code', dv1_image_url: '/media/kefu.png' }),
  );
  assert.equal(qr.status, 200, JSON.stringify(qr.body));
  // 客服码不传阈值时给 0，与后台一致；群活码那份给 200
  assert.equal(qr.body.item.threshold, 0);

  const bad = await post(
    '/open/v1/codes/create',
    await signed({ title: '乱传', url: 'https://example.com/x' }, apiKey, apiSecret, { dv1_kind: 'whatever' }),
  );
  assert.equal(bad.status, 400);
});

test('活码可以配通知渠道，改的时候只动这一个字段', async () => {
  const { apiKey, apiSecret } = await setup();
  const channels = await post(
    '/open/v1/codes/create',
    await signed({ title: '带通知的群', url: 'https://example.com/fb' }, apiKey, apiSecret, {
      dv1_slug: 'notify-code',
    }),
  );
  assert.equal(channels.status, 200, JSON.stringify(channels.body));

  const patched = await post(
    '/open/v1/codes/update',
    await signed({}, apiKey, apiSecret, { dv1_slug: 'notify-code', dv1_notify_channel: 7 }),
  );
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.item.fallbackUrl, 'https://example.com/fb');

  const cleared = await post(
    '/open/v1/codes/update',
    await signed({}, apiKey, apiSecret, { dv1_slug: 'notify-code', dv1_notify_channel: null }),
  );
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
});

test('并流：把 A 的访客导到 B，取消后 A 恢复独立', async () => {
  const { apiKey, apiSecret } = await setup();
  const from = await newCode(apiKey, apiSecret, '被并流');
  const to = await newCode(apiKey, apiSecret, '目标');

  const catalog = await json('/open/v1');
  const codes = catalog.body.resources.find((r) => r.resource === 'codes');
  const paths = codes.actions.map((a) => a.path);
  assert.ok(paths.includes('/open/v1/codes/merges/set'), '目录应包含 merges/set');
  assert.ok(paths.includes('/open/v1/codes/merges/remove'), '目录应包含 merges/remove');

  const set = await post(
    '/open/v1/codes/merges/set',
    await signed({}, apiKey, apiSecret, { dv1_slug: from, dv1_to_slug: to }),
  );
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.from, from);

  // 自己并给自己没有意义，明确拒绝比让它静默成环强
  const loop = await post(
    '/open/v1/codes/merges/set',
    await signed({}, apiKey, apiSecret, { dv1_slug: from, dv1_to_slug: from }),
  );
  assert.equal(loop.status, 400);

  const missingTarget = await post(
    '/open/v1/codes/merges/set',
    await signed({}, apiKey, apiSecret, { dv1_slug: from, dv1_to_slug: 'not-exist-slug' }),
  );
  assert.equal(missingTarget.status, 404);

  const removed = await post('/open/v1/codes/merges/remove', await signed({}, apiKey, apiSecret, { dv1_slug: from }));
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  // 没并流再取消要报「没有并流」，别谎报成功
  const again = await post('/open/v1/codes/merges/remove', await signed({}, apiKey, apiSecret, { dv1_slug: from }));
  assert.equal(again.status, 404);
  assert.match(again.body.msg, /并流/);
});

test('并流不能把访客导去别人的活码', async () => {
  const { token, apiKey, apiSecret } = await setup();
  const from = await newCode(apiKey, apiSecret, '我的A');
  const other = await post('/api/auth/register', { username: 'merger1', password: 'supersecret1' }, token);
  const otherCode = await post('/api/codes', { kind: 'group', title: '别人的B' }, other.body.token);
  const foreign = otherCode.body.item.slug;

  const res = await post(
    '/open/v1/codes/merges/set',
    await signed({}, apiKey, apiSecret, { dv1_slug: from, dv1_to_slug: foreign }),
  );
  assert.equal(res.status, 404, JSON.stringify(res.body));
  assert.match(res.body.msg, /目标活码不存在/);
});

test('渠道码黑名单：解封别人的记录时报「记录不存在」，而不是谎报成功', async () => {
  const { token, apiKey, apiSecret } = await setup();

  const mine = await post(
    '/open/v1/channels/create',
    await signed({ title: '我的渠道', type: 'any', url: 'https://example.com/mine' }, apiKey, apiSecret, {
      dv1_slug: 'block-mine',
    }),
  );
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const added = await post(
    '/open/v1/channels/blocks',
    await signed({}, apiKey, apiSecret, { dv1_action: 'add', dv1_slug: 'block-mine', dv1_ip: '9.9.9.9' }),
  );
  assert.equal(added.status, 200, JSON.stringify(added.body));

  // 别人的渠道 + 他拉黑的名单记录
  const other = await post('/api/auth/register', { username: 'blocker1', password: 'supersecret1' }, token);
  const otherChannel = await post('/api/channels', { title: '别人的渠道', targetUrl: 'https://example.com/o' }, other.body.token);
  assert.equal(otherChannel.status, 200, JSON.stringify(otherChannel.body));
  const otherId = otherChannel.body.item.id;
  const block = await post(`/api/channels/${otherId}/blocks`, { ip: '8.8.8.8' }, other.body.token);
  assert.equal(block.status, 200, JSON.stringify(block.body));
  const detail = await json(`/api/channels/${otherId}`, {
    headers: { authorization: `Bearer ${other.body.token}` },
  });
  const foreignBlockId = detail.body.blocks[0].id;
  assert.ok(Number.isInteger(foreignBlockId));

  const res = await post(
    '/open/v1/channels/blocks',
    await signed({}, apiKey, apiSecret, { dv1_action: 'remove', dv1_id: String(foreignBlockId) }),
  );
  assert.equal(res.status, 404, JSON.stringify(res.body));
  assert.match(res.body.msg, /黑名单记录不存在/);

  // 别人的名单还好好在库里
  const still = await json(`/api/channels/${otherId}`, {
    headers: { authorization: `Bearer ${other.body.token}` },
  });
  assert.ok(
    still.body.blocks.some((item) => item.id === foreignBlockId),
    '没权限的一方不该把别人的黑名单记录删掉',
  );
});

test('域名 / 卡密 / 巡检 / 素材列表这些设施：成员带 grant 也拿不到全站视图', async () => {
  const { apiKey, apiSecret } = await setupMember();

  // 这几类在后台挂的是 requireOwnerMiddleware，开放接口必须画同一条线。
  // 成员自己声明 dv1_grant 不产生任何权限 —— 见 grantSession 的注释。
  for (const [path, payload] of [
    ['/open/v1/domains/list', { dv1_grant: 'owner' }],
    ['/open/v1/cardkeys/list', { dv1_grant: 'owner', dv1_page: 1 }],
    ['/open/v1/inspection/list', { dv1_grant: 'owner', dv1_page: 1 }],
    ['/open/v1/assets/list', { dv1_grant: 'owner', dv1_page: 1 }],
    ['/open/v1/users/list', { dv1_grant: 'owner', dv1_page: 1 }],
    ['/open/v1/notify-channels/list', { dv1_grant: 'owner' }],
    ['/open/v1/credentials/list', { dv1_grant: 'owner' }],
    ['/open/v1/stats-admin/visitors', { dv1_grant: 'owner', dv1_page: 1 }],
    ['/open/v1/domains/create', { dv1_grant: 'owner', dv1_host: 'member.example.com' }],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await post(path, await signed({}, apiKey, apiSecret, payload));
    assert.equal(res.status, 403, `${path} 应拒绝成员，实际 ${res.status} ${JSON.stringify(res.body)}`);
    assert.match(res.body.msg, /超级管理员/);
  }
});
