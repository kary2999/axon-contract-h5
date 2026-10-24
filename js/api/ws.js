// WebSocket 封装（api-doc/07-websocket.md）。
// 对外：ws.subscribe(channel, handler) → 取消订阅函数；ws.state 为响应式连接状态。
// Mock 模式下不建真实连接，直接把 market 模拟器与引擎的私有事件当作推送源。

import { config } from '../config.js';
import { auth } from './client.js';

const { reactive } = Vue;

export const wsState = reactive({ status: 'idle', lastMsgAt: 0, offline: false });

const subs = new Map(); // channel → Set<handler>
const isPrivate = (ch) => ch.startsWith('private.');

// ------------------------------ Mock 源 ------------------------------
let mockOff = [];
// 演示开关：__mockOffline = 断网（WS 与请求都失败）；__mockLag = 只有行情推送暂停（用于「行情延迟」提示）
const pub = () => !window.__mockOffline && !window.__mockLag;
async function startMock() {
  stopMock();
  const { market } = await import('../mock/market.js');
  const { bus } = await import('../mock/handlers.js');
  const dispatch = (ch, payload, type = 'update') => {
    const hs = subs.get(ch);
    if (!hs || !hs.size) return;
    wsState.lastMsgAt = Date.now();
    hs.forEach((h) => { try { h({ channel: ch, type, ts: new Date().toISOString(), data: payload }); } catch (e) { console.error(e); } });
  };
  mockOff = [
    market.on('ticker', ({ symbol, ticker }) => pub() && dispatch(`ticker.${symbol}`, ticker)),
    market.on('depth', ({ symbol, depth }) => pub() && dispatch(`depth.${symbol}`, depth)),
    market.on('trade', ({ symbol, trade }) => pub() && dispatch(`trade.${symbol}`, market.tradeOut(market.defs[symbol], trade))),
    market.on('kline', ({ symbol, interval, bar }) => pub() && dispatch(`kline.${symbol}.${interval}`, bar)),
    market.on('mark_price', ({ symbol, data }) => pub() && dispatch(`mark_price.${symbol}`, data)),
    bus.on((ch, data) => dispatch(ch, data)),
  ];
  wsState.status = 'open';
}
function stopMock() { mockOff.forEach((f) => f()); mockOff = []; }

// ------------------------------ 真实连接 ------------------------------
let sock = null; let retry = 0; let pingTimer = null; let watchdog = null;
function connectReal() {
  if (sock && (sock.readyState === 0 || sock.readyState === 1)) return;
  wsState.status = 'connecting';
  sock = new WebSocket(config.WS_URL);
  sock.onopen = () => {
    retry = 0; wsState.status = 'open'; wsState.offline = false;
    if (auth.token) sock.send(JSON.stringify({ op: 'auth', token: auth.token }));
    const chs = [...subs.keys()];
    if (chs.length) sock.send(JSON.stringify({ op: 'subscribe', args: chs }));
    clearInterval(pingTimer);
    pingTimer = setInterval(() => sock.readyState === 1 && sock.send('{"op":"ping"}'), 20000);
  };
  sock.onmessage = (ev) => {
    wsState.lastMsgAt = Date.now();
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.op) return; // pong / subscribed / error
    const hs = subs.get(m.channel);
    if (hs) hs.forEach((h) => h(m));
  };
  sock.onclose = () => {
    wsState.status = 'closed'; wsState.offline = true;
    clearInterval(pingTimer);
    const wait = Math.min(15000, 1000 * 2 ** retry++);
    setTimeout(connectReal, wait);
  };
  sock.onerror = () => { try { sock.close(); } catch { /* 忽略 */ } };
}

export const ws = {
  state: wsState,
  start() {
    if (config.USE_MOCK) startMock(); else connectReal();
    // 60s 无任何帧 → 视为断线 / 行情过期
    clearInterval(watchdog);
    watchdog = setInterval(() => {
      const stale = wsState.lastMsgAt && Date.now() - wsState.lastMsgAt > 5000;
      wsState.offline = !!window.__mockOffline || (wsState.status !== 'open') || !!stale;
    }, 1000);
  },
  /** 订阅频道，返回取消订阅函数；同一频道可多处订阅 */
  subscribe(channel, handler) {
    if (!subs.has(channel)) {
      subs.set(channel, new Set());
      if (!config.USE_MOCK && sock && sock.readyState === 1) sock.send(JSON.stringify({ op: 'subscribe', args: [channel] }));
    }
    subs.get(channel).add(handler);
    return () => {
      const hs = subs.get(channel);
      if (!hs) return;
      hs.delete(handler);
      if (!hs.size) {
        subs.delete(channel);
        if (!config.USE_MOCK && sock && sock.readyState === 1) sock.send(JSON.stringify({ op: 'unsubscribe', args: [channel] }));
      }
    };
  },
  isPrivate,
};
