// Mock 接口路由：路径、请求字段、响应字段与 api-doc/*.md 保持一致。
// 对外只有一个入口 `mockRequest(method, path, body)`，返回 data 或抛 BizError。

import { market, INTERVALS } from './market.js';
import { loadDB, saveDB, newAccount, seedDemo, DEMO_EMAIL } from './db.js';
import { Engine } from './engine.js';
import { orderOut, positionOut, fillOut, ledgerOut, symbolOut, posLiq, posMinMargin, tierFor } from './mappers.js';
import { BizError, oid, iso, cnDate, nextCnMidnight, HOUR, DAY } from './util.js';
import * as C from '../lib/calc.js';

export const db = loadDB();
export const bus = new (class { constructor() { this.fn = new Set(); } on(f) { this.fn.add(f); return () => this.fn.delete(f); } emit(ch, data) { this.fn.forEach((f) => f(ch, data)); } })();

let engine = null;
const codes = new Map(); // email → { code, sentAt, wrong }

function attach() {
  const a = db.session ? db.accounts[db.users[db.session.email]?.uid] : null;
  engine = a ? new Engine(a, { emit: (ch, d) => bus.emit(ch, privatePayload(ch, d)) }, () => saveDB(db)) : null;
}
attach();

/** 私有推送载荷：把内部 oid 展开为接口对象 */
function privatePayload(ch, d) {
  const a = acct();
  if (!a) return d;
  if (ch === 'private.order') { const o = a.orders.find((x) => x.oid === d.order); return { event: d.event, order: o ? orderOut(o) : null }; }
  if (ch === 'private.position') { const p = a.positions.find((x) => x.oid === d.position); return { event: d.event, position: p ? positionOut(p, a) : null }; }
  return d;
}

const acct = () => (db.session ? db.accounts[db.users[db.session.email]?.uid] : null);
function needLogin() {
  const a = acct();
  if (!a) throw new BizError('AUTH_TOKEN_100', '请先登录');
  return a;
}
const eng = () => { needLogin(); if (!engine) attach(); return engine; };

// ---------------------------------------------------------------- 行情循环驱动引擎
market.on('tick', () => {
  if (engine) { try { engine.onTick(); saveDB(db); } catch (e) { console.error('[mock engine]', e); } }
});

// ---------------------------------------------------------------- 公共小工具
function paging(list, body) {
  const pg = body.pagination || {};
  const size = Math.min(Number(pg.size) || 20, 100);
  const useCursor = body.cursor !== undefined && body.cursor !== null && (body.cursor !== '' || !pg.page);
  let start = 0;
  if (body.cursor) start = Number(atob(body.cursor)) || 0;
  else if (pg.page && !useCursor) start = (pg.page - 1) * size;
  else if (pg.page) start = (pg.page - 1) * size;
  const slice = list.slice(start, start + size);
  const more = start + size < list.length;
  const cursorMode = body.cursor !== undefined;
  return {
    list: slice,
    pagination: { page: cursorMode ? 1 : (pg.page || 1), size, total: cursorMode ? -1 : list.length, has_more: more, next_cursor: more ? btoa(String(start + size)) : '' },
  };
}
const inRange = (t, s, e) => (!s || t >= new Date(s).getTime()) && (!e || t <= new Date(e).getTime());
const arr = (v) => (v === undefined || v === null ? null : Array.isArray(v) ? (v.length ? v : null) : [v]);
const has = (a, v) => !a || a.includes(v);
const sortBy = (list, by, order, getter) => {
  const dir = order === 'asc' ? 1 : -1;
  return [...list].sort((x, y) => (getter(x, by) - getter(y, by)) * dir);
};

function needIdem(b) {
  if (!b.idempotency_key || !/^[a-z0-9_-]{1,64}$/.test(b.idempotency_key)) throw new BizError('COMMON_COMMON_002', '参数校验失败', { errors: [{ field: 'idempotency_key', message: 'idempotency_key 仅允许 a-z0-9_- ，长度 1~64' }] });
}

function accountOut(a, e) {
  const s = e.summary();
  const canClaim = a.claimed_date !== cnDate() && a.available < 10000;
  return {
    show_uid: a.show_uid, funding_mode: a.funding_mode, deployment_profile: 'DEMO', currency: 'USDT',
    equity: s.equity.toFixed(2), available_balance: s.available.toFixed(2), position_margin: s.margin.toFixed(2), order_frozen: s.frozen.toFixed(2), unrealized_pnl: s.upnl.toFixed(2),
    is_risk_acked: a.risk_acked, is_active: true,
    capabilities: { claim_enabled: true, cross_margin_enabled: false, api_keys_enabled: true, go_real_enabled: true },
    claim: { can_claim: canClaim, claim_amount: canClaim ? (10000 - a.available).toFixed(2) : '0.00', target_balance: '10000.00', next_claim_time: nextCnMidnight() },
    trade_settings: { ...a.trade_settings },
  };
}

