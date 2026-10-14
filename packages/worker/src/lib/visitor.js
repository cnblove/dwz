/**
 * 访客标识一律以哈希形式落库：IP 属于个人信息，
 * 我们的统计只需要「同一天内是否同一个访客」，不需要原文。
 * 盐值取自环境，保证不同部署之间哈希不可互推。
 */
export async function visitorHash(ip, salt) {
  const input = `${salt || 'dwz'}:${ip || 'unknown'}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}
