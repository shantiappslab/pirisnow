const PAGINES = 'pirisnow-pagines-v1', FITXERS = 'pirisnow-fitxers-v1', MAX_PAGINES = 60;
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(
  ks.filter((k) => k !== PAGINES && k !== FITXERS).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
async function retalla() {
  const c = await caches.open(PAGINES), ks = await c.keys();
  for (const k of ks.slice(0, Math.max(0, ks.length - MAX_PAGINES))) await c.delete(k);
}
async function pagina(req) {
  const c = await caches.open(PAGINES);
  try {
    const r = await fetch(req);
    if (r.ok) { await c.delete(req, { ignoreSearch: true }); await c.put(req, r.clone()); retalla(); }
    return r;
  } catch (err) {
    return (await c.match(req, { ignoreSearch: true })) || (await c.match(new URL('./', self.registration.scope).href))
      || new Response('<meta charset=utf-8><meta name=viewport content="width=device-width"><p style="font:16px sans-serif;padding:24px">Sin conexión · Sense connexió · Hors ligne · Offline</p>',
                      { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}
async function fitxer(req) {
  const c = await caches.open(FITXERS), desat = await c.match(req);
  const xarxa = fetch(req).then((r) => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }).catch(() => desat || Response.error());
  return desat || xarxa;
}
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.pathname.endsWith('.mp4') || req.headers.has('range')) return;
  if (req.mode === 'navigate') return e.respondWith(pagina(req));
  if (url.origin === location.origin || /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) e.respondWith(fitxer(req));
});
