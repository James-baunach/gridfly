// Mission model: settings, planning (grid / 3D / orbit / corridor), terrain heights, splitting, undo/redo, KMZ building.

import { haversine, convexHull, pathLength } from './geo.js';
import { CAMERAS, gridMetrics, autoAngle, snapStraight } from './grid.js';
import { planGrid, planOblique, planOrbit, planCorridor } from './patterns.js';
import { applyTerrain } from './terrain.js';
import { readFile, buildKmz, DRONES } from './wpml.js';
import { makeProjection } from './geo.js';
import { autoMargin, recommendTimer, nearestEdgePoint, curvedRule, GOALS } from './presets.js';
import { $, state, emit, toast, pref, setPref, getLen, setLen, fmtLen } from './state.js';

export const MISSION_COLORS = ['#ffd60a', '#4cc9f0', '#f72585', '#80ed99', '#ff9f1c', '#b5179e', '#90e0ef', '#e9ff70'];
export const MAX_GENERATED = 6000;
export const MAX_WP_CAP = 400;
export const OBLIQUE_PITCH = -45;

const PLAIN_IDS = ['camera', 'camW', 'camH', 'camF', 'camPx', 'speed', 'front', 'side', 'angle', 'turnMode', 'gimbal', 'finish', 'rcLost',
  'terrain', 'densify', 'tol', 'maxWp', 'maxMin', 'captureMode', 'crosshatch', 'oblique', 'hover', 'marginAuto', 'droneKey', 'controller', 'quality'];
const LEN_IDS = ['alt', 'overshoot', 'margin', 'orbitRadius', 'bldgHeight', 'corridorWidth'];
export const SETTING_IDS = [...PLAIN_IDS, ...LEN_IDS];

// ---------- Settings ----------

const val = id => { const e = $(id); return e.type === 'checkbox' ? e.checked : (e.type === 'number' || e.type === 'range') ? +e.value : e.value; };

export function settings() {
  const camKey = val('camera');
  const cam = camKey === 'custom'
    ? { sensorW: val('camW'), sensorH: val('camH'), focal: val('camF'), imageW: val('camPx') }
    : CAMERAS[camKey];
  return {
    cam, alt: getLen('alt'), speed: val('speed'), front: val('front'), side: val('side'), angle: val('angle'),
    overshoot: getLen('overshoot'), margin: getLen('margin'), marginAuto: val('marginAuto'),
    turnMode: val('turnMode'), gimbal: val('gimbal'), finish: val('finish'), rcLost: val('rcLost'),
    terrain: val('terrain'), densify: val('densify'), tol: val('tol'),
    maxWp: Math.min(MAX_WP_CAP, Math.max(2, val('maxWp') || 200)), maxMin: val('maxMin'),
    captureMode: val('captureMode'), crosshatch: val('crosshatch'), oblique: val('oblique'), hover: val('hover'),
    droneKey: val('droneKey'), controller: val('controller'),
    orbitRadius: getLen('orbitRadius'), bldgHeight: getLen('bldgHeight'), corridorWidth: getLen('corridorWidth'),
  };
}

export function settingsSnapshot() {
  const o = { dir: state.dir, goal: state.goal };
  for (const id of PLAIN_IDS) o[id] = $(id).type === 'checkbox' ? $(id).checked : $(id).value;
  for (const id of LEN_IDS) o[id] = getLen(id);
  return o;
}

export function applySettings(o = {}) {
  for (const id of PLAIN_IDS) {
    if (o[id] === undefined || !$(id)) continue;
    if ($(id).type === 'checkbox') $(id).checked = !!o[id]; else $(id).value = o[id];
  }
  for (const id of LEN_IDS) if (Number.isFinite(o[id])) setLen(id, o[id]);
  if (o.dir) state.dir = o.dir;
  if (o.goal && GOALS[o.goal]) state.goal = o.goal;
}

export const saveSettings = () => setPref('settings', settingsSnapshot());
export const loadSettings = () => applySettings(pref('settings', {}));

export function currentAngle() {
  if (state.dir === 'ns') return 0;
  if (state.dir === 'ew') return 90;
  if (state.dir === 'auto') return state.polygon.length >= 3 ? autoAngle(state.polygon) : 0;
  return +$('angle').value;
}

// ---------- Undo / redo ----------

const snapshot = () => JSON.stringify({
  polygon: state.polygon, waypoints: state.waypoints, home: state.home, homeGround: state.homeGround, homeUser: state.homeUser,
  generated: state.generated, terrainStale: state.terrainStale, center: state.center, line: state.line, plan: state.plan, goal: state.goal,
});

