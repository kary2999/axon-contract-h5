// 全局状态（Vue reactive）。行情高频数据放 tickers，页面按 symbol 取用，避免整页重渲染。
import * as api from './api/index.js';
import { ws } from './api/ws.js';
import { auth as authToken } from './api/client.js';
import * as C from './lib/calc.js';
import { num } from './lib/format.js';

const { reactive, onMounted, onBeforeUnmount, computed } = Vue;

export const store = reactive({
  authed: !!authToken.token,
  account: null,
  symbols: {},          // symbol → 合约静态信息
  symbolList: [],
  tickers: {},          // symbol → ticker
  toasts: [],
  rev: { orders: 0, positions: 0, balance: 0 },  // 私有推送计数：页面 watch 它来刷新
  lastEvent: null,
  ack: null,            // 风险告知弹窗
});

// ------------------------------------------------------------------ Toast
let toastId = 1;
export function toast(message, type = 'info', opt = {}) {
  const t = { id: toastId++, message, type, title: opt.title, action: opt.action, onAction: opt.onAction };
  store.toasts.push(t);
  while (store.toasts.length > 3) store.toasts.shift();
  setTimeout(() => { const i = store.toasts.findIndex((x) => x.id === t.id); if (i >= 0) store.toasts.splice(i, 1); }, opt.duration || 2800);
}
export const toastErr = (e, fallback = '操作失败') => toast(e && e.msg ? e.msg : e && e.message ? e.message : fallback, 'err');

// ------------------------------------------------------------------ 账户
export async function refreshAccount() {
  try { store.account = await api.account.me(); } catch (e) { if (e.code !== 'AUTH_TOKEN_100') console.warn(e); }
  return store.account;
}
export function setAuthed(v) { store.authed = v; if (!v) { store.account = null; } }

// ------------------------------------------------------------------ 合约 / 行情
export async function loadSymbols() {
  const r = await api.market.symbols({ quote_coin: 'USDT' });
  store.symbolList = r.list;
  r.list.forEach((s) => { store.symbols[s.symbol] = { ...(store.symbols[s.symbol] || {}), ...s }; });
  return r.list;
}
export async function loadTickers() {
  const r = await api.market.tickers([]);
  r.list.forEach((t) => { store.tickers[t.symbol] = t; });
}
/** 合约详情（含档位 / 费率）：缓存到 symbols */
export async function loadSymbolDetail(symbol) {
  const s = await api.market.symbol(symbol);
  store.symbols[symbol] = { ...(store.symbols[symbol] || {}), ...s };
  return store.symbols[symbol];
}

/** 组件内订阅某些 symbol 的 ticker（卸载自动取消） */
export function useTickers(getSymbols) {
  let offs = [];
  const sub = () => {
    offs.forEach((f) => f()); offs = [];
    getSymbols().forEach((s) => offs.push(ws.subscribe(`ticker.${s}`, (m) => { store.tickers[s] = m.data; })));
  };
  onMounted(sub);
  onBeforeUnmount(() => offs.forEach((f) => f()));
  return sub;
}

/** 私有推送：登录后调用一次，把事件转成 rev 计数 + Toast */
let privOffs = [];
export function startPrivate() {
  stopPrivate();
  privOffs = [
    ws.subscribe('private.order', (m) => {
      store.rev.orders++; store.lastEvent = m.data;
      const { event, order: o } = m.data;
      if (!o) return;
      if (event === 'FILLED') toast(`${sideLabel(o)} ${o.symbol.split('-')[0]}USDT 已完全成交`, 'ok', { title: '委托成交' });
      else if (event === 'TRIGGER_FAILED') toast('计划委托触发失败：保证金不足', 'err', { title: '触发失败' });
      else if (event === 'TRIGGERED') toast(`${o.symbol.split('-')[0]}USDT 计划委托已触发`, 'info', { title: '计划委托' });
    }),
    ws.subscribe('private.position', (m) => {
      store.rev.positions++;
      const { event, position: p } = m.data;
      if (event === 'LIQUIDATED' && p) toast(`${p.symbol.split('-')[0]}USDT ${p.position_side === 'LONG' ? '多' : '空'}仓已强平，亏损 ${Math.abs(num(p.realized_pnl_amount)).toFixed(2)} USDT，已移入历史持仓`, 'err', { title: '强平通知', duration: 5000 });
      if (event === 'CLOSED' && p && p.close_type === 'TAKE_PROFIT') toast(`${p.symbol.split('-')[0]}USDT 止盈已触发`, 'ok', { title: '止盈触发' });
      if (event === 'CLOSED' && p && p.close_type === 'STOP_LOSS') toast(`${p.symbol.split('-')[0]}USDT 止损已触发`, 'warn', { title: '止损触发' });
    }),
    ws.subscribe('private.balance', (m) => {
      store.rev.balance++;
      if (store.account) {
        const d = m.data;
        Object.assign(store.account, { available_balance: d.available_balance, equity: d.equity, position_margin: d.position_margin, order_frozen: d.order_frozen, unrealized_pnl: d.unrealized_pnl });
      }
    }),
    ws.subscribe('private.risk', (m) => {
      const d = m.data;
      toast(`${d.symbol.split('-')[0]}USDT 距强平仅 ${(num(d.distance_to_liq_rate) * 100).toFixed(1)}%，请追加保证金或减仓`, 'warn', { title: '强平预警', duration: 5000 });
    }),
  ];
}
export function stopPrivate() { privOffs.forEach((f) => f()); privOffs = []; }
const sideLabel = (o) => (o.position_effect === 'OPEN' ? '开' : '平') + (o.position_side === 'LONG' ? '多' : '空');

// ------------------------------------------------------------------ 持仓实时重算（用 ticker 标记价）
export function livePosition(p) {
  const t = store.tickers[p.symbol];
  const s = store.symbols[p.symbol];
  if (!t || !s || p.position_status !== 'OPEN') return p;
  const csz = num(s.contract_size);
  const mark = num(t.mark_price);
  const qty = num(p.position_qty) * csz;
  const upnl = C.pnl(p.position_side, qty, num(p.avg_price), mark);
  const liq = num(p.liquidation_price);
  const dist = C.distToLiq(mark, liq);
  return { ...p, mark_price: t.mark_price, unrealized_pnl_amount: upnl.toFixed(2), unrealized_pnl_rate: String(num(p.position_margin_amount) ? upnl / num(p.position_margin_amount) : 0), distance_to_liq_rate: String(dist), risk_level: C.riskLevel(dist) };
}

export const lastPrice = (symbol) => num(store.tickers[symbol]?.last_price);
export const markPrice = (symbol) => num(store.tickers[symbol]?.mark_price);
export const csizeOf = (symbol) => num(store.symbols[symbol]?.contract_size) || 1;
/** 张 → 币数量字符串（按 qty_scale） */
export function coinQty(symbol, lots) {
  const s = store.symbols[symbol];
  if (!s) return String(lots);
  return (num(lots) * num(s.contract_size)).toFixed(s.qty_scale);
}
export const baseCoin = (symbol) => (symbol || '').split('-')[0];

/** 登录 / 注册成功后调用：拉账户、合约、行情并开启私有推送 */
export async function bootstrapSession() {
  setAuthed(true);
  startPrivate();
  await Promise.all([refreshAccount(), loadSymbols().then(loadTickers)]);
}
