// Offline use: service worker registration and updates, the online / offline badge, installing the app,
// and the Offline panel that saves an area (map tiles, ground heights, site check) for use with no signal.

import { TILE_LAYERS, TILE_HARD_CAP, MAX_NATIVE_ZOOM, boundsOf, bufferBounds, downloadPlan, countTiles, tilesOf, tileUrl, chooseMaxZoom, metresPerPixel, planHasTile, fmtBytes } from './offline.js';
import { prefetchArea, storedFraction, SOURCES } from './terrain.js';
import * as store from './store.js';
import { haversine, centroid } from './geo.js';
import { $, state, on, toast, esc, isStandalone } from './state.js';
import { map } from './ui-map.js';
import { siteArea, siteCheckSave } from './ui-sitecheck.js';

const TILES_SAVED = 'gridfly-tiles-saved';
const TILES_SEEN = 'gridfly-tiles-seen';
const LAYER = 'satellite';
const POOL = 6;

let job = null;          // download in progress: {cancel}
let installPrompt = null;

// ---------- Service worker ----------

function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!window.isSecureContext) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    const offer = w => {
      if (!w || !navigator.serviceWorker.controller) return; // first install: nothing to replace
      $('updateNote').hidden = false;
      $('btnUpdate').onclick = () => {
        navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
        w.postMessage('skipWaiting');
      };
    };
    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); });
    });
    // Look for a new version when the app comes back to the front with signal.
    document.addEventListener('visibilitychange', () => { if (!document.hidden && navigator.onLine) reg.update().catch(() => {}); });
    navigator.serviceWorker.ready.then(renderStatus);
  }).catch(e => console.warn('Service worker not registered', e));
}

// ---------- Badge and status ----------

function renderBadge() {
  const off = !navigator.onLine;
  $('netBadge').hidden = !off;
  document.body.classList.toggle('offline', off);
}

async function renderStatus() {
  const box = $('offAppStatus');
  if (!box) return;
  const lines = [];
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    lines.push('<span class="pill bad">Not available</span> Offline use needs GridFly to be opened from an <b>https://</b> address (or localhost) in a current browser.');
  } else if (navigator.serviceWorker.controller) {
    lines.push('<span class="pill good">Ready</span> The app itself works with no signal on this device.');
  } else {
    lines.push('<span class="pill ok">Getting ready</span> The app is being saved on this device. Reload once with signal to finish.');
  }
  if (!isStandalone()) {
    if (installPrompt) lines.push('<button id="btnInstallApp" class="primary">Install GridFly as an app</button>');
    else if (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) lines.push('To install on iPhone or iPad: tap <b>Share</b>, then <b>Add to Home Screen</b>.');
    else lines.push('Tip: install GridFly from your browser menu (<b>Install app</b> or <b>Add to Home screen</b>) so it opens like an app, even with no signal.');
  }
  box.innerHTML = lines.map(l => `<p class="small">${l}</p>`).join('');
  const b = $('btnInstallApp');
  if (b) b.onclick = async () => { installPrompt.prompt(); await installPrompt.userChoice.catch(() => {}); installPrompt = null; renderStatus(); };
}

async function renderStorage() {
  const el = $('offStorage');
  if (!navigator.storage?.estimate) { el.textContent = ''; return; }
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const persisted = await navigator.storage.persisted?.().catch(() => false);
  el.textContent = `Using ${fmtBytes(usage)} of storage on this device` + (quota ? ` (about ${fmtBytes(quota)} available)` : '') + '. ' +
    (persisted ? 'The browser has agreed to keep it.' : 'The browser may clear saved maps if the device runs low on space.');
}

// ---------- What to save ----------

// The area to save: the drawn area or mission plus the takeoff point, or what is on screen.
function target() {
  const pts = [...(siteArea() || [])];
  if (state.center) pts.push(state.center);
  if (pts.length) {
    // Include the takeoff point unless it is far away (a mistake, or a mission opened elsewhere).
    if (state.home && haversine(state.home, centroid(pts)) < 5000) pts.push(state.home);
    return { bounds: boundsOf(pts), what: 'your area', hasArea: true };
  }
  const b = map.getBounds();
  return { bounds: { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() }, what: 'the map on screen', hasArea: false, zoom: map.getZoom() };
}

function defaultName() {
  if (state.fileName) return state.fileName.replace(/\.(kmz|kml)$/i, '');
  const b = target().bounds;
  return `Area at ${((b.s + b.n) / 2).toFixed(3)}, ${((b.w + b.e) / 2).toFixed(3)}`;
}

