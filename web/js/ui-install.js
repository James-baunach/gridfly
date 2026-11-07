/* global L */
// Step 6: get the mission onto the drone (controller-specific), plus the pre-flight checklist.

import { readFile, buildKmz } from './wpml.js';
import { gridMetrics } from './grid.js';
import { microSdPackage, microSdReadme } from './exporters.js';
import { buildChecklist, checklistHtml, checklistText } from './checklist.js';
import * as helper from './installer.js';
import { CONTROLLERS, HELPER_CONTROLLERS } from './presets.js';
import { $, state, on, emit, toast, esc, fmtTime, download } from './state.js';
import { computeMissions, settings, exportOpts, buildMissionFiles, photoEstimate, setFlown, setResume } from './plan.js';
import { layers, fitTo } from './ui-map.js';

const FINISH = { goHome: 'return to home', noAction: 'hover', autoLand: 'land', gotoFirstWaypoint: 'go to the first point' };
let results = [];      // install result lines (kept across re-renders)
let backups = null;
let experimental = false;
let busy = false;
let resumeOpen = null;  // mission index whose "where did it stop?" form is open

export function checklistCtx() {
  const s = settings();
  const missions = computeMissions();
  const m = gridMetrics(s.cam, s.alt, s.front, s.side);
  return {
    missions, home: state.home || state.waypoints[0] || null, homeGround: state.homeGround, droneKey: s.droneKey, controller: s.controller,
    captureMode: state.plan?.captureMode || 'waypoint', interval: state.plan?.interval ?? null, alt: s.alt, gsd: state.plan?.gsd ?? m.gsd,
    photoCount: photoEstimate(missions), finishAction: FINISH[s.finish] || s.finish,
  };
}

// Things that should stop you from flying yet.
export function blockers() {
  const out = [];
  const s = settings();
  const c = buildChecklist(checklistCtx());
  for (const sec of c.sections) for (const i of sec.items) if (i.level === 'stop') out.push(i.text);
  if (state.waypoints.length) {
    if (state.terrainStale) out.push('Points or the takeoff spot moved since the ground heights were worked out. Re-apply heights (or change a setting to re-plan).');
    else if (s.terrain && state.plan?.goal !== 'orbit' && state.waypoints.every(w => w.ground === undefined)) out.push('Terrain following is on but ground heights have not been worked out yet.');
  }
  for (const a of state.site.airspaceBlock || []) {
    out.push(`Airspace: the ceiling here is ${a.ceiling} ft, below your flight height. Lower the height or get authorisation.`);
    break;
  }
  return { list: out, checklist: c };
}

const slotsOf = () => state.controllers.flatMap((c, ci) => c.missions.map(m => ({ ...m, ci, key: `${ci}|${m.id}`, label: `${c.device}: ${m.id.slice(0, 8)} · ${m.modified ? new Date(m.modified).toLocaleString() : '?'}` })));

function steps(lines) {
  return `<ol class="small">${lines.map(l => `<li>${l}</li>`).join('')}</ol>`;
}

function readmeSteps(missions) {
  const text = microSdReadme(missions.map((m, i) => ({ name: `${i + 1}` }))).split('\r\n');
  const items = [];
  for (const l of text) {
    if (/^\d+\.\s/.test(l)) items.push(l.replace(/^\d+\.\s/, ''));
    else if (/^\s+\S/.test(l) && items.length) items[items.length - 1] += ' ' + l.trim();
  }
  return steps(items.map(esc));
}

