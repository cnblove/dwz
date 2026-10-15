import { badRequest, forbidden, notFound, ok } from '../lib/http.js';
import { authorizeCall, grantSession } from '../lib/openApiCore.js';

/**
 * 开放接口里「一组资源 × 一组动作」的通用执行器。
 *
 * 后台的路由表是一长串「路径 + 中间件 + handler」，逐个搬到开放接口里
 * 会得到第二份清单 —— 而清单一旦有两份，就会开始不一致（这次补齐
 * 缺的动作时，缺的那几个正是没有清单可对照才漏掉的）。
 *
 * 所以这里只描述**差异**：认证级别、动作、以及把 `dv1_*` 参数翻成
 * 业务函数要的字面量。业务逻辑仍然只有一份，在 routes/ 下。
 */

/** 认证级别：`self` 只看凭证主人自己的东西，`owner` 会额外打开全局视图。 */
export const SELF = 'self';
export const OWNER = 'owner';

/**
 * 执行一次动作。
 *
 * `handler` 收的是标准的 `(env, input, session, request)` —— 也就是
 * 后台 handler 原本的形状。开放接口不改它们的签名，只负责把
 * 「凭证 + 请求体」翻译成 `session`。
 */
export async function runAction({
  env,
  request,
  body,
  schema,
  level = SELF,
  handler,
  action,
  requireOwnerIdentity = false,
}) {
  const { cred, input } = await authorizeCall(env, request, body, schema);
  const session = await grantSession(env, cred, input, { owner: level === OWNER });

  // 后台里挂 `requireOwnerMiddleware` 的那批路由，在开放接口这条路上
  // 必须由凭证层再画一次同样的线：走的是会话鉴权，而我们手里只有凭证。
  // 少了这一步，一个成员账号发出来的 key 会直接读到全站用户列表。
  if (requireOwnerIdentity && session.role !== 'owner') {
    throw forbidden('该动作仅超级管理员的凭证可用（请用超管账号创建 API Key，并带 dv1_grant="owner"）');
  }

  const result = await handler(env, input, session, request);
  return shape(result, { action, resource: input?.resource });
}

/**
 * 统一出口。
 *
 * 后台的 handler 返回的是 Response（内部结构各式各样），而开放接口的
 * 调用方是脚本：它需要「这次调了哪个动作、资源叫什么」一致的形状。
 * 但**不重排业务字段** —— 后台返回什么就是什么，重组一遍等于多一处
 * 会漂移的地方，也把 handler 里那些小心思（比如卡密明文只出现一次）弄丢了。
 */
async function shape(result, extra) {
  if (!(result instanceof Response)) return result;
  const payload = await result.json().catch(() => ({}));
  const { code, msg, ...rest } = payload ?? {};
  if (result.status >= 400) return result;
  return ok({ ...extra, ...rest });
}

/** 从 body 里取一个必填的字符串字段。 */
export function need(input, key, label) {
  const value = input?.[key];
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text) throw badRequest(`缺少 ${key}${label ? `（${label}）` : ''}`);
  return text;
}

/** 数字 id：开放接口一律用 `dv1_id` 定位，避免暴露后台的路径形状。 */
export function idOf(input, label = '记录') {
  const raw = input?.dv1_id;
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw badRequest(`${label} id 必须是 1 以上的整数（dv1_id）`);
  return id;
}

/** 不存在的记录统一报 404，别在开放接口里泄漏「有这条线但你无权看」。 */
export function missing(label) {
  return notFound(`${label}不存在`);
}
