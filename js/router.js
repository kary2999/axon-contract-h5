// 极简 hash 路由：#/trade/BTC-USDT-PERP?x=1 → { path, params, query }。
// 选 hash 而不是 history 的原因：静态托管 / 内嵌 WebView / 本地 file 打开都不需要服务端回退配置。
const { reactive } = Vue;

export const route = reactive({ name: '', path: '/', params: {}, query: {}, meta: {} });

let table = [];
export function defineRoutes(list) {
  table = list.map((r) => ({ ...r, re: new RegExp('^' + r.path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '/?$') }));
}

function parse() {
  const raw = location.hash.replace(/^#/, '') || '/markets';
  const [path, qs = ''] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs));
  for (const r of table) {
    const m = r.re.exec(path);
    if (m) {
      const params = {};
      Object.entries(m.groups || {}).forEach(([k, v]) => { params[k] = decodeURIComponent(v); });
      return { name: r.name, path, params, query, meta: r.meta || {} };
    }
  }
  return { name: 'NotFound', path, params: {}, query, meta: {} };
}

let guard = () => true;
export function setGuard(fn) { guard = fn; }

export function syncRoute() {
  let r = parse();
  const redirect = guard(r);
  if (typeof redirect === 'string') { location.replace('#' + redirect); r = parse(); }
  Object.assign(route, r);
}

export function startRouter() {
  window.addEventListener('hashchange', syncRoute);
  syncRoute();
}

export function go(path, query) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  location.hash = '#' + path + qs;
}
export function replace(path) { location.replace('#' + path); }
export function back(fallback = '/markets') {
  if (history.length > 1) history.back(); else go(fallback);
}
