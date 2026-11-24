// Mission model: settings, planning (grid / 3D / orbit / corridor), terrain heights, splitting, undo/redo, KMZ building.

import { haversine, convexHull, pathLength, polygonAreaM2 } from './geo.js';
import { CAMERAS, gridMetrics, autoAngle, snapStraight } from './grid.js';
import { pathHitsKeepouts } from './avoid.js';
import { planGrid, planOblique, planOrbit, planCorridor, transitWaypoints, bufferPolygon } from './patterns.js';
import { rangeTiles, groupPieces, farthest } from './zones.js';
import { applyTerrain, routeClearance, SOURCES } from './terrain.js';
import { readFile, buildKmz, DRONES } from './wpml.js';
import { makeProjection } from './geo.js';
import { autoMargin, autoSpeed, recommendTimer, nearestEdgePoint, pointInPolygon, curvedRule, GOALS } from './presets.js';
import { $, state, areaList, keepoutList, emit, toast, pref, setPref, getLen, setLen, getSpeed, setSpeed, fmtLen, fmtSpeed } from './state.js';

export const MISSION_COLORS = ['#ffd60a', '#4cc9f0', '#f72585', '#80ed99', '#ff9f1c', '#b5179e', '#90e0ef', '#e9ff70'];
export const MAX_GENERATED = 6000;
export const MAX_WP_CAP = 400;
export const OBLIQUE_PITCH = -45;

const PLAIN_IDS = ['camera', 'camW', 'camH', 'camF', 'camPx', 'front', 'side', 'angle', 'turnMode', 'gimbal', 'finish', 'rcLost',
  'terrain', 'densify', 'maxWp', 'maxMin', 'captureMode', 'crosshatch', 'oblique', 'hover', 'marginAuto', 'droneKey', 'controller', 'quality',
  'trees', 'speedAuto', 'lockHeading', 'rangeSplit'];
const LEN_IDS = ['alt', 'overshoot', 'margin', 'orbitRadius', 'bldgHeight', 'corridorWidth', 'tol', 'maxRange'];
const SPEED_IDS = ['speed'];
export const SETTING_IDS = [...PLAIN_IDS, ...LEN_IDS, ...SPEED_IDS];

// ---------- Settings ----------

const val = id => { const e = $(id); return e.type === 'checkbox' ? e.checked : (e.type === 'number' || e.type === 'range') ? +e.value : e.value; };

export function settings() {
  const camKey = val('camera');
  const cam = camKey === 'custom'
    ? { sensorW: val('camW'), sensorH: val('camH'), focal: val('camF'), imageW: val('camPx') }
    : CAMERAS[camKey];
  const alt = getLen('alt'), front = val('front'), side = val('side'), turnMode = val('turnMode'), captureMode = val('captureMode');
  const speedAuto = val('speedAuto');
  // Automatic speed: as fast as the photos stay sharp and the camera keeps up. Photos are taken on the move
  // unless every photo is a stop (timer photos, including the automatic choice, are always on the move).
  const speed = speedAuto
    ? autoSpeed(gridMetrics(cam, alt, front, side), { moving: turnMode !== 'straight-stop' || captureMode !== 'waypoint' })
    : getSpeed('speed');
  return {
    cam, alt, speed, speedAuto, front, side, angle: val('angle'),
    overshoot: getLen('overshoot'), margin: getLen('margin'), marginAuto: val('marginAuto'),
    turnMode, gimbal: val('gimbal'), finish: val('finish'), rcLost: val('rcLost'),
    terrain: val('terrain'), densify: val('densify'), tol: getLen('tol'),
    maxWp: Math.min(MAX_WP_CAP, Math.max(2, val('maxWp') || 200)), maxMin: val('maxMin'),
    captureMode, crosshatch: val('crosshatch'), oblique: val('oblique'), hover: val('hover'),
    droneKey: val('droneKey'), controller: val('controller'), trees: val('trees'), lockHeading: val('lockHeading'),
    rangeSplit: val('rangeSplit'), maxRange: getLen('maxRange'),
    orbitRadius: getLen('orbitRadius'), bldgHeight: getLen('bldgHeight'), corridorWidth: getLen('corridorWidth'),
  };
}

export function settingsSnapshot() {
  const o = { dir: state.dir, goal: state.goal };
  for (const id of PLAIN_IDS) o[id] = $(id).type === 'checkbox' ? $(id).checked : $(id).value;
  for (const id of LEN_IDS) o[id] = getLen(id);
  for (const id of SPEED_IDS) o[id] = getSpeed(id);
  return o;
}

