// Mock 行情模拟器：随机游走生成 ticker / 盘口 / 成交 / K 线，并按 api-doc/07-websocket.md 的频道推送。
// 只用于演示，价格不是真实行情。

import { decimalsOf } from '../lib/format.js';

import { fixtures } from './data.js';

export const INTERVALS = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 };
const BAR_COUNT = 300;

const rnd = (a, b) => a + Math.random() * (b - a);
const gauss = () => (Math.random() + Math.random() + Math.random() + Math.random() - 2) / 2 * 1.7;
const roundTo = (v, step) => Number((Math.round(v / step) * step).toFixed(decimalsOf(step)));

function nextFundingTime(now = Date.now()) {
  const d = new Date(now);
  const h = d.getUTCHours();
  const next = [0, 8, 16, 24].find((x) => x > h);
  d.setUTCHours(next, 0, 0, 0);
  return d.toISOString();
}

class Emitter {
  constructor() { this.m = new Map(); }
  on(ev, fn) { if (!this.m.has(ev)) this.m.set(ev, new Set()); this.m.get(ev).add(fn); return () => this.m.get(ev).delete(fn); }
  emit(ev, data) { const s = this.m.get(ev); if (s) s.forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }
}

class MarketSim extends Emitter {
  constructor() {
    super();
    this.state = {};
    this.defs = {};
    this.timer = null;
    for (const s of fixtures.symbols) this.initSymbol(s);
  }

  get symbols() { return Object.keys(this.defs); }

  /** s = symbols.json 里的一项：接口字段 + mock 段（base_price / change_24h / turnover_24h / volatility_per_sec） */
  initSymbol(s) {
    const { mock, ...apiFields } = s;
    const d = { price: mock.base_price, chg: mock.change_24h, turnover: mock.turnover_24h, vol: mock.volatility_per_sec };
    const symbol = s.symbol;
    this.defs[symbol] = { ...apiFields, _vol: d.vol };
    const last = d.price;
    const st = {
      last, mark: last * 0.99997, index: last * 0.99992, anchor: last,
      open24: last / (1 + d.chg), high24: last * 1.008, low24: last * 0.985,
      volume24: d.turnover / last, turnover24: d.turnover,
      funding: 0.0001, predicted: 0.000087,
      trades: [], bars: {}, depth: null, bookSeq: 1,
    };
    this.state[symbol] = st;
    for (const iv of Object.keys(INTERVALS)) st.bars[iv] = this.genBars(symbol, iv);
    st.depth = this.genDepth(symbol);
    for (let i = 0; i < 40; i++) this.pushTrade(symbol, true);
  }

  // ----- K 线 -----
  genBars(symbol, iv) {
    const st = this.state[symbol];
    const def = this.defs[symbol];
    const ms = INTERVALS[iv] * 60000;
    const tick = Number(def.price_tick);
    const now = Math.floor(Date.now() / ms) * ms;
    const volPerBar = def._vol * 12 * Math.sqrt(INTERVALS[iv]);
    const bars = [];
    let close = st.last;
    for (let i = 0; i < BAR_COUNT; i++) {
      const t = now - i * ms;
      const open = i === 0 ? close * (1 - gauss() * volPerBar * 0.3) : close * (1 - gauss() * volPerBar);
      const hi = Math.max(open, close) * (1 + Math.abs(gauss()) * volPerBar * 0.4);
      const lo = Math.min(open, close) * (1 - Math.abs(gauss()) * volPerBar * 0.4);
      const vol = rnd(0.3, 1.6) * (st.volume24 / (1440 / INTERVALS[iv])) ;
      bars.push({
        t, o: roundTo(open, tick), h: roundTo(hi, tick), l: roundTo(lo, tick), c: roundTo(close, tick),
        v: vol, closed: i !== 0,
      });
      close = open; // 向过去游走
    }
    return bars.reverse();
  }

