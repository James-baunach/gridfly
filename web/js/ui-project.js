/* global JSZip */
// Project persistence: autosave, My projects (every project kept on this device), project files, and the export menu.

import { projectToJson, projectFromJson, bytesToBase64, base64ToBytes, toGeoJSON, toKml, microSdPackage } from './exporters.js';
import { readFile } from './wpml.js';
import { $, state, on, emit, toast, pref, setPref, dropPref, debounce, download, esc } from './state.js';
import { settingsSnapshot, applySettings, computeMissions, buildMissionFiles, startOver } from './plan.js';
import { centroid, polygonAreaM2 } from './geo.js';
import { GOALS } from './presets.js';
import * as store from './store.js';

let b64Cache = { bytes: null, text: null };

const hasContent = () => !!(state.waypoints.length || state.polygon.length || state.center || state.line.length);

function projectObject(withKmz) {
  const o = {
    polygon: state.polygon, waypoints: state.waypoints, home: state.home, homeGround: state.homeGround, fileName: state.fileName,
    settings: { ...settingsSnapshot(), _ui: { easy: state.easy, step: state.step, unit: state.unit } },
    generated: {
      generated: state.generated, plan: state.plan, center: state.center, line: state.line, homeUser: state.homeUser, homeKey: state.homeKey,
      terrainStale: state.terrainStale, pristine: state.pristine, progress: state.progress, projectName: state.projectName,
    },
  };
  if (withKmz && state.sourceBytes) {
    if (b64Cache.bytes !== state.sourceBytes) b64Cache = { bytes: state.sourceBytes, text: bytesToBase64(state.sourceBytes) };
    o.sourceKmzBase64 = b64Cache.text;
  }
  return o;
}

// ---------- Autosave ----------

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function defaultName() {
  if (state.fileName) return state.fileName.replace(/\.(kmz|kml)$/i, '');
  const pts = state.polygon.length ? state.polygon : state.waypoints.length ? state.waypoints : state.line.length ? state.line : state.center ? [state.center] : [];
  if (!pts.length) return 'Untitled project';
  const c = centroid(pts);
  return `Site at ${c.lat.toFixed(3)}, ${c.lon.toFixed(3)}`;
}

function summary() {
  const ms = state.waypoints.length ? computeMissions() : [];
  return {
    goal: GOALS[state.goal]?.title || state.goal,
    waypoints: state.waypoints.length, missions: ms.length, flown: ms.filter(m => m.flown).length,
    areaM2: state.polygon.length >= 3 ? polygonAreaM2(state.polygon) : 0,
  };
}

let lastSaved = null;
const withoutTime = json => json.replace(/"savedAt":"[^"]*",/, '');

// Keeps the open project in localStorage (restored on the next visit) and in My projects (IndexedDB).
async function autosave() {
  if (!hasContent()) { dropPref('project'); return; }
  if (!state.projectId) state.projectId = newId();
  state.projectName ||= defaultName();
  let json;
  try {
    json = projectToJson(projectObject(true));
    if (!setPref('project', json)) setPref('project', projectToJson(projectObject(false))); // too large: drop the source KMZ
    setPref('projectId', state.projectId);
  } catch { /* storage unavailable */ }
  if (!json || withoutTime(json) === lastSaved) return;
  lastSaved = withoutTime(json);
  // Everything is captured before the first await, so the state can be replaced right after calling this.
  const rec = { id: state.projectId, name: state.projectName, modified: Date.now(), summary: summary(), json };
  const prev = await store.get('projects', rec.id);
  await store.set('projects', rec.id, { ...rec, created: prev?.created ?? rec.modified });
  if (!$('projects').hidden) renderProjects();
}

async function applyProject(p, { id = null, name = null } = {}) {
  applySettings(p.settings);
  const g = p.generated || {};
  Object.assign(state, {
    polygon: p.polygon, waypoints: p.waypoints, home: p.home, homeGround: p.homeGround, fileName: p.fileName,
    generated: !!g.generated, plan: g.plan ?? null, center: g.center ?? null, line: g.line ?? [], homeUser: !!g.homeUser, homeKey: g.homeKey ?? null,
    terrainStale: !!g.terrainStale, pristine: !!g.pristine, selected: -1, undo: [], redo: [], source: null, sourceBytes: null,
    progress: g.progress ?? null, projectId: id, projectName: name || g.projectName || null,
  });
  lastSaved = null;
  if (p.sourceKmzBase64) {
    try {
      const bytes = base64ToBytes(p.sourceKmzBase64);
      state.source = await readFile(new File([bytes], p.fileName || 'mission.kmz'));
      state.sourceBytes = bytes;
    } catch { /* source unreadable: continue without it */ }
  }
  const ui = p.settings?._ui;
  if (ui) emit('uiState', ui);
  emit('render');
  emit('plan', { restored: true });
  emit('fit', state.polygon.length ? state.polygon : state.waypoints.length ? state.waypoints : state.line.length ? state.line : state.center ? [state.center] : []);
}

