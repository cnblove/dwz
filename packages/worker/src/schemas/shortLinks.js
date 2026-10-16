import { z } from 'zod';
import { boolInt, httpUrl, oneOf, optionalBoolInt, optionalHttpUrl, optionalHttpUrlPatch, text } from './common.js';

export const ACCESS_RULES = ['any', 'wechat', 'ios', 'android', 'mobile', 'desktop'];

/** 兼容别名：开放接口按「访问限制」语义读它，取值与后台完全一致。 */
export const OPEN_ACCESS_RULES = ACCESS_RULES;

/**
 * 自定义 slug 的格式约束。
 *
 * 归一化：未传/空串 → undefined（由 resolveSlug 自动生成 UUID），
 * 有值则必须是 4~32 位字母数字下划线连字符。
 */
export const customSlug = z
  .union([z.string(), z.null()])
  .transform((value) => {
    const raw = String(value ?? '').trim();
    return raw || undefined;
  })
  .refine((value) => value === undefined || /^[A-Za-z0-9_-]{4,32}$/.test(value), {
    message: '自定义短链只允许 4~32 位字母、数字、下划线与连字符',
  })
  .optional();

/** 创建短链的请求体。 */
export const createShortLinkSchema = z.object({
  title: text('标题', { max: 100 }),
  targetUrl: httpUrl,
  slug: customSlug,
  accessRule: oneOf(ACCESS_RULES, '访问限制').default('any'),
  urlIos: optionalHttpUrl,
  urlAndroid: optionalHttpUrl,
  urlDesktop: optionalHttpUrl,
  rotateDomain: boolInt(0),
  expiredAt: z.union([z.string(), z.number(), z.null(), z.undefined()]).default(null),
  expiredJump: optionalHttpUrl,
});

/**
 * 更新短链。
 *
 * 与创建不同，这里所有字段都可选 —— 只更新显式传了的字段。
 * 用 `.optional()` 而非 `.default()`：default 会把缺省字段也填上，
 * 那 update 就变成了字段覆盖，与「部分更新」语义不符。
 */
export const updateShortLinkSchema = z.object({
  title: text('标题', { max: 100 }).optional(),
  // 改自定义短链（slug）。与创建同一套格式约束；未传 = 不动。
  slug: customSlug,
  targetUrl: httpUrl.optional(),
  accessRule: oneOf(ACCESS_RULES, '访问限制').optional(),
  urlIos: optionalHttpUrlPatch,
  urlAndroid: optionalHttpUrlPatch,
  urlDesktop: optionalHttpUrlPatch,
  expiredAt: z.union([z.string(), z.number(), z.null()]).optional(),
  expiredJump: optionalHttpUrlPatch,
  status: oneOf(['active', 'paused'], '状态').optional(),
  rotateDomain: optionalBoolInt(),
});