function missionRows(missions, withSelect) {
  const slots = slotsOf();
  return missions.map(m => {
    const opts = `<option value="">Don't install</option>` +
      slots.map(s => `<option value="${s.key}" ${state.targets[m.index] === s.key ? 'selected' : ''}>${esc(s.label)}</option>`).join('') +
      (experimental ? state.controllers.map((c, ci) => `<option value="new|${ci}" ${state.targets[m.index] === `new|${ci}` ? 'selected' : ''}>New mission slot on ${esc(c.device)} (experimental)</option>`).join('') : '');
    const status = m.flown ? ' <span class="pill good">Flown</span>'
      : m.resumedFrom ? ` <span class="pill ok">Rest from point ${m.resumedFrom + 1}</span>` : '';
    return `<div class="mission-row${m.flown ? ' flown' : ''}">
      <span class="swatch" style="background:${m.color}"></span>
      <span class="name">Mission ${m.index + 1}${status}<br><span class="muted small">${m.resumedFrom ? `points ${m.resumedFrom + 1}–${m.fullCount} of ${m.fullCount}` : `${m.points.length} points`} · ${fmtTime(m.time)}</span></span>
      ${withSelect && state.controllers.length ? `<select data-target="${m.index}" aria-label="Where to install mission ${m.index + 1}">${opts}</select>` : ''}
      <button data-dl="${m.index}" title="Download this mission as a KMZ file">KMZ</button>
      <div class="mission-progress">
        <label class="check small"><input type="checkbox" data-flown="${m.index}" ${m.flown ? 'checked' : ''}> Flown</label>
        ${m.flown ? '' : m.resumedFrom
          ? `<button class="link" data-unresume="${m.index}">Fly the whole mission again</button>`
          : `<button class="link" data-resume="${m.index}" title="The flight was cut short: make a mission of the part that is left">Stopped early? Resume…</button>`}
      </div>
      ${resumeOpen === m.index && !m.flown ? resumeForm(m) : ''}
    </div>`;
  }).join('');
}

function resumeForm(m) {
  const sel = state.selected - m.fullStart;
  const guess = sel >= 0 && sel < m.fullCount ? sel + 1 : '';
  return `<div class="card resume-form">
    <label>Last waypoint it reached (the number DJI Fly showed, 1–${m.fullCount})
      <input type="number" id="resumeAt" min="2" max="${m.fullCount}" step="1" value="${guess}" placeholder="or tap the waypoint on the map"></label>
    <p class="small muted">The new mission starts at that waypoint, so its photo is taken again for overlap. Take off from the same spot (the H): heights are measured from there.</p>
    <div class="row"><button class="primary" id="btnResumeGo">Make a mission of the rest</button><button id="btnResumeCancel">Cancel</button></div>
  </div>`;
}

function progressHtml(missions) {
  const flown = missions.filter(m => m.flown).length;
  if (!flown && !missions.some(m => m.resumedFrom)) return '';
  const left = missions.filter(m => !m.flown);
  return `<p class="small progress-line"><b>${flown} of ${missions.length} mission${missions.length > 1 ? 's' : ''} flown.</b> ` +
    (left.length ? `Next: mission ${left[0].index + 1}${left[0].resumedFrom ? ` (the rest, from waypoint ${left[0].resumedFrom + 1})` : ''}.`
      : 'All done. Check the photos in step 7 before you leave the site.') + '</p>';
}

function timerNotice() {
  const p = state.plan;
  return p?.captureMode === 'timer'
    ? `<div class="notice"><b>Before starting each mission, set DJI Fly to Timed Shot every ${p.interval} s and start it when the mission starts.</b> The mission only flies the lines; the camera timer takes the photos.</div>` : '';
}

