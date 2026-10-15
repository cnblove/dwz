import { z } from 'zod';
import { oneOf } from './common.js';

/**
 * 开放接口的凭证与自描述相关 schema。
 *
 * 动作参数在 `openResource.js` / `openStats.js`；
 * 这里只管后台侧的凭证管理与目录用的枚举。
 */

const QUOTA_MAX = 100000000;

/**
 * 默认不限额（null）而不是给一个巨大的数字。
 *
 * 「配额」这一栏的意义是「本次调用预算」；给一个 10 万次的默认值，
 * 用户看到只会觉得「这功能是关着的」。要限就显式填，不限就留空 ——
 * 两种意图在界面上必须是两种写法。
 *
 * 到期时间同理：默认给 90 天，而不是 null（永不过期）。
 * 门禁卡有有效期，也有一天刷 20 次就锁 —— 两者防的不是同一件事。
 */
const QUOTA_DEFAULT = null;
const EXPIRY_DAYS_DEFAULT = 90;

/** ipAllowlist 原实现存的是「字符串化后截断 300」，保持宽容。 */
const ipAllowlistBase = z
  .union([z.string(), z.array(z.unknown()), z.null()])
  .transform((value) => {
    if (value === null || value === undefined) return null;
    const raw = Array.isArray(value) ? value.join(',') : String(value);
    const trimmed = raw.trim();
    return trimmed ? trimmed.slice(0, 300) : null;
  });

/**
 * 空串 / null 归一成 null = 不限额，其余按 1~QUOTA_MAX 校验。
 * 注意不是 `quota ?? 默认`：`quota: null` 是用户的明确意图（不限），不能当成缺省。
 */
const quotaField = z
  .union([z.number(), z.string(), z.null()])
  .default(QUOTA_DEFAULT)
  .transform((value, ctx) => {
    if (value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > QUOTA_MAX) {
      ctx.addIssue({ code: 'custom', message: `配额必须是 1~${QUOTA_MAX} 之间的整数，留空表示不限额` });
      return z.NEVER;
    }
    return n;
  });

export const createCredentialSchema = z.object({
  // 缺省归一成 null，保证能直接 bind 进 D1（undefined 会被 D1 拒绝）
  ipAllowlist: ipAllowlistBase.default(null),
  quota: quotaField,
  // 刻意不给 default(null)：缺省 = 走服务端的 90 天默认，
  // 显式传 null 才是「永不过期」。两者语义不同，不能用同一个兜底值抹平。
  expiresAt: z.union([z.string(), z.number(), z.null()]).optional(),
});

export const updateCredentialSchema = z.object({
  ipAllowlist: ipAllowlistBase.optional(),
  // 部分更新：缺省时不产生该键，不能借用 quotaField 的 default
  quota: z
    .union([z.number(), z.string(), z.null()])
    .transform((value, ctx) => {
      if (value === null || value === '') return null;
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > QUOTA_MAX) {
        ctx.addIssue({ code: 'custom', message: `配额必须是 1~${QUOTA_MAX} 之间的整数，留空表示不限额` });
        return z.NEVER;
      }
      return n;
    })
    .optional(),
  status: oneOf(['active', 'paused'], '状态').optional(),
  expiresAt: z.union([z.string(), z.number(), z.null()]).optional(),
});

/** 资源类型：也是目录里的路径段与 stats 的口径来源。 */
export const OPEN_API_RESOURCES = ['short-links', 'codes', 'channels'];

/**
 * 访问限制的中文标签。
 * 开放接口的 `dv1_type` 直接复用后台同一组取值（见 shortLinks.js 的 ACCESS_RULES），
 * 免得「后台能限制微信、开放接口却只能不限」这种口径分裂。
 */
export const OPEN_ACCESS_LABELS = {
  any: '不限',
  wechat: '仅微信',
  ios: '仅 iOS',
  android: '仅 Android',
  mobile: '仅手机浏览器',
  desktop: '仅电脑',
};
