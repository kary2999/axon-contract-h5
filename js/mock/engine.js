// Mock 撮合 / 风控引擎：只服务于前端演示，规则取自技术方案 §3.4~3.6 与原型的边界文案。
// 价格计算全部用 number（Mock 可接受；真实后端用 decimal，见 api-doc/README §1）。

import { market } from './market.js';
import { blankOrder, blankPosition } from './db.js';
import { oid, iso, BizError, DAY, MIN } from './util.js';
import * as C from '../lib/calc.js';
import { posLiq, posUpnl, posMinMargin, tierFor } from './mappers.js';
import { symName } from '../lib/format.js';

const def = (s) => {
  const d = market.defs[s];
  if (!d) throw new BizError('MARKET_SYMBOL_201', '合约不存在');
  return d;
};
const csz = (s) => Number(def(s).contract_size);
const st = (s) => market.state[s];
const MAKER = 0.0002; const TAKER = 0.0005;
const MARKET_MAX_COIN = { BTC: 100, ETH: 1500, SOL: 30000, BNB: 8000, XRP: 5e6, DOGE: 2e7, TON: 6e5, AVAX: 8e4 };
const sideTxt = (o) => (o.effect === 'OPEN' ? '开' : '平') + (o.side === 'LONG' ? '多' : '空');

export class Engine {
  /** bus: { emit(channel, data) }，把私有事件推给 mock-ws */
  constructor(acct, bus, save) {
    this.acct = acct;
    this.bus = bus;
    this.save = save;
  }

  // ------------------------------------------------------------------ 账户汇总
  summary() {
    const a = this.acct;
    const open = a.positions.filter((p) => p.status === 'OPEN');
    const margin = open.reduce((s, p) => s + p.margin, 0);
    const frozen = a.orders.filter((o) => this.isActive(o)).reduce((s, o) => s + o.frozen, 0);
    const upnl = open.reduce((s, p) => s + posUpnl(p), 0);
    return { available: a.available, margin, frozen, upnl, equity: a.available + margin + frozen + upnl };
  }
  isActive(o) { return ['SUBMITTED', 'PENDING_TRIGGER', 'OPEN', 'PARTIALLY_FILLED'].includes(o.status); }
  pushBalance(type = null, amount = 0) {
    const s = this.summary();
    this.bus.emit('private.balance', {
      ledger_type: type || undefined, ledger_amount: amount.toFixed(2), available_balance: s.available.toFixed(2), equity: s.equity.toFixed(2),
      position_margin: s.margin.toFixed(2), order_frozen: s.frozen.toFixed(2), unrealized_pnl: s.upnl.toFixed(2),
    });
  }
  ledger(type, amount, desc, extra = {}) {
    const a = this.acct;
    const before = a.available - amount; // 调用方已先改 available
    a.ledgers.push({ oid: oid(), type, amount, before, after: a.available, desc, time: Date.now(), ...extra });
  }
  emitOrder(event, o) { this.bus.emit('private.order', { event, order: o.oid }); }
  emitPos(event, p) { this.bus.emit('private.position', { event, position: p.oid }); }

  openPosition(symbol, side) { return this.acct.positions.find((p) => p.status === 'OPEN' && p.symbol === symbol && p.side === side); }
  closableQty(pos) {
    const used = this.acct.orders.filter((o) => this.isActive(o) && o.position_oid === pos.oid && o.effect === 'CLOSE' && ['LIMIT', 'CONDITIONAL'].includes(o.order_type)).reduce((s, o) => s + (o.qty - o.filled), 0);
    return pos.qty - used;
  }
  settings(symbol) {
    const a = this.acct;
    if (!a.settings[symbol]) a.settings[symbol] = { leverage: 20, margin_mode: 'ISOLATED' };
    const s = a.settings[symbol];
    s.leverage = Math.min(s.leverage, def(symbol).max_leverage);
    return s;
  }
  /** 当前持仓 + 未终态挂单的名义价值 */
  notionalOf(symbol) {
    const a = this.acct;
    const mark = st(symbol).mark;
    const pos = a.positions.filter((p) => p.status === 'OPEN' && p.symbol === symbol).reduce((s, p) => s + p.qty * csz(symbol) * mark, 0);
    const ord = a.orders.filter((o) => this.isActive(o) && o.symbol === symbol && o.effect === 'OPEN' && ['LIMIT', 'ICEBERG'].includes(o.order_type)).reduce((s, o) => s + (o.qty - o.filled) * csz(symbol) * (o.price || mark), 0);
    return pos + ord;
  }