export function pushUndo() {
  state.undo.push(snapshot());
  if (state.undo.length > 60) state.undo.shift();
  state.redo = [];
  state.pristine = false;
}

function restore(s) {
  Object.assign(state, JSON.parse(s));
  state.selected = -1;
  emit('render');
  emit('plan', { geometry: true, restored: true });
}

export function undo() {
  const s = state.undo.pop();
  if (!s) return toast('Nothing to undo');
  state.redo.push(snapshot());
  restore(s);
}

export function redo() {
  const s = state.redo.pop();
  if (!s) return toast('Nothing to redo');
  state.undo.push(snapshot());
  restore(s);
}

// ---------- Curved paths (photo actions are ignored by DJI Fly on curved paths) ----------

export function enforceTurnMode() {
  const sel = $('turnMode');
  const hasPhoto = state.waypoints.some(w => w.photo);
  const opt = [...sel.options].find(o => o.value === 'curved');
  const r = curvedRule({ turnMode: sel.value, sourceCurved: state.source?.info.turnMode === 'curved', hasPhoto, edited: !state.pristine });
  opt.disabled = r.disableCurved;
  sel.title = r.disableCurved ? 'Curved paths are switched off because DJI Fly ignores photo actions on curved paths, so no photos would be taken.' : '';
  if (r.switchToStraight) {
    sel.value = 'straight-stop';
    saveSettings();
    toast('Switched to straight paths: DJI Fly ignores photo actions on curved paths, so a curved mission would take no photos.', 7000);
  }
  return r;
}

// ---------- Missions (split by waypoint count and battery time) ----------

function segmentTime(a, b, s) {
  const d = haversine(a, b);
  const stop = s.turnMode === 'straight-pass' || s.turnMode === 'curved' ? 0 : 2.5;
  return d / Math.max(0.5, b.speed || s.speed) + stop + (b.photo ? 0.5 + (s.hover ? 1 : 0) : 0);
}

function missionOverhead(chunk) {
  if (!state.home || !chunk.length) return 0;
  const toFirst = haversine(state.home, chunk[0]) / 10;
  const back = haversine(chunk.at(-1), state.home) / 10;
  const climb = Math.max(...chunk.map(w => Math.abs(w.height))) / 4;
  return 30 + toFirst + back + climb * 2;
}

function splitRanges(wps, s, maxWp, maxSec) {
  const out = [];
  let start = 0, t = 0;
  for (let i = 0; i < wps.length; i++) {
    const count = i - start + 1;
    const dt = i > start ? segmentTime(wps[i - 1], wps[i], s) : 0;
    const overTime = maxSec > 0 && count > 2 && t + dt + missionOverhead(wps.slice(start, i + 1)) > maxSec;
    if (count > maxWp || overTime) {
      out.push({ start, end: i - 1 });
      start = i; t = 0;
    } else {
      t += dt;
    }
  }
  if (wps.length) out.push({ start, end: wps.length - 1 });
  return out;
}

export function computeMissions() {
  const s = settings();
  const wps = state.waypoints;
  const maxSec = s.maxMin > 0 ? s.maxMin * 60 : 0;
  let out = splitRanges(wps, s, s.maxWp, maxSec);
  // Even out the missions instead of leaving a tiny last one, as long as that needs no extra battery.
  const k = out.length;
  if (k > 1) {
    let flight = 0;
    for (let i = 1; i < wps.length; i++) flight += segmentTime(wps[i - 1], wps[i], s);
    const evenSec = maxSec ? Math.min(maxSec, (flight / k + missionOverhead(wps.slice(0, Math.ceil(wps.length / k)))) * 1.05) : 0;
    const even = splitRanges(wps, s, Math.min(s.maxWp, Math.ceil(wps.length / k) + 1), evenSec);
    if (even.length === k) out = even;
  }
  const prog = progress();
  return out.map((m, k) => {
    // A mission cut short in the field restarts at the waypoint where it stopped.
    const from = prog?.resume?.mission === k && prog.resume.from > 0 && prog.resume.from <= m.end - m.start ? prog.resume.from : 0;
    const start = m.start + from;
    const pts = wps.slice(start, m.end + 1);
    let time = 0;
    for (let i = 1; i < pts.length; i++) time += segmentTime(pts[i - 1], pts[i], s);
    return {
      start, end: m.end, fullStart: m.start, fullCount: m.end - m.start + 1, resumedFrom: from, flown: !!prog?.flown.includes(k),
      index: k, points: pts, distance: pathLength(pts), time: time + missionOverhead(pts), color: MISSION_COLORS[k % MISSION_COLORS.length],
    };
  });
}

