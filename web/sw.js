/* GridFly service worker: keeps the app and map tiles available with no signal.
 *
 * - The app itself (SHELL) is cached at install. It is served from the cache first, so the app opens
 *   instantly in the field; a new version is fetched in the background whenever this file changes.
 *   Bump VERSION whenever any file in SHELL changes (tests/offline.test.js checks the list is complete).
 * - Map tiles: tiles saved for offline areas live in TILES_SAVED (filled by the Offline panel) and
 *   tiles you have looked at in TILES_SEEN (trimmed to the newest SEEN_MAX). With no signal, a missing
 *   tile is drawn by enlarging a saved tile from a lower zoom.
 * - Everything else (the USB helper's /api/, weather and other services) goes straight to the network;
 *   the app keeps its own offline copies of that data in IndexedDB.
 */
const VERSION = '2026-11-06.1';
const SHELL_CACHE = 'gridfly-shell-' + VERSION;
const TILES_SAVED = 'gridfly-tiles-saved';
const TILES_SEEN = 'gridfly-tiles-seen';
const SEEN_MAX = 3000;

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'js/app.js',
  'js/checklist.js',
  'js/exporters.js',
  'js/geo.js',
  'js/grid.js',
  'js/installer.js',
  'js/offline.js',
  'js/patterns.js',
  'js/photocheck.js',
  'js/plan.js',
  'js/presets.js',
  'js/sitecheck.js',
  'js/state.js',
  'js/store.js',
  'js/sun.js',
  'js/terrain.js',
  'js/ui-help.js',
  'js/ui-install.js',
  'js/ui-map.js',
  'js/ui-offline.js',
  'js/ui-photocheck.js',
  'js/ui-project.js',
  'js/ui-sitecheck.js',
  'js/ui-wizard.js',
  'js/units.js',
  'js/wpml.js',
  'vendor/jszip/jszip.min.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-shadow.png',
];

// Tile layers: URL pattern -> function giving the URL of tile (z, x, y). Keep in step with js/offline.js.
const TILE_LAYERS = [
  {
    re: /^https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\/(\d+)\/(\d+)\/(\d+)$/,
    parse: m => ({ z: +m[1], y: +m[2], x: +m[3] }),
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    type: 'image/jpeg',
  },
  {
    re: /^https:\/\/tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)\.png$/,
    parse: m => ({ z: +m[1], x: +m[2], y: +m[3] }),
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    type: 'image/png',
  },
];

const LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL.map(p => new Request(new URL(p, self.registration.scope), { cache: 'reload' })));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('gridfly-shell-') && key !== SHELL_CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  for (const layer of TILE_LAYERS) {
    const m = req.url.match(layer.re);
    if (m) { event.respondWith(tile(req, layer, layer.parse(m))); return; }
  }

  if (url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  event.respondWith(shell(req));
});

// ---------- App files ----------

async function shell(req) {
  const cache = await caches.open(SHELL_CACHE);
  const nav = req.mode === 'navigate';
  const cached = nav
    ? await cache.match(new URL('index.html', self.registration.scope).href)
    : await cache.match(req, { ignoreSearch: true });
  // On a local copy (python server.py) prefer the network so edits show up; fall back to the cache offline.
  if (cached && !LOCAL) return cached;
  try {
    const res = await fetch(req);
    return res;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

// ---------- Map tiles ----------

let seenPuts = 0;

async function cachedTile(url) {
  return (await (await caches.open(TILES_SAVED)).match(url)) || (await (await caches.open(TILES_SEEN)).match(url));
}

async function tile(req, layer, t) {
  const hit = await cachedTile(req.url);
  if (hit) return hit;
  try {
    const res = await fetch(req.url, { mode: 'cors', credentials: 'omit' }).catch(() => fetch(req));
    if (res.ok && (res.type === 'cors' || res.type === 'basic')) {
      const copy = res.clone();
      (async () => {
        const seen = await caches.open(TILES_SEEN);
        await seen.put(req.url, copy);
        if (++seenPuts % 100 === 0) await trimSeen(seen);
      })().catch(() => {});
    }
    return res;
  } catch {
    return (await overzoom(layer, t)) || new Response('', { status: 504, statusText: 'Offline and tile not saved' });
  }
}

async function trimSeen(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - SEEN_MAX; i++) await cache.delete(keys[i]);
}

// Draws a missing tile from the nearest saved tile at a lower zoom, enlarged.
async function overzoom(layer, { z, x, y }) {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null;
  for (let d = 1; d <= 6 && z - d >= 0; d++) {
    const px = x >> d, py = y >> d;
    const res = await cachedTile(layer.url(z - d, px, py));
    if (!res) continue;
    try {
      const bmp = await createImageBitmap(await res.blob());
      const n = 1 << d, size = bmp.width / n;
      const canvas = new OffscreenCanvas(256, 256);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(bmp, (x - (px << d)) * size, (y - (py << d)) * size, size, size, 0, 0, 256, 256);
      const blob = await canvas.convertToBlob({ type: layer.type, quality: 0.85 });
      return new Response(blob, { headers: { 'Content-Type': layer.type } });
    } catch {
      return null;
    }
  }
  return null;
}
