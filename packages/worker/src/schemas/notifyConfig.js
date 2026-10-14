import { z } from 'zod';

/**
 * 各渠道的配置结构。
 *
 * 原实现是「switch (kind) 里逐字段 assertText」，字段规则与组装逻辑混在一起。
 * 这里改成按渠道路由的 schema，校验、默认值、脱敏前的归一化都在一处，
 * 新增渠道只需要加一个 case，不用改控制流。
 */

const httpsUrl = (field, max) =>
  z
    .string({ error: `${field}必须是字符串` })
    .trim()
    .min(1, `${field}不能为空`)
    .max(max, `${field}长度不能超过 ${max} 个字符`)
    .refine((value) => /^https:\/\//i.test(value), `${field}必须是 https 地址`);

const email = (field, max = 200) =>
  z
    .string({ error: `${field}必须是字符串` })
    .trim()
    .min(1, `${field}不能为空`)
    .max(max, `${field}长度不能超过 ${max} 个字符`)
    .refine((value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value), `${field}邮箱格式不正确`);

const shortText = (field, max) =>
  z
    .string({ error: `${field}必须是字符串` })
    .trim()
    .min(1, `${field}不能为空`)
    .max(max, `${field}长度不能超过 ${max} 个字符`);

export const webhookConfig = z.object({
  url: httpsUrl('Webhook 地址', 500),
  /**
   * 方法只接受 POST/GET，大小写不敏感。
   * 未传时默认 POST —— 但注意空串也走默认，与原实现 `config.method ? ... : 'POST'` 一致。
   */
  method: z
    .union([z.string(), z.null()])
    .transform((v) => (v ? String(v).toUpperCase() : 'POST'))
    .refine((v) => ['POST', 'GET'].includes(v), '请求方法取值不合法')
    .default('POST'),
});

export const wecomConfig = z.object({
  key: shortText('企业微信 key', 200),
});

export const barkConfig = z.object({
  key: shortText('Bark key', 200),
  server: z
    .union([httpsUrl('Bark 服务器', 200), z.literal(''), z.null()])
    .transform((v) => v || 'https://api.day.app')
    .default('https://api.day.app'),
});

export const serverchanConfig = z.object({
  key: shortText('方糖 SendKey', 200),
});

export const emailConfig = z.object({
  to: email('收件人'),
  from: z
    .union([z.string(), z.null()])
    .transform((v) => String(v ?? '').trim().slice(0, 200) || 'dwz@notice.local')
    .default('dwz@notice.local'),
  subject: z
    .union([z.string(), z.null()])
    .transform((v) => String(v ?? '').trim().slice(0, 100) || '短链与活码通知')
    .default('短链与活码通知'),
});

/** 渠道路由表：kind → schema。新增渠道只加一行。 */
export const CONFIG_SCHEMAS = {
  webhook: webhookConfig,
  wecom: wecomConfig,
  bark: barkConfig,
  serverchan: serverchanConfig,
  email: emailConfig,
};
