// The guided Easy-mode flow (steps 1 to 7), the Easy / Advanced switch, goal and quality presets, and automatic planning.

import { gridMetrics } from './grid.js';
import { solveForDetail, solveForBatteries } from './targets.js';
import { FT, fmtSmall } from './units.js';
import { pathLength } from './geo.js';
import { netAreaM2 } from './avoid.js';
import { GOALS, QUALITY, qualityParams, qualityMatch, detailWords, CONTROLLERS } from './presets.js';
import { $, state, areaList, keepoutList, on, emit, toast, esc, debounce, setPref, pref, setLen, getGsd, fmtTime, fmtLen, fmtDist, fmtArea } from './state.js';
import { settings, saveSettings, generate, applyHeights, computeMissions, missionsForAlt, missingInput, geometryReady, photoEstimate, currentAngle } from './plan.js';
import { startTool, setMode } from './ui-map.js';

const STEPS = ['Drone', 'Where', 'Goal', 'Quality', 'Site', 'Fly', 'After'];
// Inputs that change the generated waypoints.
export const PLAN_IDS = ['camera', 'camW', 'camH', 'camF', 'camPx', 'alt', 'speed', 'front', 'side', 'angle', 'overshoot', 'margin', 'marginAuto',
  'gimbal', 'terrain', 'densify', 'tol', 'captureMode', 'crosshatch', 'oblique', 'orbitRadius', 'bldgHeight', 'corridorWidth'];

const anyGeometry = () => areaList().length > 0 || !!state.center || state.line.length >= 2 || state.waypoints.length > 0;

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

// ---------- Targets: detail I need, batteries I have ----------

const say = msg => { $('targetNote').textContent = msg; };
const altStep = () => state.unit === 'ft' ? FT : 1;

function setHeightFromTarget() {
  saveSettings();
  emit('render');
  emit('plan', {});
}

function applyDetailTarget() {
  const box = $('targetGsd');
  if (box.value === '') return say('');
  const gsd = getGsd('targetGsd');
  if (!(gsd > 0)) return say('Type a detail size above zero, for example 2 cm per pixel.');
  const r = solveForDetail(settings().cam, gsd, { step: altStep() });
  setLen('alt', r.alt);
  const got = gridMetrics(settings().cam, r.alt, 75, 65).gsd;
  say(r.clamped
    ? `${fmtSmall(gsd, state.unit)} per pixel would need ${fmtLen(r.raw)}, which is ${r.clamped === 'low' ? 'lower' : 'higher'} than GridFly allows. Height set to ${fmtLen(r.alt)} instead, which gives about ${fmtSmall(got, state.unit)} per pixel.`
    : `Height set to ${fmtLen(r.alt)} above the ground for about ${fmtSmall(got, state.unit)} per pixel. Overlap is unchanged.`);
  setHeightFromTarget();
}

function applyBatteryTarget() {
  const n = Math.floor(+$('targetBatteries').value);
  if ($('targetBatteries').value === '') return say('');
  if (!(n >= 1)) return say('Type how many batteries you have, for example 3.');
  if (!geometryReady()) return say('Draw your area first, then GridFly can work out the height.');
  say('Working it out…');
  setTimeout(() => {
    const r = solveForBatteries(n, missionsForAlt, { step: altStep() });
    const plural = k => `${k} ${k === 1 ? 'mission' : 'missions'}`;
    if (!r.fits) {
      return say(Number.isFinite(r.missions)
        ? `Even at ${fmtLen(r.alt)}, about the highest you may legally fly in most places, this area needs ${plural(r.missions)}, more than the ${n} you have. The height was left as it was. Try a smaller area, less overlap, or a longer time per battery in Advanced.`
        : 'This area is too big to plan. Try a smaller area.');
    }
    setLen('alt', r.alt);
    say(`Lowest height that fits in ${plural(n)}: ${fmtLen(r.alt)} above the ground (${r.missions === n ? 'uses every battery' : `needs ${plural(r.missions)}`}).`);
    setHeightFromTarget();
  }, 30);
}

// ---------- Rendering ----------

function areaText() {
  const parts = [];
  const areas = areaList(), holes = keepoutList();
  if (areas.length) {
    const a = netAreaM2(areas, holes);
    const what = areas.length > 1 ? `${areas.length} areas` : `${areas[0].length} corners`;
    const less = holes.length ? `, after taking out ${holes.length} keep-out zone${holes.length > 1 ? 's' : ''}` : '';
    parts.push(`Area <b>${fmtArea(a)}</b> (${what}${less}). Drag the corners to adjust, click the small circles to add a corner, tap a corner to remove it.` +
      (areas.length > 1 ? ' Areas are flown nearest to your takeoff point first; areas that overlap are flown twice.' : ''));
  }
  if (holes.length) parts.push('<b>Keep-out zones</b> (red) are flat on the map, not height limits. The route goes round them, but the takeoff and return flights are not planned around them: you fly the takeoff, and Return to Home flies straight back.');
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
  $('targetGsd').onchange = applyDetailTarget;
  $('targetBatteries').onchange = applyBatteryTarget;
  $('alt').addEventListener('change', () => say(''));
  $('quality').oninput = () => { say(''); applyQuality(); saveSettings(); emit('render'); emit('plan', {}); };
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
