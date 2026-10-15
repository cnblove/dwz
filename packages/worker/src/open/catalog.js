import { ok } from '../lib/http.js';
import { SIGN_FIELDS, canonicalString } from '../lib/openApiCore.js';
import { OPEN_API_RESOURCES, OPEN_ACCESS_LABELS } from '../schemas/openApi.js';

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

/** 每个资源暴露的动作。字段名与签名 tag 的对应关系写在这里，供调用方照抄。 */
const ACTIONS = {
  create: {
    summary: '创建资源',
    tags: ['dv1_title', 'dv1_type', 'dv1_url'],
    extra: {
      dv1_slug: '可选，自定义短链（4~32 位字母数字 _-）；不传则生成不可枚举的随机串',
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
      dv1_keyword: '标题 / slug / 目标链接的模糊匹配',
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
  delete: {
    summary: '删除资源',
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
};

export const RESOURCE_META = {
  'short-links': {
    name: '短链',
    source: 'short_link',
    actions: ['create', 'list', 'get', 'delete'],
    note: 'access_type 支持 any / wechat / ios / android / mobile / desktop',
  },
  codes: {
    name: '活码',
    source: 'code_group',
    actions: ['create', 'list', 'get', 'delete'],
    note: '宿主活码本身；底下的子码走 codes/qrcodes（见 qrcodeActions）',
  },
  channels: {
    name: '渠道码',
    source: 'channel',
    actions: ['create', 'list', 'get', 'delete'],
    note: 'access_type 只支持 any / wechat',
  },
};

/**
 * 活码子码的动作。
 *
 * 单独一张表而不是塞进 ACTIONS：子码不是「有 slug 的资源」，
 * 它的定位参数（dv1_qrcode）与签名 tag 位的对应关系也不同，
 * 混在一起会让调用方以为 codes/{动作} 也认 dv1_qrcode。
 */
const QRCODE_ACTIONS = {
  list: {
    summary: '列出某个活码下的全部子码',
    extra: { dv1_slug: '活码的 slug', dv1_qrcode: '可不传；只有在 list 时忽略' },
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

/** 目录本身也带上 origin，方便调用方拼出完整地址。 */
function originOf(env, request) {
  return (request && (env.SHORT_ORIGIN || new URL(request.url).origin)) || '';
}

export async function catalog(env, request) {
  const origin = originOf(env, request);

  // 子码动作挂在 codes 下，因此拼进 codes 资源的 actions 里 ——
  // 调用方扫一眼某资源就能看到它全部可用动作，不必去别处找。
  const qrcodeActions = Object.entries(QRCODE_ACTIONS).map(([action, meta]) => ({
    action,
    path: `/open/v1/codes/qrcodes/${action}`,
    summary: meta.summary,
    signFields: ACTIONS.get.tags,
    params: meta.extra,
    example: meta.example,
  }));

  const resources = OPEN_API_RESOURCES.map((key) => {
    const meta = RESOURCE_META[key];
    return {
      resource: key,
      name: meta.name,
      note: meta.note,
      statsSource: meta.source,
      actions: [
        ...meta.actions.map((action) => ({
          action,
          path: `/open/v1/${key}/${action}`,
          summary: ACTIONS[action].summary,
          // 参与签名的字段顺序：调用方照这个顺序拼 | 即可
          signFields: ACTIONS[action].tags,
          params: ACTIONS[action].extra,
          example: ACTIONS[action].example,
        })),
        ...(key === 'codes' ? qrcodeActions : []),
      ],
    };
  });

  return ok({
    version: OPEN_API_VERSION,
    origin,
    signAlgorithm: 'HMAC-SHA256(api_secret, signString) → hex',
    signString: `<${SIGN_ORDER}> 依次用 | 连接，缺省字段补空串`,
    signTemplate: SIGN_FIELDS.map((field) => `<${field}>`).join('|'),
    signHint: '读操作（list / get / stats / 子码动作）的签名 tag 位一律补空串，不参与内容表达。',
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
    resources,
    credentialHint: {
      where: '后台「API Key」页自助创建，密钥只显示一次',
      quota: '配额按凭证计数，每次成功鉴权扣 1',
    },
    // 这里反过来的示例只用于说明「串长什么样」，字段名与参与签名的
    // dwz_* 一致 —— 调用方照着拼出来的串必须与服务端算的一模一样。
    canonicalExample: canonicalString({
      dwz_title: '标题',
      dwz_type: 'any',
      dwz_url: 'https://example.com/act',
      api_key: 'dwz_xxx',
      api_secret: '<你的 secret>',
    }),
  });
}