// ---------- Field progress ----------
// Which missions have been flown, and where an interrupted one should restart. Tied to the waypoint
// positions, so it is set aside automatically when the plan changes.

export function planSignature(wps = state.waypoints) {
  let h = 2166136261 >>> 0;
  const mix = v => { h = Math.imul(h ^ v, 16777619) >>> 0; };
  mix(wps.length);
  for (const w of wps) { mix(Math.round(w.lat * 1e6)); mix(Math.round(w.lon * 1e6)); }
  return h.toString(36);
}

/** The progress record for the current plan, or null. */
export function progress() {
  const p = state.progress;
  return p && state.waypoints.length && p.sig === planSignature() ? p : null;
}

function editProgress(fn) {
  const p = progress() || { sig: planSignature(), flown: [], resume: null };
  fn(p);
  state.progress = p;
  emit('render');
}

export function setFlown(k, flown) {
  editProgress(p => {
    p.flown = p.flown.filter(i => i !== k);
    if (flown) p.flown.push(k);
    if (flown && p.resume?.mission === k) p.resume = null;
  });
}

/** Restart mission k at its waypoint `from` (0-based within the mission); null clears it. */
export function setResume(k, from) {
  editProgress(p => {
    p.resume = from > 0 ? { mission: k, from } : null;
    if (from > 0) p.flown = p.flown.filter(i => i !== k);
  });
}

export function clearProgress() { state.progress = null; emit('render'); }

export function photoEstimate(missions = computeMissions()) {
  const direct = state.waypoints.filter(w => w.photo).length;
  if (direct || state.plan?.captureMode !== 'timer' || !state.plan.interval) return direct;
  return missions.reduce((a, m) => a + Math.ceil(m.time / state.plan.interval), 0);
}

// ---------- Planning ----------

export function missingInput() {
  if (state.goal === 'orbit') return state.center ? null : 'Click the building you want to orbit on the map.';
  if (state.goal === 'corridor') return state.line.length >= 2 ? null : 'Draw a line along the road, river or fence: click points on the map, then Done.';
  return state.polygon.length >= 3 ? null : 'Draw the area you want to map: at least 3 corners.';
}

export function geometryReady() { return !missingInput(); }

// Default takeoff spot: where you would stand, i.e. the edge of the area nearest the user (or the map centre).
function defaultHome(s) {
  const target = state.userLoc || state.mapCenter();
  if (state.goal === 'orbit') return makeProjection(state.center.lat, state.center.lon).toLL(0, -(s.orbitRadius + 15));
  if (state.goal === 'corridor') return nearestEdgePoint(state.line, target, false);
  return nearestEdgePoint(state.polygon, target, true);
}

function ensureHome(s) {
  if (state.homeUser && state.home) return;
  const key = JSON.stringify([state.goal, state.goal === 'orbit' ? state.center : state.goal === 'corridor' ? state.line : state.polygon]);
  if (state.home && state.homeKey === key) return;
  state.home = defaultHome(s);
  state.homeKey = key;
  state.homeGround = null;
}

