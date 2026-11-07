// GridFly entry point: wires the panel, the map and the feature modules together, and renders the Advanced-mode details.

import { haversine, polygonAreaM2, pathLength } from './geo.js';
import { CAMERAS, gridMetrics } from './grid.js';
import { buildKmz, readFile, TURN_MODES, DRONES } from './wpml.js';
import { autoMargin, CONTROLLERS, HELPER_CONTROLLERS } from './presets.js';
import { $, state, on, emit, toast, esc, pref, getLen, setLen, setUnit, fmtLen, fmtDist, fmtTime } from './state.js';
import * as plan from './plan.js';
import { map, layers, renderArea, renderWaypoints, select, setMode, startTool, initMapEvents, searchPlace, locateMe, hullOfWaypoints } from './ui-map.js';
import { initWizard, PLAN_IDS, setUi } from './ui-wizard.js';
import { initInstall } from './ui-install.js';
import { initSiteCheck } from './ui-sitecheck.js';
import { initPhotoCheck, runPhotoCheck } from './ui-photocheck.js';
import { initProject, restoreLast, openProjectFile } from './ui-project.js';
import { initHelp, toggleHelp } from './ui-help.js';
import { initOffline, toggle as toggleOffline } from './ui-offline.js';

const { settings, pushUndo, undo, redo, loadFile, saveSettings, SETTING_IDS } = plan;

// ---------- Rendering (Advanced details) ----------

function renderInfo() {
  const s = settings();
  const g = gridMetrics(s.cam, s.alt, s.front, s.side);
  const interval = g.photoSpacing / s.speed;
  $('camInfo').innerHTML = `Detail <b>${g.gsd.toFixed(2)} cm/px</b> · photo footprint <b>${fmtLen(g.across)} × ${fmtLen(g.along)}</b><br>` +
    `line spacing <b>${fmtLen(g.lineSpacing, 1)}</b> · photo every <b>${fmtLen(g.photoSpacing, 1)}</b> (${interval.toFixed(1)} s)`;
  $('customCam').hidden = $('camera').value !== 'custom';
  $('margin').disabled = s.marginAuto;
  if (s.marginAuto) setLen('margin', autoMargin(g));
  $('hover').disabled = state.plan?.captureMode === 'timer';
  $('hover').title = $('hover').disabled ? 'Not needed in timer mode: the camera takes photos on its own timer.' : '';

  $('missionInfo').innerHTML = state.source
    ? `<b>${esc(state.fileName)}</b> · ${state.source.waypoints.length} waypoints in file` +
      (state.source.info.droneEnum !== null ? ` · drone type ${state.source.info.droneEnum}/${state.source.info.droneSub ?? 0}` : '') +
      '<br><span class="small">Its drone settings will be reused for everything you export.</span>'
    : state.waypoints.length ? 'New mission (not based on a DJI Fly file).'
      : 'Open a mission saved by DJI Fly, drop a file on the map, or draw an area.';

  $('homeInfo').textContent = state.home
    ? `Takeoff (green H): ${state.home.lat.toFixed(6)}, ${state.home.lon.toFixed(6)}` + (state.homeGround !== null ? ` · ground ${fmtLen(state.homeGround)} above sea level` : '') +
      '. Drag the H to where you will actually stand. Heights are measured from there.'
    : 'No takeoff point yet. It is chosen for you when the plan is made.';

  renderSelection();
  renderStats();
  renderProfile();
}

