import { badRequest, ok } from '../lib/http.js';
import { authorizeCall, grantSession } from '../lib/openApiCore.js';
import { parseTimestamp, nowSeconds } from '../lib/time.js';
import { pruneVisits, normalizeKeepDays, saveKeepDays, visitLogSetting, listVisits } from '../lib/visitors.js';
import * as domains from '../routes/domains.js';
import * as cardkeys from '../routes/cardkeys.js';
import * as assets from '../routes/assets.js';
import * as notify from '../routes/notify.js';
import * as users from '../routes/users.js';
import * as openApi from '../lib/openApiCore.js';
import { inspectNow, listInspectionLogs } from '../domain/inspection.js';
import { ALLOWED_IMAGE_MIME, MAX_ASSET_SIZE } from '../schemas/assets.js';
import { buildObjectKey, putObject, publicUrl } from '../lib/media.js';
import {
  adminListSchema,
  assetsListSchema,
  assetsUpdateSchema,
  assetsUploadSchema,
  cardkeyAppendSchema,
  cardkeyCreateSchema,
  cardkeyUpdateSchema,
  credentialCreateSchema,
  credentialUpdateSchema,
  domainCreateSchema,
  domainListSchema,
  domainProbeSchema,
  domainUpdateSchema,
  notifyCreateSchema,
  notifyListSchema,
  notifyUpdateSchema,
  statsKeepDaysSchema,
  userCreateSchema,
  userUpdateSchema,
  usersListSchema,
} from '../schemas/openApi.js';
import { OWNER, runAction, idOf, need } from './verbs.js';

/**
 * 开放接口的「周边设施」与「后台自管」。
 *
 * 这一层存在的理由很直白：后台里能点的事情，脚本和 AI 助手也应该能做。
 * 之前开放的是业务三件套的骨架（建 / 查 / 删），缺的是「改」和所有周边 ——
 * 结果是「把它接进 CI」这件事只做到了三分之二：建得了，改不了，
 * 卡密发完了也没法补。
 *
 * 实现上刻意**不做第二份业务逻辑**：所有 handler 都直接调后台那几个
 * `routes/*.js` 里的函数，开放接口只负责把凭证翻译成会话、把
 * `dv1_*` 参数翻译成它们要的字面量。这样「后台能做的」与
 * 「API 能做的」在结构上就是同一件事，少了一处会漂移的地方。
 *
 * 授权级别（`SELF` / `OWNER`）逐条标明：
 *   - 用户、通知渠道、巡检、域名、卡密、素材等后台设施默认要求
 *     `dv1_grant: "owner"`，实际权限仍由凭证主人的身份决定；
 *   - 成员自己的资源类动作（如素材列表）允许 self，方便子账号自助。
 */

/* ---------------- 域名 ---------------- */

const domainActions = {
  list: (env, body, session) => domains.listDomains(env, { kind: body.dv1_kind }),

  create: (env, body, session) =>
    domains.createDomain(env, { host: body.dv1_host, kind: body.dv1_kind, remark: body.dv1_remark ?? null }),

  update: (env, body) =>
    domains.updateDomain(
      env,
      { host: body.dv1_host, kind: body.dv1_kind, remark: body.dv1_remark },
      idOf(body, '域名'),
    ),

  delete: (env, body) => domains.deleteDomain(env, idOf(body, '域名')),

  probe: (env, body) => domains.probeDomain(env, { host: body.dv1_host }),
};

/* ---------------- 卡密 ---------------- */

/**
 * 卡密批次。
 *
 * 明文只在 create / append 的返回里出现一次 —— 后台就是这个口径，
 * 开放接口不把它「优化」成可以重新读取：那会把一次性密钥变成
 * 一个可以反复拉的接口。
 */
