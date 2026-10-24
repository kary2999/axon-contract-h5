// 唯一的请求入口（前端规范 §3）：页面和组件禁止直接 fetch。
// 统一处理：Envelope 解析、X-Trace-Id、401 刷新、超时、读接口重试；写接口不自动重试。
// USE_MOCK=true 时请求被转给 js/mock，其余逻辑（含 ApiError）完全一致。

import { config } from '../config.js';

export class ApiError extends Error {
  constructor({ code, msg, data, trace_id, http_status }) {
    super(msg || code);
    this.name = 'ApiError';
    this.code = code;
    this.msg = msg || '';        // 页面统一用 e.msg 展示（仅作展示，逻辑判断只用 code）
    this.data = data || {};
    this.trace_id = trace_id;
    this.http_status = http_status || 200;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }));

/** 一个用户操作一个 key，重试沿用同一个（见 api-doc/README §1.4） */
export const newIdemKey = () => uuid().replace(/-/g, '').slice(0, 32);

const tokenStore = {
  get access() { try { return localStorage.getItem('axon_access') || ''; } catch { return ''; } },
  set access(v) { try { v ? localStorage.setItem('axon_access', v) : localStorage.removeItem('axon_access'); } catch { /* 忽略 */ } },
  get refresh() { try { return localStorage.getItem('axon_refresh') || ''; } catch { return ''; } },
  set refresh(v) { try { v ? localStorage.setItem('axon_refresh', v) : localStorage.removeItem('axon_refresh'); } catch { /* 忽略 */ } },
};
export const auth = {
  set(a, r) { tokenStore.access = a; tokenStore.refresh = r; },
  clear() { tokenStore.access = ''; tokenStore.refresh = ''; },
  get token() { return tokenStore.access; },
};

/** 401 之后由 main.js 注入：清登录态并跳登录页 */
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

function envelope(code, msg, data, traceId) {
  return { code, msg, data, trace_id: traceId, timestamp: new Date().toISOString() };
}

// Mock 后端按需加载：USE_MOCK=false 时不会请求 js/mock/ 下的任何文件
let mock = null;
const loadMock = async () => (mock = mock || { ...(await import('../mock/handlers.js')), ...(await import('../mock/util.js')) });

async function rawSend(method, path, body, traceId, signal) {
  if (config.USE_MOCK) {
    const { mockRequest, OPEN_PATHS, currentToken, BizError, sleep, rand } = await loadMock();
    await sleep(rand(...config.MOCK_LATENCY_MS));
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!OPEN_PATHS.includes(path) && !currentToken()) {
      return { status: 401, body: envelope('AUTH_TOKEN_100', '请先登录', {}, traceId) };
    }
    if (window.__mockOffline) throw new TypeError('Failed to fetch');
    try {
      const data = mockRequest(method, path, body ? JSON.parse(JSON.stringify(body)) : {});
      return { status: 200, body: envelope('0', 'success', data === undefined ? {} : data, traceId) };
    } catch (e) {
      if (e instanceof BizError) {
        const status = e.code === 'COMMON_COMMON_401' ? 429 : e.code.startsWith('AUTH_TOKEN') ? 401 : e.code === 'COMMON_COMMON_502' ? 502 : 200;
        return { status, body: envelope(e.code, e.message, e.data || {}, traceId) };
      }
      console.error('[mock]', e);
      return { status: 500, body: envelope('COMMON_COMMON_501', '内部异常', {}, traceId) };
    }
  }
  const res = await fetch(config.BASE_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Trace-Id': traceId, ...(tokenStore.access ? { Authorization: `Bearer ${tokenStore.access}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    signal,
  });
  const json = await res.json().catch(() => envelope('COMMON_COMMON_501', '响应不是合法 JSON', {}, traceId));
  return { status: res.status, body: json };
}

let refreshing = null;
async function tryRefresh() {
  if (!tokenStore.refresh) return false;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const r = await rawSend('POST', '/auth/refresh', { refresh_token: tokenStore.refresh }, uuid());
        if (r.body.code === '0') { auth.set(r.body.data.access_token, r.body.data.refresh_token); return true; }
      } catch { /* 刷新失败按未登录处理 */ }
      return false;
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

/**
 * request(method, path, body, opts)
 *   opts.signal  AbortController 的 signal（页面卸载时取消）
 *   opts.retry   读接口最大重试次数，默认 GET / 列表读取 2 次；写接口强制 0
 */
export async function request(method, path, body, opts = {}) {
  const isRead = method === 'GET' || opts.read === true;
  const maxRetry = isRead ? (opts.retry ?? 2) : 0;
  const traceId = uuid();
  let attempt = 0;
  let refreshed = false;
  for (;;) {
    try {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), config.REQUEST_TIMEOUT_MS);
      if (opts.signal) opts.signal.addEventListener('abort', () => timeout.abort(), { once: true });
      let r;
      try { r = await rawSend(method, path, body, traceId, timeout.signal); } finally { clearTimeout(timer); }
      const { status, body: env } = r;
      if (env.code === '0') return env.data;
      if (status === 401) {
        if (env.code === 'AUTH_TOKEN_101' && !refreshed && (await tryRefresh())) { refreshed = true; continue; }
        auth.clear(); onUnauthorized();
      }
      throw new ApiError({ code: env.code, msg: env.msg, data: env.data, trace_id: env.trace_id || traceId, http_status: status });
    } catch (e) {
      if (e instanceof ApiError) {
        // 429 / 5xx：读接口退避重试
        if (isRead && attempt < maxRetry && (e.http_status === 429 || e.http_status >= 500)) { attempt++; await sleep(300 * attempt); continue; }
        throw e;
      }
      if (e && e.name === 'AbortError' && opts.signal && opts.signal.aborted) throw e; // 主动取消：不转换
      // 网络错误 / 超时
      if (isRead && attempt < maxRetry) { attempt++; await sleep(300 * attempt); continue; }
      throw new ApiError({ code: 'NETWORK_ERROR', msg: '网络异常，请检查网络后重试', trace_id: traceId, http_status: 0 });
    }
  }
}

export const get = (path, opts) => request('GET', path, undefined, opts);
/** POST 读接口（列表查询）：幂等，可重试 */
export const query = (path, body, opts) => request('POST', path, body, { ...opts, read: true });
/** POST 写接口：不自动重试 */
export const post = (path, body, opts) => request('POST', path, body, opts);
