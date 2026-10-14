import { z } from 'zod';
import { text } from './common.js';

/**
 * 账号名约束：3~32 位字母、数字、下划线。
 * 正则放在 schema 里而不是 handler —— 它是格式约束，不是业务规则。
 */
const username = z
  .string({ error: '账号必须是字符串' })
  .trim()
  .regex(/^[A-Za-z0-9_]{3,32}$/, '账号只能包含字母、数字与下划线，长度 3~32');

const email = z
  .string()
  .trim()
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, '邮箱格式不正确')
  .max(120, '邮箱长度不能超过 120 个字符');

export const registerSchema = z.object({
  username,
  password: z.string({ error: '密码必须是字符串' }).min(8, '密码至少 8 位'),
  // 缺省归一成 null：register 会把 email 直接 bind 进 D1，undefined 会被拒
  email: z.union([email, z.literal(''), z.null()]).transform((v) => v || null).default(null),
});

export const loginSchema = z.object({
  username: text('账号', { max: 32 }),
  password: z.string({ error: '密码必须是字符串' }).min(1, '密码不能为空'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().default(''),
  newPassword: z.string({ error: '新密码必须是字符串' }).min(8, '新密码至少 8 位'),
});