export async function restoreLast() {
  const txt = pref('project', null);
  if (!txt) return false;
  try {
    const p = projectFromJson(txt);
    if (!p.polygon.length && !p.waypoints.length && !p.settings?.goal && !p.generated?.center && !(p.generated?.line || []).length) return false;
    await applyProject(p, { id: pref('projectId', null) });
    $('restoreName').textContent = state.projectName ? `“${state.projectName}”` : 'your last project';
    $('restoreNote').hidden = false;
    return true;
  } catch (e) {
    console.warn('Could not restore the last project', e);
    return false;
  }
}

// ---------- My projects ----------

/** Starts an empty project. The current one stays in My projects. */
export async function newProject({ save = true } = {}) {
  if (save) await autosave();
  startOver();
  lastSaved = null;
  dropPref('project');
  dropPref('projectId');
  $('restoreNote').hidden = true;
  if (!$('projects').hidden) renderProjects();
}

async function openSaved(id) {
  const rec = await store.get('projects', id);
  if (!rec) return toast('That project could not be found.');
  try {
    if (id !== state.projectId) await autosave();
    await applyProject(projectFromJson(rec.json), { id: rec.id, name: rec.name });
    $('restoreNote').hidden = true;
    toggleProjects(false);
    toast(`Opened “${rec.name}”.`);
  } catch (e) { toast('Could not open the project: ' + e.message, 7000); }
}

async function renameProject(id, name) {
  name = name.trim();
  if (!name) return;
  if (id === state.projectId) { state.projectName = name; lastSaved = null; await autosave(); }
  const rec = await store.get('projects', id);
  if (rec && rec.name !== name) await store.set('projects', id, { ...rec, name });
  renderProjects();
}

async function deleteProject(id) {
  const rec = await store.get('projects', id);
  if (!rec || !confirm(`Delete “${rec.name}” from this device? This cannot be undone. (Save a project file first if you want to keep a copy.)`)) return;
  await store.del('projects', id);
  if (id === state.projectId) await newProject({ save: false });
  renderProjects();
  toast('Project deleted.');
}

const fmtArea = m2 => m2 >= 1e6 ? `${(m2 / 1e6).toFixed(2)} km²` : m2 >= 1e4 ? `${(m2 / 1e4).toFixed(1)} ha` : `${Math.round(m2)} m²`;

