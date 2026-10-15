import { ok } from '../lib/http.js';
import { SIGN_FIELDS, canonicalString } from '../lib/openApiCore.js';
import { OPEN_API_ACTIONS, OPEN_API_RESOURCES, OPEN_ACCESS_LABELS } from '../schemas/openApi.js';

/**
 * 开放接口的自描述目录。
 *
 * 为什么需要它：签名接口的调用方（尤其是 AI 客户端）
 * 没法从「签名错了」这句话推出该怎么签。目录把「有哪些动作、每个动作要签什么字段、
 * 一次成功调用长什么样」摊在一处，调用方一次 GET 就能拿到全部线索。
 *
 * 刻意不鉴权：它是说明书，不含任何用户数据。真正的门在动作接口上。
 */
export const OPEN_API_VERSION = 'v1';

const SIGN_ORDER = SIGN_FIELDS.join('|');

/**
 * 签名 tag 位的语义。
 *
 * 三个 `dwz_*` 位原本是为「标题 / 访问限制 / 目标链接」留的，但它们
 * **按位置**参与签名，与内容无关。所以后台类动作（用户、通知渠道、
 * 域名……）直接复用这三个位置承载「资源名 / 动作名 / 资源标识」——
 * 位置、顺序、拼法完全不变，调用方不必为两类动作学两套规则。
 */
const TAG_SEMANTICS = {
  resource: 'create 时是标题，其余动作补空串',
  action: 'create 时是访问限制（any / wechat…），其余动作补空串',
  target: 'create 时是目标链接，其余动作补空串',
  keyword: '后台类动作里常用来放资源名 / 动作名 / 资源标识（位置不变，含义随动作而定）',
};

export const RESOURCE_META = {
  'short-links': {
    name: '短链',
    source: 'short_link',
    note: 'access_type 支持 any / wechat / ios / android / mobile / desktop；update 只改传进来的字段',
  },
  codes: {
    name: '活码',
    source: 'code_group',
    note: '宿主活码本身；底下的二维码走 codes/qrcodes，访客并流走 codes/merges',
  },
  channels: {
    name: '渠道码',
    source: 'channel',
    note: 'access_type 只支持 any / wechat；blocks 管理访客黑名单',
  },
};

/** 资源动作的说明。字段名与签名 tag 的对应关系写在这里，供调用方照抄。 */
const ACTIONS = {
  create: {
    summary: '创建',
    tags: ['dv1_title', 'dv1_type', 'dv1_url'],
    extra: {
      dv1_slug: '可选，自定义短链（4~32 位字母数字 _-）；不传则生成不可枚举的随机串',
      dv1_new_title: '创建后改名用；create 时用 dv1_title',
    },
    example: {
      dv1_title: '双十一活动',
      dv1_type: 'any',
      dv1_url: 'https://example.com/act',
      dv1_slug: '',
      api_key: 'dwz_xxxxxxxxxxxxxxxx',
      sign: '<按签名算法计算>',
    },
  },
  list: {
    summary: '分页列表',
    tags: ['dv1_title', 'dv1_type', 'dv1_url'],
    extra: {
      dv1_page: '页码，默认 1',
      dv1_page_size: '每页条数，默认 20，上限 100',
      dv1_keyword: '标题 / slug 的模糊匹配',
    },
    example: {
      dv1_title: '',
      dv1_type: '',
      dv1_url: '',
      dv1_page: 1,
      dv1_page_size: 20,
      api_key: 'dwz_xxxxxxxxxxxxxxxx',
      sign: '<按签名算法计算>',
    },
  },
  get: {
    summary: '查看详情',
    tags: ['dv1_title', 'dv1_type', 'dv1_url'],
    extra: { dv1_slug: '要查询的 slug' },
    example: {
      dv1_title: '',
      dv1_type: '',
      dv1_url: '',
      dv1_slug: 'xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx',
      api_key: 'dwz_xxxxxxxxxxxxxxxx',
      sign: '<按签名算法计算>',
    },
  },
  update: {
    summary: '修改（只改传进来的字段）',
    tags: ['dv1_title', 'dv1_type', 'dv1_url'],
    extra: {
      dv1_slug: '要改的 slug',
      dv1_new_title: '新标题（改名用这个，不要动签名位 dv1_title）',
      dv1_target_url: '短链 / 渠道码的新目标链接',
      dv1_access_type: '新的访问限制',
      dv1_status: 'active 或 paused',
      dv1_expired_at: '短链的新过期时间；传 null 表示取消过期',
      dv1_fallback_url: '活码的新兜底链接（子码全部不可用时落到这里）',
      dv1_pick_mode: '活码的选取模式：rotate 或 random',
      dv1_remark: '活码备注',
    },
    example: {
      dv1_title: '',
      dv1_type: '',
      dv1_url: '',
      dv1_slug: 'xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx',
      dv1_new_title: '改过的标题',
      api_key: 'dwz_xxxxxxxxxxxxxxxx',
      sign: '<按签名算法计算>',
    },
  },
  delete: {
    summary: '删除',
    tags: ['dv1_title', 'dv1_type', 'dv1_url'],
    extra: { dv1_slug: '要删除的 slug' },
    example: {
      dv1_title: '',
      dv1_type: '',
      dv1_url: '',
      dv1_slug: 'xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx',
      api_key: 'dwz_xxxxxxxxxxxxxxxx',
      sign: '<按签名算法计算>',
    },
  },
  reset: {
    summary: '把访问计数清零（链接仍然可用）',
    tags: ['dv1_title', 'dv1_type', 'dv1_url'],
    extra: { dv1_slug: '要清零的 slug' },
    example: {
      dv1_title: '',
      dv1_type: '',
      dv1_url: '',
      dv1_slug: 'xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx',
      api_key: 'dwz_xxxxxxxxxxxxxxxx',
      sign: '<按签名算法计算>',
    },
  },
};

