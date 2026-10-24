// 接口函数：一个函数 = 一个接口，路径 / 字段与 api-doc 一一对应。页面只调这里，不直接用 client。
import { get, post, query, newIdemKey } from './client.js';

const enc = encodeURIComponent;
/** 写接口统一补幂等键：调用方若已有 key（重试场景）则沿用 */
const withKey = (body = {}) => ({ idempotency_key: body.idempotency_key || newIdemKey(), ...body });

// ---- 01 认证 / 账户 ----
export const auth = {
  sendCode: (email, scene = 'REGISTER') => post('/auth/email-codes/send', { email, scene }),
  register: (body) => post('/auth/register', body),
  login: (email, password) => post('/auth/login', { email, password }),
  logout: () => post('/auth/logout', {}),
};
export const account = {
  open: (register_channel) => post('/contract/accounts/open', register_channel ? { register_channel } : {}),
  me: (o) => get('/contract/accounts/me', o),
  ackRisk: () => post('/contract/accounts/me/ack-risk', {}),
  claim: () => post('/contract/accounts/me/claim', {}),
  practiceSummary: (range_days = 7) => query('/contract/accounts/me/practice-summary', { range_days }),
  setTradeSettings: (confirm_before_order) => post('/contract/accounts/me/trade-settings', { confirm_before_order }),
};

// ---- 02 行情 ----
export const market = {
  symbols: (filters = {}, o) => query('/contract/symbols/list', { filters }, o),
  symbol: (symbol, o) => get(`/contract/symbols/${enc(symbol)}`, o),
  setFavorite: (symbol, is_favorite) => post('/contract/symbols/favorites/set', { symbol, is_favorite }),
  tickers: (symbols = [], o) => query('/market/tickers/list', { symbols }, o),
  klines: (body, o) => query('/market/klines/list', body, o),
  trades: (symbol, o) => get(`/market/symbols/${enc(symbol)}/trades/latest`, o),
  depth: (symbol, o) => get(`/market/symbols/${enc(symbol)}/depth`, o),
  serverTime: () => get('/common/server-time'),
};

// ---- 03 交易 ----
export const order = {
  preview: (body, o) => query('/contract/orders/preview', body, o),
  create: (body) => post('/contract/orders', withKey(body)),
  cancel: (order_oid) => post(`/contract/orders/${enc(order_oid)}/cancel`, {}),
  cancelAll: (filters) => post('/contract/orders/cancel-all', withKey({ filters })),
  amend: (order_oid, body) => post(`/contract/orders/${enc(order_oid)}/amend`, withKey(body)),
  detail: (order_oid, o) => get(`/contract/orders/${enc(order_oid)}`, o),
  list: (body, o) => query('/contract/orders/list', body, o),
  settings: (symbol, o) => get(`/contract/symbols/${enc(symbol)}/settings`, o),
  setLeverage: (symbol, leverage) => post(`/contract/symbols/${enc(symbol)}/leverage`, { leverage }),
  setMarginMode: (symbol, margin_mode) => post(`/contract/symbols/${enc(symbol)}/margin-mode`, { margin_mode }),
};

// ---- 04 持仓 ----
export const position = {
  list: (body, o) => query('/contract/positions/list', body, o),
  detail: (position_oid, o) => get(`/contract/positions/${enc(position_oid)}`, o),
  close: (position_oid, body) => post(`/contract/positions/${enc(position_oid)}/close`, withKey(body)),
  closeAll: (position_oids) => post('/contract/positions/close-all', withKey(position_oids ? { position_oids } : {})),
  marginAdd: (position_oid, body) => post(`/contract/positions/${enc(position_oid)}/margin-add`, body.dry_run ? body : withKey(body)),
  marginReduce: (position_oid, body) => post(`/contract/positions/${enc(position_oid)}/margin-reduce`, body.dry_run ? body : withKey(body)),
  tpsl: (position_oid, body) => post(`/contract/positions/${enc(position_oid)}/tpsl`, withKey(body)),
  liquidation: (position_oid, o) => get(`/contract/positions/${enc(position_oid)}/liquidation`, o),
};

// ---- 05 历史 ----
export const history = {
  fills: (body, o) => query('/contract/fills/list', body, o),
  ledgers: (body, o) => query('/contract/ledgers/list', body, o),
  ledger: (ledger_oid, o) => get(`/contract/ledgers/${enc(ledger_oid)}`, o),
};

// ---- 06 API 管理（预留） ----
export const apiKeys = {
  list: (account_type = 'DEMO', o) => query('/auth/api-keys/list', { filters: { account_type } }, o),
  create: (body) => post('/auth/api-keys/create', withKey(body)),
  update: (oid, body) => post(`/auth/api-keys/${enc(oid)}/update`, body),
  remove: (oid, totp_code) => post(`/auth/api-keys/${enc(oid)}/delete`, { totp_code }),
};

export { newIdemKey };
