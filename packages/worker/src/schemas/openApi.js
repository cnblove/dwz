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
 * 每个命名空间对外开放的动作。
 *
 * 这张表是**唯一**的动作清单：路由分发、自描述目录、skill 的用法说明
 * 都以它为准，不再各写一份。上一轮缺的 `update` 就是因为
 * 「分发有一份、目录有另一份」而漏掉的。
 */
export const OPEN_API_ACTIONS = {
  'short-links': ['create', 'list', 'get', 'update', 'delete', 'reset'],
  codes: ['create', 'list', 'get', 'update', 'delete', 'reset', 'qrcodes/list', 'qrcodes/create', 'qrcodes/update', 'qrcodes/delete', 'qrcodes/reset'],
  channels: ['create', 'list', 'get', 'update', 'delete', 'reset', 'blocks'],
  domains: ['list', 'create', 'update', 'delete', 'probe'],
  cardkeys: ['list', 'create', 'get', 'update', 'delete', 'append'],
  assets: ['list', 'upload', 'update', 'delete'],
  'notify-channels': ['list', 'create', 'update', 'delete', 'test'],
  users: ['list', 'create', 'update', 'delete'],
  inspection: ['list', 'run'],
  credentials: ['list', 'create', 'update', 'delete'],
  'stats-admin': ['prune', 'visitors', 'setting', 'clear'],
};

/* ---------------- 后台类动作的参数 schema ---------------- */

/** 所有动作都要带上签名 tag 位，否则会被签名环节漏掉。 */
const tags = {
  dv1_title: z.string().optional(),
  dv1_type: z.string().optional(),
  dv1_url: z.string().optional(),
  dv1_grant: z.union([z.string(), z.null()]).optional(),
};

/** 按自增 id 定位公共字段。 */
const idField = z.union([z.string(), z.number(), z.null()]).optional();

const pagination = {
  dv1_page: z.coerce.number().catch(1).transform((n) => Math.max(1, Math.trunc(n) || 1)),
  dv1_page_size: z.coerce.number().catch(20).transform((n) => Math.min(100, Math.max(1, Math.trunc(n) || 20))),
  dv1_keyword: z.string().trim().default(''),
};

const hostField = z
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

/** 幂等：新建 / 更新共用一份可空字段的写法容易漂，这里按动作给两份。 */
const optionalString = z.union([z.string(), z.null()]).optional();
const optionalNumber = z.union([z.string(), z.number(), z.null()]).optional();

export const domainCreateSchema = z
  .object({ ...tags, dv1_host: hostField, dv1_kind: z.string().optional(), dv1_remark: optionalString })
  .passthrough()
  .transform((body) => ({ ...body, remark: body.dv1_remark ?? null }));

export const domainUpdateSchema = z
  .object({ ...tags, dv1_id: idField, dv1_host: optionalString, dv1_kind: optionalString, dv1_remark: optionalString })
  .passthrough();

export const domainProbeSchema = z.object({ ...tags, dv1_host: hostField }).passthrough();

export const assetsListSchema = z
  .object({ ...tags, ...pagination, dv1_kind: z.string().optional() })
  .passthrough();

export const assetsUpdateSchema = z
  .object({ ...tags, dv1_id: idField, dv1_filename: optionalString, dv1_remark: optionalString, dv1_kind: optionalString })
  .passthrough();

/**
 * 素材上传：正文是 `multipart/form-data`，签名 tag 与凭据放在表单字段里。
 *
 * 与其它动作唯一的差别是「读什么」—— 比如 `dv1_remark` 从表单字段取，
 * 而文件本体不参与签名（签名只覆盖那几个 tag 位，与文件内容无关）。
 * 这也是它能绕开「先验签再解析」顺序的原因：签名不依赖文件字节。
 */
export const assetsUploadSchema = z
  .object({ ...tags, dv1_remark: optionalString, dv1_kind: optionalString })
  .passthrough()
  .transform((body) => ({ ...body, remark: body.dv1_remark ?? null }));

export const usersListSchema = z
  .object({ ...tags, ...pagination })
  .passthrough();

export const notifyListSchema = z.object({ ...tags }).passthrough();

export { tags as openTags, idField as openIdField, pagination as openPagination, optionalString, optionalNumber };

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

/* ---------------- 后台类动作的细分 schema ---------------- */

/** 后台类动作的统一 tag 收口：签名位 + 授权位一个都不能少。 */
const adminBase = { ...tags, dv1_id: idField };

/** 通用分页（后台类列表动作）。 */
export const adminListSchema = z
  .object({ ...tags, ...pagination, dv1_kind: z.string().optional(), dv1_source: z.string().optional() })
  .passthrough();

/** 域名列表：只按类型筛。 */
export const domainListSchema = z.object({ ...tags, dv1_kind: z.string().optional() }).passthrough();

