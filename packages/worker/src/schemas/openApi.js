import { z } from 'zod';
import { int, oneOf } from './common.js';

/**
 * 开放接口的凭证与自描述相关 schema。
 *
 * 动作参数在 `openResource.js` / `openStats.js`；
 * 这里只管后台侧的凭证管理与目录用的枚举。
 */

const QUOTA_MAX = 100000000;

/** ipAllowlist 原实现存的是「字符串化后截断 300」，保持宽容。 */
const ipAllowlistBase = z
  .union([z.string(), z.array(z.unknown()), z.null()])
  .transform((value) => {
    if (value === null || value === undefined) return null;
    const raw = Array.isArray(value) ? value.join(',') : String(value);
    const trimmed = raw.trim();
    return trimmed ? trimmed.slice(0, 300) : null;
  });

export const createCredentialSchema = z.object({
  // 缺省归一成 null，保证能直接 bind 进 D1（undefined 会被 D1 拒绝）
  ipAllowlist: ipAllowlistBase.default(null),
  quota: int('配额', { min: 1, max: QUOTA_MAX }).default(100000),
  expiresAt: z.union([z.string(), z.number(), z.null()]).default(null),
});

export const updateCredentialSchema = z.object({
  ipAllowlist: ipAllowlistBase.optional(),
  quota: int('配额', { min: 1, max: QUOTA_MAX }).optional(),
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
