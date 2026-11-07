// Shared app state, a tiny event bus, preferences and unit-aware input helpers.

import { toDisplay, fromDisplay, fmtLen as fmtLenU, fmtDistance } from './units.js';

export const $ = id => document.getElementById(id);

export const state = {
  source: null,        // parsed KMZ used as the XML template on export
  sourceBytes: null,   // its original bytes (kept for project autosave)
  fileName: null,
  generated: false,    // waypoints came from the generator and have not been hand-edited
  plan: null,          // metadata of the last generated plan {goal, captureMode, interval, speed, ...}
  goal: 'grid',        // 'grid' | '3d' | 'orbit' | 'corridor'
  polygon: [],         // [{lat, lon}]
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
export const fmtTime = s => { const m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min ${Math.round(s % 60)} s`; };
export const fmtLen = (m, d = 0) => fmtLenU(m, state.unit, d);
export const fmtDist = m => fmtDistance(m, state.unit);

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

// ---------- Length inputs (displayed in the chosen unit, stored in metres) ----------

export const lenInputs = () => [...document.querySelectorAll('[data-len]')];

export function getLen(id) { return fromDisplay(+$(id).value, state.unit); }

export function setLen(id, m) {
  const d = toDisplay(m, state.unit);
  $(id).value = state.unit === 'ft' ? Math.round(d) : +d.toFixed(1);
}

function applyLenAttrs() {
  for (const el of lenInputs()) {
    const conv = v => v === undefined ? null : Math.round(toDisplay(+v, state.unit));
    const min = conv(el.dataset.min), max = conv(el.dataset.max);
    if (min !== null) el.min = min;
    if (max !== null) el.max = max;
    el.step = el.dataset.step || 1;
  }
  document.querySelectorAll('.u-len').forEach(e => { e.textContent = state.unit === 'ft' ? 'ft' : 'm'; });
}

export function setUnit(unit) {
  document.querySelectorAll('#unitSeg button').forEach(b => b.classList.toggle('active', b.dataset.unit === unit));
  if (unit === state.unit) return applyLenAttrs();
  const metres = Object.fromEntries(lenInputs().map(el => [el.id, getLen(el.id)]));
  state.unit = unit;
  applyLenAttrs();
  for (const [id, m] of Object.entries(metres)) if (Number.isFinite(m)) setLen(id, m);
  setPref('unit', unit);
  document.querySelectorAll('#unitSeg button').forEach(b => b.classList.toggle('active', b.dataset.unit === unit));
  emit('render');
}