function buildPlan(s) {
  const goal = state.goal;
  const m = gridMetrics(s.cam, s.alt, s.front, s.side);
  const angle = currentAngle();
  const base = { cam: s.cam, alt: s.alt, front: s.front, side: s.side, speed: s.speed, gimbal: s.gimbal, home: state.home };
  const meta = { goal, captureMode: 'waypoint', interval: null, speed: s.speed, recommendedTimer: false, tip: false, metrics: m, angle, gsd: m.gsd, margin: 0 };

  if (goal === 'orbit') {
    const r = s.orbitRadius, bh = s.bldgHeight;
    const baseHeight = Math.max(15, Math.round(bh * 0.5)), ringStep = Math.max(8, Math.round(bh / 3));
    const photosPerRing = Math.max(16, Math.min(48, Math.ceil(2 * Math.PI * r / 10)));
    const speed = Math.min(s.speed, 3);
    const mid = Math.hypot(r, baseHeight + ringStep);
    return { ...meta, speed, gsd: gridMetrics(s.cam, mid, 80, 70).gsd, waypoints: planOrbit(state.center, { radius: r, rings: 3, ringStep, baseHeight, photosPerRing, speed }).waypoints };
  }
  if (goal === 'corridor') {
    return { ...meta, waypoints: planCorridor(state.line, { ...base, width: s.corridorWidth }).waypoints };
  }

  const margin = s.marginAuto ? autoMargin(m) : s.margin;
  const useObl = goal === '3d' && s.oblique;
  const opts = { ...base, angle, overshoot: s.overshoot, margin, crosshatch: goal === '3d' && s.crosshatch };
  const want = useObl ? 'waypoint' : s.captureMode;
  let res = planGrid(state.polygon, { ...opts, captureMode: want === 'timer' ? 'timer' : 'waypoint' });
  let recommended = false;
  if (want === 'auto' && recommendTimer(res.waypoints.length)) { res = planGrid(state.polygon, { ...opts, captureMode: 'timer' }); recommended = true; }
  const tip = want === 'waypoint' && recommendTimer(res.waypoints.length);
  let waypoints = res.waypoints;
  if (useObl) {
    const ob = planOblique(state.polygon, { ...base, overshoot: s.overshoot, pitch: OBLIQUE_PITCH, margin, home: waypoints.at(-1) || state.home });
    waypoints = waypoints.concat(ob.waypoints);
  }
  return { ...meta, margin, waypoints, captureMode: res.interval ? 'timer' : 'waypoint', interval: res.interval, speed: res.speed, recommendedTimer: recommended, tip };
}

let genToken = 0;

export async function generate({ auto = false } = {}) {
  if (state.goal !== 'orbit' && state.goal !== 'corridor' && state.polygon.length < 3 && state.waypoints.length >= 3) state.polygon = convexHull(state.waypoints);
  const need = missingInput();
  if (need) { if (!auto) toast(need); return false; }
  if (!auto && state.waypoints.length && !state.generated && !confirm('Replace the current waypoints with a new plan?')) return false;
  const s = settings();
  ensureHome(s);
  const plan = buildPlan(s);
  if (!plan.waypoints.length) { toast('That area is too small for this plan.'); return false; }
  if (plan.waypoints.length > MAX_GENERATED) { toast(`That would create ${plan.waypoints.length} waypoints. Use a smaller area, higher altitude or lower overlap.`, 6000); return false; }
  if (!auto) pushUndo();
  const token = ++genToken;
  const { waypoints, ...meta } = plan;
  state.waypoints = waypoints;
  state.plan = meta;
  state.generated = true;
  state.selected = -1;
  state.terrainStale = false;
  state.pristine = false;
  if (s.turnMode === 'keep' || s.turnMode === 'curved') $('turnMode').value = 'straight-stop';
  emit('render');
  if (s.terrain && meta.goal !== 'orbit') await applyHeights(false, token);
  else if (!auto) toast(`Planned ${waypoints.length} waypoints.`);
  return true;
}

function fixTerrainHeadings(wps) {
  wps.forEach((w, i) => { if (w.terrainPoint && w.heading === undefined && Number.isFinite(wps[i - 1]?.heading)) w.heading = wps[i - 1].heading; });
}

export async function applyHeights(withUndo = true, token = genToken) {
  const s = settings();
  if (!state.waypoints.length) return toast('No waypoints yet.');
  if (!state.home) state.home = { lat: state.waypoints[0].lat, lon: state.waypoints[0].lon };
  if (state.plan?.goal === 'orbit') return toast('Orbit heights are measured from the takeoff point; stand at the same level as the building.');
  const status = $('terrainStatus');
  if (!s.terrain) {
    if (withUndo) pushUndo();
    state.waypoints = state.waypoints.filter(w => !w.terrainPoint).map(w => ({ ...w, height: s.alt }));
    state.terrainStale = false;
    emit('render');
    return toast(`All waypoints set to ${fmtLen(s.alt)} above takeoff.`);
  }
  status.textContent = 'Fetching ground elevation…';
  $('btnHeights').disabled = true;
  try {
    const r = await applyTerrain(state.waypoints, state.home, s.alt, {
      densify: s.densify, tolerance: s.tol,
      onProgress: (n, total) => { status.textContent = `Fetching ground elevation… ${n}/${total}`; },
    });
    if (token !== genToken) return;
    if (withUndo) pushUndo();
    fixTerrainHeadings(r.waypoints);
    state.waypoints = r.waypoints;
    state.homeGround = r.homeGround;
    state.terrainStale = false;
    state.selected = -1;
    const g = r.waypoints.map(w => w.ground);
    status.textContent = `Ground varies ${fmtLen(Math.min(...g))} to ${fmtLen(Math.max(...g))} above sea level; takeoff at ${fmtLen(r.homeGround)}.` +
      (r.inserted ? ` Added ${r.inserted} terrain point${r.inserted > 1 ? 's' : ''} over ridges.` : '') +
      ' Elevation data is coarse (~30 m) and ignores trees and buildings; leave a margin.';
    emit('render');
  } catch (e) {
    status.textContent = 'Ground heights not available: ' + e.message;
  } finally {
    $('btnHeights').disabled = false;
  }
}

