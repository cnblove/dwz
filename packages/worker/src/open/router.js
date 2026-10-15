import { badRequest, notFound } from '../lib/http.js';
import { OPEN_API_VERSION } from './catalog.js';
import { OPEN_API_ACTIONS, OPEN_API_RESOURCES } from '../schemas/openApi.js';
import {
  createResource,
  deleteResource,
  getResource,
  listResources,
  resetResource,
  updateResource,
} from './resources.js';
import {
  createQrcodeAction,
  deleteQrcodeAction,
  listQrcodesAction,
  resetQrcodeAction,
  updateQrcodeAction,
} from './qrcodes.js';
import { resourceStats } from './stats.js';
import { blockVisitors } from './blocks.js';
import { ADMIN_ACTIONS, runAdminAction } from './admin.js';

/**
 * 开放接口的动词分发。
 *
 * 路径一律是 `POST /open/v1/{命名空间}/{动作}`，动作里同时表达
 * 「资源 + 动词」（`short-links/list`、`users/reset-password`）。
 * 为什么把动作用连字符压在同一个路径段里，而不是 `/{资源}/{动词}` 两段：
 * 两段会与「命名空间只有一个」的动作（如 `stats`）抢同一层路径，
 * 而读操作也要 POST，没法靠 HTTP 方法区分。
 *
 * 全部参数都在 body 里，**包括读操作**：签名是 body 的一部分，
 * 放进 query 会让密钥出现在 URL 与访问日志里，也会被平台按 URL 缓存。
 */
const RESOURCE_ACTIONS = {
  create: createResource,
  list: listResources,
  get: getResource,
  delete: deleteResource,
  update: updateResource,
  reset: resetResource,
  blocks: blockVisitors,
};

const QRCODE_ACTIONS = {
  list: listQrcodesAction,
  create: createQrcodeAction,
  update: updateQrcodeAction,
  delete: deleteQrcodeAction,
  reset: resetQrcodeAction,
};

/**
 * 顶层动作：命名空间直接就是一个动作名。
 *
 * `stats` 排在 resources 之前 —— 否则 `short-links` 之外的任何单段路径
 * 都会先被当作「命名空间」查一遍表，错误信息也会变成「命名空间不存在」。
 */
const TOP_LEVEL = {
  stats: (env, body, request) => resourceStats(env, body, request),
};

export async function dispatchOpen(env, body, request, path) {
  const segments = String(path ?? '').split('/').filter(Boolean);
  const [namespace, second, third] = segments;
  if (!namespace) throw notFound(`接口不存在，当前版本 ${OPEN_API_VERSION}`);

  // 三段路径只有一种合法形状：`codes/qrcodes/{动作}`。
  // 子码在语义上是「活码底下的子资源」，路径把它写出来，
  // 比压成一个 `codes/qrcodes-create` 段更贴近调用方脑子里的模型。
  if (segments.length === 3) {
    if (namespace !== 'codes' || second !== 'qrcodes') {
      throw notFound(`动作不存在：${path}，当前版本 ${OPEN_API_VERSION}`);
    }
    return dispatchVerb(env, QRCODE_ACTIONS, third, body, request, 'codes/qrcodes');
  }
  if (segments.length > 3) {
    throw notFound(`动作不存在：${path}，当前版本 ${OPEN_API_VERSION}`);
  }

  // 单段路径：`stats` 这类「命名空间本身就是一个动作」的入口。
  // 它没有资源可指，所以不套 `{资源}/{动作}` 的形状 —— 硬套一个假资源名
  // 只会让文档里多一个查不到的东西。
  if (!second) {
    if (TOP_LEVEL[namespace]) return TOP_LEVEL[namespace](env, body, request, namespace);
    throw notFound(`动作不存在：${path}，当前版本 ${OPEN_API_VERSION}`);
  }

  const action = second;

  if (namespace === 'codes' && action === 'qrcodes') {
    throw notFound('子码动作要写成 codes/qrcodes/{list|create|update|delete|reset}');
  }

  if (OPEN_API_RESOURCES.includes(namespace) && RESOURCE_ACTIONS[action]) {
    return RESOURCE_ACTIONS[action](env, namespace, body, request);
  }

  const admin = ADMIN_ACTIONS[namespace]?.[action];
  if (admin) {
    return runAdminAction(env, body, request, admin);
  }

  throw notFound(`动作不存在：${path}，可先 GET /open/v1 查看目录`);
}

function dispatchVerb(env, table, verb, body, request, label) {
  const handler = table[verb];
  if (!handler) {
    throw notFound(`动作不存在：${label}/${verb}，可用：${Object.keys(table).join(' / ')}`);
  }
  return handler(env, body, request);
}

/**
 * 动作清单一致性校验。
 *
 * 分发表与目录必须来自同一份清单：上一轮「缺 update」就是
 * 「分发有一份、目录有另一份」造成的。这里把这条不变量写成代码，
 * 测试会跑它 —— 加动作时忘了同步，测试就红。
 */
export function assertActionCoverage() {
  for (const [namespace, actions] of Object.entries(ADMIN_ACTIONS)) {
    const listed = OPEN_API_ACTIONS[namespace];
    if (!listed) throw badRequest(`目录缺少命名空间 ${namespace}`);
    for (const action of Object.keys(actions)) {
      if (!listed.includes(action)) throw badRequest(`目录缺少动作 ${namespace}/${action}`);
    }
    // 反过来也要查：目录里写着、实现里没有，调用方会拿到 404
    for (const action of listed) {
      if (!actions[action]) throw badRequest(`目录里有 ${namespace}/${action}，但没有实现`);
    }
  }
  for (const resource of OPEN_API_RESOURCES) {
    for (const action of OPEN_API_ACTIONS[resource]) {
      if (action.startsWith('qrcodes/')) {
        if (!QRCODE_ACTIONS[action.slice('qrcodes/'.length)]) {
          throw badRequest(`目录里有 ${resource}/${action}，但没有实现`);
        }
      } else if (!RESOURCE_ACTIONS[action] && action !== 'blocks') {
        throw badRequest(`目录里有 ${resource}/${action}，但没有实现`);
      }
    }
  }
  return true;
}