function login(email) {
  let u = db.users[email];
  if (!u) {
    db.seq += Math.floor(1 + Math.random() * 97);
    const acc = newAccount(email, db.seq, false);
    u = { email, uid: acc.uid, password: null };
    db.users[email] = u; db.accounts[acc.uid] = acc;
  }
  db.session = { email, token: 'mock_' + oid(), refresh: 'mockr_' + oid() };
  attach();
  saveDB(db);
  const a = acct();
  return { access_token: db.session.token, refresh_token: db.session.refresh, expires_in: 900, uid: a.uid, show_uid: a.show_uid };
}

// ---------------------------------------------------------------- 路由表
const routes = [];
const R = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)') + '$'), fn });

// ============ 认证 ============
R('POST', '/auth/email-codes/send', (b) => {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email || '')) throw new BizError('AUTH_EMAIL_001', '邮箱格式不正确，请检查后重试');
  if (b.scene === 'REGISTER' && db.users[b.email] && b.email !== 'new@axon.com') throw new BizError('AUTH_EMAIL_002', '该邮箱已注册 Axon 账户，可直接登入开通');
  const prev = codes.get(b.email);
  if (prev && Date.now() - prev.sentAt < 60000) throw new BizError('AUTH_CODE_003', '发送过于频繁', { retry_after_sec: Math.ceil((60000 - (Date.now() - prev.sentAt)) / 1000) });
  codes.set(b.email, { code: '123456', sentAt: Date.now(), wrong: 0 });
  return { resend_after_sec: 60, expire_in_sec: 600 };
});
R('POST', '/auth/register', (b) => {
  const c = codes.get(b.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email || '')) throw new BizError('AUTH_EMAIL_001', '邮箱格式不正确，请检查后重试');
  if (db.users[b.email]) throw new BizError('AUTH_EMAIL_002', '该邮箱已注册 Axon 账户，可直接登入开通');
  if (!c) throw new BizError('AUTH_CODE_002', '验证码已过期，请重新获取');
  if (c.locked && Date.now() < c.locked) throw new BizError('AUTH_CODE_004', '错误次数过多，已锁定 10 分钟', { locked_until_time: iso(c.locked) });
  if (Date.now() - c.sentAt > 600000) throw new BizError('AUTH_CODE_002', '验证码已过期，请重新获取');
  if (b.email_code !== c.code) {
    c.wrong += 1;
    if (c.wrong >= 5) { c.locked = Date.now() + 600000; throw new BizError('AUTH_CODE_004', '错误次数过多，已锁定 10 分钟', { locked_until_time: iso(c.locked) }); }
    throw new BizError('AUTH_CODE_001', '验证码错误，请重新输入', { remaining_attempts: 5 - c.wrong });
  }
  const pw = b.password || '';
  if (pw.length < 8 || pw.length > 32 || !/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) throw new BizError('AUTH_PWD_001', '密码强度不足：8–32 位，含字母与数字');
  if (b.agree_terms !== true) throw new BizError('COMMON_COMMON_002', '请先同意服务条款', { errors: [{ field: 'agree_terms', message: '请先同意服务条款' }] });
  db.seq += Math.floor(1 + Math.random() * 97);
  const acc = newAccount(b.email, db.seq, true);
  db.users[b.email] = { email: b.email, uid: acc.uid, password: pw };
  db.accounts[acc.uid] = acc;
  codes.delete(b.email);
  const r = login(b.email);
  return { ...r, is_new_account: true };
});
R('POST', '/auth/login', (b) => {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email || '')) throw new BizError('AUTH_EMAIL_001', '邮箱格式不正确');
  if (!b.password) throw new BizError('AUTH_LOGIN_001', '账号或密码错误');
  const u = db.users[b.email];
  if (u && u.password && u.password !== b.password && b.email !== DEMO_EMAIL) throw new BizError('AUTH_LOGIN_001', '账号或密码错误');
  const existed = !!u;
  if (!existed && b.email === DEMO_EMAIL) {
    const acc = newAccount(DEMO_EMAIL, 58213907, false);
    seedDemo(acc);
    db.users[DEMO_EMAIL] = { email: DEMO_EMAIL, uid: acc.uid, password: null };
    db.accounts[acc.uid] = acc;
  }
  const r = login(b.email);
  return { ...r, is_new_account: !existed && b.email !== DEMO_EMAIL };
});
R('POST', '/auth/refresh', (b) => {
  if (!db.session || b.refresh_token !== db.session.refresh) throw new BizError('AUTH_TOKEN_102', '登录状态无效');
  db.session.token = 'mock_' + oid();
  saveDB(db);
  return { access_token: db.session.token, refresh_token: db.session.refresh, expires_in: 900 };
});
R('POST', '/auth/logout', () => { db.session = null; engine = null; saveDB(db); return {}; });