function helperBlock(missions) {
  const h = state.helper;
  if (!h.installer) {
    return `<div class="card"><p class="small"><b>The GridFly helper is not running</b>, so GridFly can't copy missions to your controller by itself. ${h.helper ? 'It is running, but direct install only works on Windows.' : 'Start <b>GridFly.exe</b> (or double-click <code>start.bat</code>) and use the address it opens, or'} download the files and copy them over by hand:</p>
      ${steps([
        'In DJI Fly, make a throwaway waypoint mission (two points) and save it. Make one for each mission below.',
        'Connect the controller (or phone) to your computer with USB. On a phone choose <i>File transfer</i>.',
        'Copy each KMZ to <code>Android/data/dji.go.v5/files/waypoint/&lt;ID&gt;/</code> and rename it to <code>&lt;ID&gt;.kmz</code>, replacing the placeholder.',
        'Reopen DJI Fly and check each mission before flying.'])}</div>${progressHtml(missions)}${missionRows(missions, false)}`;
  }
  const hasCtl = state.controllers.length > 0;
  return `<div class="card"><p class="small"><b>Helper running.</b> In DJI Fly, save ${missions.length} placeholder waypoint mission${missions.length > 1 ? 's' : ''} (two points each), close DJI Fly, connect the controller${settings().controller === 'rcn-android' ? ' (the phone, in <i>File transfer</i> mode)' : ''} to this computer by USB, then scan.</p>
    <div class="row"><button id="btnScan" class="${hasCtl ? '' : 'primary'}">Scan for controller</button></div>
    <div id="controllerList">${controllersHtml()}</div></div>
    ${progressHtml(missions)}${missionRows(missions, true)}
    ${h.experimentalCreate ? `<label class="check" title="Untested: asks the helper to make new mission folders on the controller. DJI Fly may not show them."><input id="expCreate" type="checkbox" ${experimental ? 'checked' : ''}> Experimental: create new mission slots (no placeholder needed). Untested, may not work.</label>` : ''}
    <div class="row"><button id="btnInstall" class="primary" ${canInstall(missions) ? '' : 'disabled'}>Install to controller</button>
      <span class="small muted">${canInstall(missions) ? 'The original files are backed up first.' : hasCtl ? 'Pick a placeholder for at least one mission.' : 'Scan for your controller first.'}</span></div>
    <div id="installResults">${results.map(r => `<div class="card small">${r}</div>`).join('')}</div>
    <details><summary>Backups &amp; restore</summary><div id="backupBox">${backupsHtml()}</div></details>`;
}

function controllersHtml() {
  if (!state.controllers.length) return state.scanned ? '<p class="small">No DJI Fly waypoint folder found. Check the controller is on and connected (a phone must be in <i>File transfer</i> mode), that DJI Fly is closed, and that you have saved at least one waypoint mission in DJI Fly.</p>' : '';
  return state.controllers.map((c, ci) => `<div class="controller"><b>${esc(c.device)}</b> <span class="muted">${esc(c.storage)}</span>
    <table>${c.missions.map(m => `<tr><td><code>${m.id.slice(0, 8)}…</code></td><td>${m.modified ? new Date(m.modified).toLocaleString() : ''}</td>
      <td><button class="link" data-show="${ci}|${m.id}" title="Download this mission from the controller and outline it on the map">Show on map</button></td></tr>`).join('') || '<tr><td>No saved missions</td></tr>'}</table></div>`).join('') +
    `<button class="link" id="btnClearOutline">Clear outlines</button>`;
}

