import { z } from 'zod';
import { customSlug } from './shortLinks.js';
import { boolInt, httpUrl, int, oneOf, optionalBoolInt, optionalHttpUrl, optionalHttpUrlPatch, optionalInt, optionalIntPatch, optionalText, optionalTextPatch, text } from './common.js';

export const CODE_KINDS = ['group', 'service'];
export const PICK_MODES = ['threshold', 'random'];

const MAX_THRESHOLD = 1000000;

/**
 * 在线时段配置。
 *
 * 原实现是容错过滤：丢掉 day 不在 1~7、或时段不合 HH:MM-HH:MM 格式的项，
 * 而不是整体拒绝。这样一处脏数据不会让整个活码保存失败，照搬。
 */
const normalizeOnlineHours = (input) => {
  if (!input) return null;
  const out = {};
  for (const [day, ranges] of Object.entries(input)) {
    const dayNum = Number(day);
    if (!Number.isInteger(dayNum) || dayNum < 1 || dayNum > 7) continue;
    if (!Array.isArray(ranges)) continue;
    const cleaned = ranges
      .map((range) => String(range ?? '').trim())
      .filter((range) => /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(range));
    if (cleaned.length) out[String(dayNum)] = cleaned;
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
};

const onlineHoursBase = z.union([z.record(z.string(), z.unknown()), z.null()]).transform(normalizeOnlineHours);

/** 创建用：缺省归一成 null，保证能直接 bind 进 D1。 */
const onlineHours = onlineHoursBase.default(null);

/** 部分更新用：缺省不产生键。 */
const onlineHoursPatch = onlineHoursBase.optional();

export const createCodeSchema = z.object({
  kind: oneOf(CODE_KINDS, '活码类型'),
  title: text('标题', { max: 100 }),
  slug: customSlug,
  pickMode: oneOf(PICK_MODES, '选取模式').default('threshold'),
  sticky: boolInt(0),
  showSafety: boolInt(1),
  remark: optionalText(500),
  notifyChannel: optionalInt('通知渠道', { min: 1 }),
  showOnline: boolInt(0),
  onlineHours,
  fallbackUrl: optionalHttpUrl,
  fallbackOn: boolInt(0),
});

export const updateCodeSchema = z.object({
  title: text('标题', { max: 100 }).optional(),
  status: oneOf(['active', 'paused'], '状态').optional(),
  sticky: optionalBoolInt(),
  showSafety: optionalBoolInt(),
  remark: optionalTextPatch(500),
  notifyChannel: optionalIntPatch('通知渠道', { min: 1 }),
  pickMode: oneOf(PICK_MODES, '选取模式').optional(),
  showOnline: optionalBoolInt(),
  onlineHours: onlineHoursPatch,
  fallbackUrl: optionalHttpUrlPatch,
  fallbackOn: optionalBoolInt(),
});

export const addQrcodeSchema = z.object({
  imageUrl: httpUrl,
  /** 未传阈值时由 handler 按活码类型给默认值（群活码 200，客服码 0）。 */
  threshold: int('阈值', { min: 0, max: MAX_THRESHOLD }).optional(),
  contact: optionalText(100),
});

export const updateQrcodeSchema = z.object({
  imageUrl: httpUrl.optional(),
  contact: optionalTextPatch(100),
  threshold: int('阈值', { min: 0, max: MAX_THRESHOLD }).optional(),
  status: oneOf(['active', 'disabled'], '状态').optional(),
});

export const createMergeSchema = z
  .object({
    fromCodeId: int('原活码 ID', { min: 1 }),
    toCodeId: int('并入活码 ID', { min: 1 }),
  })
  .refine((body) => body.fromCodeId !== body.toCodeId, {
    message: '不能并入自身',
    path: ['toCodeId'],
  });

export const listCodesQuery = z.object({
  page: z.coerce.number().catch(1).transform((n) => Math.max(1, Math.trunc(n) || 1)),
  pageSize: z.coerce.number().catch(20).transform((n) => Math.min(100, Math.max(1, Math.trunc(n) || 1))),
  kind: z.string().optional(),
  keyword: z.string().trim().default(''),
});
