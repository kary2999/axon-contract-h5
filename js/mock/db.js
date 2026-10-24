// Mock 数据库：内存 + localStorage 持久化。结构为「内部格式」（数值用 number、数量用张），
// 对外输出时由 mappers.js 转换成接口文档约定的字符串字段。

import { oid, iso } from './util.js';
import { fixtures, toMs } from './data.js';

const KEY = 'axon_mock_db_v3';

import { config } from '../config.js';
export const DEMO_EMAIL = fixtures.demo.email;

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
// 演示账号种子：读取 mock-data/demo-account.json（接口响应格式，来自 api-doc/mock），转成内部格式。
// 想改演示数据：改 api-doc/mock/demo-account.json，再跑 scripts/sync-mock.sh，刷新页面并「重置 Mock 数据」。
// ---------------------------------------------------------------------------
const N = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

function posFrom(p) {
  const open = p.position_status === 'OPEN';
  const realized = N(p.realized_pnl_amount) || 0;
  return blankPosition({
    oid: p.position_oid, symbol: p.symbol, side: p.position_side, status: p.position_status, leverage: p.leverage,
    qty: open ? N(p.position_qty) : 0, max_qty: N(p.position_qty), avg: N(p.avg_price), margin: open ? N(p.position_margin_amount) : 0,
    opened: toMs(p.opened_time), closed: toMs(p.closed_time), close_type: p.close_type || null, close_avg: N(p.close_avg_price) || 0,
    close_pnl: N(p.close_pnl_amount) || 0, fee: N(p.fee_amount) || 0, funding: N(p.funding_amount) || 0, realized,
    trigger_price: N(p.trigger_price), liq_at_close: N(p.liq_price_at_close), adl_level: p.adl_level || 1,
    margin0: p.close_type === 'LIQUIDATED' ? Math.abs(realized) : undefined,
    events: (p.timeline || []).map((e) => ({ ...e, time: toMs(e.time) })),
  });
}

function orderFrom(o) {
  const filled = N(o.filled_qty) || 0;
  const visible = N(o.iceberg_visible_qty);
  const idx = o.iceberg_slice_index || 0;
  const create = toMs(o.create_time);
  return blankOrder({
    oid: o.order_oid, symbol: o.symbol, order_type: o.order_type, side: o.position_side, effect: o.position_effect, status: o.order_status,
    price: N(o.price), price_source: o.price_source || 'MANUAL', qty: N(o.quantity) || 0, filled, avg_fill: N(o.avg_fill_price) || 0,
    leverage: o.leverage, frozen: N(o.frozen_margin_amount) || 0, reduce_only: !!o.reduce_only, tif: o.time_in_force || 'GTC',
    tp: N(o.tp_trigger_price), sl: N(o.sl_trigger_price), attach_done: o.position_effect === 'OPEN' && filled > 0 && !!(o.tp_trigger_price || o.sl_trigger_price),
    trigger_price: N(o.trigger_price), trigger_cond: o.trigger_condition || null, triggered_type: o.triggered_order_type || null, triggered: !!o.is_triggered,
    trailing_mode: o.trailing_mode || null, trailing_cb: N(o.trailing_callback_value), trailing_act: N(o.trailing_activation_price), trailing_activated: !!o.trailing_activated,
    trailing_anchor: N(o.trailing_anchor_price), trailing_stop: N(o.trailing_stop_price),
    iceberg_visible: visible, iceberg_slices: o.iceberg_slice_total || 0, iceberg_index: idx, iceberg_slice_qty: N(o.iceberg_slice_qty) || 0,
    iceberg_slice_filled: visible ? Math.max(0, filled - (idx - 1) * visible) : 0,
    position_oid: o.position_oid || null, fee: N(o.fee_amount) || 0, slippage: N(o.slippage_rate), cancel_reason: o.cancel_reason || null,
    fail_reason: o.fail_reason || null, fail_detail: o.fail_detail || null, create, update: toMs(o.update_time) || create,
    trigger_time: toMs(o.trigger_time), expire: toMs(o.expire_time), timeline: (o.timeline || []).map((t) => ({ ...t, time: iso(toMs(t.time)) })),
  });
}

export function seedDemo(acct) {
  const f = fixtures.demo;
  acct.available = N(f.available_balance);
  acct.risk_acked = !!f.is_risk_acked;
  acct.favorites = [...f.favorites];
  acct.settings = JSON.parse(JSON.stringify(f.settings));
  acct.trade_settings = { ...f.trade_settings };
  acct.positions = f.positions.map(posFrom);
  acct.orders = [...f.orders_current, ...f.orders_history].map(orderFrom);
  acct.fills = f.fills.map((x) => ({
    oid: x.fill_oid, order_oid: x.order_oid || null, symbol: x.symbol, side: x.position_side, effect: x.position_effect, order_type: x.order_type,
    slice: x.iceberg_slice_index || null, role: x.fill_role, price: N(x.price), qty: N(x.quantity), amount: N(x.fill_amount), fee: N(x.fee_amount),
    fee_rate: N(x.fee_rate), pnl: N(x.realized_pnl_amount), position_oid: x.position_oid || null, time: toMs(x.fill_time),
  }));
  acct.ledgers = f.ledgers.map((x) => ({
    oid: x.ledger_oid, type: x.ledger_type, amount: N(x.ledger_amount), before: N(x.before_balance), after: N(x.after_balance), desc: x.biz_desc,
    symbol: x.symbol || null, liq_price: N(x.liquidation_price), position_oid: x.ref_position_oid || null, time: toMs(x.create_time),
  }));
  acct.api_keys = f.api_keys.map((k) => ({ ...k, oid: k.api_key_oid, create_time: iso(toMs(k.create_time)), last_used_time: k.last_used_time ? iso(toMs(k.last_used_time)) : undefined, expire_time: k.expire_time ? iso(toMs(k.expire_time)) : undefined }));
  acct.keys_seeded = true;
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
