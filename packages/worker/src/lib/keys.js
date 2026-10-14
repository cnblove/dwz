/**
 * 短链 key 校验。
 *
 * 自动生成的 key 走 UUID v4（见 `namespace.js`），公开在 URL 上必须不可猜、
 * 不可连号；自定义 key 由用户提供，这里只负责格式约束 ——
 * 只允许字母数字与 `-`/`_`，避免与路径分隔符和通配路由冲突。
 */
export function isValidCustomSlug(slug) {
  return typeof slug === 'string' && /^[A-Za-z0-9_-]{4,32}$/.test(slug);
}
