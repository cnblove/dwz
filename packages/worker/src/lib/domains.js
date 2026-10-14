/**
 * 域名池的选择。
 *
 * 域名分四类，语义不同：
 *   entry   入口域名 —— 访客看到的短链域名
 *   landing 落地域名 —— 实际承载落地页/跳转的域名
 *   short   短链域名 —— 轮询域名的候选池（把流量分散到多个短链域名上）
 *   backup  备用域名 —— 入口域名不可达时兜底
 *
 * 这里承载一个服务端降级策略：
 * 轮询域名全部不可用时，不能把访客丢在原地，要回落到入口/落地域名继续跳。
 */
export const DOMAIN_KINDS = ['entry', 'landing', 'short', 'backup'];

/** 轮询域名池：在所有「短链」类域名里等概率取一个。 */
export async function pickShortDomain(db) {
  const row = await db
    .prepare("SELECT host FROM domains WHERE kind = 'short' ORDER BY RANDOM() LIMIT 1")
    .first();
  return row?.host ?? null;
}

/** 备用域名：入口域名探测失败时使用。 */
export async function pickBackupDomain(db) {
  const row = await db
    .prepare("SELECT host FROM domains WHERE kind = 'backup' ORDER BY RANDOM() LIMIT 1")
    .first();
  return row?.host ?? null;
}

/** 启用域名巡检时，探测单个入口域名是否可达。失败一律视为「不知道」，交给兜底。 */
export async function probeHost(host, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  try {
    const response = await fetchImpl(`https://${host}`, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 3xx/4xx 说明 DNS 与 TLS 链路是通的，只有 5xx 才算异常
    return { reachable: response.status > 0 && response.status < 500, status: response.status };
  } catch (error) {
    return { reachable: false, status: 0, error: String(error?.message ?? error) };
  }
}

/**
 * 给轮询跳转挑一个目标域名。
 * 拿不到任何可用域名时返回 null，由调用方回退到入口域名 —— 降级路径必须存在，
 * 否则「轮询域名配置为空」会直接让短链失效。
 */
export async function pickRotatingDomain(db) {
  return pickShortDomain(db);
}
