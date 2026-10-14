/**
 * 口令哈希使用 PBKDF2-SHA256（WebCrypto 原生支持），
 * 存储格式：pbkdf2$<iterations>$<salt-b64>$<hash-b64>
 *
 * 迭代次数写进哈希串本身，校验时以串里的值为准 —— 这样调低/调高默认值
 * 都不会让既有口令失效，改默认值只影响新写入的哈希。
 *
 * 默认值受 Cloudflare Workers 的 CPU 预算约束：
 *   免费版每个请求只有 10ms CPU，付费版默认 30s。
 *   PBKDF2-SHA256 在本机 workerd 上 21 万次迭代约 28ms CPU，
 *   免费版部署下注册/登录（唯一走这条重活儿的接口）必然超限，
 *   表现为 onError 兜底出的 500「服务暂时不可用」。
 *   实测 workerd：2 万次约 2ms、5 万次约 7ms、10 万次约 14ms。
 *   生产 CPU 通常更慢，按 2~3 倍折算，默认取 2 万次把预算留在 10ms 以内；
 *   付费版可用 PASSWORD_ITERATIONS 调高（上限 100 万），安全性自行按预算权衡。
 */
export const DEFAULT_PBKDF2_ITERATIONS = 20000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

/**
 * 从环境变量读迭代次数：非法值（非数字、太小、太大）一律回落到默认值，
 * 避免手滑填错把注册口彻底堵死。
 */
export function resolveIterations(raw) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 10000 || parsed > 1000000) {
    return DEFAULT_PBKDF2_ITERATIONS;
  }
  return parsed;
}

function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/**
 * hashPassword(password, iterations?)
 * 调用方（需要落库的 handler）从不传第二参，由这里统一取环境默认值，
 * 保证「写进串里的迭代数」与「本次实际计算用的迭代数」始终一致。
 */
export async function hashPassword(password, iterations = DEFAULT_PBKDF2_ITERATIONS) {
  const rounds = resolveIterations(iterations);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, rounds);
  return `pbkdf2$${rounds}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, iterationsRaw, saltRaw, hashRaw] = stored.split('$');
  if (scheme !== 'pbkdf2' || !saltRaw || !hashRaw) return false;
  const iterations = Number.parseInt(iterationsRaw, 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  const expected = fromBase64(hashRaw);
  const actual = await derive(password, fromBase64(saltRaw), iterations);
  return timingSafeEqual(actual, expected);
}

/** 定长比较，避免按字节短路带来的时序差异。 */
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function randomToken(bytes = 32) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 常量时间字符串比较，用于签名与令牌校验。 */
export async function safeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  return timingSafeEqual(new TextEncoder().encode(ha), new TextEncoder().encode(hb));
}
