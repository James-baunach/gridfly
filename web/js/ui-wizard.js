// The guided Easy-mode flow (steps 1 to 7), the Easy / Advanced switch, goal and quality presets, and automatic planning.

import { gridMetrics } from './grid.js';
import { polygonAreaM2, pathLength } from './geo.js';
import { GOALS, QUALITY, qualityParams, qualityMatch, detailWords, CONTROLLERS } from './presets.js';
import { $, state, on, emit, toast, esc, debounce, setPref, pref, setLen, fmtTime, fmtLen, fmtDist } from './state.js';
import { settings, saveSettings, generate, applyHeights, computeMissions, missingInput, geometryReady, photoEstimate, currentAngle } from './plan.js';
import { startTool, setMode } from './ui-map.js';

const STEPS = ['Drone', 'Where', 'Goal', 'Quality', 'Site', 'Fly', 'After'];
// Inputs that change the generated waypoints.
export const PLAN_IDS = ['camera', 'camW', 'camH', 'camF', 'camPx', 'alt', 'speed', 'front', 'side', 'angle', 'overshoot', 'margin', 'marginAuto',
  'gimbal', 'terrain', 'densify', 'tol', 'captureMode', 'crosshatch', 'oblique', 'orbitRadius', 'bldgHeight', 'corridorWidth'];

const anyGeometry = () => state.polygon.length >= 3 || !!state.center || state.line.length >= 2 || state.waypoints.length > 0;

function canNext(n) {
  if (n === 2 && !anyGeometry()) return 'Draw or choose your area on the map first.';
  if (n === 3 && !state.waypoints.length && missingInput()) return missingInput();
  if (n === 4 && !state.waypoints.length) return missingInput() || 'Your plan is being worked out…';
  return '';
}

// ---------- Mode and steps ----------

export function setUi(easy) {
  state.easy = easy;
  document.body.dataset.ui = easy ? 'easy' : 'adv';
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('active', (b.dataset.ui === 'easy') === easy));
  setPref('easy', easy);
  goStep(state.step);
  emit('render');
}

export function goStep(n) {
  n = Math.max(1, Math.min(7, n));
  if (n !== state.step && state.mode && state.mode !== 'add') setMode(null);
  state.step = n;
  document.querySelectorAll('.step').forEach(s => s.classList.toggle('cur', +s.dataset.step === n));
  $('panel').scrollTop = 0;
  setPref('step', n);
  if (n === 5) emit('plan', {});
  renderWizard();
}

function buildNav() {
  $('stepper').innerHTML = STEPS.map((t, i) => `<button data-go="${i + 1}" title="Step ${i + 1}: ${t}"><b>${i + 1}</b><span>${t}</span></button>`).join('');
  $('stepper').onclick = e => { const b = e.target.closest('[data-go]'); if (b) goStep(+b.dataset.go); };
  document.querySelectorAll('.step').forEach(sec => {
    const n = +sec.dataset.step;
    sec.insertAdjacentHTML('beforeend', `<div class="stepnav easy-only">
      ${n > 1 ? '<button data-nav="-1">Back</button>' : ''}${n < 7 ? '<button class="primary" data-nav="1">Next</button>' : ''}</div><p class="why small muted easy-only"></p>`);
    sec.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => goStep(n + +b.dataset.nav));
  });
}

// ---------- Goals and quality ----------

function buildGoals() {
  $('goalCards').innerHTML = Object.entries(GOALS).map(([id, g]) =>
    `<button class="goal" data-goal="${id}"><b>${esc(g.title)}</b><span>${esc(g.text)}</span></button>`).join('');
  $('goalCards').onclick = e => { const b = e.target.closest('[data-goal]'); if (b) setGoal(b.dataset.goal); };
}

function qualityLevel() {
  const s = settings();
  const m = qualityMatch(state.goal, s.alt, s.front, s.side);
  return m >= 0 ? m : +$('quality').value;
}

