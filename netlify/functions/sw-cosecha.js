// Modo cosecha: permite abrir la página sin señal en el campo.
// La página se pide primero a internet (para recibir cambios) y, sin señal, se usa la copia guardada.
// Las librerías (mapa, Firebase) se guardan la primera vez y después se usan desde el celular.
const CACHE = 'cosecha-v1';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.add('/cosecha.html')).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('cosecha-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (r.mode === 'navigate' || (u.origin === location.origin && u.pathname === '/cosecha.html')) {
    e.respondWith(fetch(r).then(resp => {
      if (resp.ok) { const cp = resp.clone(); caches.open(CACHE).then(c => c.put('/cosecha.html', cp)); }
      return resp;
    }).catch(() => caches.match('/cosecha.html')));
    return;
  }
  if (/cdnjs\.cloudflare\.com|gstatic\.com\/firebasejs/.test(u.href)) {
    e.respondWith(caches.match(r).then(m => m || fetch(r).then(resp => {
      if (resp.ok || resp.type === 'opaque') { const cp = resp.clone(); caches.open(CACHE).then(c => c.put(r, cp)); }
      return resp;
    })));
  }
});