/**
 * 活码子码的动作。
 *
 * 单独一组而不是塞进 ACTIONS：子码不是「有 slug 的资源」，
 * 它的定位参数（dv1_qrcode）与签名 tag 位的对应关系也不同，
 * 混在一起会让调用方以为 codes/{动作} 也认 dv1_qrcode。
 */
const QRCODE_ACTIONS = {
  list: {
    summary: '列出某个活码下的全部子码',
    extra: { dv1_slug: '活码的 slug' },
    example: { dv1_title: '', dv1_type: '', dv1_url: '', dv1_slug: 'code-slug', api_key: 'dwz_xxxxxxxxxxxxxxxx', sign: '<按签名算法计算>' },
  },
  create: {
    summary: '给活码新增一张子码（二维码图片）',
    extra: {
      dv1_slug: '活码的 slug',
      dv1_image_url: '二维码图片地址，http/https 或以 / 开头的站内地址（如素材库的 /media/xxx）',
      dv1_contact: '可选，客服微信号（客服码用）',
      dv1_threshold: '可选，阈值；不传按活码类型给默认（群活码 200 / 客服码 0）',
    },
    example: {
      dv1_title: '',
      dv1_type: '',
      dv1_url: '',
      dv1_slug: 'code-slug',
      dv1_image_url: '/media/assets/202610/xxx.png',
      dv1_contact: 'kefu001',
      dv1_threshold: 200,
      api_key: 'dwz_xxxxxxxxxxxxxxxx',
      sign: '<按签名算法计算>',
    },
  },
  update: {
    summary: '改子码的图片 / 联系人 / 阈值 / 启停',
    extra: {
      dv1_slug: '活码的 slug',
      dv1_qrcode: '子码数字 id，或它在宿主下的序号（从 1 开始）',
      dv1_image_url: '可选，换图',
      dv1_contact: '可选，传空串表示清空',
      dv1_threshold: '可选，新的阈值',
      dv1_status: '可选，active 或 disabled（禁用后不再被选中）',
    },
    example: {
      dv1_title: '',
      dv1_type: '',
      dv1_url: '',
      dv1_slug: 'code-slug',
      dv1_qrcode: '12',
      dv1_status: 'disabled',
      api_key: 'dwz_xxxxxxxxxxxxxxxx',
      sign: '<按签名算法计算>',
    },
  },
  delete: {
    summary: '删除一张子码',
    extra: { dv1_slug: '活码的 slug', dv1_qrcode: '子码数字 id，或序号（从 1 开始）' },
    example: {
      dv1_title: '',
      dv1_type: '',
      dv1_url: '',
      dv1_slug: 'code-slug',
      dv1_qrcode: '2',
      api_key: 'dwz_xxxxxxxxxxxxxxxx',
      sign: '<按签名算法计算>',
    },
  },
  reset: {
    summary: '把一张子码的已用次数清零',
    extra: { dv1_slug: '活码的 slug', dv1_qrcode: '子码数字 id，或序号（从 1 开始）' },
    example: {
      dv1_title: '',
      dv1_type: '',
      dv1_url: '',
      dv1_slug: 'code-slug',
      dv1_qrcode: '12',
      api_key: 'dwz_xxxxxxxxxxxxxxxx',
      sign: '<按签名算法计算>',
    },
  },
};

