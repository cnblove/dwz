import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PBKDF2_ITERATIONS, hashPassword, resolveIterations, verifyPassword, safeStringEqual, sha256Hex, timingSafeEqual, randomToken } from '../src/lib/crypto.js';

test('密码哈希可以被正确校验', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.match(stored, new RegExp(`^pbkdf2\\$${DEFAULT_PBKDF2_ITERATIONS}\\$`));
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyPassword('wrong password', stored), false);
});

test('迭代次数可自定义，且旧哈希（不同迭代数）仍能校验', async () => {
  const stored = await hashPassword('same-secret', 15000);
  assert.match(stored, /^pbkdf2\$15000\$/);
  assert.equal(await verifyPassword('same-secret', stored), true);
  // 校验以哈希串里记录的迭代数为准，与默认值无关
  const legacy = await hashPassword('same-secret', 210000);
  assert.equal(await verifyPassword('same-secret', legacy), true);
});

test('resolveIterations 对非法值回落到默认，防止把注册口堵死', () => {
  assert.equal(resolveIterations('15000'), 15000);
  assert.equal(resolveIterations(15000), 15000);
  for (const bad of [undefined, null, '', 'abc', 0, -1, 5000, 99999999]) {
    assert.equal(resolveIterations(bad), DEFAULT_PBKDF2_ITERATIONS, `非法值应回落：${bad}`);
  }
});

test('同一密码两次哈希结果不同（加盐）', async () => {
  const a = await hashPassword('same-secret');
  const b = await hashPassword('same-secret');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same-secret', a), true);
  assert.equal(await verifyPassword('same-secret', b), true);
});

test('损坏的哈希串不会抛异常，只会校验失败', async () => {
  for (const broken of ['', 'garbage', 'pbkdf2$0$AA$BB', 'pbkdf2$abc$AA$BB', null, undefined]) {
    assert.equal(await verifyPassword('x', broken), false);
  }
});

test('safeStringEqual 比较内容而非引用', async () => {
  assert.equal(await safeStringEqual('abc', 'abc'), true);
  assert.equal(await safeStringEqual('abc', 'abd'), false);
  assert.equal(await safeStringEqual('abc', 'abcd'), false);
  assert.equal(await safeStringEqual(undefined, 'abc'), false);
});

test('randomToken 长度与随机性', () => {
  const a = randomToken(16);
  const b = randomToken(16);
  assert.equal(a.length, 32);
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]+$/);
});

test('timingSafeEqual 对等长输入逐字节比较', () => {
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false);
});

test('sha256Hex 输出稳定', async () => {
  assert.equal(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});
