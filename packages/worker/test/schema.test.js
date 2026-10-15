import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import * as S from '../src/schemas/index.js';

/**
 * schema 单测。
 *
 * 这里守的是一条真机上踩过的坑：**D1 的 bind() 不接受 undefined**
 * （会抛 D1_TYPE_ERROR），而 zod 的 `.optional()` 在字段缺省时正是产出 undefined。
 * 本地的 DB 替身会把 undefined 归一成 null，所以集成测试测不出来 ——
 * 必须在这一层直接钉住「create 场景的可选字段一律归一到 null」。
 */

/** create 类 schema 及其最小合法输入。 */
const CREATE_CASES = [
  ['createShortLinkSchema', { title: 't', targetUrl: 'https://a.com' }],
  ['createCodeSchema', { kind: 'group', title: 't' }],
  ['createChannelSchema', { title: 't', targetUrl: 'https://a.com' }],
  ['createDomainSchema', { host: 'a.com', kind: 'entry' }],
  ['createNotifyChannelSchema', { name: 'n', kind: 'webhook', config: { url: 'https://h.cn' } }],
  ['createBatchSchema', { name: 'b', content: 'c' }],
  ['createCredentialSchema', {}],
  ['createUserSchema', { username: 'abc', password: '12345678' }],
  ['createGroupSchema', { name: 'g' }],
  ['registerSchema', { username: 'abc', password: '12345678' }],
  ['addQrcodeSchema', { imageUrl: 'https://a.com/q.png' }],
];

/**
 * 允许缺省不产生的键。
 *
 * 这些键的消费者自己处理了 undefined：
 *   - slug：resolveSlug 见 undefined 就走 UUID 自动生成
 *   - threshold：handler 内部按活码类型给默认值
 *   - expiredAt/expiresAt：parseTimestamp(undefined) → null
 *   - codeList/codes：parseProvidedCodes(undefined) → []
 *   - quota*：用户组配额缺省表示「不改这一项」，createGroup 只在传了才写列，
 *     未写到的列由库结构落 NULL（= 不限）—— 若在这里补默认值，
 *     反而会把「更新时不改配额」和「创建时默认不限」压成同一个语义。
 */
const ALLOWED_MISSING = new Set([
  'slug',
  'threshold',
  'expiredAt',
  'expiresAt',
  'codeList',
  'codes',
  'quotaShortLinks',
  'quotaCodes',
  'quotaQrcodes',
  'quotaChannels',
  'quotaAssets',
]);

test('create 场景的可选字段归一到 null，不产出 undefined', () => {
  for (const [name, input] of CREATE_CASES) {
    const schema = S[name];
    assert.ok(schema, `schema ${name} 应存在`);

    const result = schema.safeParse(input);
    assert.ok(result.success, `${name} 最小输入应通过：${result.error?.issues?.[0]?.message}`);

    // 显式的 undefined 值一个都不许有
    const explicitUndef = Object.entries(result.data)
      .filter(([, value]) => value === undefined)
      .map(([key]) => key);
    assert.deepEqual(explicitUndef, [], `${name} 存在 undefined 字段：${explicitUndef.join(',')}`);

    // schema 声明过的键，缺省时应出现且不是 undefined（除非在白名单）
    const missing = Object.keys(schema.shape ?? {})
      .filter((key) => !(key in result.data) && !ALLOWED_MISSING.has(key));
    assert.deepEqual(missing, [], `${name} 缺省后未产出的键：${missing.join(',')}`);
  }
});

test('update 场景缺省的键不产生，保证「没传 = 不碰」', () => {
  const UPDATE_CASES = [
    ['updateShortLinkSchema', {}],
    ['updateCodeSchema', {}],
    ['updateChannelSchema', {}],
    ['updateDomainSchema', {}],
    ['updateNotifyChannelSchema', {}],
    ['updateBatchSchema', {}],
    ['updateUserSchema', {}],
    ['updateGroupSchema', {}],
    ['updateQrcodeSchema', {}],
    ['updateCredentialSchema', {}],
  ];

  for (const [name, input] of UPDATE_CASES) {
    const schema = S[name];
    assert.ok(schema, `schema ${name} 应存在`);

    const result = schema.safeParse(input);
    assert.ok(result.success, `${name} 空 body 应通过：${result.error?.issues?.[0]?.message}`);
    assert.deepEqual(result.data, {}, `${name} 空 body 不应产出任何键（实际：${JSON.stringify(result.data)}）`);
  }
});

test('通知渠道开关未被显式传 false 时保持开启', () => {
  const base = { name: 'n', kind: 'webhook', config: { url: 'https://h.cn' } };
  assert.equal(S.createNotifyChannelSchema.parse(base).enabled, 1, '缺省应开启');
  assert.equal(S.createNotifyChannelSchema.parse({ ...base, enabled: false }).enabled, 0, '显式 false 应关闭');
  assert.equal(S.createNotifyChannelSchema.parse({ ...base, enabled: 0 }).enabled, 0);
  assert.equal(S.createNotifyChannelSchema.parse({ ...base, enabled: null }).enabled, 1, 'null 视为开启');
});

