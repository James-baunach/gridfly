/* global L */
// Step 7: check the photos after the flight, show coverage on the map and re-fly the gaps.

import { analyzePhotos } from './photocheck.js';
import { planGrid } from './patterns.js';
import { convexHull, polygonAreaM2, haversine, centroid } from './geo.js';
import { coverageCellSize } from './presets.js';
import { $, state, emit, toast, esc } from './state.js';
import { settings, pushUndo, currentAngle, applyHeights } from './plan.js';
import { layers, map, fitTo } from './ui-map.js';

let last = null, running = false;
const canvas = L.canvas({ padding: 0.3 });
const COLORS = [[0, '#e5484d'], [1, '#f5a524'], [2, '#f2d94e'], [3, '#a3d96c'], [4, '#2fb36b']];
const colorFor = n => COLORS.reduce((c, [min, col]) => n >= min ? col : c, COLORS[0][1]);

function surveyPolygon() {
  if (state.polygon.length >= 3) return state.polygon;
  if (state.waypoints.length >= 3) return convexHull(state.waypoints);
  return null;
}

export async function runPhotoCheck(fileList) {
  if (running) return toast('Already checking photos.');
  const files = [...fileList].filter(f => /\.jpe?g$/i.test(f.name));
  if (!files.length) return toast('No JPEG photos found in that selection.');
  const polygon = surveyPolygon();
  if (!polygon) return toast('Plan or draw the survey area first, so the photos can be compared with it.', 5000);
  running = true;
  const bar = $('photoBar');
  bar.hidden = false; bar.max = files.length; bar.value = 0;
  $('photoResult').innerHTML = `<p class="muted small">Reading ${files.length} photos… keep this tab open.</p>`;
  layers.coverage.clearLayers();
  try {
    const cellM = coverageCellSize(polygonAreaM2(polygon));
    last = { cellM, polygon, res: await analyzePhotos(files, { polygon, cam: settings().cam, home: state.home, cellM, onProgress: n => { bar.value = n; } }) };
    drawCoverage();
    fitTo(polygon);
  } catch (e) {
    last = null;
    $('photoResult').innerHTML = `<p class="small">The photo check failed: ${esc(e.message)}</p>`;
  } finally {
    running = false;
    bar.hidden = true;
  }
  renderResult();
}

function drawCoverage() {
  layers.coverage.clearLayers();
  if (!last) return;
  const { cellM, res } = last;
  for (const c of res.coverage.cells) {
    const dLat = cellM / 2 / 111320, dLon = dLat / Math.cos(c.lat * Math.PI / 180);
    L.rectangle([[c.lat - dLat, c.lon - dLon], [c.lat + dLat, c.lon + dLon]], { renderer: canvas, stroke: false, fillColor: colorFor(c.count), fillOpacity: 0.5, interactive: false }).addTo(layers.coverage);
  }
  for (const g of res.coverage.gaps) L.polygon(g.map(p => [p.lat, p.lon]), { renderer: canvas, color: '#e5484d', weight: 2, fill: false, dashArray: '6 4', interactive: false }).addTo(layers.coverage);
}

function renderResult() {
  const box = $('photoResult');
  if (!last) return;
  const { res } = last, sm = res.summary;
  const blurry = res.photos.filter(p => p.blurry).map(p => p.name);
  const label = { great: 'Looks great', ok: 'Probably fine', poor: 'Needs attention' }[sm.verdict];
  box.innerHTML = `<div class="ready ${sm.verdict === 'poor' ? 'no' : sm.verdict === 'ok' ? 'mid' : 'ok'}"><b>${label}</b><span>${sm.count} photos · ${sm.pctGood}% of the area has strong overlap</span></div>
    <ul class="small tight">${sm.advice.map(a => `<li>${esc(a)}</li>`).join('')}</ul>
    <div class="legend small">${COLORS.map(([n, c]) => `<span><i style="background:${c}"></i>${n === 4 ? '4+' : n} photo${n === 1 ? '' : 's'}</span>`).join('')}</div>
    ${blurry.length ? `<details><summary>${blurry.length} blurry photo${blurry.length > 1 ? 's' : ''}</summary><p class="small">${blurry.slice(0, 40).map(esc).join(', ')}${blurry.length > 40 ? ', …' : ''}</p></details>` : ''}
    <div class="row">${res.coverage.gaps.length ? `<button id="btnRefly" class="primary" title="Make a new mission that flies only over the gaps">Re-fly gaps (${res.coverage.gaps.length})</button><button id="btnReflyAdd" title="Add the gap passes to the end of your current mission">Add gaps to mission</button>` : ''}
      <button id="btnHideCov">Hide overlay</button></div>
    <p class="small">Next: process the photos into a map or 3D model with <a href="https://www.opendronemap.org/webodm/" target="_blank" rel="noopener">WebODM</a> (free, open source). Put the photos from all missions in one project.</p>`;
  const b = id => $(id);
  if (b('btnRefly')) b('btnRefly').onclick = () => reflyGaps(false);
  if (b('btnReflyAdd')) b('btnReflyAdd').onclick = () => reflyGaps(true);
  b('btnHideCov').onclick = () => { last = null; layers.coverage.clearLayers(); box.innerHTML = '<p class="muted small">Overlay hidden.</p>'; };
}

async function reflyGaps(append) {
  if (!last?.res.coverage.gaps.length) return;
  const s = settings();
  const timer = state.plan?.captureMode === 'timer';
  let from = state.home, wps = [];
  const todo = last.res.coverage.gaps.filter(g => g.length >= 3);
  while (todo.length) {
    todo.sort((a, b) => haversine(centroid(a), from) - haversine(centroid(b), from));
    const gap = todo.shift();
    const r = planGrid(gap, { cam: s.cam, alt: s.alt, front: s.front, side: s.side, angle: currentAngle(), overshoot: s.overshoot, home: from, speed: state.plan?.speed ?? s.speed, gimbal: s.gimbal, captureMode: timer ? 'timer' : 'waypoint' });
    wps = wps.concat(r.waypoints);
    if (wps.length) from = wps.at(-1);
  }
  if (!wps.length) return toast('The gaps are too small to plan a flight over.');
  const msg = append
    ? `Add ${wps.length} waypoints covering the gaps to the end of your current mission?`
    : `Replace your current mission with a new one of ${wps.length} waypoints that covers only the gaps? (You can undo.)`;
  if (!confirm(msg)) return;
  pushUndo();
  state.waypoints = append ? state.waypoints.filter(w => !w.terrainPoint).concat(wps) : wps;
  state.generated = false;
  state.plan = state.plan || { goal: 'grid', captureMode: timer ? 'timer' : 'waypoint', interval: null, speed: s.speed, gsd: null };
  state.terrainStale = false;
  emit('render');
  if (s.terrain) await applyHeights(false);
  toast(`${append ? 'Added' : 'Built'} a gap mission with ${wps.length} waypoints. Install it from step 6.`, 6000);
  emit('goStep', 6);
}

export function initPhotoCheck() {
  $('photoDir').onchange = e => { runPhotoCheck(e.target.files); e.target.value = ''; };
  $('photoFiles').onchange = e => { runPhotoCheck(e.target.files); e.target.value = ''; };
  const z = $('photoDrop');
  ['dragenter', 'dragover'].forEach(t => z.addEventListener(t, e => { e.preventDefault(); z.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => z.addEventListener(t, () => z.classList.remove('over')));
}
