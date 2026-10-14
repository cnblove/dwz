import { z } from 'zod';

/**
 * 通用字段类型。
 *
 * 设计前提：前端契约固定为 {code, msg}，且所有校验错误都是 400。
 * 所以这里只产出 z.ZodType，错误形状与文案在 http.js 的 hook 里统一收敛。
 */

/**
 * 只接受 http/https。
 * 挡掉 javascript:、data: 这类会在跳转点被浏览器执行的协议 ——
 * 短链的目标地址会被 302 出去，协议白名单是这条链路上唯一的闸门。
 */
export const httpUrl = z
  .string({ error: '链接必须是字符串' })
  .trim()
  .min(1, '链接不能为空')
  .transform((value, ctx) => {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: '链接格式不正确' });
      return z.NEVER;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: '链接只支持 http/https 协议' });
      return z.NEVER;
    }
    // 归一化：与原实现一致，补全尾斜杠等（https://a.com → https://a.com/）
    return parsed.toString();
  });

/**
 * 可选链接：缺省、空串、null 都归一成 null。
 *
 * 关键点：这里用 `.default(null)` 而不是 `.optional()`。
 *
 * D1 的 bind() 不接受 undefined（会抛 D1_TYPE_ERROR），所以落库字段必须
 * 有确定的 null。而 `.optional()` 会让缺省字段的值保持 undefined ——
 * 对「部分更新」场景合适（配 `!== undefined` 判断跳过），
 * 对「整条插入」场景则是坑。要求落库 null 的地方一律用这个。
 */
export const optionalHttpUrl = z
  .union([httpUrl, z.literal(''), z.null()])
  .transform((value) => value || null)
  .default(null);

/** 可选链接（部分更新用）：缺省时不产生该键，由 handler 决定是否跳过。 */
export const optionalHttpUrlPatch = z
  .union([httpUrl, z.literal(''), z.null()])
  .transform((value) => value || null)
  .optional();

/** 必填文本，自动 trim 并按长度约束。 */
export const text = (field, { max = 200, min = 1 } = {}) =>
  z
    .string({ error: `${field}必须是字符串` })
    .trim()
    .min(min, min <= 1 ? `${field}不能为空` : `${field}至少 ${min} 个字符`)
    .max(max, `${field}长度不能超过 ${max} 个字符`);

/**
 * 可选文本：缺省/空值归一成 null，超长截断（保持原 optionalText 语义）。
 * 同样用 `.default(null)` 而非 `.optional()`，理由见 optionalHttpUrl。
 */
export const optionalText = (max = 500) =>
  z
    .union([z.string(), z.null()])
    .transform((value) => {
      const raw = String(value ?? '').trim();
      return raw ? raw.slice(0, max) : null;
    })
    .default(null);

/** 可选文本（部分更新用）：缺省时不产生该键。 */
export const optionalTextPatch = (max = 500) =>
  z
    .union([z.string(), z.null()])
    .transform((value) => {
      const raw = String(value ?? '').trim();
      return raw ? raw.slice(0, max) : null;
    })
    .optional();

/** 枚举：非法值直接拒绝，避免写进带 CHECK 约束的列。 */
export const oneOf = (allowed, field) =>
  z.enum(allowed, { error: `${field}取值不合法` });

/**
 * 布尔开关，落库为 0/1。
 * 兼容 JSON 布尔、数字与字符串三种来源 —— 前端表单、开放接口传参习惯不同。
 */
export const boolInt = (fallback = 0) =>
  z
    .union([z.boolean(), z.number(), z.string(), z.null()])
    .transform((value) => {
      if (value === null || value === '') return fallback;
      if (value === true || value === 1 || value === '1' || value === 'true') return 1;
      return 0;
    })
    .default(fallback);

/**
 * 可选布尔：缺省时整字段消失（不落默认值），供部分更新使用。
 * 与 boolInt 的区别只有这一点 —— update 语义要求「没传 = 不碰」，
 * 若用 boolInt，缺省会被填成 0，等于把字段重置。
 */
export const optionalBoolInt = () =>
  z
    .union([z.boolean(), z.number(), z.string(), z.null()])
    .transform((value) => {
      if (value === null || value === '') return 0;
      if (value === true || value === 1 || value === '1' || value === 'true') return 1;
      return 0;
    })
    .optional();

/** 正/非负整数，带上下界。 */
export const int = (field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) =>
  z
    .union([z.number(), z.string()])
    .transform((value) => Number(value))
    .refine((n) => Number.isInteger(n) && n >= min && n <= max,
      `${field}必须是 ${min}~${max} 之间的整数`);

/** 可为空的整数（如通知渠道 ID）：空值归一成 null。 */
/**
 * 可为空的整数（如通知渠道 ID）：空值归一成 null。
 *
 * 注意这里必须用 `ctx.addIssue` 而不是在 transform 里 throw：
 * zod v4 的 transform 抛出的异常会脱离 safeParse 的保护直接冒出去，
 * 而 addIssue 才能让它变成正常的校验失败。
 */
export const optionalInt = (field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) =>
  z
    .union([z.number(), z.string(), z.null()])
    .transform((value, ctx) => {
      if (value === null || value === '') return null;
      const n = Number(value);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `${field}必须是 ${min}~${max} 之间的整数` });
        return z.NEVER;
      }
      return n;
    })
    .default(null);

/** 可为空的整数（部分更新用）：缺省时不产生该键。 */
export const optionalIntPatch = (field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) =>
  z
    .union([z.number(), z.string(), z.null()])
    .transform((value, ctx) => {
      if (value === null || value === '') return null;
      const n = Number(value);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `${field}必须是 ${min}~${max} 之间的整数` });
        return z.NEVER;
      }
      return n;
    })
    .optional();

/**
 * 分页查询参数。
 *
 * 注意这里是「越界截断」而非「回落默认值」：pageSize=999 → 100。
 * 原实现是 Math.min(100, Math.max(1, n))，前端可能依赖这个宽容行为，
 * 所以用 clamp 而不是 .max().catch()。非数字才回落到默认值。
 */
const clampInt = (fallback, min, max) =>
  z.coerce
    .number()
    .catch(fallback)
    .transform((n) => Math.min(max, Math.max(min, Math.trunc(n) || min)));

export const pageQuery = z.object({
  page: clampInt(1, 1, Number.MAX_SAFE_INTEGER),
  pageSize: clampInt(20, 1, 100),
  keyword: z.string().trim().default(''),
  status: z.string().optional(),
});