const cardkeyActions = {
  list: (env, body, session) =>
    cardkeys.listBatches(env, { page: body.dv1_page, pageSize: body.dv1_page_size, keyword: body.dv1_keyword }, session),

  get: (env, body, session) => cardkeys.getBatch(env, idOf(body, '批次'), session),

  create: (env, body, session) =>
    cardkeys.createBatch(
      env,
      {
        name: body.dv1_name,
        content: body.dv1_content,
        count: body.dv1_count,
        expiredAt: body.dv1_expired_at,
        redirectUrl: body.dv1_redirect_url,
        remark: body.dv1_remark,
        lowStock: body.dv1_low_stock,
        notifyChannel: body.dv1_notify_channel,
        codeList: body.dv1_codes,
      },
      session,
    ),

  update: (env, body, session) =>
    cardkeys.updateBatch(
      env,
      {
        name: body.dv1_name,
        content: body.dv1_content,
        status: body.dv1_status,
        expiredAt: body.dv1_expired_at,
        redirectUrl: body.dv1_redirect_url,
        remark: body.dv1_remark,
        lowStock: body.dv1_low_stock,
        notifyChannel: body.dv1_notify_channel,
      },
      idOf(body, '批次'),
      session,
    ),

  delete: (env, body, session) => cardkeys.deleteBatch(env, idOf(body, '批次'), session),

  append: (env, body, session) =>
    cardkeys.appendKeys(
      env,
      { count: body.dv1_count, codeList: body.dv1_codes },
      idOf(body, '批次'),
      session,
    ),
};

/* ---------------- 素材 ---------------- */

const assetActions = {
  list: (env, body, session) =>
    assets.listAssets(env, { page: body.dv1_page, pageSize: body.dv1_page_size, kind: body.dv1_kind, keyword: body.dv1_keyword }, session),

  update: (env, body, session) =>
    assets.updateAsset(
      env,
      { filename: body.dv1_filename, remark: body.dv1_remark, kind: body.dv1_kind },
      idOf(body, '素材'),
      session,
    ),

  delete: (env, body, session) => assets.deleteAsset(env, idOf(body, '素材'), session),
};

/**
 * 素材上传。
 *
 * 这是唯一一个收二进制而不是 JSON 的动作，所以它绕开了通用执行器：
 * 请求体是 `multipart/form-data`，签名 tag 与 `api_key` / `sign` 放在
 * 表单字段里，文件本体在 `file` 字段。取原始表单要在签名之前，
 * 这和其它动作「先签名再解析」的顺序正好相反 —— 所以单独一段，
 * 而不是硬塞进 runAction。
 *
 * 为什么不收 base64：base64 会把体积撑大约 1/3，而 Worker 的请求体
 * 有硬上限 —— 大图上传时这 1/3 就是「传得上去」与「传不上去」的差别。
 */
async function uploadAssetViaOpen(env, request) {
  const form = await request.formData();
  const body = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') body[key] = value;
  }

  const { cred } = await authorizeCall(env, request, body, assetsUploadSchema);
  const session = await grantSession(env, cred, body, { owner: true });

  const file = form.get('file');
  if (!(file instanceof Blob)) throw badRequest('缺少上传文件（file 字段）');

  const mime = String(file.type ?? '').toLowerCase();
  if (!ALLOWED_IMAGE_MIME.includes(mime)) {
    throw badRequest(`不支持的图片格式：${mime || '未知'}（仅支持 PNG / JPG / GIF / WebP / BMP / ICO）`);
  }
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength === 0) throw badRequest('文件内容为空');
  if (bytes.byteLength > MAX_ASSET_SIZE) {
    throw badRequest(`文件超过 ${Math.floor(MAX_ASSET_SIZE / 1024 / 1024)}MB 上限`);
  }

  const filename = String(file.name ?? '').trim() || `image-${Date.now()}`;
  const key = buildObjectKey(filename);
  await putObject(env, key, bytes, { mime });

  // 复用后台的上传语义：库里的元数据是同一张表，地址也走同一个 publicUrl，
  // 所以之后拿到的 `/media/xxx` 能直接喂给 qrcodes create。
  const result = await env.DB
    .prepare(
      `INSERT INTO assets (filename, object_key, url, kind, mime, size, remark, owner_id, created_at)
       VALUES (?, ?, ?, 'image', ?, ?, ?, ?, ?)`,
    )
    .bind(filename.slice(0, 120), key, publicUrl(env, key), mime, bytes.byteLength, body.remark ?? null, session.id, nowSeconds())
    .run();

  const created = await env.DB.prepare('SELECT * FROM assets WHERE id = ?').bind(result.meta?.last_row_id).first();
  return ok({
    action: 'assets/create',
    item: {
      id: created.id,
      filename: created.filename,
      url: created.url,
      kind: created.kind,
      mime: created.mime,
      size: created.size,
      remark: created.remark,
    },
  });
}

