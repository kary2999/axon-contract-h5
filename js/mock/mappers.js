// 内部格式 → 接口文档约定的输出（字符串金额、ISO 时间、枚举）。字段含义见 api-doc/03~05。

import { market } from './market.js';
import { iso } from './util.js';
import * as C from '../lib/calc.js';

const def = (s) => market.defs[s];
const st = (s) => market.state[s];
const S = (v, dp = 2) => Number(v).toFixed(dp);
const P = (v, symbol) => Number(v).toFixed(def(symbol).price_scale);
const csz = (s) => Number(def(s).contract_size);

export function tierFor(symbol, notional) {
  return C.tierOf(def(symbol).tiers.map((t) => ({ ...t, position_value_upper: Number(t.position_value_upper) })), notional);
}

/** 持仓的强平价（逐仓）：按当前持仓名义价值所在档位 */
export function posLiq(p) {
  const d = def(p.symbol);
  const qty = p.qty * csz(p.symbol);
  const tier = tierFor(p.symbol, qty * p.avg);
  return C.liqPrice({
    side: p.side, qty, entry: p.avg, margin: p.margin, mmr: Number(tier.maintenance_margin_rate),
    cum: Number(tier.maintenance_amount), takerFee: Number(d.taker_fee_rate),
  });
}

export function posUpnl(p) {
  return C.pnl(p.side, p.qty * csz(p.symbol), p.avg, st(p.symbol).mark);
}

/** 最少需保留的保证金（维持仓位所需），用于"可减少金额" */
export function posMinMargin(p) {
  const mark = st(p.symbol).mark;
  const d = def(p.symbol);
  const qty = p.qty * csz(p.symbol);
  const tier = tierFor(p.symbol, qty * mark);
  const mm = qty * mark * Number(tier.maintenance_margin_rate) - Number(tier.maintenance_amount);
  return Math.max(0, mm) + qty * mark * Number(d.taker_fee_rate) + qty * mark * 0.001;
}

export function orderOut(o, { detail = false } = {}) {
  const d = def(o.symbol);
  const pp = (v) => (v === null || v === undefined ? undefined : P(v, o.symbol));
  const out = {
    order_oid: o.oid, symbol: o.symbol, order_type: o.order_type, position_side: o.side, position_effect: o.effect,
    order_status: o.status, price: o.price ? P(o.price, o.symbol) : undefined, price_source: o.price_source,
    quantity: String(o.qty), filled_qty: String(o.filled), avg_fill_price: o.avg_fill ? P(o.avg_fill, o.symbol) : '0',
    leverage: o.leverage, margin_mode: 'ISOLATED', frozen_margin_amount: S(o.frozen), reduce_only: !!o.reduce_only,
    time_in_force: o.tif, tp_trigger_price: pp(o.tp), sl_trigger_price: pp(o.sl),
    trigger_price: pp(o.trigger_price), trigger_condition: o.trigger_cond || undefined, triggered_order_type: o.triggered_type || undefined,
    trigger_basis: o.trigger_price ? 'MARK_PRICE' : undefined,
    trailing_mode: o.trailing_mode || undefined,
    trailing_callback_value: o.trailing_cb !== null && o.trailing_cb !== undefined ? String(o.trailing_cb) : undefined,
    trailing_activation_price: pp(o.trailing_act), trailing_activated: o.order_type === 'TRAILING' ? !!o.trailing_activated : undefined,
    trailing_anchor_price: pp(o.trailing_anchor), trailing_stop_price: pp(o.trailing_stop),
    iceberg_visible_qty: o.iceberg_visible ? String(o.iceberg_visible) : undefined,
    iceberg_slice_total: o.iceberg_slices || undefined, iceberg_slice_index: o.iceberg_index || undefined,
    iceberg_slice_qty: o.iceberg_slices ? String(o.iceberg_slice_qty) : undefined,
    iceberg_remaining_qty: o.iceberg_slices ? String(Math.max(0, o.qty - o.filled - o.iceberg_slice_qty + o.iceberg_slice_filled)) : undefined,
    position_oid: o.position_oid || undefined, fee_amount: S(o.fee, 4),
    slippage_rate: o.slippage !== null && o.slippage !== undefined ? S(o.slippage, 4) : undefined,
    cancel_reason: o.cancel_reason || undefined, fail_reason: o.fail_reason || undefined, fail_detail: o.fail_detail || undefined,
    type_param: typeParam(o, d), create_time: iso(o.create), update_time: iso(o.update),
    trigger_time: o.trigger_time ? iso(o.trigger_time) : undefined, expire_time: o.expire ? iso(o.expire) : undefined,
    is_triggered: o.triggered || undefined,
  };
  if (detail) out.timeline = o.timeline.map((t) => ({ ...t }));
  return out;
}

