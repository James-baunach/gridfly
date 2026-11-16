// Shared app state, a tiny event bus, preferences and unit-aware input helpers.

import { QTY, qtyText, fmtLen as fmtLenU, fmtDistance, fmtSpeed as fmtSpeedU, fmtArea as fmtAreaU } from './units.js';

export const $ = id => document.getElementById(id);

export const state = {
  source: null,        // parsed KMZ used as the XML template on export
  sourceBytes: null,   // its original bytes (kept for project autosave)
  fileName: null,
  generated: false,    // waypoints came from the generator and have not been hand-edited
  plan: null,          // metadata of the last generated plan {goal, captureMode, interval, speed, ...}
  goal: 'grid',        // 'grid' | '3d' | 'orbit' | 'corridor'
  polygon: [],         // [{lat, lon}] the main (first) area
  areas: [],           // more areas: [[{lat, lon}], ...] (flown after the main one, nearest first)
  keepouts: [],        // keep-out zones: [[{lat, lon}], ...] the drone must not fly over
  center: null,        // orbit centre
  line: [],            // corridor centre line
  waypoints: [],       // [{lat, lon, height, speed, photo, gimbalPitch, actions, heading?, ground?, terrainPoint?}]
  home: null,          // takeoff point {lat, lon}
  homeUser: false,     // the user placed it
  homeKey: null,
  homeGround: null,
  terrainStale: false,
  pristine: false,     // a loaded file that has not been edited yet
  mode: null,          // map tool: 'draw' | 'rect' | 'circle' | 'line' | 'center' | 'add' | 'home'
  dir: 'auto',
  selected: -1,
  undo: [],
  redo: [],
  helper: { installer: false },
  controllers: [],
  targets: {},         // mission index -> 'controllerIndex|placeholderId' or 'new|controllerIndex'
  userLoc: null,
  step: 1,
  easy: true,
  unit: 'm',
  site: { obstacles: [], airspace: [], airspaceError: null, key: null },
  progress: null,      // field progress {sig, flown: [missionIndex], resume: {mission, from}} (see plan.js)
  projectId: null,     // this project's entry in My projects
  projectName: null,
  mapCenter: () => ({ lat: 40, lon: -100 }),
};

// ---------- Events ----------

const handlers = {};
export const on = (ev, fn) => { (handlers[ev] ||= []).push(fn); };
export const emit = (ev, data) => { for (const f of handlers[ev] || []) f(data); };

// ---------- Preferences ----------

export function pref(key, def) {
  try { const v = localStorage.getItem('gridfly.' + key); return v === null ? def : JSON.parse(v); } catch { return def; }
}
export function setPref(key, value) {
  try { localStorage.setItem('gridfly.' + key, JSON.stringify(value)); return true; } catch { return false; }
}
export function dropPref(key) {
  try { localStorage.removeItem('gridfly.' + key); } catch { /* storage unavailable */ }
}

// ---------- Small helpers ----------

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const ll = p => [p.lat, p.lon];
// Every area to map (the main one first) that has at least 3 corners.
export const areaList = () => [state.polygon, ...(state.areas || [])].filter(p => p.length >= 3);
export const keepoutList = () => (state.keepouts || []).filter(p => p.length >= 3);
export const fmtTime = s => { const m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min ${Math.round(s % 60)} s`; };
export const fmtLen = (m, d = 0) => fmtLenU(m, state.unit, d);
export const fmtDist = m => fmtDistance(m, state.unit);
export const fmtSpeed = (ms, d = 1) => fmtSpeedU(ms, state.unit, d);
export const fmtArea = m2 => fmtAreaU(m2, state.unit);

let toastTimer;
export function toast(msg, ms = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// Installed on an iPhone or iPad, a download link opens the file in a viewer with no way back to the app,
// so use the share sheet there (Save to Files, AirDrop, …).
const isAppleTouch = () => typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
export const isStandalone = () => typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true);

export async function download(blob, name) {
  if (isAppleTouch() && isStandalone() && navigator.canShare) {
    const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
    if (navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; }
      catch (e) { if (e.name === 'AbortError') return; /* otherwise fall back to a download link */ }
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- Unit-aware inputs (displayed in the chosen unit, stored in metric) ----------
// data-len = metres, data-speed = metres per second, data-gsd = centimetres per pixel (see QTY in units.js).

const qtyInputs = kind => [...document.querySelectorAll(`[data-${QTY[kind].attr}]`)];
export const lenInputs = () => qtyInputs('len');
const allQtyInputs = () => Object.keys(QTY).flatMap(kind => qtyInputs(kind).map(el => ({ el, kind })));

// The exact metric value is remembered next to the rounded text on screen, so switching units and back
// (or just reading an untouched box) never drifts.
function getQty(kind, id) {
  const el = $(id), q = QTY[kind];
  if (el.dataset.si !== undefined && el.value === qtyText(kind, +el.dataset.si, state.unit)) return +el.dataset.si;
  return q.from(+el.value, state.unit);
}

function setQty(kind, id, si) {
  const el = $(id);
  el.value = qtyText(kind, si, state.unit);
  el.dataset.si = si;
}

export const getLen = id => getQty('len', id);
export const setLen = (id, m) => setQty('len', id, m);
export const getSpeed = id => getQty('speed', id);
export const setSpeed = (id, ms) => setQty('speed', id, ms);
export const getGsd = id => getQty('gsd', id);
export const setGsd = (id, cm) => setQty('gsd', id, cm);

function applyLenAttrs() {
  for (const { el, kind } of allQtyInputs()) {
    const q = QTY[kind], dec = q.decimals(state.unit);
    const conv = v => v === undefined ? null : +q.to(+v, state.unit).toFixed(dec);
    const min = conv(el.dataset.min), max = conv(el.dataset.max);
    if (min !== null) el.min = min;
    if (max !== null) el.max = max;
    el.step = el.dataset.step ? conv(el.dataset.step) : kind === 'len' ? 1 : (state.unit === 'ft' ? (kind === 'gsd' ? 0.05 : 0.5) : (kind === 'gsd' ? 0.1 : 0.5));
  }
  for (const q of Object.values(QTY)) document.querySelectorAll('.' + q.cls).forEach(e => { e.textContent = q.label(state.unit); });
}

export function setUnit(unit) {
  document.querySelectorAll('#unitSeg button').forEach(b => b.classList.toggle('active', b.dataset.unit === unit));
  if (unit === state.unit) return applyLenAttrs();
  const values = allQtyInputs().map(({ el, kind }) => [el.id, kind, el.value === '' ? NaN : getQty(kind, el.id)]);
  state.unit = unit;
  applyLenAttrs();
  for (const [id, kind, si] of values) if (Number.isFinite(si)) setQty(kind, id, si);
  setPref('unit', unit);
  document.querySelectorAll('#unitSeg button').forEach(b => b.classList.toggle('active', b.dataset.unit === unit));
  emit('render');
}
