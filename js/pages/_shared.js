// 页面间共享的小工具
const KEY = 'axon_last_symbol';
export function getDefaultSymbol() {
  try { return localStorage.getItem(KEY) || 'BTC-USDT-PERP'; } catch { return 'BTC-USDT-PERP'; }
}
export function setDefaultSymbol(s) {
  try { localStorage.setItem(KEY, s); } catch { /* 忽略 */ }
}

/** 近 N 天 → 起止时间（ISO），用于历史筛选 */
export function rangeOf(days) {
  if (!days) return {};
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  return { start: start.toISOString(), end: end.toISOString() };
}