  // ------------------------------------------------------------------ 校验 + 预估
  /** 返回预估并校验参数；校验失败抛 BizError。create=true 表示真实下单（额外检查账户状态与幂等外的规则） */
  quote(req, { create = false } = {}) {
    const a = this.acct;
    const d = def(req.symbol);
    const s = st(req.symbol);
    const size = csz(req.symbol);
    const tick = Number(d.price_tick);
    const type = req.order_type;
    const side = req.position_side;
    const effect = req.position_effect;
    const buy = (side === 'LONG') === (effect === 'OPEN');
    const warnings = [];
    const err = (field, message, code = 'COMMON_COMMON_002') => { throw new BizError(code, message, { errors: [{ field, message }] }); };

    if (create) {
      if (!a.risk_acked) throw new BizError('CONTRACT_ACCOUNT_102', '请先确认风险提示');
    }
    if (effect === 'OPEN' && !d.is_open_allowed) throw new BizError('CONTRACT_ORDER_017', '该交易对当前禁止开仓');
    if (effect === 'CLOSE' && !d.is_close_allowed) throw new BizError('CONTRACT_ORDER_017', '该交易对当前禁止平仓');

    // ---- 依附持仓的类型
    let pos = null;
    if (['TPSL', 'TRAILING'].includes(type) || (effect === 'CLOSE')) {
      pos = req.position_oid ? a.positions.find((p) => p.oid === req.position_oid) : this.openPosition(req.symbol, side);
      if (!pos || pos.status !== 'OPEN') throw new BizError('CONTRACT_POSITION_201', '止盈止损必须基于已有仓位设置，该仓位可能已平仓或被强平');
    }

    const lots = req.quantity !== undefined && req.quantity !== '' ? Number(req.quantity) : NaN;
    const needQty = !['TPSL', 'TRAILING'].includes(type) || req.quantity;
    if (needQty && !(lots > 0)) err('quantity', `请输入数量（最小 ${(Number(d.min_qty) * size).toFixed(d.qty_scale)} ${d.base_coin}）`);
    if (needQty && (!Number.isInteger(lots) || lots < Number(d.min_qty))) err('quantity', `数量低于最小下单量 ${(Number(d.min_qty) * size).toFixed(d.qty_scale)} ${d.base_coin}`, 'CONTRACT_ORDER_013');

    // ---- 价格
    let price = null;
    const needPrice = type === 'LIMIT' || type === 'ICEBERG' || (type === 'CONDITIONAL' && req.triggered_order_type === 'LIMIT');
    const src = req.price_source && req.price_source !== 'MANUAL' ? req.price_source : null;
    if (needPrice) {
      if (src && type === 'LIMIT') price = market.bboPrice(req.symbol, buy ? 'BUY' : 'SELL', src);
      else {
        price = Number(req.price);
        if (!(price > 0)) err('price', '请输入价格');
        if (Math.abs(price / tick - Math.round(price / tick)) > 1e-6) err('price', `价格不符合精度 ${d.price_tick}`, 'CONTRACT_ORDER_013');
        if (type !== 'CONDITIONAL' && Math.abs(price - s.last) / s.last > 0.05) {
          throw new BizError('CONTRACT_ORDER_018', '委托价格超出限价范围（±5%），请刷新价格后重试', { max_deviation_rate: '0.05' });
        }
        const best = buy ? s.depth.bids[0].p : s.depth.asks[0].p;
        if (Math.abs(price - best) / best > 0.005) warnings.push({ code: 'PRICE_DEVIATION', msg: `与${buy ? '买一价' : '卖一价'} ${best} 偏离 ${(Math.abs(price - best) / best * 100).toFixed(2)}%`, data: { deviation_rate: (Math.abs(price - best) / best).toFixed(4) } });
      }
    }

    // ---- 市价
    let est = { avg: s.last, slip: 0 };
    if (type === 'MARKET' || (type === 'CONDITIONAL' && req.triggered_order_type === 'MARKET')) {
      const coin = lots * size;
      if (coin > MARKET_MAX_COIN[d.base_coin]) throw new BizError('CONTRACT_ORDER_020', `市价单单笔最大 ${MARKET_MAX_COIN[d.base_coin]} ${d.base_coin}，请分笔下单或改用限价 / 冰山委托`, { max_market_qty: String(Math.floor(MARKET_MAX_COIN[d.base_coin] / size)) });
      if (lots > 0) {
        const r = market.sweep(req.symbol, buy ? 'BUY' : 'SELL', coin);
        est = { avg: r.avg, slip: Math.abs(r.avg - s.last) / s.last };
        if (est.slip > 0.005) warnings.push({ code: 'SLIPPAGE_HIGH', msg: `盘口深度不足，预估滑点 ${(est.slip * 100).toFixed(2)}%，成交均价约 ${r.avg.toFixed(d.price_scale)}。建议改用限价委托`, data: { slippage_rate: est.slip.toFixed(4) } });
      }
    }

    // ---- 类型专属
    if (type === 'ICEBERG') {
      const v = Number(req.iceberg_visible_qty);
      if (!(v >= Number(d.min_qty))) err('iceberg_visible_qty', `单次显示数量不能低于最小下单量 ${(Number(d.min_qty) * size).toFixed(d.qty_scale)} ${d.base_coin}`, 'CONTRACT_ORDER_013');
      if (v > lots) throw new BizError('CONTRACT_ORDER_015', '单次显示数量大于总量', { errors: [{ field: 'iceberg_visible_qty', message: '单次显示数量大于总量' }] });
    }
    let trigCond = null;
    if (type === 'CONDITIONAL') {
      const tp = Number(req.trigger_price);
      if (!(tp > 0)) err('trigger_price', '请输入触发价');
      if (Math.abs(tp - s.last) < tick / 2 || Math.abs(tp - s.mark) < tick / 2) throw new BizError('CONTRACT_ORDER_016', '触发价不能等于最新价，请设置高于或低于最新价', { errors: [{ field: 'trigger_price', message: '触发价不能等于最新价' }] });
      trigCond = tp > s.mark ? 'GTE' : 'LTE';
      if (!['LIMIT', 'MARKET'].includes(req.triggered_order_type)) err('triggered_order_type', '请选择触发后的执行类型');
    }
    if (type === 'TPSL') {
      const tpv = req.tp_trigger_price === undefined || req.tp_trigger_price === '' ? null : Number(req.tp_trigger_price);
      const slv = req.sl_trigger_price === undefined || req.sl_trigger_price === '' ? null : Number(req.sl_trigger_price);
      this.checkTpsl(pos, tpv, slv, warnings);
    } else if (['LIMIT', 'MARKET'].includes(type) && effect === 'OPEN' && (req.tp_trigger_price || req.sl_trigger_price)) {
      const ref = price || est.avg;
      const tpv = req.tp_trigger_price ? Number(req.tp_trigger_price) : null;
      const slv = req.sl_trigger_price ? Number(req.sl_trigger_price) : null;
      this.checkTpslDir(side, ref, tpv, slv);
    }
    if (type === 'TRAILING') {
      const cb = Number(req.trailing_callback_value);
      if (!(cb > 0)) err('trailing_callback_value', '请输入回撤幅度');
      if (req.trailing_mode === 'RATE') {
        if (cb > 0.1) throw new BizError('CONTRACT_ORDER_021', '回撤幅度最大 10%', { errors: [{ field: 'trailing_callback_value', message: '回撤幅度最大 10%' }] });
        if (cb < 0.001) warnings.push({ code: 'TRAILING_CALLBACK_SMALL', msg: '回撤幅度最小 0.1%，过小会被正常波动频繁触发', data: {} });
      }
    }

    // ---- 平仓量
    let closeLots = lots;
    if (effect === 'CLOSE' && ['LIMIT', 'MARKET', 'CONDITIONAL'].includes(type)) {
      const can = pos ? this.closableQty(pos) : 0;
      if (lots > can) throw new BizError('CONTRACT_ORDER_013', `超过可平数量，最多可平 ${(can * size).toFixed(d.qty_scale)} ${d.base_coin}`, { max_qty: String(can), errors: [{ field: 'quantity', message: '超过可平数量' }] });
    }
    if (effect === 'CLOSE' && type === 'TPSL' && req.quantity) {
      const taken = a.orders.filter((o) => o.position_oid === pos.oid && o.order_type === 'TPSL' && o.status === 'PENDING_TRIGGER').reduce((sm, o) => sm + (o.qty || pos.qty), 0);
      const rest = pos.qty - (req.tpsl_order_oid ? 0 : taken);
      if (lots > pos.qty || (taken && lots > rest)) throw new BizError('CONTRACT_ORDER_022', `超过可设数量，剩余可设 ${(Math.max(0, rest) * size).toFixed(d.qty_scale)} ${d.base_coin}`, { max_qty: String(Math.max(0, rest)) });
    }

    // ---- 杠杆 / 档位 / 保证金（仅开仓）
    let lev = Number(req.leverage) || this.settings(req.symbol).leverage;
    let required = 0; let notional = 0; let tier = tierFor(req.symbol, 0); let liq = 0; let maxOpen = 0;
    const refPrice = price || est.avg;
    if (effect === 'OPEN') {
      if (!(lev >= 1)) err('leverage', '请设置杠杆');
      notional = (lots > 0 ? lots : 0) * size * refPrice;
      const total = this.notionalOf(req.symbol) + notional;
      tier = tierFor(req.symbol, total);
      const allowed = Math.min(d.max_leverage, tier.max_leverage);
      if (lev > d.max_leverage || lev > allowed) throw new BizError('CONTRACT_ORDER_012', `名义价值 ${C.floorTo(total, 1).toLocaleString()} USDT 处于档位 ${tier.tier}，最大杠杆 ${allowed}×，请调低杠杆或数量`, { max_allowed_leverage: allowed });
      required = notional / lev;
      maxOpen = Math.floor(C.maxOpenQty(a.available, lev, refPrice * (type === 'MARKET' ? 1.001 : 1), size) / size + 1e-9);
      if (lots > 0) {
        liq = C.liqPrice({ side, qty: lots * size, entry: refPrice, margin: required, mmr: Number(tier.maintenance_margin_rate), cum: Number(tier.maintenance_amount), takerFee: TAKER });
      }
      // 计划委托触发前不占用保证金，只给预估
      if (create && type !== 'CONDITIONAL' && required > a.available + 1e-9) {
        throw new BizError('CONTRACT_ORDER_011', '可用余额不足', {
          required_margin_amount: required.toFixed(2), available_balance: a.available.toFixed(2), shortfall_amount: (required - a.available).toFixed(2),
          max_open_qty: String(maxOpen),
        });
      }
    }

    const fee = lots > 0 ? lots * size * refPrice * (type === 'MARKET' ? TAKER : MAKER) : 0;
    return { d, s, size, lots, price, src, buy, pos, lev, required, notional, tier, liq, maxOpen, est, fee, warnings, trigCond, refPrice };
  }