// ============ 账户 ============
R('POST', '/contract/accounts/open', () => {
  const a = needLogin();
  const isNew = a.ledgers.length === 0 && a.available === 0;
  if (isNew) { a.available = 10000; a.ledgers.push({ oid: oid(), type: 'GRANT', amount: 10000, before: 0, after: 10000, desc: '开通赠送体验金', time: Date.now() }); saveDB(db); }
  return { show_uid: a.show_uid, account_type: 'TRADE_CONTRACT', is_new_account: isNew, funding_mode: 'GRANT', available_balance: a.available.toFixed(2), is_risk_acked: a.risk_acked };
});
R('GET', '/contract/accounts/me', () => accountOut(needLogin(), eng()));
R('POST', '/contract/accounts/me/ack-risk', () => { const a = needLogin(); a.risk_acked = true; saveDB(db); return { is_risk_acked: true }; });
R('POST', '/contract/accounts/me/claim', () => {
  const a = needLogin();
  if (a.claimed_date === cnDate()) throw new BizError('CONTRACT_ACCOUNT_401', '今日已申请，明日 00:00（UTC+8）后可再次申请', { next_claim_time: nextCnMidnight() });
  if (a.available >= 10000) throw new BizError('CONTRACT_ACCOUNT_402', '余额已达每日上限，暂不可申请');
  if (window.__mockClaimFail) { window.__mockClaimFail = false; throw new BizError('COMMON_COMMON_502', '网络异常，请稍后重试'); }
  const before = a.available; const amt = 10000 - before;
  a.available = 10000; a.claimed_date = cnDate();
  a.ledgers.push({ oid: oid(), type: 'CLAIM', amount: amt, before, after: 10000, desc: '每日补充，补至 10,000', time: Date.now() });
  eng().pushBalance('CLAIM', amt); saveDB(db);
  return { claim_oid: oid(), before_balance_amount: before.toFixed(2), claim_amount: amt.toFixed(2), after_balance_amount: '10000.00' };
});
R('POST', '/contract/accounts/me/practice-summary', (b) => {
  const a = needLogin();
  const since = Date.now() - (b.range_days || 7) * DAY;
  const fills = a.fills.filter((f) => f.time >= since);
  const closed = a.positions.filter((p) => p.status === 'CLOSED' && p.closed >= since);
  const wins = closed.filter((p) => p.realized > 0).length;
  const types = new Set(a.orders.filter((o) => ['TPSL', 'TRAILING', 'CONDITIONAL', 'ICEBERG'].includes(o.order_type)).map((o) => o.order_type));
  return {
    range_days: b.range_days || 7, fill_count: fills.length, win_rate: closed.length ? (wins / closed.length).toFixed(2) : '0.00',
    advanced_order_types_used: types.size, advanced_order_types_total: 4, liquidated_count: closed.filter((p) => p.close_type === 'LIQUIDATED').length, go_real_url: '#/go-real',
  };
});
R('POST', '/contract/accounts/me/trade-settings', (b) => { const a = needLogin(); a.trade_settings.confirm_before_order = !!b.confirm_before_order; saveDB(db); return { ...a.trade_settings }; });

