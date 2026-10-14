/**
 * API 客户端。
 *
 * 令牌只放在内存 + sessionStorage：
 * 后台是同源部署，但仍然避免 localStorage 长期驻留带来的 XSS 放大效应。
 */
const TOKEN_KEY = 'dwz.token';

let token = sessionStorage.getItem(TOKEN_KEY) ?? '';

export function setToken(value) {
  token = value ?? '';
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

export function getToken() {
  return token;
}

export function isLoggedIn() {
  return Boolean(token);
}

export class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

/**
 * 统一请求入口。
 * 401 时清理本地令牌并通知外层跳回登录页，避免每个调用点各写一遍。
 */
export async function request(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth && token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError('服务返回了非 JSON 内容', response.status);
    }
  }

  if (!response.ok) {
    if (response.status === 401 && auth) {
      setToken('');
      window.dispatchEvent(new CustomEvent('dwz:unauthorized'));
    }
    throw new ApiError(payload?.msg ?? `请求失败（${response.status}）`, response.status);
  }

  return payload ?? {};
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  del: (path) => request(path, { method: 'DELETE' }),
};

export const auth = {
  bootstrap: () => request('/api/bootstrap', { auth: false }),
  login: (username, password) => request('/api/auth/login', { method: 'POST', body: { username, password }, auth: false }),
  register: (body) => request('/api/auth/register', { method: 'POST', body, auth: false }),
  logout: () => request('/api/auth/logout', { method: 'POST', auth: false }),
  me: () => request('/api/auth/me'),
  changePassword: (body) => request('/api/auth/password', { method: 'POST', body }),
};
