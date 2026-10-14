import { z } from 'zod';
import { oneOf, text } from './common.js';
import { CHANNEL_KINDS } from '../lib/notify.js';

/**
 * 开关默认开启。
 *
 * 原实现是 `body.enabled === false ? 0 : 1` —— 注意它**只把显式的 false 当关闭**，
 * undefined / null / 0 / '0' 全部落到「开启」。这个宽容行为被前端依赖，所以照搬，
 * 不能直接用通用的 boolInt（那套缺省会落 0）。
 */
const enabledFlag = z
  .union([z.boolean(), z.number(), z.string(), z.null()])
  .transform((value) => {
    if (value === false || value === 0 || value === '0' || value === 'false') return 0;
    return 1;
  });

const enabledDefaultOn = enabledFlag.default(1);

/** 渠道配置：结构由渠道类型决定，这里只保证是对象。具体字段由 normalizeConfig 校验。 */
const config = z.record(z.string(), z.unknown()).default({});

export const createNotifyChannelSchema = z.object({
  name: text('渠道名称', { max: 50 }),
  kind: oneOf(CHANNEL_KINDS, '渠道类型'),
  config,
  enabled: enabledDefaultOn,
});

export const updateNotifyChannelSchema = z.object({
  name: text('渠道名称', { max: 50 }).optional(),
  enabled: enabledFlag.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