export function applyQuality(level = +$('quality').value) {
  const p = qualityParams(state.goal, level);
  $('quality').value = level;
  setLen('alt', p.alt);
  $('front').value = p.front;
  $('side').value = p.side;
}

export function setGoal(goal) {
  if (!GOALS[goal]) return;
  state.goal = goal;
  applyQuality(qualityLevel());
  $('crosshatch').checked = !!GOALS[goal].crosshatch;
  if (goal !== '3d') $('oblique').checked = false;
  saveSettings();
  emit('render');
  emit('plan', { geometry: true });
  const need = missingInput();
  if (need && !state.waypoints.length) {
    if (goal === 'orbit') { startTool('center'); toast('Click the building you want to orbit.'); }
    else if (goal === 'corridor') { startTool('line'); toast('Click points along the road, river or fence, then press Done.'); }
  }
}

// ---------- Rendering ----------

function areaText() {
  const parts = [];
  if (state.polygon.length >= 3) {
    const a = polygonAreaM2(state.polygon);
    parts.push(`Area <b>${(a / 10000).toFixed(2)} ha</b> (${(a / 4046.86).toFixed(2)} acres), ${state.polygon.length} corners. Drag the orange corners to adjust, click the small circles to add a corner, right-click a corner to remove it.`);
  }
  if (state.line.length >= 2) parts.push(`Line of <b>${fmtDist(pathLength(state.line))}</b> with ${state.line.length} points.`);
  if (state.center) parts.push('Orbit centre set. Drag it to move.');
  return parts.join('<br>') || 'Search for your site above, then pick a tool to mark the area.';
}

