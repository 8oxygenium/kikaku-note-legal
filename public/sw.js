/* Service Worker — オフライン対応キャッシュ。
 * 開発・更新が頻繁なうちは「network-first（最新優先・失敗時キャッシュ）」で全アセットを扱う。
 *  → push で更新したら、オンラインなら常に最新が出る（古いシェルがキャッシュに張り付かない）。
 *  → オフライン時のみキャッシュから配信。
 * 表示が更新されない場合は CACHE 版を上げると確実に切り替わる。
 */
const CACHE = 'roppou-v0.1.3';
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

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const sameOrigin = new URL(req.url).origin === self.location.origin;
  if (!sameOrigin) return; // 外部はブラウザ任せ

  // network-first：最新を取りに行き、成功したらキャッシュ更新。失敗時のみキャッシュ。
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});
