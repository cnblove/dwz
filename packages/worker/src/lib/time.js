const SHANGHAI_OFFSET_MINUTES = 8 * 60;

/** 平台的统计口径统一按北京时间切天/切小时。 */
function shanghaiParts(epochMs = Date.now()) {
  const shifted = new Date(epochMs + SHANGHAI_OFFSET_MINUTES * 60 * 1000);
  return {
    day: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    hour: shifted.getUTCHours(),
    weekday: shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function todayKey(now = Date.now()) {
  return shanghaiParts(now).day;
}

export function hourOfDay(now = Date.now()) {
  return shanghaiParts(now).hour;
}

export function nowSeconds(now = Date.now()) {
  return Math.floor(now / 1000);
}

/**
 * 判断当前是否落在配置的在线时段内。
 * hours 形如 { "1": ["09:00-12:00", "14:00-18:00"], ... }，键为 1(周一)~7(周日)。
 */
export function isWithinOnlineHours(hours, now = Date.now()) {
  if (!hours || typeof hours !== 'object') return false;
  const { weekday, minutes } = shanghaiParts(now);
  const ranges = hours[String(weekday)];
  if (!Array.isArray(ranges)) return false;
  return ranges.some((range) => {
    const [start, end] = String(range).split('-');
    const from = parseClock(start);
    const to = parseClock(end);
    if (from === null || to === null) return false;
    // 跨零点的时间段（如 22:00-02:00）
    return from <= to ? minutes >= from && minutes <= to : minutes >= from || minutes <= to;
  });
}

function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** 把 "2026-10-14" 或 "2026-10-14 12:00:00" 解析成 Unix 秒，失败返回 null。 */
export function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.floor(value) : null;
  const normalized = String(value).trim().replace(' ', 'T');
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}+08:00`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