  checkTpslDir(side, ref, tp, sl) {
    const long = side === 'LONG';
    const bad = (m) => { throw new BizError('CONTRACT_ORDER_014', m, { errors: [{ field: 'tp_trigger_price', message: m }] }); };
    if (tp !== null && (long ? tp <= ref : tp >= ref)) bad(long ? '多头止盈价须高于开仓价' : '空头止盈价须低于开仓价');
    if (sl !== null && (long ? sl >= ref : sl <= ref)) bad(long ? '多头止损价须低于开仓价' : '空头止损价须高于开仓价');
  }
  checkTpsl(pos, tp, sl, warnings) {
    if (tp === null && sl === null) throw new BizError('COMMON_COMMON_002', '至少设置止盈或止损价', { errors: [{ field: 'tp_trigger_price', message: '至少设置止盈或止损价' }] });
    const mark = st(pos.symbol).mark;
    // 方向校验以标记价为参照（原型：多头止盈须高于标记价、止损须低于标记价）
    this.checkTpslDir(pos.side, mark, tp, sl);
    const liq = posLiq(pos);
    if (sl !== null && ((pos.side === 'LONG' && sl <= liq) || (pos.side === 'SHORT' && sl >= liq))) {
      warnings.push({ code: 'SL_BEYOND_LIQ', msg: `止损价${pos.side === 'LONG' ? '低于' : '高于'}强平价 ${liq.toFixed(def(pos.symbol).price_scale)}，仓位会先被强平，止损不会生效`, data: { liquidation_price: liq.toFixed(def(pos.symbol).price_scale) } });
    }
  }

  // ------------------------------------------------------------------ 创建委托
  createOrder(req) {
    const a = this.acct;
    if (a.idem[req.idempotency_key]) return a.idem[req.idempotency_key];
    const q = this.quote(req, { create: true });
    const { d, s, size, lots, price, src, buy, pos, lev, required } = q;
    const t = Date.now();
    const o = blankOrder({
      symbol: req.symbol, order_type: req.order_type, side: req.position_side, effect: req.position_effect, status: 'SUBMITTED',
      price, price_source: src || 'MANUAL', qty: lots || 0, leverage: lev, reduce_only: !!req.reduce_only || req.position_effect === 'CLOSE',
      tp: req.tp_trigger_price ? Number(req.tp_trigger_price) : null, sl: req.sl_trigger_price ? Number(req.sl_trigger_price) : null,
      position_oid: pos ? pos.oid : null, create: t, update: t,
    });
    o.timeline.push({ time: iso(t), event: 'CREATED', text: '委托已提交' });
    a.orders.push(o);

    // 杠杆即该交易对设置
    if (req.position_effect === 'OPEN' && req.leverage) this.settings(req.symbol).leverage = Number(req.leverage);

    let result;
    switch (req.order_type) {
      case 'LIMIT': case 'ICEBERG': {
        if (req.order_type === 'ICEBERG') {
          const v = Number(req.iceberg_visible_qty);
          o.iceberg_visible = v; o.iceberg_slices = Math.ceil(lots / v); o.iceberg_index = 1; o.iceberg_slice_qty = Math.min(v, lots);
        }
        o.frozen = o.effect === 'OPEN' ? (lots * size * price) / lev : 0;
        a.available -= o.frozen;
        o.status = 'OPEN';
        this.matchLimit(o, q);
        break;
      }
      case 'MARKET': {
        o.frozen = o.effect === 'OPEN' ? (lots * size * q.est.avg * 1.002) / lev : 0;
        a.available -= o.frozen;
        o.status = 'OPEN';
        this.fill(o, lots, q.est.avg, 'TAKER');
        o.slippage = q.est.slip;
        break;
      }
      case 'CONDITIONAL': {
        o.status = 'PENDING_TRIGGER'; o.trigger_price = Number(req.trigger_price); o.trigger_cond = q.trigCond; o.triggered_type = req.triggered_order_type;
        o.expire = t + 7 * DAY;
        break;
      }
      case 'TPSL': {
        o.status = 'PENDING_TRIGGER'; o.qty = lots || 0; o.tp = req.tp_trigger_price ? Number(req.tp_trigger_price) : null; o.sl = req.sl_trigger_price ? Number(req.sl_trigger_price) : null;
        o.reduce_only = true;
        break;
      }
      case 'TRAILING': {
        o.status = 'PENDING_TRIGGER'; o.qty = lots || 0; o.reduce_only = true;
        o.trailing_mode = req.trailing_mode; o.trailing_cb = Number(req.trailing_callback_value);
        o.trailing_act = req.trailing_activation_price ? Number(req.trailing_activation_price) : null;
        break;
      }
      default: throw new BizError('COMMON_COMMON_002', '不支持的委托类型');
    }
    o.update = Date.now();
    this.emitOrder('CREATED', o);
    this.pushBalance();
    result = {
      order_oid: o.oid, order_status: o.status, frozen_margin_amount: o.frozen.toFixed(2), filled_qty: String(o.filled),
      avg_fill_price: o.avg_fill ? o.avg_fill.toFixed(d.price_scale) : '0', warnings: q.warnings,
    };
    a.idem[req.idempotency_key] = result;
    this.save();
    return result;
  }

