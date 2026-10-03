// Service worker del modo tractor (solo controla /tractor*).
// Guarda la página, las librerías y las imágenes del mapa que se van viendo,
// para que el modo tractor abra y muestre el mapa aunque no haya señal.
const VERSION = 'tractor-v1';
const TESELAS = 'tractor-teselas';
const MAX_TESELAS = 6000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(['/tractor.html'])).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k.startsWith('tractor-') && k !== VERSION && k !== TESELAS).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function recortarTeselas() {
  const c = await caches.open(TESELAS);
  const ks = await c.keys();
  if (ks.length > MAX_TESELAS) for (const k of ks.slice(0, ks.length - MAX_TESELAS)) await c.delete(k);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Imágenes satelitales: primero las guardadas; si no están, se descargan y se guardan.
  if (url.hostname === 'server.arcgisonline.com') {
    e.respondWith(caches.open(TESELAS).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const resp = await fetch(req);
        if (resp && (resp.ok || resp.type === 'opaque')) { c.put(req, resp.clone()); if (Math.random() < 0.02) recortarTeselas(); }
        return resp;
      } catch (err) { return new Response('', { status: 504 }); }
    }));
    return;
  }

  // Página del modo tractor: primero la red (para recibir actualizaciones); sin señal, la guardada.
  if (url.origin === self.location.origin && url.pathname.startsWith('/tractor')) {
    e.respondWith(fetch(req).then(resp => {
      if (resp.ok) caches.open(VERSION).then(c => c.put('/tractor.html', resp.clone()));
      return resp;
    }).catch(() => caches.match('/tractor.html')));
    return;
  }

  // Librerías (Leaflet, Firebase): las guardadas primero.
  if (url.hostname === 'cdnjs.cloudflare.com' || url.hostname === 'www.gstatic.com') {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const resp = await fetch(req);
      if (resp && (resp.ok || resp.type === 'opaque')) c.put(req, resp.clone());
      return resp;
    }));
  }
  // Todo lo demás (Firestore, etc.) pasa directo, sin tocar.
});