/** 渠道码的访客黑名单：一个动作三种用法。 */
const CHANNEL_BLOCK_ACTION = {
  summary: '访客黑名单：list（默认）/ add / remove',
  extra: {
    dv1_action: 'list（默认，列黑名单）/ add（拉黑）/ remove（解封）',
    dv1_slug: 'add / list 时的渠道 slug',
    dv1_ip: 'add 时要拉黑的访客 IP（明文即可，落库前会哈希）',
    dv1_id: 'remove 时黑名单记录 id（从 list 里拿）',
  },
  example: {
    dv1_title: '',
    dv1_type: '',
    dv1_url: '',
    dv1_action: 'add',
    dv1_slug: 'channel-slug',
    dv1_ip: '1.2.3.4',
    api_key: 'dwz_xxxxxxxxxxxxxxxx',
    sign: '<按签名算法计算>',
  },
};

/**
 * 并流：把 A 活码的访客导流到 B 活码。
 *
 * 与子码同属「活码底下的二级资源」，所以单独一组而不是塞进 ACTIONS ——
 * 它不认 `dv1_qrcode`，混在一起会让调用方以为并流也要给子码编号。
 */
const MERGE_ACTIONS = {
  set: {
    summary: '把本活码的访客并流到另一个活码',
    extra: { dv1_slug: '被并流的活码 slug', dv1_to_slug: '目标活码 slug（也必须是自己的）' },
    example: {
      dv1_title: '',
      dv1_type: '',
      dv1_url: '',
      dv1_slug: 'from-slug',
      dv1_to_slug: 'to-slug',
      api_key: 'dwz_xxxxxxxxxxxxxxxx',
      sign: '<按签名算法计算>',
    },
  },
  remove: {
    summary: '取消本活码的并流',
    extra: { dv1_slug: '要取消并流的活码 slug' },
    example: {
      dv1_title: '',
      dv1_type: '',
      dv1_url: '',
      dv1_slug: 'from-slug',
      api_key: 'dwz_xxxxxxxxxxxxxxxx',
      sign: '<按签名算法计算>',
    },
  },
};

/**
 * 后台类动作的说明。
 *
 * 这些动作把「后台里能点的事」整体搬出来，所以参数名统一用 `dv1_`
 * 前缀 + snake_case：与 JSON 里其它字段保持同一种视觉，也避免
 * 与签名 tag 位（dwz_*）混淆。
 */