  /** 限价撮合：先吃对手盘（价格满足的档位），剩余挂单 */
  matchLimit(o, q) {
    const s = st(o.symbol);
    const buy = (o.side === 'LONG') === (o.effect === 'OPEN');
    const levels = buy ? s.depth.asks : s.depth.bids;
    const limit = o.price;
    const qty = o.order_type === 'ICEBERG' ? o.iceberg_slice_qty : o.qty - o.filled;
    let rest = qty; let cost = 0; let got = 0;
    for (const lv of levels) {
      if (buy ? lv.p > limit : lv.p < limit) break;
      const take = Math.min(rest, Math.floor(lv.q / csz(o.symbol)));
      if (take <= 0) continue;
      cost += take * csz(o.symbol) * lv.p; got += take; rest -= take;
      if (rest <= 0) break;
    }
    if (got > 0) this.fill(o, got, cost / (got * csz(o.symbol)), 'TAKER');
  }

  // ------------------------------------------------------------------ 成交结算
  fill(o, lots, price, role) {
    const a = this.acct;
    const d = def(o.symbol);
    const size = csz(o.symbol);
    const amount = lots * size * price;
    const rate = role === 'MAKER' ? MAKER : TAKER;
    const fee = amount * rate;
    const t = Date.now();
    const remainingBefore = Math.max(1, o.qty - o.filled);
    let pnl = null;

    if (o.effect === 'OPEN') {
      const partFrozen = o.frozen * (lots / remainingBefore);
      o.frozen -= partFrozen;
      const marginUsed = amount / o.leverage;
      a.available += partFrozen - marginUsed - fee;
      let pos = this.openPosition(o.symbol, o.side);
      if (!pos) {
        pos = blankPosition({ symbol: o.symbol, side: o.side, leverage: o.leverage, opened: t });
        pos.events.push({ time: iso(t), event: 'OPEN', text: `${sideTxt(o)} ${(lots * size).toFixed(d.qty_scale)} ${d.base_coin}，保证金 ${marginUsed.toFixed(2)} USDT` });
        a.positions.push(pos);
        this.emitPos('OPENED', pos);
      }
      pos.avg = (pos.avg * pos.qty + price * lots) / (pos.qty + lots);
      pos.qty += lots; pos.margin += marginUsed; pos.fee += fee; pos.max_qty = Math.max(pos.max_qty, pos.qty);
      pos.leverage = o.leverage;
      o.position_oid = pos.oid;
      this.ledger('FEE', -fee, `${symName(o.symbol)} ${sideTxt(o)}成交`, { symbol: o.symbol });
    } else {
      const pos = a.positions.find((p) => p.oid === o.position_oid && p.status === 'OPEN');
      if (!pos) return;
      const dir = C.dirOf(pos.side);
      pnl = (price - pos.avg) * lots * size * dir;
      const marginRelease = pos.margin * (lots / pos.qty);
      pnl = Math.max(pnl, -marginRelease); // 逐仓：单笔亏损不超过该部分保证金
      a.available += marginRelease + pnl - fee;
      pos.margin -= marginRelease; pos.qty -= lots; pos.close_pnl += pnl; pos.fee += fee;
      pos.close_avg = ((pos.close_avg * (pos.max_qty - pos.qty - lots)) + price * lots) / Math.max(1, pos.max_qty - pos.qty);
      this.ledger('REALIZED_PNL', pnl, `${symName(o.symbol)} ${pos.side === 'LONG' ? '多' : '空'} · ${o.order_type === 'TPSL' ? (o.triggerKind === 'TP' ? '止盈' : '止损') : o.order_type === 'TRAILING' ? '移动止损' : '平仓'}`, { symbol: o.symbol, position_oid: pos.oid });
      this.ledger('FEE', -fee, `${symName(o.symbol)} ${sideTxt(o)}成交`, { symbol: o.symbol });
      if (pos.qty <= 0) this.closePosition(pos, o.order_type === 'TPSL' ? (o.triggerKind === 'TP' ? 'TAKE_PROFIT' : 'STOP_LOSS') : o.order_type === 'TRAILING' ? 'STOP_LOSS' : 'MANUAL', price);
      else this.emitPos('UPDATED', pos);
    }

    o.avg_fill = (o.avg_fill * o.filled + price * lots) / (o.filled + lots);
    o.filled += lots; o.fee += fee; o.update = t;
    a.fills.push({ oid: oid(), order_oid: o.oid, symbol: o.symbol, side: o.side, effect: o.effect, order_type: o.order_type, slice: o.iceberg_slices ? o.iceberg_index : null, role, price, qty: lots, amount, fee, fee_rate: rate, pnl, position_oid: o.position_oid, time: t });
    o.timeline.push({ time: iso(t), event: 'FILLED', text: `成交 ${(lots * size).toFixed(d.qty_scale)} ${d.base_coin} @ ${price.toFixed(d.price_scale)}（${role === 'MAKER' ? 'Maker' : 'Taker'}）` });

    // 冰山：当前切片成交完 → 挂下一笔
    if (o.iceberg_slices) {
      o.iceberg_slice_filled += lots;
      if (o.iceberg_slice_filled >= o.iceberg_slice_qty && o.filled < o.qty) {
        o.iceberg_index += 1; o.iceberg_slice_filled = 0; o.iceberg_slice_qty = Math.min(o.iceberg_visible, o.qty - o.filled);
      }
    }
    if (o.filled >= o.qty) {
      o.status = 'FILLED';
      a.available += o.frozen; o.frozen = 0;
      this.emitOrder('FILLED', o);
    } else {
      o.status = 'PARTIALLY_FILLED';
      this.emitOrder('UPDATED', o);
    }
    // 附带止盈止损：首次成交后创建
    if (o.effect === 'OPEN' && (o.tp || o.sl) && !o.attach_done && o.order_type !== 'TPSL') {
      o.attach_done = true;
      const pos = a.positions.find((p) => p.oid === o.position_oid);
      if (pos) {
        const g = blankOrder({ symbol: o.symbol, order_type: 'TPSL', side: o.side, effect: 'CLOSE', status: 'PENDING_TRIGGER', qty: 0, tp: o.tp, sl: o.sl, reduce_only: true, position_oid: pos.oid, leverage: o.leverage });
        g.timeline.push({ time: iso(), event: 'CREATED', text: '随开仓委托附带创建' });
        a.orders.push(g);
      }
    }
    this.pushBalance();
  }