function renderStats() {
  const s = settings();
  const wps = state.waypoints;
  const missions = plan.computeMissions();
  const heights = wps.map(w => w.height);
  const total = missions.reduce((a, m) => a + m.time, 0);
  const rows = wps.length ? [
    ['Waypoints', wps.length + (wps.some(w => w.terrainPoint) ? ` (${wps.filter(w => w.terrainPoint).length} terrain)` : '')],
    ['Photos', plan.photoEstimate(missions) + (state.plan?.captureMode === 'timer' ? ` (timer, every ${state.plan.interval} s)` : '')],
    ['Missions', missions.length],
    ['Flight distance', fmtDist(pathLength(wps))],
    ['Estimated time', fmtTime(total)],
    ['Height range', `${fmtLen(Math.min(...heights))} to ${fmtLen(Math.max(...heights))} above takeoff`],
  ] : [['Waypoints', 0]];
  $('stats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

  const warn = [];
  if (wps.length) {
    const r = plan.enforceTurnMode();
    if (Math.max(...heights) > 120) warn.push(`Some waypoints are more than ${fmtLen(120)} above the takeoff point. Check local altitude limits and your max altitude setting in DJI Fly.`);
    if (Math.min(...heights) < 5) warn.push(`Some waypoints are less than ${fmtLen(5)} above the takeoff point. Check obstacles and the takeoff location.`);
    if (state.terrainStale && s.terrain) warn.push('Points or the takeoff point moved since the ground heights were worked out. Click "Apply heights" again.');
    if (s.terrain && state.plan?.goal !== 'orbit' && wps.every(w => w.ground === undefined)) warn.push('Following the ground is on but no heights have been worked out yet.');
    const g = gridMetrics(s.cam, s.alt, s.front, s.side);
    if ((s.turnMode === 'straight-pass' || s.turnMode === 'curved') && g.photoSpacing / s.speed < 2 && state.plan?.captureMode !== 'timer') {
      warn.push(`Photos would be ${(g.photoSpacing / s.speed).toFixed(1)} s apart while flying through points. Slow down to ${(g.photoSpacing / 2).toFixed(1)} m/s or use "stop at each point".`);
    }
    if (r.warnLoaded) warn.push('This file uses curved paths, and DJI Fly ignores photo actions on curved paths. GridFly switches to straight paths as soon as you edit anything.');
    else if (s.turnMode === 'curved') warn.push('Curved paths cut corners between points and can bend flight lines. Use a straight path style for mapping.');
    if (missions.length > 1) warn.push(`Split into ${missions.length} missions (max ${s.maxWp} waypoints${s.maxMin ? ` / ${s.maxMin} min` : ''} each). Fly them in order from the same takeoff point, one battery each.`);
    if (!state.source && !HELPER_CONTROLLERS.includes(s.controller)) warn.push('Not based on a DJI Fly file, so GridFly uses built-in drone settings. If DJI Fly refuses the mission, open a KMZ saved by your drone first.');
    if (state.source?.info.heightMode && state.source.info.heightMode !== 'relativeToStartPoint') warn.push(`This file uses "${state.source.info.heightMode}" heights; GridFly treats heights as relative to takeoff.`);
  }
  $('warnings').innerHTML = warn.map(w => `<li>${esc(w)}</li>`).join('');
}

function renderProfile() {
  const c = $('profile');
  const wps = state.waypoints;
  const ok = wps.length > 1 && state.homeGround !== null && wps.some(w => w.ground !== undefined);
  c.hidden = !ok;
  if (!ok) return;
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height, pad = 26;
  ctx.clearRect(0, 0, W, H);
  const xs = [0];
  for (let i = 1; i < wps.length; i++) xs.push(xs[i - 1] + haversine(wps[i - 1], wps[i]));
  const gr = wps.map(w => w.ground !== undefined ? w.ground - state.homeGround : null);
  const all = [...wps.map(w => w.height), ...gr.filter(v => v !== null), 0];
  const lo = Math.min(...all) - 5, hi = Math.max(...all) + 5;
  const X = d => pad + (W - pad - 8) * d / (xs.at(-1) || 1);
  const Y = v => H - 18 - (H - 30) * (v - lo) / (hi - lo);
  const css = getComputedStyle(document.documentElement);
  ctx.font = '11px system-ui';
  ctx.fillStyle = css.getPropertyValue('--muted');
  ctx.fillText(fmtLen(hi), 2, 12);
  ctx.fillText(fmtLen(lo), 2, H - 20);
  ctx.fillText('ground', pad + 4, H - 4);
  ctx.fillStyle = '#ffd60a';
  ctx.fillText('flight', pad + 54, H - 4);
  ctx.fillStyle = css.getPropertyValue('--muted');
  ctx.fillText(fmtDist(xs.at(-1)), W - 60, H - 4);
  ctx.beginPath();
  let started = false;
  gr.forEach((g, i) => { if (g === null) return; started ? ctx.lineTo(X(xs[i]), Y(g)) : ctx.moveTo(X(xs[i]), Y(g)); started = true; });
  ctx.lineTo(X(xs.at(-1)), H - 18); ctx.lineTo(X(0), H - 18); ctx.closePath();
  ctx.fillStyle = 'rgba(128,150,120,.45)'; ctx.fill();
  ctx.beginPath();
  wps.forEach((w, i) => i ? ctx.lineTo(X(xs[i]), Y(w.height)) : ctx.moveTo(X(xs[i]), Y(w.height)));
  ctx.strokeStyle = '#ffd60a'; ctx.lineWidth = 2; ctx.stroke();
  ctx.strokeStyle = 'rgba(128,128,128,.6)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad, Y(0)); ctx.lineTo(W - 8, Y(0)); ctx.stroke(); ctx.setLineDash([]);
}

function renderSelection() {
  const w = state.waypoints[state.selected];
  $('selPanel').hidden = !w;
  if (!w) return;
  $('selTitle').textContent = `Waypoint ${state.selected + 1} of ${state.waypoints.length}`;
  if (document.activeElement !== $('selHeight')) setLen('selHeight', w.height);
  if (document.activeElement !== $('selSpeed')) $('selSpeed').value = w.speed;
  $('selPhoto').checked = !!w.photo;
  $('selInfo').textContent = `${w.lat.toFixed(7)}, ${w.lon.toFixed(7)}` +
    (w.ground !== undefined && state.homeGround !== null ? ` · ${fmtLen(w.height - (w.ground - state.homeGround))} above ground` : '') +
    (w.terrainPoint ? ' · added for terrain' : '');
}

function renderAll() {
  renderArea();
  renderWaypoints();
  renderInfo();
}

// ---------- Events ----------

function deleteSelected() {
  const i = state.selected;
  if (i < 0) return;
  pushUndo();
  state.waypoints.splice(i, 1);
  state.generated = false;
  state.selected = Math.min(i, state.waypoints.length - 1);
  emit('render');
}

const editSelected = fn => () => { const w = state.waypoints[state.selected]; if (!w) return; pushUndo(); fn(w); state.generated = false; emit('render'); };

function bind() {
  $('btnOpen').onclick = $('btnImport').onclick = () => $('fileInput').click();
  $('fileInput').onchange = e => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; };
  $('btnNew').onclick = () => {
    if (state.waypoints.length && !confirm('Start a new mission? (You can undo.)')) return;
    pushUndo();
    Object.assign(state, { source: null, sourceBytes: null, fileName: null, generated: false, plan: null, polygon: [], center: null, line: [], waypoints: [], home: null, homeUser: false, homeGround: null, selected: -1, terrainStale: false });
    emit('render');
    emit('plan', { geometry: true });
  };
  $('btnUndo').onclick = undo;
  $('btnRedo').onclick = redo;

  document.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => ['add', 'home'].includes(b.dataset.tool) ? setMode(b.dataset.tool) : startTool(b.dataset.tool));
  $('btnHull').onclick = hullOfWaypoints;
  $('btnClearArea').onclick = () => {
    pushUndo();
    state.polygon = []; state.center = null; state.line = [];
    if (state.generated) { state.waypoints = []; state.plan = null; state.generated = false; state.home = state.homeUser ? state.home : null; }
    emit('render');
    emit('plan', { geometry: true });
  };
  $('searchForm').onsubmit = e => { e.preventDefault(); searchPlace($('search').value); };
  $('btnLocate').onclick = locateMe;

  $('btnStraighten').onclick = plan.straighten;
  $('btnPhotoAll').onclick = () => {
    pushUndo();
    const p = settings().gimbal;
    state.waypoints.forEach(w => { w.photo = true; w.actions = null; w.gimbalPitch = p; });
    emit('render'); toast('Photo action added to every waypoint.');
  };
  $('btnPhotoNone').onclick = () => { pushUndo(); state.waypoints.forEach(w => { w.photo = false; w.actions = null; }); emit('render'); };
  $('btnSpeedAll').onclick = () => { pushUndo(); const sp = settings().speed; state.waypoints.forEach(w => { w.speed = sp; }); emit('render'); toast(`Speed set to ${sp} m/s.`); };
  $('btnReverse').onclick = () => { pushUndo(); state.waypoints.reverse(); state.waypoints.forEach(w => { w.actions = null; }); state.selected = -1; emit('render'); };
  $('btnHeights').onclick = () => plan.applyHeights(true);

  $('btnDeselect').onclick = () => select(-1);
  $('btnDelete').onclick = deleteSelected;
  $('btnInsert').onclick = () => {
    const i = state.selected, wps = state.waypoints;
    if (i < 0) return;
    const a = wps[i], b = wps[i + 1];
    pushUndo();
    const nw = b ? { ...a, lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2, height: (a.height + b.height) / 2, actions: null, terrainPoint: false }
      : { ...a, lat: a.lat + 0.0002, actions: null, terrainPoint: false };
    delete nw.ground;
    wps.splice(i + 1, 0, nw);
    state.generated = false;
    state.selected = i + 1;
    emit('render');
  };
  $('selHeight').onchange = editSelected(w => { w.height = getLen('selHeight'); });
  $('selSpeed').onchange = editSelected(w => { w.speed = +$('selSpeed').value; });
  $('selPhoto').onchange = editSelected(w => { w.photo = $('selPhoto').checked; w.actions = null; });

  const skip = new Set(['quality', 'angle']);
  for (const id of SETTING_IDS) {
    if (skip.has(id)) continue;
    $(id).addEventListener('change', () => { saveSettings(); emit('render'); if (PLAN_IDS.includes(id)) emit('plan', {}); });
  }
  for (const id of ['alt', 'speed', 'front', 'side']) $(id).addEventListener('input', renderInfo);
  document.querySelectorAll('#unitSeg button').forEach(b => b.onclick = () => setUnit(b.dataset.unit));

  document.addEventListener('keydown', e => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName);
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && k === 'y' && !typing) { e.preventDefault(); redo(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && state.selected >= 0) { e.preventDefault(); deleteSelected(); }
    else if (e.key === 'Escape') {
      if (!$('help').hidden) toggleHelp(false);
      else if (!$('offline').hidden) toggleOffline(false);
      else if (state.mode) setMode(null);
      else select(-1);
    } else if (e.key === '?' && !typing) toggleHelp();
  });

  // Drag and drop files onto the window: missions, projects or photos.
  let depth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); depth++; $('dropHint').hidden = false; });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('dropHint').hidden = true; } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault(); depth = 0; $('dropHint').hidden = true;
    openFiles([...e.dataTransfer.files]);
  });

  // Files opened with the installed app (desktop "Open with GridFly").
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async params => {
      if (params.files?.length) openFiles(await Promise.all(params.files.map(h => h.getFile())));
    });
  }

  // Phones: make the map bigger or smaller.
  $('btnMapSize').onclick = () => {
    const big = document.body.classList.toggle('mapbig');
    $('btnMapSize').textContent = big ? '⤡' : '⤢';
    $('btnMapSize').setAttribute('aria-label', big ? 'Make the map smaller' : 'Make the map bigger');
  };
}

