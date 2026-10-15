import { z } from 'zod';
import { OPEN_ACCESS_RULES } from './shortLinks.js';

/**
 * 开放接口「资源动作」的参数校验。
 *
 * 放在签名之后执行（见 openApiCore.authorizeCall）：签名要用原始 body，
 * 提前校验会让「签名失败」被报成「参数不合法」。
 *
 * 三个动作共享同一套 tag 位（dv1_title/dv1_type/dv1_url），
 * 读过签名串的人一眼能对上；额外的字段单独加。
 */

const tag = (schema) => z.union([schema, z.undefined(), z.literal('')]).optional();

const url = z
  .string()
  .trim()
  .min(1, '目标链接不能为空')
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }, '目标链接格式不正确，或不是 http/https');

const title = z.string().trim().min(1, '标题不能为空').max(100, '标题长度不能超过 100 个字符');

const slug = z
  .union([z.string(), z.null()])
  .transform((value) => String(value ?? '').trim())
  .refine((value) => !value || /^[A-Za-z0-9_-]{4,32}$/.test(value), '自定义短链只允许 4~32 位字母、数字、下划线与连字符')
  .optional();

/** 创建：标题 + 目标链接必填，访问限制可选。 */
export const createResourceSchema = z
  .object({
    dv1_title: tag(title),
    dv1_type: tag(z.enum(OPEN_ACCESS_RULES, { error: '访问限制取值不合法' })),
    dv1_url: tag(url),
    dv1_slug: slug,
  })
  .passthrough()
  .superRefine((body, ctx) => {
    if (!String(body.dv1_title ?? '').trim()) {
      ctx.addIssue({ code: 'custom', path: ['dv1_title'], message: '标题不能为空' });
    }
    if (!String(body.dv1_url ?? '').trim()) {
      ctx.addIssue({ code: 'custom', path: ['dv1_url'], message: '目标链接不能为空' });
    }
  })
  .transform((body) => ({
    ...body,
    dv1_title: String(body.dv1_title ?? '').trim(),
    dv1_url: String(body.dv1_url ?? '').trim(),
    dv1_type: body.dv1_type || 'any',
  }));

/** 按 slug 定位：查详情与删除共用。 */
export const slugResourceSchema = z
  .object({
    dv1_title: tag(z.string()),
    dv1_type: tag(z.string()),
    dv1_url: tag(z.string()),
    dv1_slug: z.string().optional(),
    slug: z.string().optional(),
  })
  .passthrough()
  .transform((body, ctx) => {
    const value = String(body.dv1_slug ?? body.slug ?? '').trim();
    if (!value) {
      ctx.addIssue({ code: 'custom', path: ['dv1_slug'], message: '缺少 slug' });
      return z.NEVER;
    }
    return { ...body, dv1_slug: value };
  });

/** 列表：分页与关键字。 */
export const listResourceSchema = z
  .object({
    dv1_title: tag(z.string()),
    dv1_type: tag(z.string()),
    dv1_url: tag(z.string()),
    dv1_page: z.coerce.number().catch(1).transform((n) => Math.max(1, Math.trunc(n) || 1)),
    dv1_page_size: z.coerce.number().catch(20).transform((n) => Math.min(100, Math.max(1, Math.trunc(n) || 20))),
    dv1_keyword: z.string().trim().default(''),
  })
  .passthrough();