/* ---------------- 通知渠道 ---------------- */

const notifyActions = {
  list: (env) => notify.listNotifyChannels(env),

  create: (env, body) => notify.createNotifyChannel(env, { name: body.dv1_name, kind: body.dv1_kind, config: body.dv1_config, enabled: body.dv1_enabled }),

  update: (env, body) =>
    notify.updateNotifyChannel(env, { name: body.dv1_name, enabled: body.dv1_enabled, config: body.dv1_config }, idOf(body, '通知渠道')),

  delete: (env, body) => notify.deleteNotifyChannel(env, idOf(body, '通知渠道')),

  test: (env, body) => notify.testNotifyChannel(env, idOf(body, '通知渠道')),
};

/* ---------------- 用户与用户组 ---------------- */

/**
 * 用户管理。
 *
 * 注意这里**没有**改密的动作：开放接口的凭证不该能替人改登录密码 ——
 * 一张泄露的 key 会因此升级成「接管后台账号」。后台里那个入口留给
 * 真人用会话操作。
 *
 * 用户组（配额、导航）也是同一类：能配它就等于能改整个后台的限额，
 * 所以只开放读取，写留给人。
 */
const userActions = {
  list: (env, body) =>
    users.listUsers(env, { page: body.dv1_page, pageSize: body.dv1_page_size, keyword: body.dv1_keyword }),

  create: (env, body, session) =>
    users.createUser(env, {
      username: need(body, 'dv1_username', '登录账号'),
      password: need(body, 'dv1_password', '初始密码'),
      email: body.dv1_email ?? null,
      role: body.dv1_role ?? 'member',
      remark: body.dv1_remark ?? null,
      groupId: body.dv1_group_id ?? null,
      expiresAt: body.dv1_expires_at,
    }),

  update: (env, body, session) =>
    users.updateUser(
      env,
      {
        email: body.dv1_email,
        remark: body.dv1_remark,
        groupId: body.dv1_group_id,
        expiresAt: body.dv1_expires_at,
        status: body.dv1_user_status,
        role: body.dv1_role,
      },
      idOf(body, '账号'),
      session,
    ),

  delete: (env, body, session) => users.deleteUser(env, idOf(body, '账号'), session),
};

/* ---------------- 统计运维 ---------------- */

/**
 * 访客明细与保留窗口。
 *
 * 这里直接复用后台那几个函数（`lib/visitors`），所以「保留 7 天」
 * 在后台和开放接口里是同一份实现、同一个数字，不会各说各话。
 */
const statsAdminActions = {
  async prune(env, body) {
    const keepDays = Math.min(365, Math.max(1, Number(body.dv1_keep_days ?? 90)));
    const cutoff = new Date(Date.now() - keepDays * 86400_000).toISOString().slice(0, 10);
    const result = await env.DB.prepare('DELETE FROM daily_visitors WHERE day < ?').bind(cutoff).run();
    return ok({ deleted: result.meta?.changes ?? 0, cutoff });
  },

  async visitors(env, body, session) {
    const page = Math.max(1, Math.trunc(Number(body.dv1_page ?? 1)) || 1);
    const pageSize = Math.min(50, Math.max(1, Math.trunc(Number(body.dv1_page_size ?? 10)) || 10));
    const [keepDays, list] = await Promise.all([
      visitLogSetting(env.DB),
      listVisits(env.DB, { page, pageSize }),
    ]);
    return ok({
      ...list,
      keepDays,
      canManage: session.role === 'owner',
      note: `原始 IP 仅保留最近 ${keepDays} 天，超期由定时任务自动清理。`,
    });
  },

  async setting(env, body) {
    if (!Number.isFinite(Number(body.dv1_keep_days))) throw badRequest('dv1_keep_days 必须是数字');
    const days = await saveKeepDays(env.DB, normalizeKeepDays(body.dv1_keep_days));
    const pruned = await pruneVisits(env.DB, days);
    return ok({ keepDays: days, pruned: pruned.deleted });
  },

  async clear(env) {
    const result = await env.DB.prepare('DELETE FROM visit_logs').run();
    return ok({ deleted: result.meta?.changes ?? 0 });
  },
};