function renderPlanner() {
  const t = target();
  const lat = (t.bounds.s + t.bounds.n) / 2;
  const sel = $('offZoom');
  const prev = +sel.value || 0;
  const best = chooseMaxZoom(t.bounds);
  const opts = [];
  for (let z = MAX_NATIVE_ZOOM; z >= 13; z--) {
    const n = countTiles(downloadPlan(t.bounds, z));
    if (n > TILE_HARD_CAP) continue;
    const cm = metresPerPixel(lat, z) * 100;
    opts.push(`<option value="${z}">${cm < 100 ? `${Math.round(cm)} cm` : `${(cm / 100).toFixed(1)} m`} per pixel · ${n} tiles · about ${fmtBytes(n * TILE_LAYERS[LAYER].avgBytes)}${z === best ? ' (suggested)' : ''}</option>`);
  }
  sel.innerHTML = opts.join('');
  const has = z => !!sel.querySelector(`option[value="${z}"]`);
  if (opts.length) sel.value = String(has(prev) ? prev : has(best) ? best : sel.options[sel.options.length - 1].value);
  const tooBig = !opts.length;
  const zoomedOut = !t.hasArea && t.zoom < 11;
  $('offAreaInfo').innerHTML = tooBig || zoomedOut
    ? `<p class="bad-note">${t.hasArea ? 'Your area is too large to save in one go. Save it in parts: zoom in on one part at a time, clear the area, and save what is on screen.' : 'Zoom in on the place you are going (or draw your area) first; the whole map on screen is too large to save.'}</p>`
    : `<p class="small">Saves <b>${t.what}</b>${t.hasArea ? ' plus a margin around it' : ''}: satellite imagery, a wider overview for finding your way, ground heights${t.hasArea ? ', and the weather forecast, obstacles and airspace' : ''}.</p>`;
  $('btnOffSave').disabled = tooBig || zoomedOut || !!job;
  if (!$('offName').value) $('offName').value = defaultName();
}

// ---------- Saving ----------

async function saveTiles(parts, onProgress, isCancelled) {
  const saved = await caches.open(TILES_SAVED);
  const seen = await caches.open(TILES_SEEN);
  const tpl = TILE_LAYERS[LAYER].url;
  const iter = tilesOf(parts);
  const total = countTiles(parts);
  let done = 0, bytes = 0, failed = 0;
  const worker = async () => {
    for (let n = iter.next(); !n.done; n = iter.next()) {
      if (isCancelled()) return;
      const url = tileUrl(tpl, n.value);
      try {
        let res = await saved.match(url);
        if (!res) {
          res = await seen.match(url);
          if (!res) {
            res = await fetch(url, { mode: 'cors', credentials: 'omit' });
            if (!res.ok) throw new Error(res.status);
          }
          await saved.put(url, res.clone());
        }
        bytes += (await res.blob()).size;
      } catch { failed++; }
      onProgress(++done, total);
    }
  };
  await Promise.all(Array.from({ length: POOL }, worker));
  return { total, done, bytes, failed };
}

async function saveArea() {
  if (job) return;
  if (!navigator.onLine) return toast('You need signal to save an area. Do this before you head out.', 5000);
  if (!('caches' in window)) return toast('This browser cannot save maps for offline use.', 5000);
  const t = target();
  const maxZoom = +$('offZoom').value;
  if (!maxZoom) return;
  const parts = downloadPlan(t.bounds, maxZoom);
  const name = $('offName').value.trim() || defaultName();
  job = { cancelled: false };
  const cancelled = () => job?.cancelled;
  const bar = $('offBar'), msg = $('offProgress');
  bar.hidden = false; bar.value = 0;
  $('btnOffSave').disabled = true;
  $('btnOffCancel').hidden = false;
  navigator.storage?.persist?.().catch(() => {});

  const notes = [];
  let tiles = { total: 0, bytes: 0, failed: 0 };
  try {
    msg.textContent = 'Saving map tiles…';
    tiles = await saveTiles(parts, (n, total) => { bar.value = n / total * 0.8; msg.textContent = `Saving map tiles… ${n} of ${total}`; }, cancelled);
    if (cancelled()) throw new Error('cancelled');
    if (tiles.failed) notes.push(`${tiles.failed} map tile${tiles.failed > 1 ? 's' : ''} could not be saved.`);

    msg.textContent = 'Saving ground heights…';
    let elevOk = false, elevSource = null;
    try {
      ({ source: elevSource } = await prefetchArea(bufferBounds(t.bounds, 300), (n, total) => { bar.value = 0.8 + 0.1 * n / total; msg.textContent = `Saving ground heights… ${n} of ${total}`; }));
      elevOk = true;
    } catch (e) { notes.push('Ground heights: ' + e.message); }
    if (cancelled()) throw new Error('cancelled');

    let siteOk = null;
    if (t.hasArea) {
      msg.textContent = 'Saving the site check (weather, obstacles, airspace)…';
      const r = await siteCheckSave();
      siteOk = r.every(Boolean);
      if (!siteOk) notes.push('Part of the site check could not be saved; open step 5 to see which.');
    }
    bar.value = 1;

    const area = { id: Date.now().toString(36), name, created: Date.now(), bounds: t.bounds, maxZoom, parts, layer: LAYER, tiles: tiles.total - tiles.failed, bytes: tiles.bytes, elevOk, elevSource, siteOk };
    await store.set('areas', area.id, area);
    msg.innerHTML = `<b>Saved “${esc(name)}”</b>: ${area.tiles} tiles (${fmtBytes(tiles.bytes)})${elevOk ? `, ground heights (${SOURCES[elevSource].short})` : ''}${siteOk ? ', site check' : ''}.` +
      (notes.length ? `<br>${notes.map(esc).join('<br>')}` : '');
    toast(`Saved “${name}” for offline use.`);
  } catch (e) {
    msg.textContent = e.message === 'cancelled' ? 'Stopped. Tiles saved so far are kept and will be used.' : 'Saving failed: ' + e.message;
  } finally {
    job = null;
    $('btnOffCancel').hidden = true;
    setTimeout(() => { bar.hidden = true; }, 1500);
    renderPlanner();
    renderList();
    renderStorage();
  }
}

