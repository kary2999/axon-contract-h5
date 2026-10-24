// Mock 公共工具

/** 生成 UUIDv7 风格的 36 位小写字符串（前 48 位为毫秒时间戳） */
export function oid() {
  const ts = Date.now().toString(16).padStart(12, '0');
  const r = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const variant = (8 + Math.floor(Math.random() * 4)).toString(16);
  return `${ts.slice(0, 8)}-${ts.slice(8)}-7${r(3)}-${variant}${r(3)}-${r(12)}`;
}

export const iso = (t = Date.now()) => new Date(t).toISOString();
export const ago = (ms) => iso(Date.now() - ms);
export const MIN = 60000; export const HOUR = 3600000; export const DAY = 86400000;

/** UTC+8 的自然日，用于体验金"每日 1 次" */
export function cnDate(t = Date.now()) {
  return new Date(t + 8 * HOUR).toISOString().slice(0, 10);
}
/** 下一个 UTC+8 00:00 对应的 UTC 时间 */
export function nextCnMidnight(t = Date.now()) {
  const d = new Date(t + 8 * HOUR);
  d.setUTCHours(24, 0, 0, 0);
  return iso(d.getTime() - 8 * HOUR);
}

/** 业务错误：Mock 抛出，client 统一转成 ApiError */
export class BizError extends Error {
  constructor(code, msg, data = {}) {
    super(msg || code);
    this.code = code;
    this.data = data;
  }
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rand = (a, b) => a + Math.random() * (b - a);

/** 取小数位 */
export const fix = (v, dp = 2) => Number(v).toFixed(dp);
