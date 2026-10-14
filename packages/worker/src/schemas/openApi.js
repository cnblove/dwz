import { z } from 'zod';
import { int, oneOf } from './common.js';

const QUOTA_MAX = 100000000;

/** ipAllowlist 原实现存的是「字符串化后截断 300」，保持宽容。 */
const ipAllowlistBase = z
  .union([z.string(), z.array(z.unknown()), z.null()])
  .transform((value) => {
    if (value === null || value === undefined) return null;
    const raw = Array.isArray(value) ? value.join(',') : String(value);
    const trimmed = raw.trim();
    return trimmed ? trimmed.slice(0, 300) : null;
  });

export const createCredentialSchema = z.object({
  // 缺省归一成 null，保证能直接 bind 进 D1（undefined 会被 D1 拒绝）
  ipAllowlist: ipAllowlistBase.default(null),
  quota: int('配额', { min: 1, max: QUOTA_MAX }).default(100000),
  expiresAt: z.union([z.string(), z.number(), z.null()]).default(null),
});

const ipAllowlistPatch = z
  .union([z.string(), z.array(z.unknown()), z.null()])
  .transform((value) => {
    if (value === null || value === undefined) return null;
    const raw = Array.isArray(value) ? value.join(',') : String(value);
    const trimmed = raw.trim();
    return trimmed ? trimmed.slice(0, 300) : null;
  })
  .optional();

export const updateCredentialSchema = z.object({
  ipAllowlist: ipAllowlistPatch,
  quota: int('配额', { min: 1, max: QUOTA_MAX }).optional(),
  status: oneOf(['active', 'paused'], '状态').optional(),
  expiresAt: z.union([z.string(), z.number(), z.null()]).optional(),
});

/**
 * 开放接口参数（dwz_* 前缀）。
 *
 * 注意：签名校验必须拿到**原始** body 计算 HMAC，所以这些 schema 只用于
 * 签名通过后的业务字段校验，不能在签名前拦截请求 —— 否则签名失败会被
 * 报成「参数不合法」，对外调用方难以排查。
 */
export const OPEN_ACCESS_RULES = ['any', 'wechat', 'ios', 'android', 'mobile', 'desktop'];

export const openCreateShortLinkSchema = z.object({
  dwz_title: z.string({ error: '标题必须是字符串' }).trim().min(1, '标题不能为空').max(100, '标题长度不能超过 100 个字符'),
  dwz_url: z
    .string({ error: '目标链接必须是字符串' })
    .trim()
    .min(1, '目标链接不能为空')
    .refine((value) => {
      try {
        const { protocol } = new URL(value);
        return protocol === 'http:' || protocol === 'https:';
      } catch {
        return false;
      }
    }, '目标链接格式不正确，或不是 http/https'),
  dwz_type: oneOf(OPEN_ACCESS_RULES, '访问限制').default('any'),
  dwz_slug: z
    .union([z.string(), z.null()])
    .transform((v) => String(v ?? '').trim())
    .refine((v) => !v || /^[A-Za-z0-9_-]{4,32}$/.test(v), { message: '自定义短链格式不正确' })
    .optional(),
}).passthrough();

export const openQueryStatsSchema = z
  .object({
    slug: z.string().optional(),
    dwz_slug: z.string().optional(),
  })
  .passthrough()
  .transform((body, ctx) => {
    const slug = String(body.slug ?? body.dwz_slug ?? '').trim();
    if (!slug) {
      ctx.addIssue({ code: 'custom', path: ['slug'], message: '缺少 slug' });
      return z.NEVER;
    }
    return { ...body, slug };
  });
