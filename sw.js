// Service worker: the whole app is cached so it opens on stage with no internet.
// MuseScore (vendor/webmscore, ~22 MB) is cached the first time it is fetched (the app fetches it early).
// Songs themselves live in IndexedDB, not here.
const VERSION = 'v21';
const SHELL = 'ms-shell-' + VERSION;
const VENDOR = 'ms-vendor-v2';

const SHELL_FILES = [
  './', 'index.html', 'app.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-512.png',
  'js/app.js', 'js/db.js', 'js/store.js', 'js/ui.js', 'js/i18n.js', 'js/i18n-en.js', 'js/music.js', 'js/library.js', 'js/viewer.js',
  'js/pdfdoc.js', 'js/annot.js', 'js/setlists.js', 'js/settings.js', 'js/metronome.js', 'js/live.js',
  'js/player.js', 'js/importer.js', 'js/layout.js', 'js/zip.js', 'js/engrave.js', 'js/mscz.js', 'js/mstranspose.js',
  'js/net.js', 'js/qr.js', 'js/band.js', 'js/msedit.js', 'js/scoreedit.js', 'js/staffhit.js', 'js/chordguess.js', 'js/tuner.js', 'js/duration.js', 'js/instruments.js', 'js/newscore.js',
  'vendor/qrcode.js', 'vendor/jsQR.js',
];
const VENDOR_FILES = ['vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs', 'vendor/pdf-lib.min.js', 'vendor/verovio-toolkit-wasm.js'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await c.addAll(SHELL_FILES);
    // live mode (and every song played in another key) depends on these: no install without them
    const v = await caches.open(VENDOR);
    for (const f of VENDOR_FILES) if (!(await v.match(f))) await v.add(f);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (![SHELL, VENDOR].includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/vendor/')) { e.respondWith(cacheFirst(e.request, VENDOR)); return; }
  // app shell: network first (so updates arrive), cache when offline
  e.respondWith((async () => {
    try {
      // weak Wi-Fi must not stall the app on stage: fall back to the cache after 3 seconds
      const r = await Promise.race([fetch(e.request), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 3000))]);
      if (r.ok) (await caches.open(SHELL)).put(e.request, r.clone());
      return r;
    } catch {
      const c = await caches.open(SHELL);
      return (await c.match(e.request, { ignoreSearch: true })) || (await c.match('index.html'));
    }
  })());
});

async function cacheFirst(req, name) {
  const c = await caches.open(name);
  const hit = await c.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok) c.put(req, r.clone());
  return r;
}
