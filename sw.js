// PWA service worker：静态资源离线缓存（H5「添加到主屏幕」后可离线打开壳；接口请求不缓存）。
// 升级版本时改 VERSION，旧缓存会被清掉。
const VERSION = 'axon-client-v1';
const CORE = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg', 'css/app.css', 'vendor/vue.global.prod.js', 'vendor/klinecharts.min.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  // 页面与脚本：网络优先，失败回退缓存；vendor 与图标：缓存优先
  const cacheFirst = /\/vendor\/|icon\.svg|manifest/.test(url.pathname);
  e.respondWith(
    cacheFirst
      ? caches.match(req).then((hit) => hit || fetch(req).then((r) => { const c = r.clone(); caches.open(VERSION).then((x) => x.put(req, c)); return r; }))
      : fetch(req).then((r) => { const c = r.clone(); caches.open(VERSION).then((x) => x.put(req, c)); return r; }).catch(() => caches.match(req)),
  );
});