const ADMIN_META = {
  domains: {
    name: '域名',
    actions: {
      list: { summary: '域名列表', extra: { dv1_kind: '可选按类型筛：entry / landing / short / backup' } },
      create: { summary: '新增域名', extra: { dv1_host: '域名（可带协议，会归一成 host）', dv1_kind: 'entry / landing / short / backup', dv1_remark: '可选备注' } },
      update: { summary: '改域名', extra: { dv1_id: '域名 id', dv1_host: '新域名', dv1_kind: '新类型', dv1_remark: '新备注' } },
      delete: { summary: '删域名', extra: { dv1_id: '域名 id' } },
      probe: { summary: '探测域名是否可达（HEAD 请求）', extra: { dv1_host: '要探测的域名' } },
    },
  },
  cardkeys: {
    name: '卡密',
    actions: {
      list: { summary: '批次列表', extra: { dv1_page: '页码', dv1_page_size: '每页条数', dv1_keyword: '批次名模糊匹配' } },
      get: { summary: '批次详情（含兑换记录）', extra: { dv1_id: '批次 id' } },
      create: {
        summary: '新建批次（明文只返回一次）',
        extra: {
          dv1_name: '批次名称',
          dv1_content: '兑换后展示的内容',
          dv1_count: '生成数量',
          dv1_codes: '可选，自带明文（换行分隔或 CSV），传了就以它为准',
          dv1_expired_at: '可选过期时间',
          dv1_redirect_url: '可选兑换后跳转地址',
          dv1_low_stock: '可选库存告警阈值',
          dv1_notify_channel: '可选通知渠道 id',
        },
      },
      update: { summary: '改批次', extra: { dv1_id: '批次 id', dv1_status: 'paused 会暂停发放' } },
      delete: { summary: '删批次（卡密与兑换记录级联删除）', extra: { dv1_id: '批次 id' } },
      append: { summary: '给已有批次追加卡密（明文只返回一次）', extra: { dv1_id: '批次 id', dv1_count: '追加数量' } },
    },
  },
  assets: {
    name: '素材',
    actions: {
      list: { summary: '素材列表', extra: { dv1_page: '页码', dv1_page_size: '每页条数', dv1_keyword: '文件名 / 备注模糊匹配' } },
      upload: { summary: '上传图片（multipart/form-data）', extra: { file: '文件字段，PNG / JPG / GIF / WebP / BMP / ICO，单文件 ≤ 10MB', remark: '可选备注（表单字段）' } },
      update: { summary: '改文件名 / 备注 / 类型', extra: { dv1_id: '素材 id', dv1_filename: '新文件名', dv1_remark: '新备注' } },
      delete: { summary: '删素材（R2 对象一并删除）', extra: { dv1_id: '素材 id' } },
    },
  },
  'notify-channels': {
    name: '通知渠道',
    actions: {
      list: { summary: '渠道列表（配置只回脱敏提示）', extra: {} },
      create: { summary: '新建渠道', extra: { dv1_name: '渠道名', dv1_kind: '渠道类型', dv1_config: '配置对象（含密钥）', dv1_enabled: '是否启用' } },
      update: { summary: '改渠道', extra: { dv1_id: '渠道 id', dv1_name: '新名字', dv1_enabled: '启停', dv1_config: '新配置' } },
      delete: { summary: '删渠道', extra: { dv1_id: '渠道 id' } },
      test: { summary: '发一条测试消息', extra: { dv1_id: '渠道 id' } },
    },
  },
  users: {
    name: '用户',
    actions: {
      list: { summary: '账号列表', extra: { dv1_page: '页码', dv1_page_size: '每页条数', dv1_keyword: '账号 / 邮箱模糊匹配' } },
      create: { summary: '新建账号', extra: { dv1_username: '登录账号', dv1_password: '初始密码', dv1_role: 'owner / member', dv1_group_id: '所属用户组 id', dv1_expires_at: '可选到期时间' } },
      update: { summary: '改账号（不能改密码，也不能改自己的角色 / 停用自己）', extra: { dv1_id: '账号 id', dv1_user_status: 'active / disabled', dv1_role: 'owner / member', dv1_group_id: '新用户组' } },
      delete: { summary: '删账号（名下的码与 slug 一并释放）', extra: { dv1_id: '账号 id' } },
    },
  },
  inspection: {
    name: '巡检',
    actions: {
      list: { summary: '巡检日志', extra: { dv1_page: '页码', dv1_page_size: '每页条数', dv1_kind: 'domain / cardkey' } },
      run: { summary: '立刻执行一次巡检', extra: {} },
    },
  },
  credentials: {
    name: 'API 凭证（自管）',
    actions: {
      list: { summary: '凭证列表（secret 只回脱敏提示）', extra: {} },
      create: { summary: '新建凭证（明文只返回一次）', extra: { dv1_quota: '可选调用配额，留空 = 不限额', dv1_expires_at: '可选到期时间，缺省 90 天', dv1_ip_allowlist: '可选 IP 白名单，逗号分隔' } },
      update: { summary: '改凭证', extra: { dv1_id: '凭证 id', dv1_credential_status: 'active / paused', dv1_quota: '新配额' } },
      delete: { summary: '删凭证', extra: { dv1_id: '凭证 id' } },
    },
  },
  'stats-admin': {
    name: '统计运维',
    actions: {
      prune: { summary: '清理聚合数据的保留窗口', extra: { dv1_keep_days: '保留天数，默认 90' } },
      visitors: { summary: '最近访客明细（含原始 IP，保留期见配置）', extra: { dv1_page: '页码', dv1_page_size: '每页条数，上限 50' } },
      setting: { summary: '改访客明细保留天数', extra: { dv1_keep_days: '1~365 天' } },
      clear: { summary: '清空访客明细', extra: {} },
    },
  },
};

/** 目录本身也带上 origin，方便调用方拼出完整地址。 */
function originOf(env, request) {
  return (request && (env.SHORT_ORIGIN || new URL(request.url).origin)) || '';
}

