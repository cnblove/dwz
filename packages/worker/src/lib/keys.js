/**
 * 短链 key 生成。字母表剔除了容易混淆的 I/l/O/0，
 * 便于用户在口头或纸面上传递。
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export const MIN_KEY_LENGTH = 4;
export const MAX_KEY_LENGTH = 12;

export function isValidKeyLength(length) {
  const n = Number(length);
  return Number.isInteger(n) && n >= MIN_KEY_LENGTH && n <= MAX_KEY_LENGTH;
}

export function generateSlug(length = 6) {
  const size = isValidKeyLength(length) ? Number(length) : 6;
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
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