  closePosition(pos, closeType, price, extra = {}) {
    const a = this.acct;
    pos.status = 'CLOSED'; pos.closed = Date.now(); pos.close_type = closeType; pos.qty = 0;
    pos.realized = pos.close_pnl - pos.fee + pos.funding;
    pos.margin0 = pos.margin0 || (pos.max_qty * csz(pos.symbol) * pos.avg) / pos.leverage;
    pos.trigger_price = extra.trigger_price || pos.trigger_price;
    pos.margin = 0;
    for (const o of a.orders) {
      if (o.position_oid === pos.oid && this.isActive(o)) this.cancelInternal(o, 'POSITION_CLOSED', 'SYSTEM_CANCELED');
    }
    this.emitPos(closeType === 'LIQUIDATED' ? 'LIQUIDATED' : 'CLOSED', pos);
  }

  cancelInternal(o, reason, status = 'CANCELED') {
    const a = this.acct;
    a.available += o.frozen;
    const released = o.frozen;
    o.frozen = 0;
    o.status = status === 'CANCELED' && o.filled > 0 ? 'PARTIALLY_CANCELED' : status;
    o.cancel_reason = reason; o.update = Date.now();
    o.timeline.push({ time: iso(), event: 'CANCELED', text: reason === 'USER' ? '用户撤单' : reason === 'POSITION_CLOSED' ? '仓位已平，系统撤单' : reason === 'EXPIRED' ? '委托已过期' : '系统撤单' });
    this.emitOrder('CANCELED', o);
    return released;
  }

  // ------------------------------------------------------------------ 撤单 / 改单
  cancel(order_oid) {
    const a = this.acct;
    const o = a.orders.find((x) => x.oid === order_oid);
    if (!o) throw new BizError('CONTRACT_ORDER_201', '委托不存在');
    if (!this.isActive(o)) throw new BizError('CONTRACT_ORDER_301', '该委托已完全成交或已撤销，无法撤销');
    const released = this.cancelInternal(o, 'USER');
    this.pushBalance(); this.save();
    return { order_oid: o.oid, order_status: o.status, released_margin_amount: released.toFixed(2) };
  }

  /** 当前委托分组：计划委托触发后进入"普通"组 */
  groupOf(o) {
    if (o.order_type === 'LIMIT' || o.order_type === 'MARKET') return 'NORMAL';
    if (o.order_type === 'CONDITIONAL') return o.triggered ? 'NORMAL' : 'CONDITIONAL';
    return o.order_type;
  }

  cancelAll(filters = {}, idem) {
    const a = this.acct;
    const hit = a.orders.filter((o) => this.isActive(o)
      && (!filters.symbol || o.symbol === filters.symbol)
      && (!filters.position_side || o.side === filters.position_side)
      && (!filters.order_group || this.groupOf(o) === filters.order_group));
    const ok = []; let released = 0;
    for (const o of hit) { released += this.cancelInternal(o, 'USER'); ok.push(o.oid); }
    this.pushBalance(); this.save();
    return { success_oids: ok, failures: [], released_margin_amount: released.toFixed(2) };
  }

  amend(order_oid, req) {
    const a = this.acct;
    const o = a.orders.find((x) => x.oid === order_oid);
    if (!o) throw new BizError('CONTRACT_ORDER_201', '委托不存在');
    if (!this.isActive(o) || (o.order_type === 'CONDITIONAL' && o.triggered && false)) throw new BizError('CONTRACT_ORDER_301', '该委托已完全成交或已撤销，无法修改');
    const newQty = req.quantity !== undefined ? Number(req.quantity) : o.qty;
    if (newQty < o.filled) throw new BizError('CONTRACT_ORDER_019', `不能小于已成交数量 ${(o.filled * csz(o.symbol)).toFixed(def(o.symbol).qty_scale)}`);
    // 以修改后的参数走一遍创建校验（先撤后挂，原单已成交部分保留）
    const merged = {
      idempotency_key: req.idempotency_key, symbol: o.symbol, order_type: o.order_type, position_side: o.side, position_effect: o.effect,
      leverage: o.leverage, quantity: String(newQty - o.filled), price: req.price !== undefined ? req.price : o.price, trigger_price: req.trigger_price !== undefined ? req.trigger_price : o.trigger_price,
      triggered_order_type: o.triggered_type, position_oid: o.position_oid, iceberg_visible_qty: req.iceberg_visible_qty !== undefined ? req.iceberg_visible_qty : o.iceberg_visible,
      trailing_mode: o.trailing_mode, trailing_callback_value: req.trailing_callback_value !== undefined ? req.trailing_callback_value : o.trailing_cb,
      trailing_activation_price: req.trailing_activation_price !== undefined ? req.trailing_activation_price : o.trailing_act,
      tp_trigger_price: o.tp, sl_trigger_price: o.sl, reduce_only: o.reduce_only, price_source: 'MANUAL',
    };
    if (o.order_type === 'TPSL' || o.order_type === 'TRAILING') { merged.quantity = req.quantity !== undefined ? req.quantity : (o.qty ? String(o.qty) : undefined); }
    // 先释放原单冻结，校验通过再替换；校验失败要回滚
    const snapshotAvail = a.available; const snapFrozen = o.frozen;
    a.available += o.frozen; o.frozen = 0;
    try {
      this.quote(merged, { create: true });
    } catch (e) { a.available = snapshotAvail; o.frozen = snapFrozen; throw e; }
    const before = o.filled;
    const old = { ...o };
    // 取消原单未成交部分，生成新单
    const releasedOld = 0; o.status = before > 0 ? 'PARTIALLY_CANCELED' : 'CANCELED'; o.cancel_reason = 'USER'; o.update = Date.now();
    o.timeline.push({ time: iso(), event: 'CANCELED', text: '改单：撤销原单未成交部分' });
    this.emitOrder('CANCELED', o);
    const res = this.createOrder({ ...merged, idempotency_key: req.idempotency_key });
    const created = a.orders.find((x) => x.oid === res.order_oid);
    created.create = old.create;
    created.timeline.unshift({ time: iso(), event: 'AMENDED', text: `由改单生成（原委托 …${o.oid.slice(-4).toUpperCase()}）` });
    return { order_oid: res.order_oid, original_order_oid: o.oid, order_status: res.order_status, frozen_margin_amount: res.frozen_margin_amount };
  }

