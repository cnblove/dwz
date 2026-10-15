import { z } from 'zod';
import { oneOf, optionalInt, optionalIntPatch, optionalText, optionalTextPatch, text } from './common.js';

export const ROLE = ['owner', 'member'];
export const USER_STATUS = ['active', 'disabled'];

const username = z
  .string({ error: '账号必须是字符串' })
  .trim()
  .regex(/^[A-Za-z0-9_]{3,32}$/, '账号只能包含字母、数字与下划线，长度 3~32');

export const createUserSchema = z.object({
  username,
  password: z.string({ error: '密码必须是字符串' }).min(8, '密码至少 8 位'),
  email: optionalText(120),
  role: oneOf(ROLE, '角色').default('member'),
  remark: optionalText(100),
  groupId: optionalInt('用户组', { min: 1 }).transform((v) => v ?? null),
  expiresAt: z.union([z.string(), z.number(), z.null()]).optional(),
});

export const updateUserSchema = z.object({
  email: optionalTextPatch(120),
  remark: optionalTextPatch(100),
  groupId: optionalIntPatch('用户组', { min: 1 }),
  expiresAt: z.union([z.string(), z.number(), z.null()]).optional(),
  status: oneOf(USER_STATUS, '状态').optional(),
  role: oneOf(ROLE, '角色').optional(),
  password: z.string().min(8, '密码至少 8 位').optional(),
});

/**
 * 用户组资源配额。
 *
 * 每类一个可空整数：**null / 空串 = 不限额**，与 api_credentials.quota 同一口径。
 * 上限 100000 是「防手抖」而不是业务规则 —— 再大就该直接用「不限」。
 * 用 optionalIntPatch 而不是 optionalInt：创建与更新共用一套字段语义，
 * 创建时缺省落 null（默认不限），更新时缺省表示「不改这一项」。
 */
export const QUOTA_FIELDS = {
  quotaShortLinks: 'quota_short_links',
  quotaCodes: 'quota_codes',
  quotaQrcodes: 'quota_qrcodes',
  quotaChannels: 'quota_channels',
  quotaAssets: 'quota_assets',
};

const quota = (field) => optionalIntPatch(field, { min: 0, max: 100000 });

export const createGroupSchema = z.object({
  name: text('用户组名称', { max: 32 }),
  navList: z.array(z.unknown()).default([]),
  quotaShortLinks: quota('短链配额'),
  quotaCodes: quota('活码配额'),
  quotaQrcodes: quota('子码配额'),
  quotaChannels: quota('渠道码配额'),
  quotaAssets: quota('素材配额'),
});

export const updateGroupSchema = z.object({
  name: text('用户组名称', { max: 32 }).optional(),
  navList: z.array(z.unknown()).optional(),
  quotaShortLinks: quota('短链配额'),
  quotaCodes: quota('活码配额'),
  quotaQrcodes: quota('子码配额'),
  quotaChannels: quota('渠道码配额'),
  quotaAssets: quota('素材配额'),
});

/** 用户列表分页；审计日志的 pageSize 上限是 200，与默认 pageQuery 的 100 不同。 */
export const listUsersQuery = z.object({
  page: z.coerce.number().catch(1).transform((n) => Math.max(1, Math.trunc(n) || 1)),
  pageSize: z.coerce.number().catch(20).transform((n) => Math.min(100, Math.max(1, Math.trunc(n) || 1))),
  keyword: z.string().trim().default(''),
});

export const auditLogsQuery = z.object({
  page: z.coerce.number().catch(1).transform((n) => Math.max(1, Math.trunc(n) || 1)),
  pageSize: z.coerce.number().catch(50).transform((n) => Math.min(200, Math.max(1, Math.trunc(n) || 1))),
});
