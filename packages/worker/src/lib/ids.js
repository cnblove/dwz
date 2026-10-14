/**
 * 对外可见的标识。
 *
 * 所有资源的 `uuid` 都是 128 位纯随机值（UUID v4）：
 *   - 短链 / 活码 / 渠道码的 uuid 就是它的 slug，公开在 URL 上，
 *     必须不可枚举、不可连号；
 *   - 卡密批次的 uuid 只用于后台展示与查询，避免用自增 ID 暴露业务量。
 * 自增主键仍保留，只用于内部关联。
 */
export function newUuid() {
  return crypto.randomUUID();
}

export function newSlug() {
  return newUuid();
}