  barOut(b, def, turnoverPrice) {
    return {
      open_time: new Date(b.t).toISOString(),
      open: b.o.toFixed(def.price_scale), high: b.h.toFixed(def.price_scale),
      low: b.l.toFixed(def.price_scale), close: b.c.toFixed(def.price_scale),
      volume: b.v.toFixed(3), turnover: (b.v * (turnoverPrice || b.c)).toFixed(2), is_closed: b.closed,
    };
  }

  // ----- 盘口 -----
  genDepth(symbol) {
    const st = this.state[symbol];
    const def = this.defs[symbol];
    const tick = Number(def.price_tick);
    const step = Math.max(tick, roundTo(st.last * 0.000035, tick));
    const half = Math.max(tick / 2, step / 2);
    const unit = 40000 / st.last;
    const csz = Number(def.contract_size);
    const mk = (side) => {
      const out = [];
      let price = side === 'bid' ? roundTo(st.last - half, tick) : roundTo(st.last + half, tick);
      if (side === 'bid' && price >= st.last) price = roundTo(st.last - tick, tick);
      if (side === 'ask' && price <= st.last) price = roundTo(st.last + tick, tick);
      for (let i = 0; i < 20; i++) {
        const q = Math.max(csz, roundTo(unit * rnd(0.05, 1.6), csz));
        out.push({ p: price, q });
        price = roundTo(price + (side === 'bid' ? -1 : 1) * step * rnd(0.6, 2.2), tick);
      }
      return out;
    };
    return { bids: mk('bid'), asks: mk('ask') };
  }

  depthOut(symbol, n = 20) {
    const st = this.state[symbol];
    const def = this.defs[symbol];
    const f = (x) => ({ price: x.p.toFixed(def.price_scale), quantity: x.q.toFixed(def.qty_scale) });
    return { symbol, bids: st.depth.bids.slice(0, n).map(f), asks: st.depth.asks.slice(0, n).map(f), book_seq: st.bookSeq, depth_time: new Date().toISOString() };
  }

  /** 吃盘：返回 { avg, filled, worst }，超出 20 档后每档 +0.02% 外推（Mock 里不会无对手盘） */
  sweep(symbol, side, qtyCoin) {
    const st = this.state[symbol];
    const levels = side === 'BUY' ? st.depth.asks : st.depth.bids;
    let rest = qtyCoin; let cost = 0; let worst = levels[0].p;
    for (const lv of levels) {
      const take = Math.min(rest, lv.q);
      cost += take * lv.p; rest -= take; worst = lv.p;
      if (rest <= 1e-12) break;
    }
    if (rest > 1e-12) {
      let p = worst;
      const stepRate = side === 'BUY' ? 0.0002 : -0.0002;
      while (rest > 1e-12) {
        p = p * (1 + stepRate);
        const take = Math.min(rest, levels[0].q * 2);
        cost += take * p; rest -= take; worst = p;
      }
    }
    return { avg: cost / qtyCoin, worst };
  }

  /** 按"最优价"模式取价（下单瞬间取价） */
  bboPrice(symbol, side, source) {
    const st = this.state[symbol];
    const buy = side === 'BUY';
    const counter = buy ? st.depth.asks : st.depth.bids;
    const same = buy ? st.depth.bids : st.depth.asks;
    const idx = source.endsWith('_5') ? 4 : 0;
    return (source.startsWith('COUNTER') ? counter : same)[idx].p;
  }

  // ----- 成交 -----
  pushTrade(symbol, silent = false) {
    const st = this.state[symbol];
    const def = this.defs[symbol];
    const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
    const price = roundTo(st.last * (1 + gauss() * 0.00003), Number(def.price_tick));
    const q = roundTo(Math.max(Number(def.contract_size), rnd(0.002, 0.5) * 40000 / st.last / 5), Number(def.contract_size));
    const tr = { t: Date.now(), p: price, q, side };
    st.trades.unshift(tr);
    if (st.trades.length > 200) st.trades.length = 200;
    st.volume24 += q; st.turnover24 += q * price;
    if (!silent) this.emit('trade', { symbol, trade: tr });
    return tr;
  }