export function straighten() {
  if (state.waypoints.length < 3) return toast('Not enough waypoints to straighten.');
  pushUndo();
  const r = snapStraight(state.waypoints);
  state.waypoints = r.waypoints;
  if (r.moved) state.terrainStale = state.waypoints.some(w => w.ground !== undefined);
  const tm = $('turnMode');
  if (tm.value === 'curved' || tm.value === 'keep') tm.value = 'straight-stop';
  emit('render');
  toast(`Straight segments on. ${r.moved} point${r.moved === 1 ? '' : 's'} lined up.`);
}

// ---------- Files ----------

export async function loadFile(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const res = await readFile(file);
    pushUndo();
    if (res.kind === 'area') {
      state.polygon = res.polygon;
      if (state.goal === 'orbit' || state.goal === 'corridor') state.goal = 'grid';
      emit('render');
      emit('plan', { geometry: true });
      emit('fit', res.polygon);
      toast(`Loaded survey area from ${res.name}`);
      return;
    }
    if (!res.waypoints.length) throw new Error('The mission has no waypoints.');
    emit('projectSwitch'); // the open project stays in My projects; the mission file becomes a new one
    Object.assign(state, {
      projectId: null, projectName: null, progress: null,
      source: res, sourceBytes: bytes, fileName: res.name, waypoints: res.waypoints, generated: false, plan: null, polygon: [], center: null, line: [],
      home: { lat: res.waypoints[0].lat, lon: res.waypoints[0].lon }, homeUser: false, homeKey: null, homeGround: null, selected: -1, pristine: true,
    });
    $('turnMode').value = res.info.turnMode || 'keep';
    if (res.info.finishAction && [...$('finish').options].some(o => o.value === res.info.finishAction)) $('finish').value = res.info.finishAction;
    if (res.info.rcLostAction && [...$('rcLost').options].some(o => o.value === res.info.rcLostAction)) $('rcLost').value = res.info.rcLostAction;
    emit('render');
    emit('plan', {});
    emit('fit', state.waypoints);
    toast(`Opened ${res.name}: ${res.waypoints.length} waypoints. Move the H marker to your real takeoff spot.`, 5000);
  } catch (e) {
    console.error(e);
    toast('Could not open file: ' + e.message, 6000);
  }
}

export function startOver() {
  Object.assign(state, {
    source: null, sourceBytes: null, fileName: null, generated: false, plan: null, polygon: [], center: null, line: [], waypoints: [],
    home: null, homeUser: false, homeKey: null, homeGround: null, selected: -1, terrainStale: false, pristine: false, undo: [], redo: [],
    progress: null, projectId: null, projectName: null,
  });
  emit('render');
  emit('plan', { geometry: true });
}

// ---------- Export ----------

export function exportOpts(mission) {
  const s = settings();
  const d = DRONES[s.droneKey] || {};
  return {
    turnMode: s.turnMode === 'keep' ? null : s.turnMode,
    finishAction: s.finish,
    rcLostAction: s.rcLost,
    speed: state.plan?.speed ?? s.speed,
    headingMode: state.plan ? 'followWayline' : null,
    distance: mission.distance,
    duration: mission.time,
    hoverSeconds: s.hover && state.plan?.captureMode !== 'timer' ? 1 : 0,
    droneEnum: d.droneEnum ?? undefined,
    droneSub: d.droneSub ?? undefined,
  };
}

export function missionFileName(m, count) {
  const base = (state.fileName || 'gridfly-mission').replace(/\.kmz$/i, '');
  const rest = m.resumedFrom ? `-rest-from-${m.resumedFrom + 1}` : '';
  return count > 1 ? `${base}-${m.index + 1}of${count}${rest}.kmz` : `${base}${rest}.kmz`;
}

export async function buildMissionFiles(source = state.source) {
  const ms = computeMissions();
  return Promise.all(ms.map(async m => ({ ...m, name: missionFileName(m, ms.length), blob: await buildKmz(m.points, exportOpts(m), source) })));
}