// ============ 行情 / 合约 ============
R('POST', '/contract/symbols/list', (b) => {
  const a = acct();
  const f = b.filters || {};
  let list = Object.values(market.defs);
  if (f.keyword) list = list.filter((s) => s.base_coin.toLowerCase().startsWith(String(f.keyword).toLowerCase()) || s.symbol.toLowerCase().includes(String(f.keyword).toLowerCase()));
  if (f.favorite_only && a) list = list.filter((s) => a.favorites.includes(s.symbol));
  if (f.quote_coin) list = list.filter((s) => s.quote_coin === f.quote_coin);
  return { list: list.map((s) => symbolOut(s, a)) };
});
R('GET', '/contract/symbols/{symbol}', (b, p) => {
  const s = market.defs[p.symbol];
  if (!s) throw new BizError('MARKET_SYMBOL_201', '合约不存在');
  const { _vol, ...rest } = s;
  return { ...rest, is_favorite: acct() ? acct().favorites.includes(s.symbol) : false };
});
R('POST', '/contract/symbols/favorites/set', (b) => {
  const a = needLogin();
  if (!market.defs[b.symbol]) throw new BizError('MARKET_SYMBOL_201', '合约不存在');
  const i = a.favorites.indexOf(b.symbol);
  if (b.is_favorite && i < 0) a.favorites.push(b.symbol);
  if (!b.is_favorite && i >= 0) a.favorites.splice(i, 1);
  saveDB(db);
  return { symbol: b.symbol, is_favorite: !!b.is_favorite };
});
R('POST', '/market/tickers/list', (b) => {
  const syms = b.symbols && b.symbols.length ? b.symbols : market.symbols;
  return { list: syms.filter((s) => market.defs[s]).map((s) => market.tickerOut(s)) };
});
R('POST', '/market/klines/list', (b) => {
  if (!market.defs[b.symbol]) throw new BizError('MARKET_SYMBOL_201', '合约不存在');
  if (!INTERVALS[b.interval]) throw new BizError('MARKET_KLINE_401', '周期不支持');
  let list = market.klinesOut(b.symbol, b.interval, b.kind || 'LAST', b.limit || 300, b.cursor ? atob(b.cursor) : undefined);
  const has_more = list.length >= (b.limit || 300);
  return { list, pagination: { page: 1, size: b.limit || 300, total: -1, has_more, next_cursor: has_more ? btoa(list[0].open_time) : '' } };
});
R('GET', '/market/symbols/{symbol}/trades/latest', (b, p) => {
  if (!market.defs[p.symbol]) throw new BizError('MARKET_SYMBOL_201', '合约不存在');
  return { list: market.tradesOut(p.symbol, 50) };
});
R('GET', '/market/symbols/{symbol}/depth', (b, p) => {
  if (!market.defs[p.symbol]) throw new BizError('MARKET_SYMBOL_201', '合约不存在');
  return market.depthOut(p.symbol);
});
R('GET', '/common/server-time', () => ({ server_time: iso() }));

