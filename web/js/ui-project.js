/* global JSZip */
// Project persistence (autosave / restore / project files) and the export menu.

import { projectToJson, projectFromJson, bytesToBase64, base64ToBytes, toGeoJSON, toKml, microSdPackage } from './exporters.js';
import { readFile } from './wpml.js';
import { $, state, on, emit, toast, pref, setPref, dropPref, debounce, download } from './state.js';
import { settingsSnapshot, applySettings, computeMissions, buildMissionFiles, startOver } from './plan.js';

let b64Cache = { bytes: null, text: null };

const hasContent = () => !!(state.waypoints.length || state.polygon.length || state.center || state.line.length);

function projectObject(withKmz) {
  const o = {
    polygon: state.polygon, waypoints: state.waypoints, home: state.home, homeGround: state.homeGround, fileName: state.fileName,
    settings: { ...settingsSnapshot(), _ui: { easy: state.easy, step: state.step, unit: state.unit } },
    generated: {
      generated: state.generated, plan: state.plan, center: state.center, line: state.line, homeUser: state.homeUser, homeKey: state.homeKey,
      terrainStale: state.terrainStale, pristine: state.pristine,
    },
  };
  if (withKmz && state.sourceBytes) {
    if (b64Cache.bytes !== state.sourceBytes) b64Cache = { bytes: state.sourceBytes, text: bytesToBase64(state.sourceBytes) };
    o.sourceKmzBase64 = b64Cache.text;
  }
  return o;
}

function autosave() {
  if (!hasContent()) { dropPref('project'); return; }
  try {
    if (setPref('project', projectToJson(projectObject(true)))) return;
    setPref('project', projectToJson(projectObject(false))); // too large: drop the source KMZ
  } catch { /* storage unavailable */ }
}

async function applyProject(p) {
  applySettings(p.settings);
  const g = p.generated || {};
  Object.assign(state, {
    polygon: p.polygon, waypoints: p.waypoints, home: p.home, homeGround: p.homeGround, fileName: p.fileName,
    generated: !!g.generated, plan: g.plan ?? null, center: g.center ?? null, line: g.line ?? [], homeUser: !!g.homeUser, homeKey: g.homeKey ?? null,
    terrainStale: !!g.terrainStale, pristine: !!g.pristine, selected: -1, undo: [], redo: [], source: null, sourceBytes: null,
  });
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
    await applyProject(p);
    $('restoreNote').hidden = false;
    return true;
  } catch (e) {
    console.warn('Could not restore the last project', e);
    return false;
  }
}

function resetAll() {
  if (hasContent() && !confirm('Start over? This clears your area and mission. (Save a project file first if you want to keep it.)')) return;
  startOver();
  dropPref('project');
  $('restoreNote').hidden = true;
}

// ---------- Project files ----------

function saveProjectFile() {
  const name = (state.fileName || 'gridfly').replace(/\.(kmz|kml)$/i, '');
  download(new Blob([projectToJson(projectObject(true))], { type: 'application/json' }), `${name}.gridfly.json`);
}

export async function openProjectFile(file) {
  try {
    const p = projectFromJson(await file.text());
    if (hasContent() && !confirm('Open this project and replace what you have now?')) return;
    await applyProject(p);
    toast('Project opened.');
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
  const save = debounce(autosave, 800);
  on('render', () => { save(); syncExportMenu(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) autosave(); });
  window.addEventListener('pagehide', autosave);

  $('btnStartOver').onclick = resetAll;
  $('btnRestoreStart').onclick = resetAll;
  $('btnRestoreClose').onclick = () => { $('restoreNote').hidden = true; };
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
