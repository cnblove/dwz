import { badRequest } from './http.js';
import { newUuid } from './ids.js';

/**
 * slug 命名空间。
 *
 * 短链 / 活码 / 渠道码共用同一个 URL 空间（`{host}/{slug}` 依次尝试
 * 短链 → 活码 → 渠道码），因此三方必须互不重名。
 *
 * 占用动作是一次 `INSERT OR IGNORE`：只有 changes > 0 的那次创建算抢到。
 * 「先 SELECT 再 INSERT」在并发下会漏 —— 两个请求同时查到没人用，
 * 就会各自插一条同名记录，之后其中一种资源被永久遮蔽。
 */
export async function claimSlug(db, slug) {
  const result = await db
    .prepare('INSERT OR IGNORE INTO short_slugs (slug) VALUES (?)')
    .bind(slug)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/** 释放 slug；资源删除时调用，避免命名空间只增不减。 */
export async function releaseSlug(db, slug) {
  if (!slug) return;
  await db.prepare('DELETE FROM short_slugs WHERE slug = ?').bind(slug).run();
}

/**
 * 生成 slug。
 *
 * 自动生成走 UUID v4（128 位随机，公开在 URL 上，必须不可猜、不可连号）；
 * 调用方传了自定义值就沿用，但仍要在命名空间里抢一次占用。
 */
export async function resolveSlug(db, { slug, limit = 8 } = {}) {
  if (slug) {
    if (!(await claimSlug(db, slug))) throw badRequest('该短链已被占用');
    return slug;
  }
  for (let attempt = 0; attempt < limit; attempt += 1) {
    const candidate = newUuid();
    // eslint-disable-next-line no-await-in-loop
    if (await claimSlug(db, candidate)) return candidate;
  }
  throw badRequest('生成短链标识失败，请重试');
}
