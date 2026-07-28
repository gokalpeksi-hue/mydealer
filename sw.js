const CACHE = 'mydealer-v16';
const ASSETS = [
  './', './index.html', './app.js', './data.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable.png', './icon.svg',
  './vendor/leaflet.js', './vendor/leaflet.css',
  './vendor/markercluster.js', './vendor/markercluster.css', './vendor/markercluster.default.css'
];
self.addEventListener('install', e => {
  // data.js yayınlanan sürümde yoktur; tek tek ekle, olmayan dosya kurulumu bozmasın
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.allSettled(ASSETS.map(a => c.add(a))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // dış istekler (OSM karoları, Google giriş/Drive) her zaman ağdan
  if (url.origin !== location.origin) return;

  const kaydet = res => {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
    return res;
  };

  // uygulama kodu (index.html, app.js, data.js, manifest): ağ önce.
  // Böylece yeni sürüm ilk yenilemede gelir; internet yoksa önbellekten açılır.
  const kod = !url.pathname.includes('/vendor/') &&
    (url.pathname.endsWith('/') || /\.(html|js|webmanifest)$/.test(url.pathname));

  if (kod) {
    e.respondWith(
      fetch(e.request).then(kaydet)
        .catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  // kütüphaneler, ikonlar: önbellek önce (değişmiyorlar, hızlı açılsın)
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(kaydet)
      .catch(() => caches.match('./index.html')))
  );
});
