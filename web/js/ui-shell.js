// The app frame around the planner: home page vs planner, the one menu, the floating panel and the phone bottom sheet,
// the mission card (the plan's headline, its health and the next thing to do), one-tap "Map this view" and the demo.

import { gridMetrics } from './grid.js';
import { GOALS, rectPolygon, CONTROLLERS } from './presets.js';
import { fmtSmall } from './units.js';
import { $, state, on, emit, toast, esc, pref, setPref, areaList, fmtLen, fmtArea } from './state.js';
import { settings, computeMissions, photoEstimate, missingInput, geometryReady, pushUndo, saveSettings } from './plan.js';
import { netAreaM2 } from './avoid.js';
import { map, startTool, locateMe, fitTo } from './ui-map.js';
import { blockers } from './ui-install.js';
import { newProject } from './ui-project.js';

const root = document.documentElement;
const isPhone = () => window.matchMedia('(max-width: 699px)').matches;

// ---------- Home page and planner ----------

export const view = () => root.dataset.view;

// Some hosts (sandboxed previews) refuse history changes: the view still switches, only the address stays.
function setUrl(url, replace = false) {
  try { replace ? history.replaceState(null, '', url) : history.pushState(null, '', url); } catch { /* address unchanged */ }
}

export function showView(v, { push = true } = {}) {
  if (v === view()) return;
  root.dataset.view = v;
  if (push) setUrl(v === 'app' ? '#plan' : location.pathname + location.search);
  if (v === 'app') {
    map.invalidateSize();
    layoutSheet();
  } else window.scrollTo(0, 0);
  emit('view', v);
}

window.addEventListener('popstate', () => {
  const app = /^#(plan|demo)\b/.test(location.hash);
  showView(app ? 'app' : 'home', { push: false });
});

// ---------- Compatibility checker on the home page ----------

const DRONE_FIT = {
  mavic3: ['yes', 'Yes, fully supported.', 'The camera and drone settings for the Mavic 3 family are built in.'],
  mini4: ['yes', 'Yes, it works.', 'Choose the "Mini 4 Pro / Mini 3 Pro / Air 3" camera in the planner\'s settings. For the safest result, open a waypoint mission saved by your drone first so GridFly keeps its drone settings.'],
  other: ['maybe', 'Probably.', 'Open a waypoint mission saved by your drone (a KMZ file) and GridFly reuses its drone settings. Enter your camera in the planner\'s settings.'],
  nowp: ['no', 'Not on this drone.', 'DJI Fly has no waypoint missions on the Mini 2, Mini SE or Avata, so there is nothing to load a mapping mission into.'],
  pilot: ['no', 'Use DJI Pilot 2 instead.', 'Enterprise drones fly with DJI Pilot 2, which has its own mapping missions. GridFly writes missions for DJI Fly.'],
};
const CTRL_FIT = {
  rc: 'GridFly makes a microSD package with step-by-step instructions.',
  rc2: 'GridFly installs the mission over USB with a small Windows helper, and keeps a backup.',
  'rcn-android': 'GridFly installs the mission onto the phone over USB with a small Windows helper.',
  'rcn-ios': 'You copy the mission over with the iPhone Files app; GridFly shows you where.',
};

function renderCheck() {
  const [cls, title, text] = DRONE_FIT[$('hcDrone').value];
  const ctrl = cls === 'no' ? '' : ` ${CTRL_FIT[$('hcCtrl').value] || ''}`;
  const box = $('hcResult');
  box.className = `h-check-result ${cls}`;
  box.innerHTML = `<div><b>${esc(title)}</b><p>${esc(text + ctrl)}</p></div>`;
}

