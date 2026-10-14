import { z } from 'zod';
import { oneOf, optionalText, optionalTextPatch } from './common.js';

export const DOMAIN_KINDS = ['entry', 'landing', 'short', 'backup'];

/**
 * 域名归一化：只存 host，把协议与路径挡在外面，拼接时不会出现双斜杠。
 *
 * 归一化逻辑放在 schema 里，而不是 handler 里手写 —— 创建、更新、探测
 * 三处都要用到同一套规则，放在一处避免三份实现漂移。
 */
export const hostField = z
  .string({ error: '域名必须是字符串' })
  .trim()
  .min(1, '域名不能为空')
  .transform((value, ctx) => {
    let host = value;
    if (/^https?:\/\//i.test(value)) {
      try {
        host = new URL(value).host;
      } catch {
        ctx.addIssue({ code: 'custom', message: '域名格式不正确' });
        return z.NEVER;
      }
    }
    host = host.replace(/\/+$/, '').toLowerCase();
    if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) {
      ctx.addIssue({ code: 'custom', message: '域名格式不正确' });
      return z.NEVER;
    }
    return host;
  });

export const createDomainSchema = z.object({
  host: hostField,
  kind: oneOf(DOMAIN_KINDS, '域名类型'),
  remark: optionalText(100),
});

export const updateDomainSchema = z.object({
  host: hostField.optional(),
  kind: oneOf(DOMAIN_KINDS, '域名类型').optional(),
  remark: optionalTextPatch(100),
});

/**
 * 巡检开关配置。
 * notifyChannel 存的是字符串（可能是 webhook 名称之类），与 codes 的整数 ID 不同。
 */
export const updateDomainCheckSchema = z.object({
  enabled: z.union([z.boolean(), z.number(), z.string()]).transform((v) => (v ? 1 : 0)).optional(),
  notifyChannel: optionalTextPatch(100),
  backupHost: z
    .union([hostField, z.literal(''), z.null()])
    .transform((v) => v || null)
    .optional(),
});

export const probeDomainSchema = z.object({
  host: hostField,
});

/** 域名列表筛选：kind 非法时忽略（保持宽容），不报错。 */
export const listDomainsQuery = z.object({
  kind: z.string().optional(),
});
