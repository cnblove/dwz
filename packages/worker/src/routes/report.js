import { ok } from '../lib/http.js';

/**
 * 公共上报接口：长按计数。
 *
 * 不接受登录态，因此只接受自增操作 —— 参数校验（zm_id 必须是正整数）
 * 由路由层的 validateQuery 完成，这里只做自增。
 */
export async function reportLongPress(env, id) {
  await env.DB.prepare('UPDATE code_qrcodes SET long_press = long_press + 1 WHERE id = ?').bind(id).run();
  return ok({});
}
