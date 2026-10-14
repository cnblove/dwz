import { z } from 'zod';
import { int, optionalHttpUrl, optionalHttpUrlPatch, optionalInt, optionalIntPatch, optionalText, optionalTextPatch, text } from './common.js';

export const MAX_BATCH_SIZE = 5000;

/** 卡密明文列表：既支持数组，也支持 CSV 粘贴文本。归一化在 handler 的 parseProvidedCodes 里做。 */
const codeSource = z.union([z.string(), z.array(z.unknown()), z.null()]).optional();

const count = int('生成数量', { min: 1, max: MAX_BATCH_SIZE });
const lowStock = int('库存告警阈值', { min: 0, max: MAX_BATCH_SIZE });

export const createBatchSchema = z.object({
  name: text('批次名称', { max: 80 }),
  content: text('卡密内容', { max: 500 }),
  count: count.default(1),
  expiredAt: z.union([z.string(), z.number(), z.null()]).optional(),
  redirectUrl: optionalHttpUrl,
  remark: optionalText(100),
  lowStock: lowStock.default(0),
  notifyChannel: optionalInt('通知渠道', { min: 1 }),
  // 兼容两种键名
  codeList: codeSource,
  codes: codeSource,
});

export const updateBatchSchema = z.object({
  name: text('批次名称', { max: 80 }).optional(),
  content: text('卡密内容', { max: 500 }).optional(),
  /**
   * 状态是「宽松归一」而非严格枚举：除 'paused' 外一律落 'active'。
   * 原实现如此（`body.status === 'paused' ? 'paused' : 'active'`），照搬避免行为漂移。
   */
  status: z.union([z.string(), z.null()]).transform((v) => (v === 'paused' ? 'paused' : 'active')).optional(),
  expiredAt: z.union([z.string(), z.number(), z.null()]).optional(),
  redirectUrl: optionalHttpUrlPatch,
  remark: optionalTextPatch(100),
  lowStock: lowStock.optional(),
  notifyChannel: optionalIntPatch('通知渠道', { min: 1 }),
});

export const appendKeysSchema = z.object({
  count: count.default(1),
  codeList: codeSource,
  codes: codeSource,
});

/** 兑换：兼容 code 与 cardkey 两个键名，统一转大写后比对哈希。 */
export const redeemSchema = z
  .object({
    code: z.string().optional(),
    cardkey: z.string().optional(),
  })
  .transform((body, ctx) => {
    const raw = String(body.code ?? body.cardkey ?? '').trim();
    if (!raw) {
      ctx.addIssue({ code: 'custom', path: ['code'], message: '卡密不能为空' });
      return z.NEVER;
    }
    if (raw.length > 80) {
      ctx.addIssue({ code: 'custom', path: ['code'], message: '卡密长度不能超过 80 个字符' });
      return z.NEVER;
    }
    return { code: raw.toUpperCase() };
  });

export const listBatchesQuery = z.object({
  page: z.coerce.number().catch(1).transform((n) => Math.max(1, Math.trunc(n) || 1)),
  pageSize: z.coerce.number().catch(20).transform((n) => Math.min(100, Math.max(1, Math.trunc(n) || 1))),
  keyword: z.string().trim().default(''),
});
