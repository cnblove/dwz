/** JSON 响应，统一入口，避免各处重复拼装。 */
export function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function ok(data = {}) {
  return json({ code: 200, msg: 'ok', ...data });
}

/**
 * 业务错误。响应体固定为 {code, msg}，前端只认这两个字段。
 */
export class AppError extends Error {
  constructor(msg, code = 400) {
    super(msg);
    this.name = 'AppError';
    this.code = code;
  }
}

export const badRequest = (msg) => new AppError(msg, 400);
export const unauthorized = (msg = '未登录或登录已过期') => new AppError(msg, 401);
export const forbidden = (msg = '没有权限') => new AppError(msg, 403);
export const notFound = (msg = '资源不存在') => new AppError(msg, 404);

/** 读取 JSON body，空 body 与非法 JSON 都归一成空对象。 */
export async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw badRequest('请求体不是合法的 JSON');
  }
}

/**
 * 提取客户端 IP，Workers 通过 CF-Connecting-IP 透出。
 * 取不到时返回 'unknown' 而不是空串 —— 空串会让「按访客」的逻辑
 * （兑换限流、访客去重）把所有人折叠成同一个键。
 */
export function clientIp(request) {
  const direct = request.headers.get('CF-Connecting-IP');
  if (direct) return direct.trim();
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return 'unknown';
}

/**
 * D1 在库结构缺失（迁移没跑）时抛的原始错误，形如：
 *   D1_ERROR: no such table: users: SQLITE_ERROR
 * 这类错误不是「某个请求参数不对」，而是整库没初始化 —— 每个接口都会挂，
 * 但默认错误处理只会吐一句「服务暂时不可用」，让人无从下手。
 * 这里把它识别出来，好给出能直接照做的提示。
 */
export function isSchemaMissing(error) {
  const msg = String(error?.message ?? error ?? '');
  return /no such table|no such column|has no column named/i.test(msg);
}