export function applySettings(o = {}) {
  for (const id of PLAIN_IDS) {
    if (o[id] === undefined || !$(id)) continue;
    if ($(id).type === 'checkbox') $(id).checked = !!o[id]; else $(id).value = o[id];
  }
  // Older saves kept speed and ridge tolerance as text in metric, so accept numeric strings too.
  const num = v => v === undefined || v === null || v === '' ? NaN : +v;
  for (const id of LEN_IDS) if (Number.isFinite(num(o[id]))) setLen(id, num(o[id]));
  for (const id of SPEED_IDS) if (Number.isFinite(num(o[id]))) setSpeed(id, num(o[id]));
  if (o.dir) state.dir = o.dir;
  if (o.goal && GOALS[o.goal]) state.goal = o.goal;
}

export const saveSettings = () => setPref('settings', settingsSnapshot());
export const loadSettings = () => applySettings(pref('settings', {}));

export function currentAngle() {
  if (state.dir === 'ns') return 0;
  if (state.dir === 'ew') return 90;
  if (state.dir === 'auto') return areaList().length ? autoAngle(areaList()[0]) : 0;
  return +$('angle').value;
}

// ---------- Undo / redo ----------

const snapshot = () => JSON.stringify({
  polygon: state.polygon, areas: state.areas, keepouts: state.keepouts, waypoints: state.waypoints, home: state.home, homeGround: state.homeGround, homeUser: state.homeUser, launches: state.launches,
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
  // Stops at every point, or (flying through points) only at the corners where the path turns.
  const stops = s.turnMode === 'straight-stop' || s.turnMode === 'keep' || (s.turnMode === 'straight-pass' && b.corner);
  return d / Math.max(0.5, b.speed || s.speed) + (stops ? 2.5 : 0) + (b.photo ? 0.5 + (s.hover ? 1 : 0) : 0);
}

function missionOverhead(chunk, home = state.home) {
  if (!home || !chunk.length) return 0;
  const toFirst = haversine(home, chunk[0]) / 10;
  const back = haversine(chunk.at(-1), home) / 10;
  const climb = Math.max(...chunk.map(w => Math.abs(w.height))) / 4;
  return 30 + toFirst + back + climb * 2;
}

function splitRanges(wps, s, maxWp, maxSec, home) {
  const out = [];
  let start = 0, t = 0;
  for (let i = 0; i < wps.length; i++) {
    const count = i - start + 1;
    const dt = i > start ? segmentTime(wps[i - 1], wps[i], s) : 0;
    const overTime = maxSec > 0 && count > 2 && t + dt + missionOverhead(wps.slice(start, i + 1), home) > maxSec;
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

// Battery-sized missions over one stretch of waypoints flown from `home`.
function splitEven(wps, s, home) {
  const maxSec = s.maxMin > 0 ? s.maxMin * 60 : 0;
  let out = splitRanges(wps, s, s.maxWp, maxSec, home);
  // Even out the missions instead of leaving a tiny last one, as long as that needs no extra battery.
  const k = out.length;
  if (k > 1) {
    let flight = 0;
    for (let i = 1; i < wps.length; i++) flight += segmentTime(wps[i - 1], wps[i], s);
    const evenSec = maxSec ? Math.min(maxSec, (flight / k + missionOverhead(wps.slice(0, Math.ceil(wps.length / k)), home)) * 1.05) : 0;
    const even = splitRanges(wps, s, Math.min(s.maxWp, Math.ceil(wps.length / k) + 1), evenSec, home);
    if (even.length === k) out = even;
  }
  return out;
}

/** Stretches of consecutive waypoints flown from the same launch point: [{a, b, zone}]. One stretch without zones. */
export function zoneRanges(wps, launches = state.launches) {
  if (!launches?.length || !wps.length) return wps.length ? [{ a: 0, b: wps.length - 1, zone: null }] : [];
  const z = [];
  wps.forEach((w, i) => z.push(Number.isInteger(w.zone) && w.zone < launches.length ? w.zone : i ? z[i - 1] : 0));
  const out = [];
  let a = 0;
  for (let i = 1; i <= wps.length; i++) if (i === wps.length || z[i] !== z[a]) { out.push({ a, b: i - 1, zone: z[a] }); a = i; }
  return out;
}

// `wps`, `s`, `withProgress` and `launches` let the planner try out other settings (see missionsForAlt) without touching the open plan.
export function computeMissions(wps = state.waypoints, s = settings(), withProgress = true, launches = state.launches) {
  const out = [];
  for (const r of zoneRanges(wps, launches)) {
    const launch = r.zone === null ? state.home : launches[r.zone];
    for (const m of splitEven(wps.slice(r.a, r.b + 1), s, launch)) out.push({ start: m.start + r.a, end: m.end + r.a, zone: r.zone, launch });
  }
  const prog = withProgress ? progress() : null;
  return out.map((m, k) => {
    // A mission cut short in the field restarts at the waypoint where it stopped.
    const from = prog?.resume?.mission === k && prog.resume.from > 0 && prog.resume.from <= m.end - m.start ? prog.resume.from : 0;
    const start = m.start + from;
    const pts = wps.slice(start, m.end + 1);
    let time = 0;
    for (let i = 1; i < pts.length; i++) time += segmentTime(pts[i - 1], pts[i], s);
    return {
      start, end: m.end, fullStart: m.start, fullCount: m.end - m.start + 1, resumedFrom: from, flown: !!prog?.flown.includes(k),
      index: k, points: pts, distance: pathLength(pts), time: time + missionOverhead(pts, m.launch), color: MISSION_COLORS[k % MISSION_COLORS.length],
      zone: m.zone, launch: m.launch || null, far: m.launch && pts.length ? farthest(m.launch, pts) : 0,
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
  return areaList().length ? null : 'Draw the area you want to map: at least 3 corners.';
}

export function geometryReady() { return !missingInput(); }

// Default takeoff spot: where you would stand, i.e. the edge of the area nearest the user (or the map centre).
function defaultHome(s) {
  const target = state.userLoc || state.mapCenter();
  if (state.goal === 'orbit') return makeProjection(state.center.lat, state.center.lon).toLL(0, -(s.orbitRadius + 15));
  if (state.goal === 'corridor') return nearestEdgePoint(state.line, target, false);
  const edges = areaList().map(a => nearestEdgePoint(a, target, true));
  return edges.reduce((a, b) => haversine(b, target) < haversine(a, target) ? b : a);
}

function ensureHome(s) {
  if (state.homeUser && state.home) return;
  const key = JSON.stringify([state.goal, state.goal === 'orbit' ? state.center : state.goal === 'corridor' ? state.line : [state.polygon, state.areas]]);
  if (state.home && state.homeKey === key) return;
  state.home = defaultHome(s);
  state.homeKey = key;
  state.homeGround = null;
}

// Distance in metres from a point to an area (0 when inside it).
function distToArea(p, area) {
  return pointInPolygon(p, area) ? 0 : haversine(p, nearestEdgePoint(area, p, true));
}

// `next` preceded by transit waypoints that go round the keep-outs after waypoint `prev`.
function link(prev, next, keepouts) {
  return prev && next.length && keepouts.length ? transitWaypoints(prev, next[0], keepouts).concat(next) : next;
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
  const opts = { ...base, angle, overshoot: s.overshoot, margin, crosshatch: goal === '3d' && s.crosshatch, lockHeading: s.lockHeading };
  const want = useObl ? 'waypoint' : s.captureMode;
  const keepouts = keepoutList();
  // Areas too big to fly from one spot are cut into tiles lined up with the flight lines (overlapping a little).
  const range = s.rangeSplit && !useObl && s.maxRange > 0 ? s.maxRange : 0;
  const pad = Math.max(m.lineSpacing * 0.51, m.photoSpacing) + s.overshoot;
  const todo0 = [];
  for (const area of areaList()) {
    const ang = state.dir === 'auto' ? autoAngle(area) : angle;
    const tiles = range ? rangeTiles(margin ? bufferPolygon(area, margin) : area, ang, range, { pad }) : null;
    if (tiles) tiles.forEach(t => todo0.push({ area, ang, clip: t.clip, ref: t.clip }));
    else todo0.push({ area, ang, clip: null, ref: area });
  }
  // Fly the pieces one after another: nearest the takeoff point first, then the nearest to where the drone ended.
  const run = captureMode => {
    const todo = todo0.slice();
    const pieces = [];
    let last = state.home, gridCount = 0, interval = null, speed = s.speed;
    while (todo.length) {
      todo.sort((a, b) => distToArea(last, a.ref) - distToArea(last, b.ref));
      const pc = todo.shift();
      const g = planGrid(pc.area, { ...opts, keepouts, angle: pc.ang, home: last, captureMode, clip: pc.clip });
      gridCount += g.waypoints.length; interval = g.interval ?? interval; speed = g.speed;
      let part = g.waypoints;
      if (useObl) {
        const ob = planOblique(pc.area, { ...base, keepouts, overshoot: s.overshoot, pitch: OBLIQUE_PITCH, margin, home: part.at(-1) || last });
        part = part.concat(link(part.at(-1), ob.waypoints, keepouts));
      }
      if (!part.length) continue;
      pieces.push({ wps: part, ang: pc.ang });
      last = part.at(-1);
    }
    return { pieces, gridCount, interval, speed };
  };
  let res = run(want === 'timer' ? 'timer' : 'waypoint');
  let recommended = false;
  if (want === 'auto' && recommendTimer(res.gridCount)) { res = run('timer'); recommended = true; }
  const tip = want === 'waypoint' && recommendTimer(res.gridCount);

  // Launch points: when part of the plan is out of range of the takeoff point, group the pieces into zones that
  // can each be flown from one spot. A single zone just moves the takeoff point (unless you placed it yourself).
  const all = res.pieces.flatMap(p => p.wps);
  let launches = null, homeSuggest = null, zones = null;
  if (range && all.length && !(state.home && farthest(state.home, all) <= range)) {
    zones = groupPieces(res.pieces.map(p => p.wps), range, res.pieces[0].ang);
    if (zones.length > 1) launches = zones.map(z => ({ lat: z.launch.lat, lon: z.launch.lon }));
    else if (!state.homeUser) homeSuggest = zones[0].launch;
    if (!launches) zones = null;
  }
  let waypoints = [];
  if (zones) {
    zones.forEach((z, k) => {
      let part = [];
      for (const i of z.pieces) part = part.concat(link(part.at(-1), res.pieces[i].wps, keepouts));
      waypoints = waypoints.concat(part.map(w => ({ ...w, zone: k })));
    });
  } else {
    for (const p of res.pieces) waypoints = waypoints.concat(link(waypoints.at(-1), p.wps, keepouts));
  }
  return {
    ...meta, margin, waypoints, launches, homeSuggest, range,
    captureMode: res.interval ? 'timer' : 'waypoint', interval: res.interval, speed: res.speed, recommendedTimer: recommended, tip,
  };
}

/**
 * How many missions the plan would need if you flew at `alt` metres, using the real planner and mission
 * splitting but leaving the open plan alone. Terrain heights are ignored (they only move heights a little).
 * Infinity when the plan would be too big to generate.
 */
export function missionsForAlt(alt) {
  const s = { ...settings(), alt };
  ensureHome(s);
  const g = gridMetrics(s.cam, alt, s.front, s.side);
  const area = state.goal === 'corridor' ? pathLength(state.line) * s.corridorWidth : areaList().reduce((a, p) => a + polygonAreaM2(p), 0);
  // A quick count first, so a very low height over a big area does not build millions of points.
  if (area / (g.lineSpacing * g.photoSpacing) > MAX_GENERATED * 4) return Infinity;
  const p = buildPlan(s);
  if (!p.waypoints.length || p.waypoints.length > MAX_GENERATED) return p.waypoints.length ? Infinity : 0;
  return computeMissions(p.waypoints.map(w => ({ ...w, height: alt })), s, false, p.launches).length;
}

let genToken = 0;

export async function generate({ auto = false } = {}) {
  if (state.goal !== 'orbit' && state.goal !== 'corridor' && !areaList().length && state.waypoints.length >= 3) state.polygon = convexHull(state.waypoints);
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
  const { waypoints, launches, homeSuggest, ...meta } = plan;
  state.waypoints = waypoints;
  state.plan = meta;
  // Keep launch points you dragged while the zones stay the same.
  const old = state.launches;
  state.launches = launches ? launches.map((l, k) => old?.length === launches.length && old[k].user ? { ...old[k], ground: null } : l) : null;
  if (homeSuggest) { state.home = homeSuggest; state.homeGround = null; }
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
    // Heights are measured from where the drone takes off, so each launch zone is worked out from its own launch point.
    const ranges = zoneRanges(state.waypoints);
    const parts = [];
    for (const z of ranges) {
      const launch = z.zone === null ? state.home : state.launches[z.zone];
      const tag = ranges.length > 1 ? ` (launch L${z.zone + 1} of ${ranges.length})` : '';
      parts.push(await applyTerrain(state.waypoints.slice(z.a, z.b + 1), launch, s.alt, {
        densify: s.densify, tolerance: s.tol,
        onProgress: (n, total) => { status.textContent = `Fetching ground elevation${tag}… ${n}/${total}`; },
      }));
      if (token !== genToken) return;
    }
    const r = {
      waypoints: parts.flatMap((p, i) => p.waypoints.map(w => ranges[i].zone === null ? w : { ...w, zone: ranges[i].zone, launchGround: p.homeGround })),
      homeGround: parts[0].homeGround, inserted: parts.reduce((a, p) => a + p.inserted, 0), source: parts[0].source,
      note: [...new Set(parts.map(p => p.note).filter(Boolean))].join(' '),
    };
    if (state.launches) ranges.forEach((z, i) => { if (z.zone !== null) state.launches[z.zone].ground = parts[i].homeGround; });
    if (token !== genToken) return;
    if (withUndo) pushUndo();
    fixTerrainHeadings(r.waypoints);
    state.waypoints = r.waypoints;
    state.homeGround = r.homeGround;
    state.terrainStale = false;
    state.selected = -1;
    const g = r.waypoints.map(w => w.ground);
    state.terrainSource = r.source;
    const takeoff = state.launches ? `launch points at ${state.launches.map((l, k) => `L${k + 1} ${l.ground != null ? fmtLen(l.ground) : '?'}`).join(', ')}` : `takeoff at ${fmtLen(r.homeGround)}`;
    status.textContent = `Ground heights: ${SOURCES[r.source].short}. Ground varies ${fmtLen(Math.min(...g))} to ${fmtLen(Math.max(...g))} above sea level; ${takeoff}.` +
      (r.inserted ? ` Added ${r.inserted} terrain point${r.inserted > 1 ? 's' : ''} over ridges.` : '') +
      (r.source === 'ky' ? ' LiDAR ground heights are accurate, but trees and buildings are not included: your height above ground must also clear the treetops.'
        : r.source === 'd3' ? ' USGS 3DEP is bare earth (no trees or buildings) and its detail varies from about 1 m to 10 m; leave a generous margin.'
        : ' This data is coarse and ignores trees and buildings; leave a generous margin.') +
      (r.note ? ' ' + r.note : '');
    state.clearance = null;
    emit('render');
    if (r.source === 'ky' && !state.launches) {
      // Tree and building clearance from the Kentucky surface model; quiet when it is unavailable.
      const wps = state.waypoints;
      const c = await routeClearance(wps, r.homeGround).catch(() => null);
      if (c && token === genToken && state.waypoints === wps) { state.clearance = { ...c, count: wps.length }; emit('render'); }
    }
  } catch (e) {
    status.textContent = 'Ground heights not available: ' + e.message;
  } finally {
    $('btnHeights').disabled = false;
  }
}

export function straighten() {
  if (state.waypoints.length < 3) return toast('Not enough waypoints to straighten.');
  const r = snapStraight(state.waypoints);
  if (keepoutList().length && pathHitsKeepouts(r.waypoints, keepoutList()) && !pathHitsKeepouts(state.waypoints, keepoutList())) return toast('Straightening would make the path cross a keep-out zone, so it was not done.', 6000);
  pushUndo();
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
      source: res, sourceBytes: bytes, fileName: res.name, waypoints: res.waypoints, generated: false, plan: null, polygon: [], areas: [], keepouts: [], center: null, line: [], launches: null,
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
    source: null, sourceBytes: null, fileName: null, generated: false, plan: null, polygon: [], areas: [], keepouts: [], center: null, line: [], waypoints: [],
    home: null, homeUser: false, homeKey: null, homeGround: null, launches: null, selected: -1, terrainStale: false, pristine: false, undo: [], redo: [],
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
  const launch = Number.isInteger(m.zone) ? `-L${m.zone + 1}` : '';
  return count > 1 ? `${base}-${m.index + 1}of${count}${launch}${rest}.kmz` : `${base}${launch}${rest}.kmz`;
}

export async function buildMissionFiles(source = state.source) {
  const ms = computeMissions();
  return Promise.all(ms.map(async m => ({ ...m, name: missionFileName(m, ms.length), blob: await buildKmz(m.points, exportOpts(m), source) })));
}
