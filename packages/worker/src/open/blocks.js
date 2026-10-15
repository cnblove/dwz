import { notFound, ok } from '../lib/http.js';
import { authorizeCall } from '../lib/openApiCore.js';
import { blockActionSchema } from '../schemas/openResource.js';
import * as channels from '../routes/channels.js';

/**
 * 渠道码的访客黑名单。
 *
 * 三种用法压在一个动作里（list / add / remove），因为它们操作的是同一张
 * 表、在后台里也是同一块面板；拆成三个动作只会让调用方多想一步
 * 「我这个操作属于哪一类」。`dv1_action` 缺省是 list —— 「先看看有哪些」
 * 是这类操作最常见的起点。
 *
 * 加黑名单收明文 IP、落库前哈希：和后台同一口径，开放接口不引入第二种写法。
 * 解封按记录 id —— 黑名单里只有哈希，让人凭哈希去解封是难为人。
 */
export async function blockVisitors(env, resource, body, request) {
  const { cred, input } = await authorizeCall(env, request, body, blockActionSchema);

  if (input.dv1_action === 'remove') {
    const session = { id: cred.user_id, role: 'member' };
    return channels.unblockVisitor(env, input.id, session);
  }

  // add / list 都要先确认这个渠道确实是凭证主人的
  const row = await env.DB.prepare('SELECT * FROM channels WHERE slug = ?').bind(input.dv1_slug).first();
  if (!row || row.owner_id !== cred.user_id) throw notFound('渠道码不存在');

  if (input.dv1_action === 'add') {
    return channels.blockVisitor(env, { ip: input.ip }, row.id, { id: cred.user_id, role: 'member' });
  }

  const { results = [] } = await env.DB
    .prepare('SELECT id, visitor_ip, created_at FROM channel_blocks WHERE channel_id = ? ORDER BY id DESC LIMIT 100')
    .bind(row.id)
    .all();

  return ok({
    resource: 'channels',
    slug: row.slug,
    title: row.title,
    total: results.length,
    blocks: results.map((item) => ({ id: item.id, ipHash: item.visitor_ip, createdAt: item.created_at })),
  });
}
