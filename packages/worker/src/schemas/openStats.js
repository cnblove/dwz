import { z } from 'zod';

/** 开放接口统计查询：按 slug 定位，默认近 7 天。 */
export const openStatsSchema = z
  .object({
    dv1_slug: z.string().optional(),
    slug: z.string().optional(),
    dv1_days: z.coerce.number().catch(7).transform((n) => Math.min(30, Math.max(1, Math.trunc(n) || 7))),
    dv1_day: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
      .optional(),
    // 读操作也要把签名 tag 位收进来，否则它们会被 zod 之外的逻辑漏掉
    dv1_title: z.string().optional(),
    dv1_type: z.string().optional(),
    dv1_url: z.string().optional(),
  })
  .passthrough()
  .transform((body, ctx) => {
    const slug = String(body.dv1_slug ?? body.slug ?? '').trim();
    if (!slug) {
      ctx.addIssue({ code: 'custom', path: ['dv1_slug'], message: '缺少 slug' });
      return z.NEVER;
    }
    return { ...body, dv1_slug: slug };
  });