function backupsHtml() {
  if (!state.helper.installer) return '';
  if (!backups) return '<button id="btnBackups">Show backups</button>';
  if (!backups.length) return '<p class="small muted">No backups yet. One is made every time you install.</p>';
  const slots = slotsOf();
  return `<table class="small">${backups.slice(0, 12).map((b, i) => `<tr><td>${esc(new Date(b.created).toLocaleString())}</td><td><code>${esc(String(b.mission).slice(0, 8))}</code></td>
    <td>${slots.length ? `<select data-bslot="${i}">${slots.map(s => `<option value="${s.key}" ${s.id === b.mission ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select> <button data-restore="${i}">Restore</button>` : '<span class="muted">scan first</span>'}</td></tr>`).join('')}</table>`;
}

const canInstall = missions => !busy && Object.entries(state.targets).some(([k, v]) => v && +k < missions.length);

function deployHtml(missions) {
  const c = settings().controller;
  if (!missions.length) return '<p class="muted">Plan your mission first (steps 2 to 4). Then the instructions for your controller appear here.</p>';
  const head = `<p class="small muted">Your controller: <b>${esc(CONTROLLERS[c] || c)}</b>. You can change it in step 1.</p>${timerNotice()}`;
  if (HELPER_CONTROLLERS.includes(c)) return head + helperBlock(missions);
  if (c === 'rc') {
    return head + `<div class="card"><p class="small">The standard DJI RC can't be reached over USB from a computer, so GridFly packs the files for a <b>microSD card</b>.</p>
      <div class="row"><button id="btnSd" class="primary">Download microSD package</button></div>${readmeSteps(missions)}</div>${progressHtml(missions)}${missionRows(missions, false)}`;
  }
  return head + `<div class="card"><p class="small">With an iPhone, copy the files over with the <b>Files</b> app. The exact folder names can differ between DJI Fly versions; if you don't see these, look inside the DJI Fly folder for the one holding your saved waypoint missions.</p>
    <div class="row"><button id="btnKmzAll" class="primary">Download KMZ${missions.length > 1 ? ' files' : ''}</button></div>
    ${steps([
      'In DJI Fly, save a throwaway waypoint mission (two points) for each mission below.',
      'Download the KMZ file(s) on the iPhone (they land in Files, Downloads), or send them over with AirDrop.',
      'Open the <b>Files</b> app, then <b>On My iPhone</b>, then <b>DJI Fly</b>, and open its <i>wayline</i> / <i>waypoint</i> folder. Open the folder of your throwaway mission.',
      'Replace the KMZ inside with yours and give it exactly the old file name.',
      'Fully close DJI Fly (swipe it away) and reopen it. Open the mission and check it before flying.'])}</div>${progressHtml(missions)}${missionRows(missions, false)}`;
}

function render() {
  const missions = computeMissions();
  const { list, checklist } = blockers();
  const ready = missions.length > 0 && list.length === 0 && checklist.ready;
  $('readyBanner').innerHTML = !missions.length ? ''
    : ready ? '<div class="ready ok"><b>Ready to fly</b><span>Your mission is planned and nothing is blocking. Work through the checklist at the site.</span></div>'
      : `<div class="ready no"><b>Not ready yet</b><ul>${list.map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>`;
  $('deployBody').innerHTML = deployHtml(missions);
  $('checklistBox').innerHTML = missions.length ? checklistHtml(checklist) : '';
  $('checklistBtns').hidden = !missions.length;
  wire(missions);
}

function wire(missions) {
  const body = $('deployBody');
  const on1 = (id, fn) => { const e = $(id); if (e) e.onclick = fn; };
  const files = () => buildMissionFiles(state.source);
  body.querySelectorAll('[data-dl]').forEach(b => b.onclick = async () => {
    const f = (await files())[+b.dataset.dl];
    download(f.blob, f.name);
  });
  body.querySelectorAll('[data-flown]').forEach(c => c.onchange = () => {
    const k = +c.dataset.flown;
    if (resumeOpen === k) resumeOpen = null;
    setFlown(k, c.checked);
    if (c.checked) delete state.targets[k];
  });
  body.querySelectorAll('[data-resume]').forEach(b => b.onclick = () => { resumeOpen = +b.dataset.resume; render(); $('resumeAt')?.focus(); });
  body.querySelectorAll('[data-unresume]').forEach(b => b.onclick = () => setResume(+b.dataset.unresume, 0));
  on1('btnResumeCancel', () => { resumeOpen = null; render(); });
  on1('btnResumeGo', () => {
    const m = missions[resumeOpen];
    const n = Math.round(+$('resumeAt').value);
    if (!m || !(n >= 2 && n <= m.fullCount)) return toast(`Enter a waypoint number from 2 to ${m?.fullCount}. (At 1 nothing was flown yet: fly the whole mission again.)`, 6000);
    resumeOpen = null;
    setResume(m.index, n - 1);
    toast(`Mission ${m.index + 1} now starts at waypoint ${n}. Install or download it again before flying.`, 6000);
  });
  body.querySelectorAll('[data-target]').forEach(sel => sel.onchange = () => { state.targets[sel.dataset.target] = sel.value; render(); });
  on1('btnScan', scan);
  on1('btnInstall', install);
  on1('btnBackups', loadBackups);
  on1('btnClearOutline', () => layers.preview.clearLayers());
  on1('btnSd', async () => {
    const fs = await files();
    download(await microSdPackage(fs.map(f => ({ blob: f.blob })), { baseName: (state.fileName || 'gridfly').replace(/\.kmz$/i, '') }), 'GridFly-microSD.zip');
  });
  on1('btnKmzAll', async () => { for (const f of await files()) { download(f.blob, f.name); await new Promise(r => setTimeout(r, 500)); } });
  body.querySelectorAll('[data-show]').forEach(b => b.onclick = () => showOnMap(b.dataset.show));
  body.querySelectorAll('[data-restore]').forEach(b => b.onclick = () => restore(+b.dataset.restore));
  if ($('expCreate')) $('expCreate').onchange = e => { experimental = e.target.checked; render(); };
}

// ---------- Helper actions ----------

async function scan() {
  const btn = $('btnScan');
  btn.disabled = true;
  $('controllerList').innerHTML = '<p class="muted small">Scanning USB devices… (this can take a few seconds)</p>';
  try {
    state.controllers = await helper.listControllers();
    state.scanned = true;
    state.targets = {};
    const slots = slotsOf().sort((a, b) => (Date.parse(b.modified) || 0) - (Date.parse(a.modified) || 0));
    computeMissions().filter(m => !m.flown).forEach((m, i) => { if (slots[i]) state.targets[m.index] = slots[i].key; });
    render();
  } catch (e) {
    $('controllerList').innerHTML = `<p class="small">Scan failed: ${esc(e.message)}</p>`;
    btn.disabled = false;
  }
}

async function showOnMap(key) {
  const [ci, id] = key.split('|');
  try {
    toast('Copying mission from the controller…');
    const res = await readFile(await helper.fetchMission(state.controllers[+ci], id));
    if (res.kind !== 'mission' || !res.waypoints.length) return toast('That mission has no points yet.');
    layers.preview.clearLayers();
    const pts = res.waypoints.map(w => [w.lat, w.lon]);
    L.polyline(pts, { color: '#f72585', weight: 3, dashArray: '6 6' }).addTo(layers.preview);
    pts.forEach(p => L.circleMarker(p, { radius: 4, color: '#f72585', fillOpacity: 1 }).addTo(layers.preview));
    fitTo(res.waypoints);
    toast(`Outlined ${res.waypoints.length} points of ${id.slice(0, 8)} on the map (pink).`);
  } catch (e) { toast('Could not read mission: ' + e.message, 6000); }
}

async function install() {
  const missions = computeMissions();
  const jobs = Object.entries(state.targets).filter(([k, v]) => v && +k < missions.length);
  const used = jobs.map(([, v]) => v).filter(v => !v.startsWith('new|'));
  if (new Set(used).size !== used.length) return toast('Each mission needs its own placeholder.');
  const news = jobs.filter(([, v]) => v.startsWith('new|')).length;
  if (!confirm(`Install ${jobs.length} mission${jobs.length > 1 ? 's' : ''} on the controller?\n${used.length ? 'Placeholders are backed up on this computer first.' : ''}${news ? '\nNew mission slots are EXPERIMENTAL and untested.' : ''}`)) return;
  busy = true;
  render();
  const lines = [];
  for (const [k, v] of jobs) {
    const m = missions[+k];
    const [a, b] = v.split('|');
    try {
      toast(`Installing mission ${m.index + 1}…`, 20000);
      if (a === 'new') {
        const target = state.controllers[+b], tpl = target.missions[0];
        if (!tpl) throw new Error('needs at least one saved mission on the controller to copy from');
        const source = state.source || await readFile(await helper.fetchMission(target, tpl.id));
        const r = await helper.createMission(target, tpl.id, await buildKmz(m.points, exportOpts(m), source));
        lines.push(`Mission ${m.index + 1}: created new slot ${esc(String(r.id).slice(0, 8))}. ${r.verified ? '✓ verified' : '⚠ not verified'} (experimental: check DJI Fly lists it).${r.warning ? ' ' + esc(r.warning) : ''}`);
      } else {
        const target = state.controllers[+a];
        const source = state.source || await readFile(await helper.fetchMission(target, b));
        const r = await helper.installMission(target, b, await buildKmz(m.points, exportOpts(m), source));
        lines.push(`Mission ${m.index + 1} → ${esc(b.slice(0, 8))}: installed. ${r.verified ? '✓ verified (read back and matched)' : '⚠ could not verify'}${r.warning ? ' ' + esc(r.warning) : ''}${r.backup ? ` Backup: ${esc(r.backup)}` : ''}`);
      }
    } catch (e) {
      lines.push(`Mission ${m.index + 1}: FAILED. ${esc(e.message)}`);
    }
  }
  results = [...lines, 'Reopen DJI Fly and check each mission before flying.'].map(l => l);
  busy = false;
  toast('Install finished.', 3000);
  render();
}

async function loadBackups() {
  try { backups = await helper.listBackups(); } catch (e) { return toast('Could not list backups: ' + e.message); }
  render();
  document.querySelector('#deployBody details')?.setAttribute('open', '');
}

async function restore(i) {
  const b = backups[i];
  const key = document.querySelector(`[data-bslot="${i}"]`).value;
  const [ci, id] = key.split('|');
  if (!confirm(`Put the backup from ${new Date(b.created).toLocaleString()} back onto ${id.slice(0, 8)}? The file there now is backed up first.`)) return;
  try {
    const r = await helper.restoreBackup(state.controllers[+ci], id, b.folder);
    results = [`Restored backup onto ${esc(id.slice(0, 8))}. ${r.verified ? '✓ verified' : '⚠ could not verify'}${r.warning ? ' ' + esc(r.warning) : ''}`];
  } catch (e) { results = [`Restore FAILED. ${esc(e.message)}`]; }
  render();
}

// ---------- Checklist buttons ----------

function printChecklist() {
  const html = checklistHtml(buildChecklist(checklistCtx()));
  const w = window.open('', '_blank');
  if (!w) return toast('Your browser blocked the print window. Allow pop-ups for this page and try again.', 6000);
  w.document.write(`<!doctype html><meta charset="utf-8"><title>GridFly pre-flight checklist</title><body style="margin:1.5em">${html}</body>`);
  w.document.close();
  w.focus();
  w.print();
}

async function copyChecklist() {
  const text = checklistText(buildChecklist(checklistCtx()));
  try { await navigator.clipboard.writeText(text); toast('Checklist copied.'); } catch {
    const t = document.createElement('textarea');
    t.value = text; document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); toast('Checklist copied.'); } catch { toast('Could not copy. Use Print instead.'); }
    t.remove();
  }
}

export async function initInstall() {
  state.helper = await helper.status();
  $('btnPrintCl').onclick = printChecklist;
  $('btnCopyCl').onclick = copyChecklist;
  on('render', () => { if (!busy) renderSoon(); });
  // Tapping a waypoint on the map fills in the "where did it stop?" form.
  on('selection', () => {
    const m = resumeOpen !== null && computeMissions()[resumeOpen];
    const i = state.selected - (m ? m.fullStart : 0);
    if (m && $('resumeAt') && i >= 0 && i < m.fullCount) $('resumeAt').value = i + 1;
  });
  on('site', renderSoon);
  render();
}

let t;
function renderSoon() { clearTimeout(t); t = setTimeout(render, 120); }