// ============ 交易 ============
R('POST', '/contract/orders/preview', (b) => {
  const e = eng();
  const emptyQty = !(Number(b.quantity) > 0);
  const req = { ...b };
  if (emptyQty && !['TPSL', 'TRAILING'].includes(b.order_type)) req.quantity = '1';
  if (!req.price && ['LIMIT', 'ICEBERG'].includes(b.order_type) && !b.price_source) req.price = String(market.state[b.symbol].last);
  if (b.order_type === 'ICEBERG' && !b.iceberg_visible_qty) req.iceberg_visible_qty = req.quantity;
  const q = e.quote(req);
  const d = q.d;
  const out = {
    max_open_qty: String(q.maxOpen), required_margin_amount: emptyQty ? '0' : q.required.toFixed(2), est_liq_price: emptyQty || !q.liq ? '0' : q.liq.toFixed(d.price_scale),
    est_fee_amount: emptyQty ? '0' : q.fee.toFixed(4), est_avg_price: q.est.avg.toFixed(d.price_scale), est_slippage_rate: q.est.slip.toFixed(4),
    notional_amount: emptyQty ? '0' : q.notional.toFixed(2), tier: q.tier.tier, maintenance_margin_rate: q.tier.maintenance_margin_rate, warnings: emptyQty ? [] : q.warnings,
  };
  if (b.order_type === 'TPSL' && q.pos) {
    const size = q.size; const lots = b.quantity ? Number(b.quantity) : q.pos.qty;
    const d1 = C.dirOf(q.pos.side);
    if (b.tp_trigger_price) { const v = (Number(b.tp_trigger_price) - q.pos.avg) * lots * size * d1; out.est_pnl_tp = v.toFixed(2); out.est_pnl_rate_tp = (v / q.pos.margin).toFixed(4); }
    if (b.sl_trigger_price) { const v = (Number(b.sl_trigger_price) - q.pos.avg) * lots * size * d1; out.est_pnl_sl = v.toFixed(2); out.est_pnl_rate_sl = (v / q.pos.margin).toFixed(4); }
  }
  if (b.order_type === 'TRAILING' && q.pos) {
    const long = q.pos.side === 'LONG';
    const anchor = Math.max(...[q.s.mark, Number(b.trailing_activation_price) || 0, long ? q.s.high24 * 0.9995 : 0].filter(Boolean));
    out.trailing_anchor_price = (long ? anchor : q.s.mark).toFixed(d.price_scale);
    const cb = b.trailing_mode === 'RATE' ? Number(out.trailing_anchor_price) * Number(b.trailing_callback_value || 0) : Number(b.trailing_callback_value || 0);
    out.trailing_est_trigger_price = (long ? Number(out.trailing_anchor_price) - cb : Number(out.trailing_anchor_price) + cb).toFixed(d.price_scale);
  }
  if (b.order_type === 'ICEBERG' && !emptyQty) out.iceberg_slice_total = Math.ceil(Number(b.quantity) / Number(b.iceberg_visible_qty || b.quantity));
  return out;
});
R('POST', '/contract/orders', (b) => { const e = eng(); needIdem(b); return e.createOrder(b); });
R('POST', '/contract/orders/cancel-all', (b) => { const e = eng(); needIdem(b); return e.cancelAll(b.filters || {}); });
R('POST', '/contract/orders/list', (b) => {
  const a = needLogin(); const e = eng();
  const f = b.filters || {};
  const symbols = arr(f.symbol); const types = arr(f.order_type); const statuses = arr(f.order_status);
  let list = a.orders.filter((o) => {
    if (f.scope === 'CURRENT' && !e.isActive(o)) return false;
    if (f.scope === 'HISTORY' && e.isActive(o)) return false;
    if (!has(symbols, o.symbol) || !has(statuses, o.status)) return false;
    if (types && !types.includes(o.order_type)) return false;
    if (f.order_group && e.groupOf(o) !== f.order_group) return false;
    if (f.position_side && o.side !== f.position_side) return false;
    if (f.position_effect && o.effect !== f.position_effect) return false;
    if (f.is_triggered && !o.triggered) return false;
    if (f.cancel_reason && o.cancel_reason !== f.cancel_reason) return false;
    return inRange(o.create, f.create_time_start, f.create_time_end);
  });
  const current = a.orders.filter((o) => e.isActive(o));
  const typeCounts = { NORMAL: 0, TPSL: 0, TRAILING: 0, CONDITIONAL: 0, ICEBERG: 0 };
  current.forEach((o) => { typeCounts[e.groupOf(o)] += 1; });
  const summary = { current_total: current.length, type_counts: typeCounts };
  if (f.scope === 'HISTORY') summary.history_stats = { total: list.length, filled_count: list.filter((o) => o.filled > 0).length, ended_count: list.filter((o) => o.filled === 0 || ['CANCELED', 'PARTIALLY_CANCELED', 'TRIGGER_FAILED', 'SYSTEM_CANCELED'].includes(o.status)).length };
  list.sort((x, y) => (b.order === 'asc' ? 1 : -1) * (x.create - y.create));
  const p = paging(list, b);
  return { ...p, list: p.list.map((o) => orderOut(o)), summary };
});
R('POST', '/contract/orders/{order_oid}/cancel', (b, p) => eng().cancel(p.order_oid));
R('POST', '/contract/orders/{order_oid}/amend', (b, p) => { const e = eng(); needIdem(b); return e.amend(p.order_oid, b); });
R('GET', '/contract/orders/{order_oid}', (b, p) => {
  const o = needLogin().orders.find((x) => x.oid === p.order_oid);
  if (!o) throw new BizError('CONTRACT_ORDER_201', '委托不存在');
  return orderOut(o, { detail: true });
});
R('GET', '/contract/symbols/{symbol}/settings', (b, p) => {
  const e = eng();
  const d = market.defs[p.symbol];
  if (!d) throw new BizError('MARKET_SYMBOL_201', '合约不存在');
  const total = e.notionalOf(p.symbol);
  const tier = tierFor(p.symbol, total);
  const a = acct();
  const busy = a.positions.some((x) => x.status === 'OPEN' && x.symbol === p.symbol) || a.orders.some((o) => e.isActive(o) && o.symbol === p.symbol);
  const s = e.settings(p.symbol);
  return { symbol: p.symbol, margin_mode: s.margin_mode, leverage: s.leverage, max_leverage: d.max_leverage, max_allowed_leverage: Math.min(d.max_leverage, tier.max_leverage), current_notional_amount: total.toFixed(2), can_switch_margin_mode: !busy };
});
R('POST', '/contract/symbols/{symbol}/leverage', (b, p) => eng().setLeverage(p.symbol, Number(b.leverage)));
R('POST', '/contract/symbols/{symbol}/margin-mode', (b, p) => {
  const e = eng(); const a = acct();
  if (b.margin_mode === 'CROSS') throw new BizError('CONTRACT_POSITION_303', '全仓暂未开放');
  const busy = a.positions.some((x) => x.status === 'OPEN' && x.symbol === p.symbol) || a.orders.some((o) => e.isActive(o) && o.symbol === p.symbol);
  if (busy) throw new BizError('CONTRACT_POSITION_303', '该交易对存在持仓或挂单时不可切换保证金模式');
  e.settings(p.symbol).margin_mode = 'ISOLATED';
  return { symbol: p.symbol, margin_mode: 'ISOLATED' };
});