  // ------------------------------------------------------------------ 平仓 / 保证金 / 止盈止损
  closePos(position_oid, req) {
    const a = this.acct;
    if (a.idem[req.idempotency_key]) return a.idem[req.idempotency_key];
    const pos = a.positions.find((p) => p.oid === position_oid);
    if (!pos) throw new BizError('CONTRACT_POSITION_201', '仓位不存在');
    if (pos.status !== 'OPEN') throw new BizError('CONTRACT_POSITION_301', '仓位已平仓');
    if (pos.liq_state === 2) throw new BizError('CONTRACT_POSITION_302', '强平处理中 · 仓位已锁定，暂不可调整或平仓');
    const type = req.order_type || 'MARKET';
    const can = this.closableQty(pos);
    const lots = req.quantity ? Number(req.quantity) : pos.qty; // 缺省全平
    if (type === 'MARKET' && lots > pos.qty) throw new BizError('CONTRACT_ORDER_013', `超过可平数量，最多可平 ${(pos.qty * csz(pos.symbol)).toFixed(def(pos.symbol).qty_scale)}`, { max_qty: String(pos.qty) });
    const body = {
      idempotency_key: req.idempotency_key + '_o', symbol: pos.symbol, order_type: type, position_side: pos.side, position_effect: 'CLOSE', quantity: String(lots), price: req.price, position_oid: pos.oid, leverage: pos.leverage,
    };
    if (type === 'MARKET') {
      // 市价平仓：先撤掉占用可平量的挂单（与"一键全平撤止盈止损"一致，仅限制挂单占用）
      for (const o of a.orders) if (this.isActive(o) && o.position_oid === pos.oid && o.effect === 'CLOSE' && ['LIMIT', 'CONDITIONAL'].includes(o.order_type)) { /* 保留，不占用市价平仓 */ }
    }
    void can;
    const r = this.createOrder(body);
    const o = a.orders.find((x) => x.oid === r.order_oid);
    const realized = a.fills.filter((f) => f.order_oid === o.oid).reduce((s, f) => s + (f.pnl || 0), 0);
    const result = { order_oid: o.oid, order_status: o.status, filled_qty: String(o.filled), avg_fill_price: o.avg_fill ? o.avg_fill.toFixed(def(o.symbol).price_scale) : '0', realized_pnl_amount: realized.toFixed(2) };
    a.idem[req.idempotency_key] = result;
    this.save();
    return result;
  }

  closeAll(req) {
    const a = this.acct;
    if (a.idem[req.idempotency_key]) return a.idem[req.idempotency_key];
    const targets = a.positions.filter((p) => p.status === 'OPEN' && (!req.position_oids || !req.position_oids.length || req.position_oids.includes(p.oid)));
    const ok = []; const fails = []; let total = 0;
    for (const p of targets) {
      try {
        // 先撤该仓位的止盈止损 / 平仓挂单
        for (const o of a.orders) if (this.isActive(o) && o.position_oid === p.oid && o.effect === 'CLOSE') this.cancelInternal(o, 'POSITION_CLOSED', 'SYSTEM_CANCELED');
        const r = this.closePos(p.oid, { idempotency_key: `${req.idempotency_key}_${p.oid.slice(-6)}`, order_type: 'MARKET' });
        total += Number(r.realized_pnl_amount); ok.push(p.oid);
      } catch (e) { fails.push({ position_oid: p.oid, code: e.code || 'COMMON_COMMON_501' }); }
    }
    const result = { success_oids: ok, failures: fails, realized_pnl_total: total.toFixed(2) };
    a.idem[req.idempotency_key] = result;
    this.save();
    return result;
  }

  adjustMargin(position_oid, req, sign) {
    const a = this.acct;
    const pos = a.positions.find((p) => p.oid === position_oid);
    if (!pos) throw new BizError('CONTRACT_POSITION_201', '仓位不存在');
    if (pos.status !== 'OPEN') throw new BizError('CONTRACT_POSITION_301', '仓位已平仓');
    if (pos.liq_state === 2) throw new BizError('CONTRACT_POSITION_302', '仓位已触及强平，不可调整');
    const amt = Number(sign > 0 ? req.margin_add_amount : req.margin_reduce_amount);
    if (!(amt > 0)) throw new BizError('COMMON_COMMON_002', '请输入金额', { errors: [{ field: sign > 0 ? 'margin_add_amount' : 'margin_reduce_amount', message: '请输入金额' }] });
    if (!req.dry_run && a.idem[req.idempotency_key]) return a.idem[req.idempotency_key];
    if (sign > 0 && amt > a.available + 1e-9) throw new BizError('CONTRACT_ORDER_011', `可用余额不足，最多可增加 ${a.available.toFixed(2)} USDT`, { shortfall_amount: (amt - a.available).toFixed(2), max_add_margin_amount: a.available.toFixed(2) });
    const maxReduce = Math.max(0, pos.margin - posMinMargin(pos));
    if (sign < 0 && amt > maxReduce + 1e-9) throw new BizError('CONTRACT_POSITION_306', `超过可减少金额，最多可减少 ${maxReduce.toFixed(2)} USDT，否则仓位将立即触发强平`, { max_reduce_margin_amount: maxReduce.toFixed(2) });
    const probe = { ...pos, margin: pos.margin + sign * amt };
    const liq = posLiq(probe);
    const mark = st(pos.symbol).mark;
    const dist = C.distToLiq(mark, liq);
    const out = { position_oid: pos.oid, position_margin_amount: probe.margin.toFixed(2), liquidation_price: liq.toFixed(def(pos.symbol).price_scale), distance_to_liq_rate: dist.toFixed(4), risk_level: C.riskLevel(dist), available_balance: (a.available - sign * amt).toFixed(2), dry_run: !!req.dry_run };
    if (req.dry_run) return out;
    pos.margin += sign * amt; a.available -= sign * amt;
    this.ledger('MARGIN_ADJUST', -sign * amt, `${symName(pos.symbol)} ${pos.side === 'LONG' ? '多' : '空'} · ${sign > 0 ? '追加' : '减少'}保证金`, { symbol: pos.symbol, position_oid: pos.oid });
    this.emitPos('UPDATED', pos); this.pushBalance('MARGIN_ADJUST', -sign * amt);
    a.idem[req.idempotency_key] = out;
    this.save();
    return out;
  }