/* ---------------- 巡检 ---------------- */

const inspectionActions = {
  async list(env, body) {
    return ok(await listInspectionLogs(env, { page: body.dv1_page, pageSize: body.dv1_page_size, kind: body.dv1_kind }));
  },
  async run(env) {
    return ok({ result: await inspectNow(env) });
  },
};

/* ---------------- 凭证自管 ---------------- */

/**
 * 凭证自己管自己。
 *
 * 为什么开放这个：让 AI 能自助发一串新 key 给别的脚本用，
 * 而不是每次都喊人去后台点一遍。但「能发 key」这件事本身很敏感，
 * 所以设了两条硬线：
 *
 *   1. `dv1_grant: "owner"` 只对**凭证主人是超管**时有效 —— 凭证
 *      不能凭空把成员变成管理员（见 grantSession）。
 *   2. 无论谁调用，创建的凭证都挂在凭证主人名下，不能替别人发 key。
 *
 * 另外这里也不给「查看明文 secret」的入口：secret 只在创建时返回一次，
 * 这条规则在后台和开放接口里必须一致，否则一次性密钥就成了摆设。
 */
const credentialActions = {
  list: (env, body, session) => openApi.listCredentials(env, session),

  create: (env, body, session) =>
    openApi.createCredential(
      env,
      {
        ipAllowlist: body.dv1_ip_allowlist,
        quota: body.dv1_quota,
        // 缺省 = 服务端默认 90 天；显式传 null 才是永不过期
        expiresAt: body.dv1_expires_at === undefined ? undefined : parseTimestamp(body.dv1_expires_at),
      },
      { id: session.id, role: session.role },
    ),

  update: (env, body, session) =>
    openApi.updateCredential(
      env,
      {
        ipAllowlist: body.dv1_ip_allowlist,
        quota: body.dv1_quota,
        status: body.dv1_credential_status,
        expiresAt: body.dv1_expires_at,
      },
      idOf(body, '凭证'),
      { id: session.id, role: session.role },
    ),

  delete: (env, body, session) => openApi.deleteCredential(env, idOf(body, '凭证'), { id: session.id, role: session.role }),
};

/* ---------------- 分发 ---------------- */

/**
 * 动作表：`命名空间 → 动作 → { handler, level }`。
 *
 * 用一张表而不是一堆 if：目录、文档与实现共用它，少一处会漂移的地方。
 * `level: OWNER` 表示该动作允许用 `dv1_grant: "owner"` 打开全局视图，
 * 不代表任何凭证都能拿到 —— 权限最终仍取决于凭证主人是不是超管。
 */
/**
 * 需要「凭证主人本身是超管」才放行的命名空间。
 *
 * 后台里这些路由挂的是 `requireOwnerMiddleware`（会话层），而开放接口
 * 走的不是会话 —— 所以必须在凭证层把同一条线再画一次，否则一个成员
 * 账号发出来的 key 会直接读到全站用户列表。
 *
 * 注意这不等价于「声明了 owner 就行」：声明只是允许打开全局视图，
 * 真正的身份仍由凭证主人决定（见 grantSession）。
 *
 * 名单为什么细到这个程度：这几个命名空间动的是**全站**数据 ——
 * 域名决定所有短链落在哪个 host、卡密是面向所有买家的凭证、
 * 素材 / 凭证 / 访客明细都带全局视图。后台里它们全在
 * `requireOwnerMiddleware` 后面；开放接口若只靠「调用方自己声明 owner」，
 * 一个成员账号发出的 key 就能改全站域名。
 *
 * 命名空间里唯一留在「成员可用」一侧的是资源类动作
 * （short-links / codes / channels 及其子码、并流）—— 它们本就按
 * user_id 收敛，成员用同一个接口管自己的码是应得的。
 */
const OWNER_NAMESPACES = new Set([
  'users',
  'notify-channels',
  'inspection',
  'domains',
  'cardkeys',
  'assets',
  'credentials',
  'stats-admin',
]);

