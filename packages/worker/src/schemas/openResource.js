import { z } from 'zod';
import { OPEN_ACCESS_RULES } from './shortLinks.js';

/** 子码阈值上限，与后台 `schemas/codes.js` 保持同一口径。 */
const MAX_THRESHOLD = 1000000;

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

/* ---------------- 活码子码（客服码 / 群码宿主下的二维码） ---------------- */

/**
 * 子码动作只在 `codes/{动作}` 上存在，但对外仍走 slug 定位宿主 ——
 * 调用方拿到的 slug 是宿主活码的，不该再暴露内部自增 id。
 *
 * `dv1_qrcode` 是子码自身的标识（数字 id 或它在宿主下的序号，从 1 开始）。
 * 之所以允许两种写法：脚本里通常只知道「第几张」，而刚创建时又能拿到 id，
 * 让调用方记住一套编号规则的成本高于在服务端多认一种写法。
 */
const qrcodeRef = z
  .union([z.string(), z.number(), z.null()])
  .transform((value) => String(value ?? '').trim())
  .refine((value) => !value || /^\d+$/.test(value), '子码编号应为数字 id 或从 1 开始的序号')
  .optional();

/** 子码动作的签名 tag 位与资源动作一致，读操作补空串。 */
const tags = {
  dv1_title: tag(z.string()),
  dv1_type: tag(z.string()),
  dv1_url: tag(z.string()),
};

const imageUrlField = z
  .string()
  .trim()
  .min(1, '二维码图片地址不能为空')
  .refine((value) => {
    // 允许本域相对地址（素材库给的就是 /media/xxx），但必须是站内路径，
    // 否则「图片地址」会变成任意 URL 的跳板。
    if (value.startsWith('/')) return !value.startsWith('//');
    try {
      const { protocol } = new URL(value);
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }, '二维码图片地址需为 http/https，或以 / 开头的站内地址');

/** 新建子码：图片必填；不传阈值时服务端按活码类型给默认（群码 200 / 客服码 0）。 */
export const createQrcodeSchema = z
  .object({
    ...tags,
    dv1_slug: z.string().optional(),
    slug: z.string().optional(),
    dv1_image_url: imageUrlField.optional(),
    dv1_contact: z.union([z.string(), z.null()]).optional(),
    dv1_threshold: z.coerce.number().int('阈值必须是整数').min(0).max(MAX_THRESHOLD).optional(),
  })
  .passthrough()
  .transform((body, ctx) => {
    const slug = String(body.dv1_slug ?? body.slug ?? '').trim();
    if (!slug) {
      ctx.addIssue({ code: 'custom', path: ['dv1_slug'], message: '缺少 slug' });
      return z.NEVER;
    }
    const imageUrl = String(body.dv1_image_url ?? '').trim();
    if (!imageUrl) {
      ctx.addIssue({ code: 'custom', path: ['dv1_image_url'], message: '缺少 dv1_image_url（二维码图片地址）' });
      return z.NEVER;
    }
    return {
      ...body,
      dv1_slug: slug,
      dv1_image_url: imageUrl,
      dv1_contact: String(body.dv1_contact ?? '').trim().slice(0, 100) || null,
    };
  });

/** 改子码：至少给一个要改的字段。 */
export const updateQrcodeApiSchema = z
  .object({
    ...tags,
    dv1_slug: z.string().optional(),
    slug: z.string().optional(),
    dv1_qrcode: qrcodeRef,
    dv1_image_url: imageUrlField.optional(),
    dv1_contact: z.union([z.string(), z.null()]).optional(),
    dv1_threshold: z.coerce.number().int('阈值必须是整数').min(0).max(MAX_THRESHOLD).optional(),
    dv1_status: z.enum(['active', 'disabled'], { error: '状态只支持 active 或 disabled' }).optional(),
  })
  .passthrough()
  .transform((body, ctx) => {
    const slug = String(body.dv1_slug ?? body.slug ?? '').trim();
    if (!slug) {
      ctx.addIssue({ code: 'custom', path: ['dv1_slug'], message: '缺少 slug' });
      return z.NEVER;
    }
    if (!String(body.dv1_qrcode ?? '').trim()) {
      ctx.addIssue({ code: 'custom', path: ['dv1_qrcode'], message: '缺少 dv1_qrcode（子码 id 或序号）' });
      return z.NEVER;
    }
    const patch = {};
    if (body.dv1_image_url !== undefined) patch.dv1_image_url = String(body.dv1_image_url).trim();
    if (body.dv1_contact !== undefined) patch.dv1_contact = String(body.dv1_contact ?? '').trim().slice(0, 100) || null;
    if (body.dv1_threshold !== undefined) patch.dv1_threshold = body.dv1_threshold;
    if (body.dv1_status !== undefined) patch.dv1_status = body.dv1_status;
    if (Object.keys(patch).length === 0) {
      ctx.addIssue({ code: 'custom', message: '没有需要更新的字段（可传 dv1_image_url / dv1_contact / dv1_threshold / dv1_status）' });
      return z.NEVER;
    }
    return { ...body, dv1_slug: slug, dv1_qrcode: String(body.dv1_qrcode).trim(), ...patch };
  });

/** 列子码：只要宿主，`dv1_qrcode` 不参与 —— list 不针对某一张。 */
export const listQrcodesSchema = z
  .object({
    ...tags,
    dv1_slug: z.string().optional(),
    slug: z.string().optional(),
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

/** 读 / 删 / 重置计数：定位宿主与子码即可。 */
export const qrcodeRefSchema = z
  .object({
    ...tags,
    dv1_slug: z.string().optional(),
    slug: z.string().optional(),
    dv1_qrcode: qrcodeRef,
  })
  .passthrough()
  .transform((body, ctx) => {
    const slug = String(body.dv1_slug ?? body.slug ?? '').trim();
    if (!slug) {
      ctx.addIssue({ code: 'custom', path: ['dv1_slug'], message: '缺少 slug' });
      return z.NEVER;
    }
    if (!String(body.dv1_qrcode ?? '').trim()) {
      ctx.addIssue({ code: 'custom', path: ['dv1_qrcode'], message: '缺少 dv1_qrcode（子码 id 或序号）' });
      return z.NEVER;
    }
    return { ...body, dv1_slug: slug, dv1_qrcode: String(body.dv1_qrcode).trim() };
  });
