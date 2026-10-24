// Mock 数据库：内存 + localStorage 持久化。结构为「内部格式」（数值用 number、数量用张），
// 对外输出时由 mappers.js 转换成接口文档约定的字符串字段。

import { oid, iso, ago, MIN, HOUR, DAY } from './util.js';

const KEY = 'axon_mock_db_v2';

import { config } from '../config.js';
export const DEMO_EMAIL = config.DEMO_EMAIL;

export function blankOrder(p = {}) {
  const now = Date.now();
  return {
    oid: oid(), symbol: 'BTC-USDT-PERP', order_type: 'LIMIT', side: 'LONG', effect: 'OPEN', status: 'OPEN',
    price: null, price_source: 'MANUAL', qty: 0, filled: 0, avg_fill: 0, leverage: 20, frozen: 0,
    reduce_only: false, tif: 'GTC', tp: null, sl: null, attach_done: false,
    trigger_price: null, trigger_cond: null, triggered_type: null, triggered: false,
    trailing_mode: null, trailing_cb: null, trailing_act: null, trailing_activated: false, trailing_anchor: null, trailing_stop: null,
    iceberg_visible: null, iceberg_slices: 0, iceberg_index: 0, iceberg_slice_qty: 0, iceberg_slice_filled: 0,
    position_oid: null, fee: 0, slippage: null, cancel_reason: null, fail_reason: null, fail_detail: null,
    create: now, update: now, trigger_time: null, expire: null, timeline: [], ...p,
  };
}

export function blankPosition(p = {}) {
  return {
    oid: oid(), symbol: 'BTC-USDT-PERP', side: 'LONG', status: 'OPEN', leverage: 20, qty: 0, avg: 0, margin: 0,
    opened: Date.now(), closed: null, close_type: null, close_avg: 0, close_pnl: 0, fee: 0, funding: 0, realized: 0,
    max_qty: 0, trigger_price: null, liq_at_close: null, liq_state: 0, adl_level: 2, warned: false, events: [], ...p,
  };
}

export function newAccount(email, showUid, grant = true) {
  const t = Date.now();
  const acct = {
    uid: oid(), show_uid: showUid, email, funding_mode: 'GRANT', available: grant ? 10000 : 0,
    risk_acked: false, claimed_date: null, favorites: [], settings: {}, trade_settings: { confirm_before_order: true },
    orders: [], positions: [], fills: [], ledgers: [], api_keys: [], idem: {},
  };
  if (grant) {
    acct.ledgers.push({
      oid: oid(), type: 'GRANT', amount: 10000, before: 0, after: 10000, desc: '开通赠送体验金', time: t,
    });
  }
  return acct;
}