  setTpsl(position_oid, req) {
    const a = this.acct;
    if (a.idem[req.idempotency_key]) return a.idem[req.idempotency_key];
    const pos = a.positions.find((p) => p.oid === position_oid);
    if (!pos || pos.status !== 'OPEN') throw new BizError('CONTRACT_POSITION_201', '止盈止损必须基于已有仓位设置。该仓位可能已平仓或被强平。');
    const tpv = req.tp_trigger_price === undefined ? undefined : req.tp_trigger_price;
    const slv = req.sl_trigger_price === undefined ? undefined : req.sl_trigger_price;
    const existing = a.orders.filter((o) => o.position_oid === pos.oid && o.order_type === 'TPSL' && o.status === 'PENDING_TRIGGER');
    const grp = existing.find((o) => (req.quantity ? o.qty === Number(req.quantity) : !o.qty));
    // 清除语义：传 null 清除该侧
    const nextTp = tpv === undefined ? (grp ? grp.tp : null) : (tpv === null ? null : Number(tpv));
    const nextSl = slv === undefined ? (grp ? grp.sl : null) : (slv === null ? null : Number(slv));
    const warnings = [];
    if (nextTp === null && nextSl === null) {
      if (grp) this.cancelInternal(grp, 'USER');
      this.save();
      const r0 = { tpsl_order_oid: grp ? grp.oid : null, quantity: grp ? String(grp.qty) : '0', warnings };
      a.idem[req.idempotency_key] = r0;
      return r0;
    }
    const mkReq = { symbol: pos.symbol, order_type: 'TPSL', position_side: pos.side, position_effect: 'CLOSE', position_oid: pos.oid, tp_trigger_price: nextTp === null ? undefined : String(nextTp), sl_trigger_price: nextSl === null ? undefined : String(nextSl), quantity: req.quantity, tpsl_order_oid: grp ? grp.oid : undefined };
    const q = this.quote(mkReq, { create: true });
    warnings.push(...q.warnings);
    let o = grp;
    if (!o) {
      o = blankOrder({ symbol: pos.symbol, order_type: 'TPSL', side: pos.side, effect: 'CLOSE', status: 'PENDING_TRIGGER', qty: req.quantity ? Number(req.quantity) : 0, reduce_only: true, position_oid: pos.oid, leverage: pos.leverage });
      o.timeline.push({ time: iso(), event: 'CREATED', text: '止盈止损已设置' });
      a.orders.push(o);
      this.emitOrder('CREATED', o);
    }
    o.tp = nextTp; o.sl = nextSl; o.update = Date.now();
    const result = { tpsl_order_oid: o.oid, tp_trigger_price: o.tp ? o.tp.toFixed(def(pos.symbol).price_scale) : undefined, sl_trigger_price: o.sl ? o.sl.toFixed(def(pos.symbol).price_scale) : undefined, quantity: String(o.qty), warnings };
    a.idem[req.idempotency_key] = result;
    this.emitPos('UPDATED', pos);
    this.save();
    return result;
  }

  setLeverage(symbol, leverage) {
    const a = this.acct;
    const d = def(symbol);
    const total = this.notionalOf(symbol);
    const tier = tierFor(symbol, total);
    const allowed = Math.min(d.max_leverage, tier.max_leverage);
    if (leverage < 1 || leverage > allowed) throw new BizError('CONTRACT_ORDER_012', `当前持仓与挂单名义价值 ${Math.round(total).toLocaleString()} USDT 超出 ${leverage}× 档位上限，最高可设 ${allowed}×。请降低杠杆或减少仓位。`, { max_allowed_leverage: allowed });
    const sets = this.settings(symbol);
    const old = sets.leverage;
    sets.leverage = leverage;
    const liqs = [];
    for (const p of a.positions.filter((x) => x.status === 'OPEN' && x.symbol === symbol)) {
      // 逐仓：改杠杆不改保证金，只影响后续追加；Mock 里同步展示的强平价
      p.leverage = leverage;
      const liq = posLiq(p);
      const bad = (p.side === 'LONG' && st(symbol).mark <= liq) || (p.side === 'SHORT' && st(symbol).mark >= liq);
      if (bad) { p.leverage = old; sets.leverage = old; throw new BizError('CONTRACT_POSITION_305', '调整后已有持仓会立即触及强平价，不允许'); }
      liqs.push({ position_oid: p.oid, liquidation_price: liq.toFixed(d.price_scale) });
    }
    this.save();
    return { symbol, leverage, liquidation_prices: liqs };
  }