// ---------- Saved areas ----------

async function deleteArea(id) {
  const areas = await store.all('areas');
  const area = areas.find(a => a.id === id);
  if (!area || !confirm(`Delete the saved maps for “${area.name}”?`)) return;
  const others = areas.filter(a => a.id !== id && a.layer === area.layer);
  const cache = await caches.open(TILES_SAVED);
  const tpl = TILE_LAYERS[area.layer].url;
  for (const t of tilesOf(area.parts)) {
    if (!others.some(o => planHasTile(o.parts, t))) await cache.delete(tileUrl(tpl, t));
  }
  await store.del('areas', id);
  toast('Saved area deleted.');
  renderList();
  renderStorage();
}

async function renderList() {
  const areas = (await store.all('areas')).sort((a, b) => b.created - a.created);
  const box = $('offList');
  if (!areas.length) { box.innerHTML = '<p class="muted small">Nothing saved yet.</p>'; return; }
  const ground = await Promise.all(areas.map(a => storedFraction(bufferBounds(a.bounds, 300)).catch(() => 0)));
  box.innerHTML = areas.map((a, i) => `<div class="saved-area">
      <div class="name"><b>${esc(a.name)}</b><br><span class="small muted">${new Date(a.created).toLocaleDateString()} · ${a.tiles} tiles, ${fmtBytes(a.bytes)}${ground[i] > 0.98 ? (a.elevSource === 'ky' ? ' · Kentucky LiDAR' : ' · ground heights') : ''}${a.siteOk ? ' · site check' : ''}</span></div>
      <button data-go="${a.id}">Show</button><button data-del="${a.id}" class="link">Delete</button>
    </div>`).join('');
  box.querySelectorAll('[data-go]').forEach(b => b.onclick = () => {
    const a = areas.find(x => x.id === b.dataset.go);
    toggle(false);
    map.fitBounds([[a.bounds.s, a.bounds.w], [a.bounds.n, a.bounds.e]], { maxZoom: Math.min(18, a.maxZoom) });
  });
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = () => deleteArea(b.dataset.del));
}

// ---------- Panel ----------

export function toggle(show = $('offline').hidden) {
  $('offline').hidden = !show;
  if (!show) return;
  $('offName').value = '';
  renderStatus();
  renderPlanner();
  renderList();
  renderStorage();
}

/** Saved areas, for jumping to one by name when there is no signal to search. */
export const savedAreas = () => store.all('areas');

export function initOffline() {
  registerWorker();
  renderBadge();
  window.addEventListener('online', () => { renderBadge(); toast('Back online.'); });
  window.addEventListener('offline', () => { renderBadge(); toast('No signal: GridFly keeps working with what is saved on this device.', 5000); });
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; renderStatus(); });
  window.addEventListener('appinstalled', () => { installPrompt = null; toast('GridFly is installed.'); });

  $('btnOffline').onclick = () => toggle(true);
  $('btnOfflineArea').onclick = () => toggle(true);
  $('netBadge').onclick = () => toggle(true);
  $('btnOfflineClose').onclick = () => toggle(false);
  $('offline').addEventListener('click', e => { if (e.target.id === 'offline' && !job) toggle(false); });
  $('btnOffSave').onclick = saveArea;
  $('btnOffCancel').onclick = () => { if (job) job.cancelled = true; };
  on('render', () => { if (!$('offline').hidden && !job) renderPlanner(); });
}