async function renderProjects() {
  const list = (await store.all('projects')).sort((a, b) => b.modified - a.modified);
  const cur = $('projCurrent');
  if (document.activeElement !== cur) cur.value = state.projectName || '';
  cur.disabled = !state.projectId;
  cur.placeholder = state.projectId ? '' : 'Draw an area to start a project';
  const box = $('projList');
  if (!list.length) { box.innerHTML = '<p class="muted small">No projects yet. Everything you plan is kept here by itself.</p>'; return; }
  box.innerHTML = list.map(r => {
    const s = r.summary || {};
    const bits = [s.goal, s.areaM2 ? fmtArea(s.areaM2) : '', s.waypoints ? `${s.waypoints} waypoints` : '',
      s.missions ? `${s.missions} mission${s.missions > 1 ? 's' : ''}${s.flown ? ` (${s.flown} flown)` : ''}` : ''].filter(Boolean);
    const open = r.id === state.projectId;
    return `<div class="saved-area">
      <div class="name"><b>${esc(r.name)}</b>${open ? ' <span class="pill good">Open now</span>' : ''}<br>
        <span class="small muted">${esc(new Date(r.modified).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}${bits.length ? ' · ' + esc(bits.join(' · ')) : ''}</span></div>
      ${open ? '' : `<button data-open="${r.id}">Open</button>`}
      <button class="link" data-rename="${r.id}">Rename</button>
      <button class="link" data-delete="${r.id}">Delete</button>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openSaved(b.dataset.open));
  box.querySelectorAll('[data-delete]').forEach(b => b.onclick = () => deleteProject(b.dataset.delete));
  box.querySelectorAll('[data-rename]').forEach(b => b.onclick = () => {
    const r = list.find(x => x.id === b.dataset.rename);
    const name = prompt('New name for this project:', r.name);
    if (name) renameProject(r.id, name);
  });
}

export function toggleProjects(show = $('projects').hidden) {
  $('projects').hidden = !show;
  if (show) renderProjects();
}

// ---------- Project files ----------

function saveProjectFile() {
  const name = (state.projectName || state.fileName || 'gridfly').replace(/\.(kmz|kml)$/i, '').replace(/[\\/:*?"<>|]+/g, '-');
  download(new Blob([projectToJson(projectObject(true))], { type: 'application/json' }), `${name}.gridfly.json`);
}

export async function openProjectFile(file) {
  try {
    const p = projectFromJson(await file.text());
    await autosave(); // the current project stays in My projects
    await applyProject(p, { name: p.generated?.projectName || file.name.replace(/(\.gridfly)?\.json$/i, '') });
    $('restoreNote').hidden = true;
    toast('Project opened. It is also kept in My projects.');
  } catch (e) { toast('Could not open project: ' + e.message, 7000); }
}

// ---------- Export menu ----------

async function exportKmz() {
  const files = await buildMissionFiles();
  if (files.length === 1) return download(files[0].blob, files[0].name);
  const zip = new JSZip();
  files.forEach(f => zip.file(f.name, f.blob));
  download(await zip.generateAsync({ type: 'blob' }), 'gridfly-missions.zip');
}

const withNames = ms => ms.map((m, i) => ({ ...m, name: `Mission ${i + 1}` }));

const EXPORTS = {
  expKmz: exportKmz,
  expSd: async () => {
    const files = await buildMissionFiles();
    download(await microSdPackage(files.map(f => ({ blob: f.blob })), { baseName: (state.fileName || 'gridfly').replace(/\.kmz$/i, '') }), 'GridFly-microSD.zip');
  },
  expKml: () => download(new Blob([toKml({ polygon: state.polygon, missions: withNames(computeMissions()), home: state.home })], { type: 'application/vnd.google-earth.kml+xml' }), 'gridfly.kml'),
  expGeo: () => download(new Blob([JSON.stringify(toGeoJSON({ polygon: state.polygon, missions: computeMissions(), home: state.home }))], { type: 'application/geo+json' }), 'gridfly.geojson'),
};

function syncExportMenu() {
  const none = !state.waypoints.length;
  for (const id of Object.keys(EXPORTS)) {
    $(id).disabled = none;
    $(id).title = none ? 'Make a mission first' : '';
  }
}

export function initProject() {
  // Something is about to replace the open project (e.g. a DJI mission file was opened): keep it in My projects.
  on('projectSwitch', () => { autosave(); lastSaved = null; });
  const save = debounce(autosave, 800);
  on('render', () => { save(); syncExportMenu(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) autosave(); });
  window.addEventListener('pagehide', autosave);

  const fresh = () => newProject().then(() => { toggleProjects(false); toast('New project started. The previous one is kept in My projects.'); });
  $('btnStartOver').onclick = fresh;
  $('btnRestoreStart').onclick = fresh;
  $('btnRestoreClose').onclick = () => { $('restoreNote').hidden = true; };
  $('btnProjects').onclick = () => toggleProjects(true);
  $('btnProjectsClose').onclick = () => toggleProjects(false);
  $('btnProjectsNew').onclick = fresh;
  $('projects').addEventListener('click', e => { if (e.target.id === 'projects') toggleProjects(false); });
  $('projCurrent').onchange = () => { if (state.projectId) renameProject(state.projectId, $('projCurrent').value); };
  $('btnSaveProject').onclick = saveProjectFile;
  $('btnOpenProject').onclick = () => $('projectInput').click();
  $('projectInput').onchange = e => { if (e.target.files[0]) openProjectFile(e.target.files[0]); e.target.value = ''; };

  for (const [id, fn] of Object.entries(EXPORTS)) {
    $(id).onclick = async () => {
      try { await fn(); } catch (e) { toast('Export failed: ' + e.message, 6000); }
    };
  }
  // Close menus after a choice or a click elsewhere.
  document.addEventListener('click', e => {
    document.querySelectorAll('details.menu[open]').forEach(d => { if (!d.contains(e.target) || e.target.closest('button')) d.removeAttribute('open'); });
  });
  syncExportMenu();
}