// ============ 持仓 ============
R('POST', '/contract/positions/list', (b) => {
  const a = needLogin(); const e = eng();
  const f = b.filters || {};
  const status = f.position_status || 'OPEN';
  const symbols = arr(f.symbol); const ctypes = arr(f.close_type);
  let list = a.positions.filter((p) => p.status === status && has(symbols, p.symbol) && (!f.position_side || p.side === f.position_side)
    && (status === 'OPEN' || (has(ctypes, p.close_type) && inRange(p.closed, f.closed_time_start, f.closed_time_end))));
  const out = list.map((p) => ({ p, o: positionOut(p, a) }));
  const by = b.sort_by || (status === 'OPEN' ? 'opened_time' : 'closed_time');
  const key = (x, k) => (k === 'opened_time' ? x.p.opened : k === 'closed_time' ? x.p.closed : k === 'avg_price' ? x.p.avg : Number(x.o[k]));
  const sorted = sortBy(out, by, b.order || 'desc', key);
  const pg = paging(sorted, b);
  const summary = status === 'OPEN'
    ? { count: list.length, unrealized_pnl_total: out.reduce((s, x) => s + Number(x.o.unrealized_pnl_amount), 0).toFixed(2), order_count: a.orders.filter((o) => e.isActive(o)).length }
    : { realized_pnl_total: list.reduce((s, p) => s + p.realized, 0).toFixed(2), win_rate: list.length ? (list.filter((p) => p.realized > 0).length / list.length).toFixed(2) : '0.00', close_count: list.length };
  return { ...pg, list: pg.list.map((x) => x.o), summary };
});
R('GET', '/contract/positions/{position_oid}', (b, p) => {
  const a = needLogin();
  const pos = a.positions.find((x) => x.oid === p.position_oid);
  if (!pos) throw new BizError('CONTRACT_POSITION_201', '仓位不存在');
  return {
    ...positionOut(pos, a),
    tpsl_orders: a.orders.filter((o) => o.position_oid === pos.oid && ['TPSL', 'TRAILING'].includes(o.order_type) && o.status === 'PENDING_TRIGGER').map((o) => orderOut(o)),
    fills_count: a.fills.filter((f) => f.position_oid === pos.oid).length,
  };
});
R('POST', '/contract/positions/close-all', (b) => { const e = eng(); needIdem(b); return e.closeAll(b); });
R('POST', '/contract/positions/{position_oid}/close', (b, p) => { const e = eng(); needIdem(b); return e.closePos(p.position_oid, b); });
R('POST', '/contract/positions/{position_oid}/margin-add', (b, p) => { const e = eng(); if (!b.dry_run) needIdem(b); return e.adjustMargin(p.position_oid, b, 1); });
R('POST', '/contract/positions/{position_oid}/margin-reduce', (b, p) => { const e = eng(); if (!b.dry_run) needIdem(b); return e.adjustMargin(p.position_oid, b, -1); });
R('POST', '/contract/positions/{position_oid}/tpsl', (b, p) => { const e = eng(); needIdem(b); return e.setTpsl(p.position_oid, b); });
R('GET', '/contract/positions/{position_oid}/liquidation', (b, p) => {
  const a = needLogin();
  const pos = a.positions.find((x) => x.oid === p.position_oid);
  if (!pos) throw new BizError('CONTRACT_POSITION_201', '仓位不存在');
  if (pos.close_type !== 'LIQUIDATED') throw new BizError('CONTRACT_POSITION_307', '该仓位不是被强平，无强平详情');
  const d = market.defs[pos.symbol]; const size = Number(d.contract_size);
  const bk = pos.close_avg;
  return {
    position_oid: pos.oid, symbol: pos.symbol, position_side: pos.side, leverage: pos.leverage, loss_amount: (-(pos.margin0 || -pos.realized)).toFixed(2),
    avg_price: pos.avg.toFixed(d.price_scale), position_qty: String(pos.max_qty), liquidation_price: (pos.liq_at_close || 0).toFixed(d.price_scale), bankruptcy_price: bk.toFixed(d.price_scale),
    timeline: pos.events.map((e) => ({ ...e, time: iso(e.time) })), contract_size: String(size),
  };
});