  // ----- 对外读取 -----
  tickerOut(symbol) {
    const st = this.state[symbol];
    const def = this.defs[symbol];
    const dp = def.price_scale;
    const change = st.last - st.open24;
    return {
      symbol,
      last_price: st.last.toFixed(dp), mark_price: st.mark.toFixed(dp), index_price: st.index.toFixed(dp),
      price_change: change.toFixed(dp), price_change_rate: (change / st.open24).toFixed(4),
      high_24h: st.high24.toFixed(dp), low_24h: st.low24.toFixed(dp),
      volume_24h: st.volume24.toFixed(3), turnover_24h: st.turnover24.toFixed(2),
      funding_rate: st.funding.toFixed(6), predicted_funding_rate: st.predicted.toFixed(6),
      next_funding_time: nextFundingTime(), ticker_time: new Date().toISOString(),
    };
  }

  tradesOut(symbol, n = 20) {
    const def = this.defs[symbol];
    return this.state[symbol].trades.slice(0, n).map((t) => this.tradeOut(def, t));
  }
  tradeOut(def, t) {
    return { trade_time: new Date(t.t).toISOString(), price: t.p.toFixed(def.price_scale), quantity: t.q.toFixed(def.qty_scale), side: t.side };
  }

  klinesOut(symbol, iv, kind, limit = 300, before) {
    const st = this.state[symbol];
    const def = this.defs[symbol];
    let bars = st.bars[iv];
    if (before) bars = bars.filter((b) => b.t < new Date(before).getTime());
    bars = bars.slice(-limit);
    const off = kind === 'MARK' ? -0.00003 : 0;
    const out = bars.map((b) => this.barOut(off ? { ...b, o: b.o * (1 + off), h: b.h * (1 + off), l: b.l * (1 + off), c: b.c * (1 + off) } : b, def));
    return out;
  }

  // ----- 驱动 -----
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000);
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  tick() {
    const now = Date.now();
    for (const symbol of this.symbols) {
      const def = this.defs[symbol];
      const st = this.state[symbol];
      const tick = Number(def.price_tick);
      // 随机游走 + 向锚点轻微回归，避免长时间漂移
      const drift = (st.anchor - st.last) / st.anchor * 0.02;
      st.last = Math.max(tick, roundTo(st.last * (1 + gauss() * def._vol + drift), tick));
      st.mark = roundTo(st.last * (1 - 0.00003 + gauss() * 0.00001), tick);
      st.index = roundTo(st.mark * (1 - 0.00005), tick);
      st.high24 = Math.max(st.high24, st.last);
      st.low24 = Math.min(st.low24, st.last);
      st.funding = Math.max(-0.0005, Math.min(0.0005, st.funding + gauss() * 0.0000005));
      this.pushTrade(symbol);
      if (Math.random() < 0.5) this.pushTrade(symbol);
      st.depth = this.genDepth(symbol);
      st.bookSeq++;

      // K 线：更新或滚动当前 bar
      for (const iv of Object.keys(INTERVALS)) {
        const ms = INTERVALS[iv] * 60000;
        const bars = st.bars[iv];
        let cur = bars[bars.length - 1];
        const slot = Math.floor(now / ms) * ms;
        if (cur.t < slot) {
          cur.closed = true;
          cur = { t: slot, o: cur.c, h: st.last, l: st.last, c: st.last, v: 0, closed: false };
          bars.push(cur);
          if (bars.length > BAR_COUNT + 50) bars.shift();
        }
        cur.c = st.last; cur.h = Math.max(cur.h, st.last); cur.l = Math.min(cur.l, st.last);
        cur.v += rnd(0.1, 1.2) * (st.volume24 / 86400);
        this.emit('kline', { symbol, interval: iv, bar: this.barOut(cur, def) });
      }

      this.emit('ticker', { symbol, ticker: this.tickerOut(symbol) });
      this.emit('depth', { symbol, depth: this.depthOut(symbol) });
      this.emit('mark_price', { symbol, data: { mark_price: st.mark.toFixed(def.price_scale), index_price: st.index.toFixed(def.price_scale), mark_time: new Date(now).toISOString() } });
    }
    this.emit('tick', { now });
  }
}

export const market = new MarketSim();
