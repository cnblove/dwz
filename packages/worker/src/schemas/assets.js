import { z } from 'zod';
import { oneOf, optionalTextPatch, text } from './common.js';

/** 素材类型：目前以图片为主，doc 预留。 */
export const ASSET_KINDS = ['image', 'doc'];

/** 上传体积上限（字节）。10 MB —— 二维码/海报类图片远超不到这个量级。 */
export const MAX_ASSET_SIZE = 10 * 1024 * 1024;

/**
 * 允许的图片 MIME 白名单。
 * 用白名单而不是黑名单：素材会以公开链接展示在落地页上，
 * 放行 text/html、image/svg+xml 这类可执行内容等于给自己开 XSS 口子。
 */
export const ALLOWED_IMAGE_MIME = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/x-icon',
];

/** 列表查询：复用统一分页口径，额外支持 kind 与关键词。 */
export const listAssetsQuery = z.object({
  page: z.coerce.number().catch(1).transform((n) => Math.max(1, Math.trunc(n) || 1)),
  pageSize: z.coerce.number().catch(24).transform((n) => Math.min(100, Math.max(1, Math.trunc(n) || 1))),
  kind: z.string().optional(),
  keyword: z.string().trim().default(''),
});

/** 编辑素材：改名 / 备注 / 类型。缺省字段一律不碰。 */
export const updateAssetSchema = z.object({
  filename: text('文件名', { max: 120 }).optional(),
  remark: optionalTextPatch(200),
  kind: oneOf(ASSET_KINDS, '素材类型').optional(),
});
