/**
 * 对象存储（Cloudflare R2）访问层。
 *
 * 素材库的文件本体不进 D1，只有元数据进库；这里负责把二者对上：
 *   - putObject   上传字节流到桶
 *   - getObject   按对象键取回（/media/{key} 回源用）
 *   - deleteObject 删除对象
 *
 * 关键取舍：R2 绑定（env.MEDIA）可能未被配置 —— 比如本地开发只跑了
 * `wrangler dev` 而没建桶、或测试环境根本没有绑定。这类情况不应该让
 * 整个后台崩掉，所以这里统一在「未配置」时抛可读的 AppError（503），
 * 并把配置方法写进提示里。
 */
import { AppError } from './http.js';

const NOT_CONFIGURED_MSG =
  '对象存储（R2）未配置：请在 wrangler.toml 里绑定名为 MEDIA 的 R2 桶后重新部署';

/** 有绑定才算可用；其余分支都走同一个报错，调用方不必各自判断。 */
export function assertMedia(env) {
  if (!env?.MEDIA) throw new AppError(NOT_CONFIGURED_MSG, 503);
  return env.MEDIA;
}

/**
 * 生成对象键：`assets/{yyyymm}/{uuid}{ext}`。
 * 前缀按月份分层，桶里翻文件时不会把上万个对象堆在根目录；
 * 主体用随机 UUID，避免同名文件互相覆盖（也是 object_key UNIQUE 的前提）。
 */
export function buildObjectKey(filename, now = Date.now()) {
  const date = new Date(now);
  const month = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
  return `assets/${month}/${crypto.randomUUID()}${extensionOf(filename)}`;
}

/** 取扩展名（含点），没有或过长就留空。长度限制是防止把整段垃圾串当后缀。 */
function extensionOf(filename) {
  const match = /(\.[A-Za-z0-9]{1,10})$/.exec(String(filename ?? '').trim());
  return match ? match[1].toLowerCase() : '';
}

/** 上传对象。R2 的 put 接受 ArrayBuffer/ReadableStream/字符串。 */
export async function putObject(env, key, body, { mime } = {}) {
  const bucket = assertMedia(env);
  await bucket.put(key, body, {
    httpMetadata: { contentType: mime || 'application/octet-stream' },
  });
  return key;
}

/**
 * 读对象。命中时带回 content-type 与缓存头 —— 素材是「一次上传、长期不变」，
 * 适合长缓存：URL 里的 UUID 决定内容不会变，缓存到脏数据的风险为零。
 */
export async function getObject(env, key) {
  const bucket = assertMedia(env);
  const object = await bucket.get(key);
  if (!object) return null;

  const headers = new Headers();
  headers.set('content-type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('etag', object.httpEtag);
  return { body: object.body, size: object.size, headers };
}

/** 删除对象。对象不存在时 R2 也返回成功，语义上就是「删完即无」。 */
export async function deleteObject(env, key) {
  const bucket = assertMedia(env);
  await bucket.delete(key);
}

/**
 * 素材的公开访问地址。
 *
 * 默认走同域的 `/media/{key}`，由 Worker 从 R2 回源 —— 这样不需要把桶
 * 设成公开、也不用额外配域名，开箱即用。
 * 配了 MEDIA_ORIGIN（自定义域名 / R2 公开桶 / CDN）时优先用它。
 */
export function publicUrl(env, key) {
  const origin = (env?.MEDIA_ORIGIN ?? '').replace(/\/+$/, '');
  return origin ? `${origin}/${key}` : `/media/${key}`;
}
