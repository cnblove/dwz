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

export const createGroupSchema = z.object({
  name: text('用户组名称', { max: 32 }),
  navList: z.array(z.unknown()).default([]),
});

export const updateGroupSchema = z.object({
  name: text('用户组名称', { max: 32 }).optional(),
  navList: z.array(z.unknown()).optional(),
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
