import { badRequest } from './http.js';

/** 只接受 http/https，挡掉 javascript: 这类会在跳转点被执行的协议。 */
export function assertHttpUrl(value, field = '链接') {
  const raw = String(value ?? '').trim();
  if (!raw) throw badRequest(`${field}不能为空`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw badRequest(`${field}格式不正确`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest(`${field}只支持 http/https 协议`);
  }
  return parsed.toString();
}

export function optionalHttpUrl(value, field = '链接') {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return assertHttpUrl(raw, field);
}

export function assertText(value, field, { max = 200, min = 1 } = {}) {
  const raw = String(value ?? '').trim();
  if (raw.length < min) throw badRequest(`${field}不能为空`);
  if (raw.length > max) throw badRequest(`${field}长度不能超过 ${max} 个字符`);
  return raw;
}

export function optionalText(value, max = 500) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return raw.slice(0, max);
}

/** 枚举校验，避免把非法值写进有 CHECK 约束的列里。 */
export function assertOneOf(value, allowed, field) {
  const raw = String(value ?? '').trim();
  if (!allowed.includes(raw)) {
    throw badRequest(`${field}取值不合法`);
  }
  return raw;
}

export function toBoolInt(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 1 || value === '1' || value === 'true') return 1;
  return 0;
}

export function toPositiveInt(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw badRequest(`${field}必须是 ${min}~${max} 之间的整数`);
  }
  return n;
}