// ---------------------------------------------------------------------------
// 种子数据：还原原型里的演示场景（3 个持仓、10 个当前委托、若干历史）
// ---------------------------------------------------------------------------
export function seedDemo(acct) {
  const T = (ms) => Date.now() - ms;
  acct.available = 3000;
  acct.risk_acked = true;
  acct.favorites = ['BTC-USDT-PERP', 'ETH-USDT-PERP'];
  acct.settings = { 'BTC-USDT-PERP': { leverage: 20, margin_mode: 'ISOLATED' } };

  // ----- 持仓 -----
  const pSol = blankPosition({ symbol: 'SOL-USDT-PERP', side: 'LONG', leverage: 25, qty: 1096, avg: 182.45, margin: 79.99, opened: T(5 * HOUR), max_qty: 1096, adl_level: 4 });
  const pBtc = blankPosition({ symbol: 'BTC-USDT-PERP', side: 'LONG', leverage: 20, qty: 20, avg: 67200, margin: 67.2, opened: T(2 * DAY), max_qty: 20, adl_level: 2 });
  const pEth = blankPosition({ symbol: 'ETH-USDT-PERP', side: 'SHORT', leverage: 10, qty: 50, avg: 3504.42, margin: 175.22, opened: T(30 * HOUR), max_qty: 50, adl_level: 3 });
  acct.positions.push(pSol, pBtc, pEth);

  const O = (p) => { const o = blankOrder(p); o.timeline.push({ time: iso(o.create), event: 'CREATED', text: '委托已提交' }); acct.orders.push(o); return o; };

  // ----- 当前委托：普通 3 -----
  O({ symbol: 'BTC-USDT-PERP', order_type: 'LIMIT', side: 'LONG', effect: 'OPEN', status: 'PARTIALLY_FILLED', price: 67500, qty: 20, filled: 8, avg_fill: 67499.8, leverage: 20, frozen: 40.5, tp: 70000, sl: 65500, attach_done: true, create: T(3 * HOUR), update: T(2 * HOUR) });
  O({ symbol: 'BTC-USDT-PERP', order_type: 'LIMIT', side: 'SHORT', effect: 'OPEN', status: 'OPEN', price: 68100, qty: 50, leverage: 10, frozen: 340.5, create: T(2.5 * HOUR) });
  O({ symbol: 'ETH-USDT-PERP', order_type: 'LIMIT', side: 'SHORT', effect: 'CLOSE', status: 'OPEN', price: 3480, qty: 30, leverage: 10, frozen: 0, reduce_only: true, position_oid: pEth.oid, create: T(2 * HOUR) });
  // ----- 止盈止损 2 -----
  O({ symbol: 'ETH-USDT-PERP', order_type: 'TPSL', side: 'SHORT', effect: 'CLOSE', status: 'PENDING_TRIGGER', qty: 0, tp: 3300, sl: 3620, reduce_only: true, position_oid: pEth.oid, leverage: 10, create: T(28 * HOUR) });
  O({ symbol: 'BTC-USDT-PERP', order_type: 'TPSL', side: 'LONG', effect: 'CLOSE', status: 'PENDING_TRIGGER', qty: 10, tp: 69000, sl: 66000, reduce_only: true, position_oid: pBtc.oid, leverage: 20, create: T(20 * HOUR) });
  // ----- 移动止盈止损 2 -----
  O({ symbol: 'BTC-USDT-PERP', order_type: 'TRAILING', side: 'LONG', effect: 'CLOSE', status: 'PENDING_TRIGGER', qty: 0, trailing_mode: 'RATE', trailing_cb: 0.01, trailing_act: 67500, trailing_activated: true, trailing_anchor: 68120, trailing_stop: 67438.8, reduce_only: true, position_oid: pBtc.oid, leverage: 20, create: T(15 * HOUR) });
  O({ symbol: 'ETH-USDT-PERP', order_type: 'TRAILING', side: 'SHORT', effect: 'CLOSE', status: 'PENDING_TRIGGER', qty: 30, trailing_mode: 'VALUE', trailing_cb: 30, trailing_act: 3400, trailing_activated: false, reduce_only: true, position_oid: pEth.oid, leverage: 10, create: T(10 * HOUR) });
  // ----- 计划委托 2 -----
  O({ symbol: 'BTC-USDT-PERP', order_type: 'CONDITIONAL', side: 'LONG', effect: 'OPEN', status: 'PENDING_TRIGGER', price: 68600, triggered_type: 'LIMIT', trigger_price: 68500, trigger_cond: 'GTE', qty: 20, leverage: 20, create: T(6 * HOUR), expire: T(-7 * DAY + 6 * HOUR) });
  O({ symbol: 'BTC-USDT-PERP', order_type: 'CONDITIONAL', side: 'SHORT', effect: 'OPEN', status: 'PENDING_TRIGGER', triggered_type: 'MARKET', trigger_price: 66000, trigger_cond: 'LTE', qty: 30, leverage: 10, create: T(8 * HOUR), expire: T(-7 * DAY + 8 * HOUR) });
  // ----- 冰山 1 -----
  O({ symbol: 'BTC-USDT-PERP', order_type: 'ICEBERG', side: 'LONG', effect: 'OPEN', status: 'PARTIALLY_FILLED', price: 67500, qty: 500, filled: 230, avg_fill: 67499.6, leverage: 20, frozen: 911.25, iceberg_visible: 100, iceberg_slices: 5, iceberg_index: 3, iceberg_slice_qty: 70, iceberg_slice_filled: 30, create: T(4 * HOUR) });

  // ----- 历史持仓 -----
  const H = (p) => acct.positions.push(blankPosition({ status: 'CLOSED', ...p }));
  H({ symbol: 'SOL-USDT-PERP', side: 'LONG', leverage: 50, qty: 0, max_qty: 1096, avg: 182.45, margin: 0, close_type: 'LIQUIDATED', close_avg: 178.8, closed: T(1 * DAY + 2 * HOUR), opened: T(1 * DAY + 3 * HOUR), close_pnl: -40, fee: 0, realized: -40, trigger_price: 178.986, liq_at_close: 178.986, adl_level: 1,
    events: [{ time: T(1 * DAY + 2.6 * HOUR), event: 'OPEN', text: '市价开多 10.96 SOL，保证金 40.00 USDT' }, { time: T(1 * DAY + 2.2 * HOUR), event: 'RISK_WARNING', text: '标记价 179.30，距强平 < 10%，已推送提醒', mark_price: '179.300' }, { time: T(1 * DAY + 2 * HOUR), event: 'LIQUIDATION_TRIGGERED', text: '标记价跌至 178.986，触及逐仓强平价', mark_price: '178.986' }, { time: T(1 * DAY + 2 * HOUR), event: 'LIQUIDATION_SETTLED', text: '以破产价 178.800 平仓，仓位移入历史持仓' }] });
  H({ symbol: 'BTC-USDT-PERP', side: 'SHORT', leverage: 20, max_qty: 50, avg: 68420, close_type: 'ADL', close_avg: 67707.8, closed: T(1 * DAY + 11 * HOUR), opened: T(3 * DAY), close_pnl: 35.6 + 0.0, fee: 0, realized: 35.6 });
  H({ symbol: 'ETH-USDT-PERP', side: 'SHORT', leverage: 10, max_qty: 50, avg: 3548.1, close_type: 'MANUAL', close_avg: 3511.7, closed: T(2 * DAY + 5 * HOUR), opened: T(3 * DAY + 4 * HOUR), close_pnl: 18.2 + 0.88 + 0.2, fee: 0.88 + 0.2, funding: -0.21, realized: 18.2 });
  H({ symbol: 'BTC-USDT-PERP', side: 'LONG', leverage: 20, max_qty: 20, avg: 66480, close_type: 'TAKE_PROFIT', close_avg: 67600, closed: T(2 * DAY + 14 * HOUR), opened: T(2 * DAY + 15.5 * HOUR), close_pnl: 23.4, fee: 1.21, funding: 0.21, realized: 22.4, trigger_price: 67600 });
  H({ symbol: 'DOGE-USDT-PERP', side: 'SHORT', leverage: 25, max_qty: 1500, avg: 0.1241, close_type: 'STOP_LOSS', close_avg: 0.1265, closed: T(3 * DAY + 5 * HOUR), opened: T(3 * DAY + 9 * HOUR), close_pnl: -8.65, fee: 0.95, realized: -9.6, trigger_price: 0.1265 });
  H({ symbol: 'ETH-USDT-PERP', side: 'SHORT', leverage: 25, max_qty: 100, avg: 3402.5, close_type: 'LIQUIDATED', close_avg: 3550, closed: T(22 * DAY), opened: T(22.5 * DAY), close_pnl: -56, realized: -56, liq_at_close: 3535.8, trigger_price: 3535.8,
    events: [{ time: T(22.5 * DAY), event: 'OPEN', text: '市价开空 1.00 ETH，保证金 136.10 USDT' }, { time: T(22 * DAY + 10 * MIN), event: 'LIQUIDATION_TRIGGERED', text: '标记价涨至 3,535.8，触及逐仓强平价', mark_price: '3535.8' }, { time: T(22 * DAY), event: 'LIQUIDATION_SETTLED', text: '以破产价平仓，仓位移入历史持仓' }] });

  // ----- 历史委托 -----
  const HO = (p) => { const o = blankOrder({ frozen: 0, ...p }); o.timeline.push({ time: iso(o.create), event: 'CREATED', text: '委托已提交' }); acct.orders.push(o); return o; };
  HO({ order_type: 'LIMIT', side: 'LONG', effect: 'OPEN', status: 'FILLED', price: 67200, qty: 20, filled: 20, avg_fill: 67200, leverage: 20, fee: 0.27, create: T(2 * DAY), update: T(2 * DAY) });
  HO({ order_type: 'LIMIT', side: 'SHORT', effect: 'OPEN', status: 'PARTIALLY_CANCELED', price: 67950, qty: 50, filled: 12, avg_fill: 67950, leverage: 10, fee: 0.16, cancel_reason: 'USER', create: T(2.1 * DAY), update: T(2.05 * DAY) });
  HO({ symbol: 'ETH-USDT-PERP', order_type: 'MARKET', side: 'SHORT', effect: 'CLOSE', status: 'FILLED', qty: 50, filled: 50, avg_fill: 3511.7, leverage: 10, fee: 0.88, slippage: 0.0001, create: T(2 * DAY + 5 * HOUR), update: T(2 * DAY + 5 * HOUR) });
  HO({ symbol: 'DOGE-USDT-PERP', order_type: 'TPSL', side: 'SHORT', effect: 'CLOSE', status: 'FILLED', qty: 1500, filled: 1500, avg_fill: 0.12652, sl: 0.1265, leverage: 25, triggered: true, trigger_time: T(3 * DAY + 5 * HOUR), fee: 0.95, create: T(3 * DAY + 9 * HOUR), update: T(3 * DAY + 5 * HOUR) });
  HO({ order_type: 'CONDITIONAL', side: 'LONG', effect: 'OPEN', status: 'TRIGGER_FAILED', price: 68100, triggered_type: 'LIMIT', trigger_price: 68000, trigger_cond: 'GTE', qty: 200, leverage: 20, fail_reason: 'INSUFFICIENT_MARGIN', fail_detail: { required_margin_amount: '681.00', available_balance: '300.00' }, triggered: true, trigger_time: T(4 * DAY), create: T(4 * DAY + 15 * MIN), update: T(4 * DAY) });
  HO({ symbol: 'ETH-USDT-PERP', order_type: 'CONDITIONAL', side: 'SHORT', effect: 'OPEN', status: 'SYSTEM_CANCELED', triggered_type: 'MARKET', trigger_price: 3350, trigger_cond: 'LTE', qty: 30, leverage: 10, cancel_reason: 'EXPIRED', create: T(11 * DAY), update: T(4 * DAY), expire: T(4 * DAY) });
  HO({ symbol: 'SOL-USDT-PERP', order_type: 'CONDITIONAL', side: 'LONG', effect: 'OPEN', status: 'FILLED', price: 175.5, triggered_type: 'LIMIT', trigger_price: 175, trigger_cond: 'GTE', qty: 500, filled: 500, avg_fill: 175.5, leverage: 50, triggered: true, trigger_time: T(21 * DAY), fee: 0.3, create: T(22 * DAY), update: T(21 * DAY) });
  HO({ order_type: 'LIMIT', side: 'LONG', effect: 'OPEN', status: 'CANCELED', price: 66000, qty: 10, filled: 0, leverage: 20, cancel_reason: 'USER', create: T(2.2 * DAY), update: T(2.1 * DAY) });

  // ----- 成交 -----
  const F = (p) => acct.fills.push({ oid: oid(), order_oid: null, symbol: 'BTC-USDT-PERP', side: 'LONG', effect: 'OPEN', order_type: 'LIMIT', slice: null, role: 'MAKER', price: 0, qty: 0, amount: 0, fee: 0, fee_rate: 0.0002, pnl: null, position_oid: null, time: Date.now(), ...p });
  F({ order_type: 'ICEBERG', slice: 2, price: 67499.6, qty: 100, amount: 6749.96, fee: 1.35, time: T(3.5 * HOUR) });
  F({ price: 67200, qty: 20, amount: 1344, fee: 0.27, time: T(2 * DAY) });
  F({ side: 'SHORT', price: 67950, qty: 12, amount: 815.4, fee: 0.16, time: T(2.1 * DAY) });
  F({ symbol: 'ETH-USDT-PERP', side: 'SHORT', effect: 'CLOSE', order_type: 'MARKET', role: 'TAKER', price: 3511.7, qty: 50, amount: 1755.85, fee: 0.88, fee_rate: 0.0005, pnl: 18.2, time: T(2 * DAY + 5 * HOUR) });
  F({ symbol: 'DOGE-USDT-PERP', side: 'SHORT', effect: 'CLOSE', order_type: 'TPSL', role: 'TAKER', price: 0.12652, qty: 1500, amount: 189.78, fee: 0.95, fee_rate: 0.0005, pnl: -9.6, time: T(3 * DAY + 5 * HOUR) });

  // ----- 资金流水（时间倒序展示，这里按发生顺序写入） -----
  const L = (type, amount, desc, t, extra = {}) => { acct.ledgers.push({ oid: oid(), type, amount, before: 0, after: 0, desc, time: t, ...extra }); };
  L('GRANT', 10000, '开通赠送体验金', T(9 * DAY));
  L('FUNDING_FEE', -0.21, 'ETHUSDT 空 · 支付', T(2 * DAY + 13 * HOUR), { symbol: 'ETH-USDT-PERP' });
  L('REALIZED_PNL', -9.6, 'DOGEUSDT 空 · 止损', T(3 * DAY + 5 * HOUR), { symbol: 'DOGE-USDT-PERP' });
  L('FEE', -0.95, 'DOGEUSDT 止损成交', T(3 * DAY + 5 * HOUR), { symbol: 'DOGE-USDT-PERP' });
  L('REALIZED_PNL', 18.2, 'ETHUSDT 空 · 平仓', T(2 * DAY + 5 * HOUR), { symbol: 'ETH-USDT-PERP' });
  L('FEE', -0.88, 'ETHUSDT 平空成交', T(2 * DAY + 5 * HOUR), { symbol: 'ETH-USDT-PERP' });
  L('LIQUIDATION', -40, 'SOLUSDT 多 50× · 逐仓清算', T(1 * DAY + 2 * HOUR), { symbol: 'SOL-USDT-PERP', liq_price: 178.986 });
  L('FUNDING_FEE', 0.13, 'BTCUSDT 空 · 收取', T(1 * DAY + 3 * HOUR), { symbol: 'BTC-USDT-PERP' });
  L('MARGIN_ADJUST', -20, 'BTCUSDT 多 · 追加保证金', T(1 * DAY), { symbol: 'BTC-USDT-PERP' });
  L('FEE', -0.27, 'BTCUSDT 开多成交', T(6 * HOUR), { symbol: 'BTC-USDT-PERP' });
  L('CLAIM', 57.59, '每日补充，补至 10,000', T(5 * HOUR));
  // 原型里「账户页可用 3,000」与「流水页余额 ~10,000」互相矛盾；Mock 以可用余额为准，
  // 追加一条对齐用的平账行，使流水累计恰好等于当前可用余额。
  const sum = acct.ledgers.reduce((s, l) => s + l.amount, 0);
  L('ADJUST', Math.round((acct.available - sum) * 100) / 100, '演示账户初始化（对齐当前可用余额）', T(8 * DAY));
  acct.ledgers.sort((a, b) => a.time - b.time);
  let bal = 0;
  for (const l of acct.ledgers) { l.before = bal; bal += l.amount; l.after = bal; }
  return acct;
}

// ---------------------------------------------------------------------------
export function emptyDB() {
  return { users: {}, accounts: {}, session: null, seq: 58213907 };
}

export function loadDB() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const db = JSON.parse(raw);
      if (db && db.users && db.accounts) return db;
    }
  } catch (e) { /* 隐私模式 / 存储不可用：回退到内存 */ }
  return emptyDB();
}

let saveTimer = null;
export function saveDB(db) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* 忽略 */ }
  }, 300);
}

export function resetDB() {
  try { localStorage.removeItem(KEY); } catch (e) { /* 忽略 */ }
}