// ============ 成交 / 流水 ============
R('POST', '/contract/fills/list', (b) => {
  const a = needLogin();
  const f = b.filters || {}; const symbols = arr(f.symbol); const types = arr(f.order_type);
  const list = a.fills.filter((x) => has(symbols, x.symbol) && has(types, x.order_type) && (!f.fill_role || x.role === f.fill_role) && (!f.position_effect || x.effect === f.position_effect)
    && (!f.order_oid || x.order_oid === f.order_oid) && (!f.position_oid || x.position_oid === f.position_oid) && inRange(x.time, f.fill_time_start, f.fill_time_end))
    .sort((x, y) => y.time - x.time);
  const pg = paging(list, { ...b, cursor: b.cursor === undefined ? '' : b.cursor });
  return {
    ...pg, list: pg.list.map(fillOut),
    summary: { turnover_total: list.reduce((s, x) => s + x.amount, 0).toFixed(2), fee_total: list.reduce((s, x) => s + x.fee, 0).toFixed(2), maker_count: list.filter((x) => x.role === 'MAKER').length, taker_count: list.filter((x) => x.role === 'TAKER').length },
  };
});
R('POST', '/contract/ledgers/list', (b) => {
  const a = needLogin();
  const f = b.filters || {}; const types = arr(f.ledger_type);
  const list = a.ledgers.filter((l) => has(types, l.type) && (!f.currency || f.currency === 'USDT') && inRange(l.time, f.create_time_start, f.create_time_end)).sort((x, y) => y.time - x.time);
  const pg = paging(list, { ...b, cursor: b.cursor === undefined ? '' : b.cursor });
  return {
    ...pg, list: pg.list.map((l) => ledgerOut(l, a)),
    summary: { income_total: list.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0).toFixed(2), expense_total: list.filter((l) => l.amount < 0).reduce((s, l) => s + l.amount, 0).toFixed(2), available_balance: a.available.toFixed(2) },
  };
});
R('GET', '/contract/ledgers/{ledger_oid}', (b, p) => {
  const a = needLogin();
  const l = a.ledgers.find((x) => x.oid === p.ledger_oid);
  if (!l) throw new BizError('CONTRACT_LEDGER_201', '流水不存在');
  const out = ledgerOut(l, a);
  if (l.liq_price) out.liquidation_price = String(l.liq_price);
  if (l.type === 'LIQUIDATION') out.note = '逐仓仓位保证金已全部清算，只影响该仓位，不影响其他仓位和可用余额中的其余资金。';
  out.links = l.position_oid ? [l.type === 'LIQUIDATION' ? { type: 'LIQUIDATION_DETAIL', position_oid: l.position_oid } : { type: 'POSITION_HISTORY', position_oid: l.position_oid }] : [];
  return out;
});

