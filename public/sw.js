/* Service Worker —— 让页面能装到主屏、秒开、没网也能打开界面。
 *
 * 策略是「网络优先,失败回落缓存」:
 *   - 有网时永远拿最新的,重新部署后刷新一下就生效,不会卡在旧版本
 *   - 没网时至少界面能开起来(识别本来就需要网,开起来也只是能看设置)
 *   - /api/ 一律不碰 —— 中转接口绝不能被缓存
 */
const CACHE = 'si-shell-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest',
               './icon-192.png', './icon-512.png', './apple-touch-icon.png', './favicon.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .catch(() => {})            // 某个图标没传上去也不该让安装整个失败
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== location.origin) return;        // 第三方资源不管
  if (url.pathname.startsWith('/api/')) return;      // 中转接口:直通,不缓存

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(m => m || caches.match('./index.html')))
  );
});