export async function catalog(env, request) {
  const origin = originOf(env, request);

  // 子码动作挂在 codes 下，因此拼进 codes 资源的 actions 里 ——
  // 调用方扫一眼某资源就能看到它全部可用动作，不必去别处找。
  const qrcodeActions = Object.entries(QRCODE_ACTIONS).map(([action, meta]) =>
    describeSubAction('qrcodes', action, meta),
  );
  const mergeActions = Object.entries(MERGE_ACTIONS).map(([action, meta]) =>
    describeSubAction('merges', action, meta),
  );

  const resources = OPEN_API_RESOURCES.map((key) => {
    const meta = RESOURCE_META[key];
    return {
      resource: key,
      name: meta.name,
      note: meta.note,
      statsSource: meta.source,
      actions: [
        ...OPEN_API_ACTIONS[key]
          // 二级资源（qrcodes / merges）有自己的一份说明，下面单独拼，
          // 不走这条「资源 × 动词」的展开 —— 它们的定位参数与宿主不同。
          .filter((action) => !action.includes('/'))
          .map((action) => {
            const spec = action === 'blocks' ? CHANNEL_BLOCK_ACTION : ACTIONS[action];
            return {
              action,
              path: `/open/v1/${key}/${action}`,
              summary: spec.summary,
              // 参与签名的字段顺序：调用方照这个顺序拼 | 即可
              signFields: spec.tags ?? ACTIONS.get.tags,
              params: spec.extra,
              example: spec.example,
            };
          }),
        ...(key === 'codes' ? [...qrcodeActions, ...mergeActions] : []),
      ],
    };
  });

  // 后台类命名空间：形状与资源一致，但用 id 定位、多数需要 owner 授权。
  const admin = Object.entries(ADMIN_META).map(([namespace, meta]) => ({
    resource: namespace,
    name: meta.name,
    note: '后台类动作：参数用 dv1_id / dv1_* 命名，清单与后台页面一一对应',
    actions: OPEN_API_ACTIONS[namespace].map((action) => {
      const spec = meta.actions[action] ?? { summary: action, extra: {} };
      return describeWithAction(namespace, action, spec);
    }),
  }));

  return ok({
    version: OPEN_API_VERSION,
    origin,
    signAlgorithm: 'HMAC-SHA256(api_secret, signString) → hex',
    signString: `<${SIGN_ORDER}> 依次用 | 连接，缺省字段补空串`,
    signTemplate: SIGN_FIELDS.map((field) => `<${field}>`).join('|'),
    signHint: '读操作（list / get / stats / 子码动作 / 后台类动作）的签名 tag 位一律补空串，不参与内容表达。',
    tagSemantics: TAG_SEMANTICS,
    accessRules: OPEN_ACCESS_LABELS,
    actions: [
      {
        action: 'stats',
        path: '/open/v1/stats',
        summary: '访问分析：小时分布 / 近 N 天趋势 / 独立访客',
        signFields: ACTIONS.get.tags,
        params: {
          dv1_slug: '要分析的 slug',
          dv1_days: '趋势天数，默认 7，上限 30',
          dv1_day: '可选，YYYY-MM-DD，看某一天的小时分布',
        },
        example: {
          dv1_title: '',
          dv1_type: '',
          dv1_url: '',
          dv1_slug: 'xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx',
          dv1_days: 7,
          api_key: 'dwz_xxxxxxxxxxxxxxxx',
          sign: '<按签名算法计算>',
        },
      },
    ],
    resources: [...resources, ...admin],
    credentialHint: {
      where: '后台「API Key」页自助创建，密钥只显示一次；也可用 credentials/create 自助再发一串',
      quota: '配额按凭证计数，每次成功鉴权扣 1',
      grant: '后台类动作需要 dv1_grant="owner"；它只对「凭证主人本身是超管」的凭证有效，声明本身不会带来权限',
    },
    // 这里反过来的示例只用于说明「串长什么样」，字段名与参与签名的
    // dwz_* 一致 —— 调用方照着拼出来的串必须与服务端算的一模一样。
    canonicalExample: canonicalString({
      dwz_title: '标题',
      dwz_type: 'any',
      dwz_url: 'https://example.com/act',
      dv1_grant: '',
      api_key: 'dwz_xxx',
      api_secret: '<你的 secret>',
    }),
  });
}

/** 二级资源动作的条目：路径是 `codes/{集合}/{动作}`，签名 tag 与读操作一致。 */
function describeSubAction(collection, action, meta) {
  return {
    action: `${collection}/${action}`,
    path: `/open/v1/codes/${collection}/${action}`,
    summary: meta.summary,
    signFields: ACTIONS.get.tags,
    params: meta.extra,
    example: meta.example,
  };
}

/** 后台类动作的条目：路径用连字符，说明取自 ADMIN_META。 */
function describeWithAction(namespace, action, spec) {
  return {
    action,
    path: `/open/v1/${namespace}/${action}`,
    summary: spec.summary,
    signFields: ACTIONS.get.tags,
    params: spec.extra ?? {},
    example: {
      dv1_title: '',
      dv1_type: '',
      dv1_url: '',
      ...Object.fromEntries(
        Object.keys(spec.extra ?? {})
          .filter((key) => key.startsWith('dv1_'))
          .map((key) => [key, '<见参数说明>']),
      ),
      dv1_grant: 'owner',
      api_key: 'dwz_xxxxxxxxxxxxxxxx',
      sign: '<按签名算法计算>',
    },
  };
}
