import { z } from 'zod';

/**
 * 统计明细查询。
 * 原实现：days 越界截断到 1~30，day 缺省由 handler 取今日。
 */
export const statsDetailQuery = z.object({
  source: z.string().default('short_link'),
  days: z.coerce
    .number()
    .catch(7)
    .transform((n) => Math.min(30, Math.max(1, Math.trunc(n) || 1))),
  day: z.string().optional(),
});

/** 统计清理：保留天数截断到 1~365。 */
export const pruneStatsSchema = z.object({
  keepDays: z.coerce
    .number()
    .catch(90)
    .transform((n) => Math.min(365, Math.max(1, Math.trunc(n) || 1))),
});

/** 巡检日志分页，pageSize 上限 30（与列表页默认值一致）。 */
export const inspectionQuery = z.object({
  page: z.coerce.number().catch(1).transform((n) => Math.max(1, Math.trunc(n) || 1)),
  pageSize: z.coerce.number().catch(30).transform((n) => Math.min(100, Math.max(1, Math.trunc(n) || 1))),
  kind: z.string().optional(),
});

/**
 * 长按上报参数：/report/longpress?zm_id=<正整数>。
 * zm_id 是从 query 来的字符串，这里转成正整数；非法值直接 400。
 */
export const longPressQuery = z.object({
  zm_id: z
    .union([z.string(), z.number()])
    .transform((value) => Number(value))
    .refine((n) => Number.isInteger(n) && n >= 1, '子码 ID 必须是 1 以上的整数'),
});

/** 最近访客列表分页，pageSize 上限 50。 */
export const visitorsQuery = z.object({
  page: z.coerce.number().catch(1).transform((n) => Math.max(1, Math.trunc(n) || 1)),
  pageSize: z.coerce.number().catch(10).transform((n) => Math.min(50, Math.max(1, Math.trunc(n) || 1))),
  source: z.string().optional(),
});

/** 原始 IP 明细的保留天数，1~365，越界截断（与 visitors.js 的上下界一致）。 */
export const updateVisitorSettingSchema = z.object({
  keepDays: z.coerce
    .number()
    .transform((n) => Math.min(365, Math.max(1, Math.trunc(n) || 1))),
});
