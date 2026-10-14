/**
 * 短链 key 生成。
 *
 * 命名空间是公开的 URL 空间，key 必须「不可猜」：
 * 字母表剔除容易混淆的 I/l/O/0，并且只由随机字符构成；
 * 用户自定义的 key 也要先过一遍短哈希掺入随机位，
 * 否则连号（`test1`、`test2`）或纯数字的 key 会被逐个试出来。
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const DIGITS = '23456789';

export const MIN_KEY_LENGTH = 4;
export const MAX_KEY_LENGTH = 12;

export function isValidKeyLength(length) {
  const n = Number(length);
  return Number.isInteger(n) && n >= MIN_KEY_LENGTH && n <= MAX_KEY_LENGTH;
}

function pick(alphabet, size) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

export function generateSlug(length = 6) {
  return pick(ALPHABET, isValidKeyLength(length) ? Number(length) : 6);
}

/**
 * 自定义 key 的最终形态：用户可读的前缀 + 随机后缀。
 *
 * base32 由 SHA-256 派生（只取前 5 字节 → 只含字母数字），
 * 因此每次调用结果不同，无法从名字反推、也不会连号。
 */
export async function generateSlugFromName(name, length = 6, salt = 'dwz') {
  const size = isValidKeyLength(length) ? Number(length) : 6;
  const readable = String(name ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${salt}:${name}:${Date.now()}:${Math.random()}`),
  );
  const suffix = base32(new Uint8Array(digest).slice(0, 4));
  const maxPrefix = Math.max(0, size - suffix.length - 1);
  const prefix = readable.slice(0, Math.min(4, maxPrefix));
  return prefix ? `${prefix}-${suffix}` : suffix;
}

function base32(bytes) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

/**
 * 生成一个尚未被占用的 key。
 * isTaken 由调用方提供，把「查重」这件事留在数据层。
 */
export async function generateUniqueSlug(isTaken, length = 6, attempts = 8) {
  for (let i = 0; i < attempts; i += 1) {
    const slug = generateSlug(length);
    // eslint-disable-next-line no-await-in-loop
    if (!(await isTaken(slug))) return slug;
  }
  throw new Error('无法生成未被占用的短链标识');
}

/** 自定义 key 只允许字母数字，避免与路径分隔符和通配路由冲突。 */
export function isValidCustomSlug(slug) {
  return typeof slug === 'string' && /^[A-Za-z0-9_-]{4,32}$/.test(slug);
}

export { DIGITS };
