/* ELO service worker — app shell offline-first + cache de tiles de mapa */
const VERSION = 'elo-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const TILE_CACHE = 'elo-tiles-v1';
const MAX_TILES = 3000;
const SHELL = [
  '/index.html', '/manifest.webmanifest', '/css/app.css', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
  '/js/main.js', '/js/state.js', '/js/util.js', '/js/db.js', '/js/net.js', '/js/sound.js', '/js/geo.js', '/js/map.js', '/js/ui.js',
  '/js/view-join.js', '/js/view-chats.js', '/js/view-map.js', '/js/view-people.js', '/js/view-settings.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('elo-v') && k !== SHELL_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function trim(cache, max) {
  const keys = await cache.keys();
  if (keys.length > max) for (const k of keys.slice(0, keys.length - max)) await cache.delete(k);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;

  // tiles de mapa (locais ou remotos): cache primeiro, preenche ao navegar
  if (url.pathname.startsWith('/tiles/') || (!same && req.destination === 'image')) {
    e.respondWith((async () => {
      const c = await caches.open(TILE_CACHE);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') { c.put(req, res.clone()).then(() => trim(c, MAX_TILES)).catch(() => {}); }
        return res;
      } catch (err) { return Response.error(); }
    })());
    return;
  }
  if (!same) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/ca.crt' || url.pathname === '/landing.html') return;

  // navegação: entrega o app do cache (abre instantaneamente, inclusive sem rede) e atualiza em segundo plano
  if (req.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/app')) {
    e.respondWith((async () => {
      const c = await caches.open(SHELL_CACHE);
      const cached = await c.match('/index.html');
      const update = fetch('/index.html', { cache: 'no-cache' }).then((r) => { if (r.ok) c.put('/index.html', r.clone()); return r; }).catch(() => null);
      if (cached) { e.waitUntil(update); return cached; }
      return (await update) || new Response('Offline — abra o app uma vez com conexão ao servidor.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    })());
    return;
  }

  // estáticos: stale-while-revalidate
  e.respondWith((async () => {
    const c = await caches.open(SHELL_CACHE);
    const cached = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
    if (cached) { e.waitUntil(net); return cached; }
    return (await net) || new Response('', { status: 504 });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const ch = e.notification.data && e.notification.data.ch;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const c = all[0] || (await self.clients.openWindow('/'));
    if (c) { await c.focus(); if (ch) c.postMessage({ type: 'open-chat', ch }); }
  })());
});