function initHome() {
  $('hcCtrl').innerHTML = Object.entries(CONTROLLERS).map(([k, t]) => `<option value="${k}">${esc(t)}</option>`).join('');
  $('hcDrone').onchange = $('hcCtrl').onchange = renderCheck;
  renderCheck();
  document.querySelectorAll('[data-go-app]').forEach(a => a.onclick = e => { e.preventDefault(); showView('app'); });
  document.querySelectorAll('[data-demo]').forEach(a => a.onclick = e => { e.preventDefault(); showView('app'); runDemo(); });
  document.querySelectorAll('[data-home-top]').forEach(a => a.onclick = e => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  $('btnBrand').onclick = $('btnHomePage').onclick = () => showView('home');
}

// ---------- One tap: plan what the map shows ----------

// The part of the map the top bar and the panel don't cover, in container pixels.
export function visibleBox() {
  const m = map.getContainer().getBoundingClientRect();
  let x0 = 0, y0 = 0, x1 = m.width, y1 = m.height;
  const tb = $('topbar').getBoundingClientRect();
  y0 = Math.max(y0, tb.bottom - m.top);
  const p = $('panel').getBoundingClientRect();
  const panelShown = !document.body.classList.contains('panel-hidden') && p.width > 0;
  if (panelShown && isPhone()) y1 = Math.min(y1, p.top - m.top);
  else if (panelShown) x0 = Math.max(x0, p.right - m.left);
  return { x0, y0, x1, y1 };
}

export function mapThisView() {
  if (map.getZoom() < 14) return toast('Zoom in to your site first (search for it at the top), then tap Map this view.', 5000);
  const b = visibleBox();
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  if (w < 60 || h < 60) return toast('Make the map bigger first.');
  const ix = w * 0.14, iy = h * 0.14;
  const ll = (x, y) => { const p = map.containerPointToLatLng([x, y]); return { lat: p.lat, lon: p.lng }; };
  const poly = rectPolygon(ll(b.x0 + ix, b.y0 + iy), ll(b.x1 - ix, b.y1 - iy));
  pushUndo();
  if (state.goal === 'orbit' || state.goal === 'corridor') { state.goal = 'grid'; emit('goal'); }
  state.polygon = poly; state.areas = []; state.center = null; state.line = [];
  if (state.generated || !state.waypoints.length) { state.waypoints = []; state.plan = null; state.launches = null; }
  saveSettings();
  emit('render');
  emit('plan', { geometry: true });
  if (state.easy) emit('goStep', 4);
  toast('Planned the area on screen. Drag the orange corners to adjust it.');
}

// A real field to try GridFly on, in Kentucky so the LiDAR terrain and treetop check show what they can do.
const DEMO = [
  { lat: 38.1512, lon: -84.5196 }, { lat: 38.1531, lon: -84.5188 }, { lat: 38.1536, lon: -84.5149 },
  { lat: 38.1514, lon: -84.5140 }, { lat: 38.1503, lon: -84.5168 },
];

export async function runDemo() {
  setPref('tourDone', true); // the demo explains itself; the tour stays in the menu
  await newProject();
  if (location.hash.startsWith('#demo')) setUrl('#plan', true);
  state.goal = 'grid';
  emit('goal');
  state.polygon = DEMO.map(p => ({ ...p }));
  state.projectName = 'Demo field';
  emit('render');
  emit('plan', { geometry: true });
  if (state.easy) emit('goStep', 4);
  setTimeout(() => fitTo(state.polygon), 350); // after the panel or sheet has settled
  toast('This is a demo field in Kentucky. Try the Quality slider, drag a corner, or search for your own site.', 6500);
}

// ---------- Mission card ----------

let showIssues = false;

const shortTime = s => { const m = Math.max(1, Math.round(s / 60)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };

function health(missions) {
  if (!state.waypoints.length) return null;
  const stop = blockers().list;
  // The ground-height warning repeats a blocker in other words: show it once.
  const check = (state.health?.issues || []).filter(c => !(/heights/.test(c) && stop.some(s => /heights/.test(s))));
  if (stop.length) return { cls: 'bad', label: stop.length === 1 ? '1 thing to fix' : `${stop.length} things to fix`, items: [...stop, ...check] };
  if (check.length) return { cls: 'mid', label: check.length === 1 ? '1 thing to check' : `${check.length} things to check`, items: check };
  return { cls: 'good', label: missions.length ? 'Ready to fly' : 'Planned', items: [] };
}

// The next thing to do, by step: [label, action] for the main button and an optional second one.
function nextActions() {
  const go = n => () => emit('goStep', n);
  if (!state.easy) return [['Download KMZ', () => $('expKmz').click()], ['Site check', () => $('siteBody').scrollIntoView({ behavior: 'smooth' })]];
  switch (state.step) {
    case 5: return [['Get it on my drone', go(6)], ['Edit plan', go(4)]];
    case 6: return [['After the flight', go(7)], ['Download KMZ', () => $('expKmz').click()]];
    case 7: return [['Choose photos', () => $('photoDir').click()], ['Edit plan', go(4)]];
    default: return [['Check the site', go(5)], state.step === 4 ? null : ['Adjust quality', go(4)]];
  }
}

function renderCard() {
  const box = $('missionCard');
  const wps = state.waypoints;
  if (!wps.length) {
    const need = areaList().length || state.center || state.line.length >= 2;
    if (need && geometryReady()) {
      box.innerHTML = `<div class="mc-kicker">${esc(GOALS[state.goal]?.title || 'Mission')}</div><div class="mc-head"><span class="spin"></span> Working out your plan…</div>`;
    } else if (need) {
      box.innerHTML = `<div class="mc-kicker">${esc(GOALS[state.goal]?.title || 'Mission')}</div><div class="mc-head">Almost there</div><div class="mc-sub">${esc(missingInput() || '')}</div>`;
    } else {
      box.innerHTML = `<div class="mc-kicker">New map</div>
        <div class="mc-head">Where are we mapping?</div>
        <div class="mc-sub">Find your site at the top, then plan what you see in one tap. Or draw the area yourself.</div>
        <div class="mc-actions"><button class="primary" data-mc="view">Map this view</button></div>
        <div class="mc-quick"><button data-mc="draw">Draw shape</button><button data-mc="rect">Rectangle</button><button data-mc="locate">My location</button></div>`;
    }
  } else {
    const s = settings(), missions = computeMissions(), p = state.plan;
    const total = missions.reduce((a, m) => a + m.time, 0);
    const gsd = p?.gsd ?? gridMetrics(s.cam, s.alt, s.front, s.side).gsd;
    const areas = areaList();
    const area = areas.length ? ` · ${fmtArea(netAreaM2(areas, state.keepouts.filter(k => k.length >= 3)))}` : '';
    const h = health(missions);
    const n = missions.length;
    const acts = nextActions().filter(Boolean);
    box.innerHTML = `<div class="mc-top"><div>
        <div class="mc-kicker">${esc((p?.goal && GOALS[p.goal]?.title) || (state.source ? esc(state.fileName || 'DJI mission') : 'Mission'))}${area}</div>
        <div class="mc-head">${shortTime(total)} · ${n} ${n === 1 ? 'battery' : 'batteries'}</div>
        <div class="mc-sub">${p?.goal === 'orbit' ? '' : `${fmtSmall(gsd, state.unit)} detail · `}${photoEstimate(missions)} photos · ${fmtLen(s.alt)} high</div>
      </div>${h ? `<button class="health ${h.cls}" data-mc="issues" aria-expanded="${showIssues}" ${h.items.length ? '' : 'disabled'}>${esc(h.label)}</button>` : ''}</div>
      ${showIssues && h?.items.length ? `<ul class="mc-issues">${h.items.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      <div class="mc-actions">${acts.map(([t], i) => `<button data-act="${i}" class="${i === 0 ? 'primary' : ''}">${esc(t)}</button>`).join('')}</div>`;
    box.querySelectorAll('[data-act]').forEach(b => b.onclick = () => acts[+b.dataset.act][1]());
  }
  box.querySelectorAll('[data-mc]').forEach(b => b.onclick = () => ({
    view: mapThisView,
    draw: () => { startTool('draw'); emit('goStep', 2); },
    rect: () => { startTool('rect'); emit('goStep', 2); },
    locate: locateMe,
    issues: () => { showIssues = !showIssues; renderCard(); },
  })[b.dataset.mc]?.());
  $('btnUndo').disabled = !state.undo.length;
  $('btnRedo').disabled = !state.redo.length;
}

// ---------- Panel: hide on wide screens, bottom sheet on phones ----------

let sheet = pref('sheet', 'half'); // 'peek' | 'half' | 'full'

function sheetHeights() {
  const vh = window.innerHeight;
  const tb = $('topbar').getBoundingClientRect().bottom;
  const peek = Math.min(vh * 0.45, 26 + $('missionCard').offsetHeight);
  return { peek, half: Math.max(peek, Math.round(vh * 0.5)), full: vh - tb - 8 };
}

function layoutSheet(h) {
  if (!isPhone()) { root.style.setProperty('--sheet-h', '0px'); $('panel').style.height = ''; return; }
  const px = h ?? sheetHeights()[sheet];
  $('panel').style.height = `${px}px`;
  root.style.setProperty('--sheet-h', `${Math.round(px)}px`);
}

export function setSheet(s) {
  sheet = s;
  setPref('sheet', s);
  layoutSheet();
}

function initSheet() {
  const grip = $('sheetGrip'), panel = $('panel');
  let drag = null;
  const start = e => {
    if (!isPhone()) return;
    drag = { y: e.clientY, h: panel.getBoundingClientRect().height, moved: false };
    panel.classList.add('dragging');
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = e => {
    if (!drag) return;
    const dy = drag.y - e.clientY;
    if (Math.abs(dy) > 4) drag.moved = true;
    const hs = sheetHeights();
    layoutSheet(Math.max(hs.peek * 0.8, Math.min(hs.full, drag.h + dy)));
  };
  const end = () => {
    if (!drag) return;
    panel.classList.remove('dragging');
    const hs = sheetHeights(), cur = panel.getBoundingClientRect().height;
    if (!drag.moved) setSheet(sheet === 'peek' ? 'half' : sheet === 'half' ? 'full' : 'peek');
    else setSheet(Object.entries(hs).sort((a, b) => Math.abs(a[1] - cur) - Math.abs(b[1] - cur))[0][0]);
    drag = null;
  };
  grip.addEventListener('pointerdown', start);
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSheet(sheet === 'full' ? 'peek' : sheet === 'half' ? 'full' : 'half'); } };
  new ResizeObserver(() => { if (!drag) layoutSheet(); }).observe($('missionCard'));
  window.addEventListener('resize', () => layoutSheet());

  // Drawing needs the map: drop the sheet to its peek height. A new step brings it back up.
  on('mode', mode => { if (mode && isPhone() && sheet !== 'peek') setSheet('peek'); });
  on('step', () => { if (isPhone() && sheet === 'peek' && !state.mode) setSheet('half'); });

  const hidden = pref('panelHidden', false);
  const setHidden = h => {
    document.body.classList.toggle('panel-hidden', h);
    $('btnPanel').setAttribute('aria-pressed', String(h));
    setPref('panelHidden', h);
    setTimeout(() => map.invalidateSize(), 300);
  };
  setHidden(hidden);
  $('btnPanel').onclick = () => setHidden(!document.body.classList.contains('panel-hidden'));
}

// ---------- Menu extras ----------

function setSun(onOff) {
  root.classList.toggle('sun', onOff);
  setPref('sun', onOff);
  $('btnSun').setAttribute('aria-checked', String(onOff));
  emit('render');
}

// ---------- Init ----------

export function initShell() {
  initHome();
  initSheet();
  $('btnMenuOpenKmz').onclick = () => $('fileInput').click();
  $('btnSun').onclick = () => setSun(!root.classList.contains('sun'));
  $('btnSun').setAttribute('aria-checked', String(root.classList.contains('sun')));
  on('render', renderCard);
  on('plan', () => setTimeout(renderCard, 0));
  renderCard();
  layoutSheet();
  if (location.hash.startsWith('#demo')) runDemo();
}
