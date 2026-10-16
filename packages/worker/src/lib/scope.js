import { notFound } from './http.js';

/**
 * 资源可见范围。
 *
 * 「超管看全部、成员只看自己的」这句话在整个后台里出现了十几次，
 * 每次都手写成 `session.role === 'owner' ? [] : [session.id]`。
 * 这种写法有三个坑，全都在真实代码里踩过：
 *
 *   1. **参数顺序**：拼 SQL 时 `where` 与 `params` 必须同增同减，
 *      漏推一个参数，语句就静默变成另一种查询（而且可能仍然「跑得通」）。
 *   2. **漏写**：新加的列表接口常常只复制了 SQL，忘了复制那两行判断 ——
 *      这次「成员能看到全站访客明细」就是这么来的。
 *   3. **只做列表不做详情**：列表按 owner 收敛了，详情接口却直接
 *      `SELECT * WHERE id = ?`，于是改一下 URL 里的 id 就能读到别人的。
 *
 * 所以这里把口径收敛成两个函数：一个给 WHERE 用，一个给「取到行之后」用。
 * 两者都是纯函数，测试直接覆盖。
 */

/** 判断某行是否对当前会话可见。owner 全部可见，成员只看自己名下的。 */
export function canAccess(ownerId, session) {
  return session?.role === 'owner' || ownerId === session?.id;
}

/**
 * 列表查询的 owner 过滤片段。
 *
 * 返回值形如 `{ clause: 'AND owner_id = ?', params: [3] }`，直接拼进 WHERE：
 *   `SELECT ... FROM t WHERE 1 = 1 ${scope.clause}`
 *
 * 刻意返回 `clause` + `params` 这一对，而不是只返回一个字符串 ——
 * 调用方就没有机会「改了 SQL 忘了改参数」。
 * 前缀写成 `AND` 而不是 `WHERE`，是为了让调用方可以继续往后面接条件。
 */
export function ownerScope(session, { column = 'owner_id' } = {}) {
  if (session?.role === 'owner') return { clause: '', params: [] };
  return { clause: `AND ${column} = ?`, params: [session?.id ?? -1] };
}

/**
 * 详情/更新/删除前的取行 + 鉴权。
 *
 * 不存在与「存在但不是你的」都折叠成 404：403 会告诉对方
 * 「这条记录真的存在」，那是一个可以用来枚举 id 的信息面。
 * 后台各处的口径本来就是一致的（`notFound('短链不存在')`），
 * 这里只是把它变成一次调用而不是三段重复代码。
 */
export function assertVisible(row, session, message = '资源不存在') {
  if (!canAccess(row?.owner_id, session)) throw notFound(message);
  return row;
}