test('更新通知渠道时只改名称，不应把开关重置掉', () => {
  const data = S.updateNotifyChannelSchema.parse({ name: 'x' });
  assert.deepEqual(data, { name: 'x' }, '未传的 enabled 不应出现在结果里');
});

test('分页参数越界截断而非回落默认值', () => {
  assert.equal(S.pageQuery.parse({ pageSize: '999' }).pageSize, 100);
  assert.equal(S.pageQuery.parse({ pageSize: '0' }).pageSize, 1);
  assert.equal(S.pageQuery.parse({ pageSize: 'abc' }).pageSize, 20);
  assert.equal(S.pageQuery.parse({ page: '-5' }).page, 1);
  // 审计日志的上限与其他列表不同，单独一套
  assert.equal(S.auditLogsQuery.parse({ pageSize: '999' }).pageSize, 200);
  assert.equal(S.inspectionQuery.parse({ pageSize: '999' }).pageSize, 100);
});

test('链接只接受 http/https，挡住 javascript 协议', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://a.com', 'not-a-url', '']) {
    assert.equal(S.httpUrl.safeParse(bad).success, false, `${bad} 不应通过`);
  }
  assert.equal(S.httpUrl.parse('https://a.com/x').startsWith('https://'), true);
  assert.equal(S.httpUrl.parse('http://a.com').startsWith('http://'), true);
});

test('可选链接的空值统一归一成 null', () => {
  const schema = z.object({ u: S.optionalHttpUrl });
  assert.equal(schema.parse({}).u, null);
  assert.equal(schema.parse({ u: '' }).u, null);
  assert.equal(schema.parse({ u: null }).u, null);
  assert.equal(schema.parse({ u: 'https://a.com' }).u, 'https://a.com/');
});

test('域名归一化：去协议、去尾斜杠、转小写', () => {
  assert.equal(S.hostField.parse('HTTPS://Example.COM/path/'), 'example.com');
  assert.equal(S.hostField.parse('  a.b.cn  '), 'a.b.cn');
  assert.equal(S.hostField.safeParse('not a host!!').success, false);
  assert.equal(S.hostField.parse('localhost:8788'), 'localhost:8788');
});

test('活码在线时段容错：丢掉脏项而不是整体拒绝', () => {
  const data = S.createCodeSchema.parse({
    kind: 'group',
    title: 't',
    onlineHours: { '8': ['09:00-18:00'], '1': ['bad', '10:00-12:00'], '3': 'oops' },
  });
  assert.deepEqual(JSON.parse(data.onlineHours), { 1: ['10:00-12:00'] });
  assert.equal(S.createCodeSchema.parse({ kind: 'group', title: 't' }).onlineHours, null);
});

test('卡密兑换兼容 code / cardkey 两个键名，统一大写', () => {
  assert.equal(S.redeemSchema.parse({ code: ' ab-1 ' }).code, 'AB-1');
  assert.equal(S.redeemSchema.parse({ cardkey: 'xy' }).code, 'XY');
  assert.equal(S.redeemSchema.safeParse({}).success, false);
  assert.equal(S.redeemSchema.safeParse({ code: 'x'.repeat(81) }).success, false);
});

test('卡密批次状态是宽松归一：非 paused 一律 active', () => {
  assert.equal(S.updateBatchSchema.parse({ status: 'paused' }).status, 'paused');
  assert.equal(S.updateBatchSchema.parse({ status: 'whatever' }).status, 'active');
});

test('并流不允许指向自身', () => {
  assert.equal(S.createMergeSchema.safeParse({ fromCodeId: 1, toCodeId: 1 }).success, false);
  assert.equal(S.createMergeSchema.safeParse({ fromCodeId: 1, toCodeId: 2 }).success, true);
});

test('渠道配置按类型校验，敏感项必填', () => {
  assert.equal(S.webhookConfig.parse({ url: 'https://h.cn' }).method, 'POST');
  assert.equal(S.webhookConfig.parse({ url: 'https://h.cn', method: 'get' }).method, 'GET');
  assert.equal(S.webhookConfig.safeParse({ url: 'http://h.cn' }).success, false);
  assert.equal(S.barkConfig.parse({ key: 'k' }).server, 'https://api.day.app');
  assert.equal(S.emailConfig.safeParse({ to: 'bad' }).success, false);
  assert.equal(S.wecomConfig.safeParse({}).success, false);
});

test('校验错误统一收敛成 {code:400,msg}', async () => {
  const worker = (await import('../src/index.js')).default;
  const { createEnv, createCtx, makeRequest } = await import('./helpers.js');

  const env = createEnv();
  const ctx = createCtx();
  const res = await worker.fetch(
    makeRequest('https://api.test/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: '', password: '' }),
    }),
    env,
    ctx,
  );
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.code, 400);
  assert.equal(typeof body.msg, 'string');
  assert.ok(body.msg.length > 0);
});