function typeParam(o, d) {
  const p = (v) => Number(v).toFixed(d.price_scale);
  switch (o.order_type) {
    case 'CONDITIONAL': return `${o.trigger_cond === 'LTE' ? '≤' : '≥'} ${p(o.trigger_price)}`;
    case 'TRAILING': return o.trailing_mode === 'RATE' ? `回撤 ${(o.trailing_cb * 100).toFixed(2)}%` : `回撤 ${o.trailing_cb} USDT`;
    case 'ICEBERG': return `单次显示 ${o.iceberg_visible} 张`;
    case 'TPSL': return `${o.tp ? '止盈 ' + p(o.tp) : ''}${o.tp && o.sl ? ' / ' : ''}${o.sl ? '止损 ' + p(o.sl) : ''}`;
    default: return '';
  }
}

export function positionOut(p, acct) {
  const d = def(p.symbol);
  const mark = st(p.symbol).mark;
  const base = {
    position_oid: p.oid, symbol: p.symbol, position_side: p.side, position_status: p.status, margin_mode: 'ISOLATED',
    leverage: p.leverage, position_qty: String(p.status === 'OPEN' ? p.qty : p.max_qty), avg_price: P(p.avg, p.symbol),
    opened_time: iso(p.opened), adl_level: p.adl_level,
  };
  if (p.status === 'CLOSED') {
    return {
      ...base, close_type: p.close_type, close_avg_price: P(p.close_avg || p.avg, p.symbol), closed_time: iso(p.closed),
      close_pnl_amount: S(p.close_pnl), fee_amount: S(p.fee), funding_amount: S(p.funding), realized_pnl_amount: S(p.realized),
      realized_pnl_rate: S(p.margin0 ? p.realized / p.margin0 : p.realized / ((p.max_qty * csz(p.symbol) * p.avg) / p.leverage || 1), 4),
      trigger_price: p.trigger_price ? P(p.trigger_price, p.symbol) : undefined,
      liq_price_at_close: p.liq_at_close ? P(p.liq_at_close, p.symbol) : undefined,
      mark_price: P(mark, p.symbol), position_margin_amount: '0', unrealized_pnl_amount: '0',
    };
  }
  const liq = posLiq(p);
  const dist = C.distToLiq(mark, liq);
  const upnl = posUpnl(p);
  // 聚合当前生效的止盈 / 止损（取第一组"全部仓位"，否则取第一组）
  const tpsl = acct.orders.filter((o) => o.position_oid === p.oid && o.order_type === 'TPSL' && o.status === 'PENDING_TRIGGER');
  const grp = tpsl.find((o) => !o.qty) || tpsl[0];
  const bankruptcy = C.bankruptcyPrice(p.side, p.qty * csz(p.symbol), p.avg, p.margin);
  return {
    ...base, mark_price: P(mark, p.symbol), position_margin_amount: S(p.margin), unrealized_pnl_amount: S(upnl),
    unrealized_pnl_rate: S(p.margin ? upnl / p.margin : 0, 4), liquidation_price: P(liq, p.symbol), bankruptcy_price: P(bankruptcy, p.symbol),
    distance_to_liq_rate: S(dist, 4), risk_level: C.riskLevel(dist), liq_state: p.liq_state,
    tp_trigger_price: grp && grp.tp ? P(grp.tp, p.symbol) : undefined, sl_trigger_price: grp && grp.sl ? P(grp.sl, p.symbol) : undefined,
    has_trailing: acct.orders.some((o) => o.position_oid === p.oid && o.order_type === 'TRAILING' && o.status === 'PENDING_TRIGGER'),
    max_add_margin_amount: S(Math.max(0, acct.available)), max_reduce_margin_amount: S(Math.max(0, p.margin - posMinMargin(p))),
  };
}

export function fillOut(f) {
  const d = def(f.symbol);
  return {
    fill_oid: f.oid, order_oid: f.order_oid || undefined, symbol: f.symbol, position_side: f.side, position_effect: f.effect,
    order_type: f.order_type, iceberg_slice_index: f.slice || undefined, fill_role: f.role, price: P(f.price, f.symbol),
    quantity: String(f.qty), fill_amount: S(f.amount), fee_amount: S(f.fee, 4), fee_rate: String(f.fee_rate),
    realized_pnl_amount: f.pnl === null || f.pnl === undefined ? undefined : S(f.pnl), fill_time: iso(f.time),
  };
}

export function ledgerOut(l, acct) {
  const pos = l.position_oid ? acct.positions.find((p) => p.oid === l.position_oid) : null;
  return {
    ledger_oid: l.oid, ledger_type: l.type, currency: 'USDT', ledger_amount: S(l.amount), before_balance: S(l.before), after_balance: S(l.after),
    symbol: l.symbol || undefined, biz_desc: l.desc, ref_position_oid: l.position_oid || pos?.oid || undefined,
    position_side: pos?.side, leverage: pos?.leverage, create_time: iso(l.time),
  };
}

export function symbolOut(s, acct) {
  const { _vol, tiers, ...rest } = s;
  return { ...rest, is_favorite: acct ? acct.favorites.includes(s.symbol) : false };
}