// Missions, projects or photos, dropped or opened.
function openFiles(files) {
  const first = files.find(f => /\.(kmz|kml)$/i.test(f.name));
  const proj = files.find(f => /\.json$/i.test(f.name));
  if (first) loadFile(first);
  else if (proj) openProjectFile(proj);
  else if (files.some(f => /\.jpe?g$/i.test(f.name))) { emit('goStep', 7); runPhotoCheck(files); }
  else if (files.length) toast('GridFly can open .kmz, .kml, .gridfly.json and JPEG photos.');
}

// ---------- Start ----------

$('camera').innerHTML = Object.entries(CAMERAS).map(([k, c]) => `<option value="${k}">${c.name}</option>`).join('');
$('droneKey').innerHTML = Object.entries(DRONES).map(([k, d]) => `<option value="${k}">${d.name}</option>`).join('');
$('controller').innerHTML = Object.entries(CONTROLLERS).map(([k, t]) => `<option value="${k}">${t}</option>`).join('');
$('camera').value = 'mavic3';

setUnit(pref('unit', 'm'));
plan.loadSettings();
on('render', renderAll);
initMapEvents();
bind();
initWizard();
initSiteCheck();
initPhotoCheck();
initProject();
initInstall();
initOffline();
emit('render');
restoreLast().then(restored => initHelp({ firstRun: !restored }));

// For debugging from the console.
window.gridfly = { state, map, layers, settings, computeMissions: plan.computeMissions, generate: plan.generate, buildKmz, readFile, TURN_MODES, setUi, plan, emit };