function renderResult() {
  const box = $('plainResult');
  const wps = state.waypoints;
  if (!wps.length) {
    box.innerHTML = `<p class="muted">${esc(missingInput() || 'Working out your plan…')}</p>`;
    return;
  }
  const s = settings(), missions = computeMissions(), p = state.plan;
  const gsd = p?.gsd ?? gridMetrics(s.cam, s.alt, s.front, s.side).gsd;
  const total = missions.reduce((a, m) => a + m.time, 0);
  const rows = [
    ['Detail', detailWords(gsd, state.unit)],
    ['Photos', `${photoEstimate(missions)}${p?.captureMode === 'timer' ? ' (timer)' : ''}`],
    ['Flight time', fmtTime(total)],
    ['Batteries', `${missions.length} (one per mission) + 1 spare`],
    ['Missions', missions.length],
    ['Flying height', p?.goal === 'orbit' ? `${fmtLen(Math.min(...wps.map(w => w.height)))} to ${fmtLen(Math.max(...wps.map(w => w.height)))} above takeoff` : `${fmtLen(s.alt)} above the ground`],
  ];
  box.innerHTML = `<dl class="stats">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

function renderNotices() {
  const p = state.plan, s = settings();
  const timer = p?.captureMode === 'timer';
  $('timerNotice').hidden = !timer;
  if (timer) {
    $('timerNotice').innerHTML = `<b>Before starting each mission set DJI Fly to Timed Shot every ${p.interval} s and start it when the mission starts.</b>` +
      (p.recommendedTimer ? '<br>GridFly chose this automatically because a photo at every waypoint would need a lot of missions.' : '');
  }
  const tip = p?.tip && !timer;
  $('captureNote').textContent = tip ? 'This plan is big. Timer photos would need far fewer waypoints.'
    : s.captureMode === 'auto' && p && !timer ? 'Automatic: a photo at every waypoint, unless the plan gets very large.'
    : (state.goal === '3d' && s.oblique && s.captureMode !== 'waypoint') ? 'Angled passes always use a photo at every waypoint.' : '';
}

export function renderWizard() {
  const s = settings();
  document.querySelectorAll('[data-goal]').forEach(b => b.classList.toggle('sel', b.dataset.goal === state.goal));
  document.querySelectorAll('[data-for]').forEach(el => { el.hidden = !el.dataset.for.split(' ').includes(state.goal); });
  $('qualityBox').hidden = state.goal === 'orbit';
  const lvl = qualityMatch(state.goal, s.alt, s.front, s.side);
  $('qualityName').textContent = lvl >= 0 ? QUALITY[lvl].label : 'Custom';
  if (lvl >= 0) $('quality').value = lvl;
  document.querySelectorAll('#dirSeg button').forEach(b => b.classList.toggle('active', b.dataset.dir === state.dir));
  $('angleWrap').hidden = state.dir !== 'custom';
  $('angleVal').textContent = `${currentAngle()}°`;
  $('areaInfo').innerHTML = areaText();
  $('controllerNote').textContent = {
    rc: 'The standard DJI RC has no USB file access, so GridFly makes a microSD package for you.',
    rc2: 'GridFly can copy missions straight onto this controller (needs the helper, Windows).',
    'rcn-android': 'GridFly can copy missions onto the phone over USB (needs the helper, Windows).',
    'rcn-ios': 'You will copy the files over with the iPhone Files app.',
  }[s.controller] || '';
  renderResult();
  renderNotices();
  $('btnGenerate').hidden = state.easy && !(state.waypoints.length && !state.generated && geometryReady());
  $('btnGenerate').textContent = state.easy ? 'Re-plan (discard my hand edits)' : 'Generate flight plan';

  document.querySelectorAll('#stepper button').forEach(b => {
    const n = +b.dataset.go;
    b.classList.toggle('cur', n === state.step);
    b.classList.toggle('done', n < state.step);
  });
  document.querySelectorAll('.step').forEach(sec => {
    const n = +sec.dataset.step, why = canNext(n), next = sec.querySelector('[data-nav="1"]');
    if (next) next.disabled = !!why;
    const w = sec.querySelector('.why');
    if (w) w.textContent = why;
  });
}

// ---------- Automatic planning ----------

let pending = {};

const autoPlan = debounce(async () => {
  const e = pending;
  pending = {};
  if (e.restored || state.mode === 'draw' || state.mode === 'line') return;
  const ready = geometryReady();
  if (state.easy) {
    if (ready && (state.generated || !state.waypoints.length)) await generate({ auto: true });
    else if (e.home && settings().terrain && state.waypoints.length) await applyHeights(false);
  } else if (e.geometry && state.generated && ready) await generate({ auto: true });
  else if (e.home && settings().terrain && state.waypoints.length) await applyHeights(false);
}, 600);

// ---------- Init ----------

export function initWizard() {
  buildNav();
  buildGoals();
  $('droneKey').onchange = () => { $('camera').value = 'mavic3'; };
  $('quality').oninput = () => { applyQuality(); saveSettings(); emit('render'); emit('plan', {}); };
  document.querySelectorAll('#modeSeg button').forEach(b => b.onclick = () => setUi(b.dataset.ui === 'easy'));
  document.querySelectorAll('#dirSeg button').forEach(b => b.onclick = () => {
    state.dir = b.dataset.dir;
    if (state.dir === 'custom') $('angle').value = currentAngle();
    saveSettings();
    emit('render');
    emit('plan', { geometry: true });
  });
  $('angle').oninput = () => { $('angleVal').textContent = `${$('angle').value}°`; };
  $('angle').onchange = () => { saveSettings(); emit('plan', { geometry: true }); };
  $('btnGenerate').onclick = () => generate();

  on('render', renderWizard);
  on('goal', () => { applyQuality(qualityLevel()); renderWizard(); });
  on('plan', e => { Object.assign(pending, e || {}); autoPlan(); });
  on('goStep', goStep);
  on('uiState', ui => {
    if (typeof ui.step === 'number') state.step = ui.step;
    if (typeof ui.easy === 'boolean' && ui.easy !== state.easy) setUi(ui.easy);
  });

  state.step = pref('step', 1);
  setUi(pref('easy', true));
}