const optionalIntLike = z.union([z.string(), z.number(), z.null()]).optional();

export const cardkeyCreateSchema = z
  .object({
    ...tags,
    dv1_name: z.string({ error: '批次名称必须是字符串' }).trim().min(1, '批次名称不能为空').max(80, '批次名称不能超过 80 个字符'),
    dv1_content: z.union([z.string(), z.null()]).optional(),
    dv1_count: z.coerce.number().int('生成数量必须是整数').min(1).max(5000).catch(1),
    dv1_codes: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
    dv1_expired_at: optionalIntLike,
    dv1_redirect_url: optionalString,
    dv1_remark: optionalString,
    dv1_low_stock: optionalIntLike,
    dv1_notify_channel: optionalIntLike,
  })
  .passthrough()
  .transform((body) => ({
    ...body,
    dv1_content: body.dv1_content ?? '',
    dv1_low_stock: body.dv1_low_stock ?? 0,
  }));

export const cardkeyUpdateSchema = z
  .object({
    ...tags,
    ...adminBase,
    dv1_name: optionalString,
    dv1_content: optionalString,
    dv1_status: optionalString,
    dv1_expired_at: optionalIntLike,
    dv1_redirect_url: optionalString,
    dv1_remark: optionalString,
    dv1_low_stock: optionalIntLike,
    dv1_notify_channel: optionalIntLike,
  })
  .passthrough();

export const cardkeyAppendSchema = z
  .object({
    ...tags,
    ...adminBase,
    dv1_count: z.coerce.number().int('追加数量必须是整数').min(1).max(5000).catch(1),
    dv1_codes: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
  })
  .passthrough();

export const notifyCreateSchema = z
  .object({
    ...tags,
    dv1_name: z.string({ error: '渠道名称必须是字符串' }).trim().min(1, '渠道名称不能为空').max(80, '渠道名称不能超过 80 个字符'),
    dv1_kind: z.string().trim().min(1, '渠道类型不能为空'),
    dv1_config: z.record(z.string(), z.unknown()).optional(),
    dv1_enabled: z.coerce.number().int().min(0).max(1).catch(1),
  })
  .passthrough()
  .transform((body) => ({ ...body, dv1_config: body.dv1_config ?? {} }));

export const notifyUpdateSchema = z
  .object({
    ...tags,
    ...adminBase,
    dv1_name: optionalString,
    dv1_enabled: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    dv1_config: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const userCreateSchema = z
  .object({
    ...tags,
    dv1_username: z.string({ error: '登录账号必须是字符串' }).trim().min(1, '登录账号不能为空').max(50, '登录账号不能超过 50 个字符'),
    dv1_password: z.string({ error: '初始密码必须是字符串' }).min(8, '初始密码至少 8 位'),
    dv1_email: optionalString,
    dv1_role: z.enum(['owner', 'member'], { error: '角色只支持 owner 或 member' }).optional(),
    dv1_remark: optionalString,
    dv1_group_id: optionalIntLike,
    dv1_expires_at: optionalIntLike,
  })
  .passthrough()
  .transform((body) => ({ ...body, dv1_role: body.dv1_role ?? 'member' }));

/**
 * 改账号。
 *
 * 刻意不接受 `dv1_password`：开放接口的凭证不该能替人改登录密码 ——
 * 一张泄露的 key 会因此从「能建短链」升级成「接管后台账号」。
 * 后台里那个入口留给真人用会话操作。
 */
export const userUpdateSchema = z
  .object({
    ...tags,
    ...adminBase,
    dv1_email: optionalString,
    dv1_remark: optionalString,
    dv1_group_id: optionalIntLike,
    dv1_expires_at: optionalIntLike,
    dv1_user_status: optionalString,
    dv1_role: z.enum(['owner', 'member'], { error: '角色只支持 owner 或 member' }).optional(),
  })
  .passthrough();

export const credentialCreateSchema = z
  .object({
    ...tags,
    dv1_quota: z.union([z.string(), z.number(), z.null()]).optional(),
    dv1_expires_at: z.union([z.string(), z.number(), z.null()]).optional(),
    dv1_ip_allowlist: optionalString,
  })
  .passthrough();

export const credentialUpdateSchema = z
  .object({
    ...tags,
    ...adminBase,
    dv1_credential_status: optionalString,
    dv1_quota: z.union([z.string(), z.number(), z.null()]).optional(),
    dv1_expires_at: z.union([z.string(), z.number(), z.null()]).optional(),
    dv1_ip_allowlist: optionalString,
  })
  .passthrough();

export const statsKeepDaysSchema = z
  .object({ ...tags, dv1_keep_days: z.coerce.number().int().min(1).max(365).optional() })
  .passthrough();
