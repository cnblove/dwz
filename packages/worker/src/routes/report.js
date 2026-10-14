import { ok } from '../lib/http.js';
import { toPositiveInt } from '../lib/validate.js';

/** 公共上报接口：长按计数。不接受登录态，因此只接受自增操作。 */
export async function reportLongPress(env, qrcodeId) {
  const id = toPositiveInt(qrcodeId, '子码 ID', { min: 1, max: Number.MAX_SAFE_INTEGER });
  await env.DB.prepare('UPDATE code_qrcodes SET long_press = long_press + 1 WHERE id = ?').bind(id).run();
  return ok({});
}