export const ADMIN_ACTIONS = tagNamespaces({
  domains: {
    list: withSchema(domainListSchema, { level: OWNER }, domainActions.list),
    create: withSchema(domainCreateSchema, { level: OWNER }, domainActions.create),
    update: withSchema(domainUpdateSchema, { level: OWNER }, domainActions.update),
    delete: { level: OWNER, handler: domainActions.delete },
    probe: withSchema(domainProbeSchema, { level: OWNER }, domainActions.probe),
  },
  cardkeys: {
    list: withSchema(adminListSchema, { level: OWNER }, cardkeyActions.list),
    get: { level: OWNER, handler: cardkeyActions.get },
    create: withSchema(cardkeyCreateSchema, { level: OWNER }, cardkeyActions.create),
    update: withSchema(cardkeyUpdateSchema, { level: OWNER }, cardkeyActions.update),
    delete: { level: OWNER, handler: cardkeyActions.delete },
    append: withSchema(cardkeyAppendSchema, { level: OWNER }, cardkeyActions.append),
  },
  assets: {
    list: withSchema(assetsListSchema, { level: OWNER }, assetActions.list),
    update: withSchema(assetsUpdateSchema, { level: OWNER }, assetActions.update),
    delete: { level: OWNER, handler: assetActions.delete },
    upload: { level: OWNER, upload: true },
  },
  'notify-channels': {
    list: withSchema(notifyListSchema, { level: OWNER }, notifyActions.list),
    create: withSchema(notifyCreateSchema, { level: OWNER }, notifyActions.create),
    update: withSchema(notifyUpdateSchema, { level: OWNER }, notifyActions.update),
    delete: { level: OWNER, handler: notifyActions.delete },
    test: { level: OWNER, handler: notifyActions.test },
  },
  users: {
    list: withSchema(usersListSchema, { level: OWNER }, userActions.list),
    create: withSchema(userCreateSchema, { level: OWNER }, userActions.create),
    update: withSchema(userUpdateSchema, { level: OWNER }, userActions.update),
    delete: { level: OWNER, handler: userActions.delete },
  },
  inspection: {
    list: withSchema(adminListSchema, { level: OWNER }, inspectionActions.list),
    run: { level: OWNER, handler: inspectionActions.run },
  },
  'credentials': {
    list: { level: OWNER, handler: credentialActions.list },
    create: withSchema(credentialCreateSchema, { level: OWNER }, credentialActions.create),
    update: withSchema(credentialUpdateSchema, { level: OWNER }, credentialActions.update),
    delete: { level: OWNER, handler: credentialActions.delete },
  },
  'stats-admin': {
    prune: withSchema(statsKeepDaysSchema, { level: OWNER }, statsAdminActions.prune),
    visitors: withSchema(adminListSchema, { level: OWNER }, statsAdminActions.visitors),
    setting: withSchema(statsKeepDaysSchema, { level: OWNER }, statsAdminActions.setting),
    clear: { level: OWNER, handler: statsAdminActions.clear },
  },
});

/**
 * 给每个动作补上「它属于哪个命名空间」。
 *
 * 不逐条手写是为了让新增动作时不会漏 —— 漏了的表现是
 * 「这个动作不受身份闸门管」，那是安全漏洞而不是显示问题。
 */
function tagNamespaces(table) {
  const out = {};
  for (const [namespace, actions] of Object.entries(table)) {
    out[namespace] = Object.fromEntries(
      Object.entries(actions).map(([action, spec]) => [action, { ...spec, namespace }]),
    );
  }
  return out;
}

function withSchema(schema, options, handler) {
  return { ...options, schema, handler };
}

/**
 * 执行一个后台类动作。
 *
 * 认证与字段校验都在 `authorizeCall` 里（顺序：签名 → 字段）；
 * 这里加一道命名空间级的身份闸门，再分派到通用执行器 ——
 * 素材上传因为收二进制，单独走一条路。
 */
export async function runAdminAction(env, body, request, { namespace, level, schema, handler, upload }) {
  if (upload) return uploadAssetViaOpen(env, request);
  return runAction({
    env,
    request,
    body,
    schema,
    level,
    requireOwnerIdentity: OWNER_NAMESPACES.has(namespace),
    handler,
  });
}