// ============ API 管理（预留） ============
const maskKey = (k) => k.slice(0, 7) + '••••••••••' + k.slice(-4);
const keyOut = (k) => {
  const exp = k.expire_time ? new Date(k.expire_time).getTime() : null;
  const status = exp && exp < Date.now() ? 'EXPIRED' : exp && exp - Date.now() < 7 * DAY ? 'EXPIRING' : 'NORMAL';
  return { api_key_oid: k.oid, name: k.name, api_key: maskKey(k.api_key), account_type: k.account_type, scopes: k.scopes, trade_scopes: k.trade_scopes, ip_whitelist: k.ip_whitelist, ip_count: k.ip_whitelist.length, status, expire_time: k.expire_time || undefined, last_used_time: k.last_used_time || undefined, create_time: k.create_time };
};
function ensureKeys(a) {
  if (a.email === DEMO_EMAIL && !a.keys_seeded) {
    a.keys_seeded = true;
    a.api_keys.push(
      { oid: oid(), name: '量化-做市机器人', api_key: 'ak_7f3c2e91d04b4a8f9c55e1b0a6d39b21', account_type: 'DEMO', scopes: ['READ', 'TRADE'], trade_scopes: ['FUTURES'], ip_whitelist: ['203.0.113.24', '203.0.113.25', '203.0.113.26'], create_time: iso(Date.now() - 30 * DAY), last_used_time: iso(Date.now() - 2 * HOUR) },
      { oid: oid(), name: '行情看板', api_key: 'ak_90de44b7c1a24f08a1e9d2b36c7f41f8', account_type: 'DEMO', scopes: ['READ'], trade_scopes: [], ip_whitelist: [], expire_time: iso(Date.now() + 6 * DAY), create_time: iso(Date.now() - 84 * DAY) },
    );
  }
}
R('POST', '/auth/api-keys/list', () => { const a = needLogin(); ensureKeys(a); return { list: a.api_keys.map(keyOut), created_count: a.api_keys.length, max_count: 30 }; });
R('POST', '/auth/api-keys/create', (b) => {
  const a = needLogin(); ensureKeys(a); needIdem(b);
  if (a.idem[b.idempotency_key]) return a.idem[b.idempotency_key];
  if (a.api_keys.length >= 30) throw new BizError('AUTH_APIKEY_001', '已达上限（30 / 30），请删除不再使用的 API 后再创建');
  if (!b.name) throw new BizError('COMMON_COMMON_002', '请填写备注名', { errors: [{ field: 'name', message: '请填写备注名' }] });
  if (!b.scopes || !b.scopes.length) throw new BizError('COMMON_COMMON_002', '请至少选择一项权限', { errors: [{ field: 'scopes', message: '请至少选择一项权限' }] });
  if (b.scopes.includes('DEPOSIT_WITHDRAW')) throw new BizError('AUTH_APIKEY_003', 'Demo 账户不提供充提权限');
  if (b.email_code !== '123456') throw new BizError('AUTH_CODE_001', '邮箱验证码错误');
  if (!/^\d{6}$/.test(b.totp_code || '')) throw new BizError('AUTH_TOTP_001', '谷歌验证码错误');
  const ips = (b.ip_whitelist || []).filter(Boolean);
  const badIp = ips.find((ip) => !/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(ip));
  if (badIp) throw new BizError('AUTH_APIKEY_002', `IP 格式不正确：${badIp}`);
  const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const key = { oid: oid(), name: b.name, api_key: 'ak_' + hex(32), api_secret: 'sk_' + btoa(hex(30)).replace(/=/g, ''), account_type: b.account_type || 'DEMO', scopes: b.scopes, trade_scopes: b.scopes.includes('TRADE') ? (b.trade_scopes || ['FUTURES']) : [], ip_whitelist: ips, create_time: iso(), expire_time: ips.length ? undefined : iso(Date.now() + 90 * DAY) };
  a.api_keys.push(key);
  const out = { api_key_oid: key.oid, api_key: key.api_key, api_secret: key.api_secret, scopes: key.scopes, trade_scopes: key.trade_scopes, ip_whitelist: key.ip_whitelist, expire_time: key.expire_time };
  a.idem[b.idempotency_key] = out; // 注意：secret 只在首次返回，这里为 Mock 幂等保留
  saveDB(db);
  return out;
});
R('POST', '/auth/api-keys/{api_key_oid}/update', (b, p) => {
  const a = needLogin(); ensureKeys(a);
  const k = a.api_keys.find((x) => x.oid === p.api_key_oid);
  if (!k) throw new BizError('COMMON_COMMON_201', 'API 不存在');
  if (!/^\d{6}$/.test(b.totp_code || '')) throw new BizError('AUTH_TOTP_001', '谷歌验证码错误');
  if (b.name !== undefined) k.name = b.name;
  if (b.scopes) { k.scopes = b.scopes; k.trade_scopes = b.scopes.includes('TRADE') ? (b.trade_scopes || k.trade_scopes) : []; }
  if (b.ip_whitelist) k.ip_whitelist = b.ip_whitelist.filter(Boolean);
  saveDB(db);
  return keyOut(k);
});
R('POST', '/auth/api-keys/{api_key_oid}/delete', (b, p) => {
  const a = needLogin(); ensureKeys(a);
  const i = a.api_keys.findIndex((x) => x.oid === p.api_key_oid);
  if (i < 0) return {};
  if (!/^\d{6}$/.test(b.totp_code || '')) throw new BizError('AUTH_TOTP_001', '谷歌验证码错误');
  a.api_keys.splice(i, 1); saveDB(db);
  return {};
});

// ---------------------------------------------------------------- 入口
export function mockRequest(method, path, body = {}) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(path);
    if (m) return r.fn(body, m.groups || {});
  }
  throw new BizError('COMMON_COMMON_201', `接口不存在：${method} ${path}`);
}

export const OPEN_PATHS = ['/auth/email-codes/send', '/auth/register', '/auth/login', '/auth/refresh', '/common/server-time'];

export function isLoggedIn() { return !!acct(); }
export function currentToken() { return db.session ? db.session.token : null; }
export function mockReset() { localStorage.removeItem('axon_mock_db_v2'); location.hash = '#/entry'; location.reload(); }
export { posLiq, posMinMargin };
