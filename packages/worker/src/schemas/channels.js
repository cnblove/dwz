import { z } from 'zod';
import { customSlug } from './shortLinks.js';
import { httpUrl, oneOf, text } from './common.js';

export const CHANNEL_ACCESS_RULES = ['any', 'wechat'];

export const createChannelSchema = z.object({
  title: text('标题', { max: 100 }),
  targetUrl: httpUrl,
  slug: customSlug,
  accessRule: oneOf(CHANNEL_ACCESS_RULES, '访问限制').default('any'),
});

export const updateChannelSchema = z.object({
  title: text('标题', { max: 100 }).optional(),
  targetUrl: httpUrl.optional(),
  accessRule: oneOf(CHANNEL_ACCESS_RULES, '访问限制').optional(),
  status: oneOf(['active', 'paused'], '状态').optional(),
});

/** 封禁访客：前端传明文 IP，落库前统一哈希。 */
export const blockVisitorSchema = z.object({
  ip: text('IP', { max: 60 }),
});

export const listChannelsQuery = z.object({
  page: z.coerce.number().catch(1).transform((n) => Math.max(1, Math.trunc(n) || 1)),
  pageSize: z.coerce.number().catch(20).transform((n) => Math.min(100, Math.max(1, Math.trunc(n) || 1))),
  keyword: z.string().trim().default(''),
});