  // ------------------------------------------------------------------ 行情驱动：成交 / 触发 / 强平
  onTick() {
    const a = this.acct;
    const now = Date.now();
    // 1) 挂单成交（价格穿过委托价）
    for (const o of a.orders.filter((x) => ['OPEN', 'PARTIALLY_FILLED'].includes(x.status))) {
      const s = st(o.symbol);
      const buy = (o.side === 'LONG') === (o.effect === 'OPEN');
      const cross = buy ? s.last <= o.price : s.last >= o.price;
      if (!cross) continue;
      let want = o.order_type === 'ICEBERG' ? o.iceberg_slice_qty - o.iceberg_slice_filled : o.qty - o.filled;
      if (o.effect === 'CLOSE') {
        const pos = a.positions.find((p) => p.oid === o.position_oid && p.status === 'OPEN');
        if (!pos) { this.cancelInternal(o, 'POSITION_CLOSED', 'SYSTEM_CANCELED'); continue; }
        want = Math.min(want, pos.qty);
      }
      if (want <= 0) continue;
      const lots = want > 3 && Math.random() < 0.35 ? Math.max(1, Math.floor(want * (0.3 + Math.random() * 0.5))) : want;
      this.fill(o, lots, o.price, 'MAKER');
    }
    // 2) 计划委托触发 / 过期
    for (const o of a.orders.filter((x) => x.status === 'PENDING_TRIGGER' && x.order_type === 'CONDITIONAL')) {
      if (o.expire && now > o.expire) { this.cancelInternal(o, 'EXPIRED', 'SYSTEM_CANCELED'); continue; }
      const mark = st(o.symbol).mark;
      const hit = o.trigger_cond === 'GTE' ? mark >= o.trigger_price : mark <= o.trigger_price;
      if (hit) this.triggerConditional(o, mark);
    }
    // 3) 止盈止损 / 移动止盈止损
    for (const o of a.orders.filter((x) => x.status === 'PENDING_TRIGGER' && ['TPSL', 'TRAILING'].includes(x.order_type))) {
      const pos = a.positions.find((p) => p.oid === o.position_oid && p.status === 'OPEN');
      if (!pos) { this.cancelInternal(o, 'POSITION_CLOSED', 'SYSTEM_CANCELED'); continue; }
      const mark = st(o.symbol).mark;
      const long = pos.side === 'LONG';
      if (o.order_type === 'TPSL') {
        const tp = o.tp !== null && (long ? mark >= o.tp : mark <= o.tp);
        const sl = o.sl !== null && (long ? mark <= o.sl : mark >= o.sl);
        if (tp || sl) this.triggerClose(o, pos, tp ? 'TP' : 'SL', mark);
      } else {
        if (!o.trailing_activated) {
          if (o.trailing_act === null || (long ? mark >= o.trailing_act : mark <= o.trailing_act)) { o.trailing_activated = true; o.trailing_anchor = mark; }
        }
        if (o.trailing_activated) {
          o.trailing_anchor = long ? Math.max(o.trailing_anchor, mark) : Math.min(o.trailing_anchor, mark);
          const cb = o.trailing_mode === 'RATE' ? o.trailing_anchor * o.trailing_cb : o.trailing_cb;
          o.trailing_stop = long ? o.trailing_anchor - cb : o.trailing_anchor + cb;
          if (long ? mark <= o.trailing_stop : mark >= o.trailing_stop) this.triggerClose(o, pos, 'SL', mark);
        }
      }
    }
    // 4) 预警 / 强平
    for (const p of a.positions.filter((x) => x.status === 'OPEN')) {
      const mark = st(p.symbol).mark;
      const liq = posLiq(p);
      const dist = C.distToLiq(mark, liq);
      if (dist < 0.1 && !p.warned) {
        p.warned = true;
        p.events.push({ time: iso(), event: 'RISK_WARNING', text: `标记价 ${mark}，距强平 < 10%，已推送提醒`, mark_price: String(mark) });
        this.bus.emit('private.risk', { position_oid: p.oid, symbol: p.symbol, distance_to_liq_rate: dist.toFixed(4), risk_level: C.riskLevel(dist), mark_price: String(mark) });
      } else if (dist >= 0.12) p.warned = false;
      const hit = (p.side === 'LONG' && mark <= liq) || (p.side === 'SHORT' && mark >= liq);
      if (hit && p.liq_state !== 2) this.liquidate(p, mark, liq);
    }
  }

  triggerConditional(o, mark) {
    const a = this.acct;
    o.triggered = true; o.trigger_time = Date.now();
    o.timeline.push({ time: iso(), event: 'TRIGGERED', text: `已触发 · 标记价 ${mark}` });
    const d = def(o.symbol); const size = csz(o.symbol);
    const buy = (o.side === 'LONG') === (o.effect === 'OPEN');
    const px = o.triggered_type === 'LIMIT' ? o.price : market.sweep(o.symbol, buy ? 'BUY' : 'SELL', o.qty * size).avg;
    const need = o.effect === 'OPEN' ? (o.qty * size * px) / o.leverage : 0;
    if (need > a.available + 1e-9) {
      o.status = 'TRIGGER_FAILED'; o.fail_reason = 'INSUFFICIENT_MARGIN';
      o.fail_detail = { required_margin_amount: need.toFixed(2), available_balance: a.available.toFixed(2) };
      o.timeline.push({ time: iso(), event: 'TRIGGER_FAILED', text: '下单失败 · 委托结束（保证金不足）' });
      this.emitOrder('TRIGGER_FAILED', o);
      return;
    }
    o.frozen = need; a.available -= need;
    o.status = 'OPEN'; o.update = Date.now();
    this.emitOrder('TRIGGERED', o);
    if (o.triggered_type === 'MARKET') { o.price = null; this.fill(o, o.qty, px, 'TAKER'); }
    else this.matchLimit(o, null);
    void d;
  }

  triggerClose(o, pos, kind, mark) {
    o.triggerKind = kind;
    o.triggered = true; o.trigger_time = Date.now();
    const lots = o.qty ? Math.min(o.qty, pos.qty) : pos.qty;
    const buy = pos.side === 'SHORT';
    const r = market.sweep(o.symbol, buy ? 'BUY' : 'SELL', lots * csz(o.symbol));
    o.timeline.push({ time: iso(), event: 'TRIGGERED', text: `${kind === 'TP' ? '止盈' : '止损'}触发 · 标记价 ${mark}` });
    o.status = 'OPEN'; o.qty = lots; o.filled = 0;
    const trig = kind === 'TP' ? o.tp : (o.order_type === 'TRAILING' ? o.trailing_stop : o.sl);
    this.fill(o, lots, r.avg, 'TAKER');
    const p = this.acct.positions.find((x) => x.oid === pos.oid);
    if (p && p.status === 'CLOSED') p.trigger_price = trig;
    // 同仓位的另一组互斥：止盈止损互斥由同一订单承载，这里不需要额外处理
    this.save();
  }

  liquidate(p, mark, liq) {
    const a = this.acct;
    const loss = p.margin;
    p.liq_state = 2;
    p.events.push({ time: iso(), event: 'LIQUIDATION_TRIGGERED', text: `标记价触及逐仓强平价 ${liq.toFixed(def(p.symbol).price_scale)}`, mark_price: String(mark) });
    const bk = C.bankruptcyPrice(p.side, p.qty * csz(p.symbol), p.avg, p.margin);
    p.events.push({ time: iso(), event: 'LIQUIDATION_SETTLED', text: `以破产价 ${bk.toFixed(def(p.symbol).price_scale)} 平仓，仓位移入历史持仓` });
    p.close_pnl = -loss; p.close_avg = bk; p.liq_at_close = liq; p.margin0 = loss;
    this.ledger('LIQUIDATION', -loss * 0, `${symName(p.symbol)} ${p.side === 'LONG' ? '多' : '空'} ${p.leverage}× · 逐仓清算`, { symbol: p.symbol, position_oid: p.oid, liq_price: liq });
    // 强平亏损 = 全部仓位保证金（保证金早已从可用扣除，这里不再扣）；流水为展示该事件，金额记为 -保证金
    a.ledgers[a.ledgers.length - 1].amount = -loss;
    a.ledgers[a.ledgers.length - 1].before = a.available + 0;
    a.ledgers[a.ledgers.length - 1].after = a.available + 0;
    p.fee += 0;
    this.closePosition(p, 'LIQUIDATED', bk, { trigger_price: liq });
    p.realized = -loss;
    this.pushBalance('LIQUIDATION', -loss);
    this.save();
  }
}
