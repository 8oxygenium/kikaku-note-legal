/* Service Worker — オフライン起動用キャッシュ。
 *  - アプリ本体（HTML/CSS/JS/アイコン）: cache-first（速い・更新は CACHE 版を上げて反映）
 *  - データ/音声（/data/・/audio/）: network-first（オンラインなら最新、オフラインはキャッシュ）
 *    → 条文JSONを差し替えても、cache-first にマスクされず更新が見える。
 */
const CACHE = 'roppou-v0.1.2';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './playback.js',
  './app.js',
  './manifest.json',
  './icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isContent(url) {
  return url.pathname.includes('/data/') || url.pathname.includes('/audio/');
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin && isContent(url)) {
    // network-first（最新優先・失敗時キャッシュ）
    e.respondWith(
      fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // cache-first（アプリ本体）
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok && sameOrigin) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }))
  );
});
