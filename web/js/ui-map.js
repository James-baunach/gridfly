/* global L */
// The Leaflet map: layers, rendering of area / route / waypoints, and the drawing tools.

import { haversine, convexHull, centroid } from './geo.js';
import { circlePolygon, rectPolygon } from './presets.js';
import { $, state, on, emit, toast, ll, setLen, esc, areaList } from './state.js';
import { computeMissions, pushUndo, settings } from './plan.js';
import { TILE_LAYERS, MAX_NATIVE_ZOOM } from './offline.js';
import * as store from './store.js';

// Bigger handles for fingers on phones and tablets.
const COARSE = window.matchMedia?.('(pointer: coarse)').matches;

export const map = L.map('map', { doubleClickZoom: false, zoomControl: false }).setView([39.5, -98.35], 4);
L.control.zoom({ position: 'bottomright' }).addTo(map);
// crossOrigin lets the service worker keep the tiles for offline use (see sw.js).
const tileOpts = t => ({ maxZoom: 21, maxNativeZoom: MAX_NATIVE_ZOOM, attribution: t.attribution, crossOrigin: true });
const satellite = L.tileLayer(TILE_LAYERS.satellite.url, tileOpts(TILE_LAYERS.satellite)).addTo(map);
const streets = L.tileLayer(TILE_LAYERS.streets.url, tileOpts(TILE_LAYERS.streets));
L.control.layers({ Satellite: satellite, Streets: streets }).addTo(map);
L.control.scale({ imperial: true }).addTo(map);
state.mapCenter = () => { const c = map.getCenter(); return { lat: c.lat, lon: c.lng }; };

const renderer = L.canvas({ padding: 0.5, tolerance: 4 });
export const layers = {
  site: L.layerGroup().addTo(map),      // airspace, obstacles
  coverage: L.layerGroup().addTo(map),  // photo check overlay
  preview: L.layerGroup().addTo(map),   // controller mission outlines, drawing preview
  area: L.layerGroup().addTo(map),
  route: L.layerGroup().addTo(map),
  wp: L.layerGroup().addTo(map),
  top: L.layerGroup().addTo(map),
};

const icon = (cls, size, html = '', style = '') => L.divIcon({ className: '', html: `<div class="${cls}" style="width:${size}px;height:${size}px;${style}">${html}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
const pt = e => ({ lat: e.latlng.lat, lon: e.latlng.lng });

let pendingFit = null;
export function fitTo(points) {
  if (!points.length) return;
  map.invalidateSize();
  if (!map.getSize().x) { pendingFit = points; return; }
  const pad = overlayPadding();
  map.fitBounds(L.latLngBounds(points.map(ll)).pad(0.12), { maxZoom: 19, paddingTopLeft: pad.tl, paddingBottomRight: pad.br });
}

// The top bar and the panel float over the map: keep fitted shapes clear of them.
function overlayPadding() {
  const m = map.getContainer().getBoundingClientRect();
  const tb = document.getElementById('topbar')?.getBoundingClientRect();
  const p = document.getElementById('panel')?.getBoundingClientRect();
  const shown = p && p.width > 0 && !document.body.classList.contains('panel-hidden');
  const phone = window.matchMedia('(max-width: 699px)').matches;
  const top = tb ? Math.max(0, tb.bottom - m.top) + 8 : 0;
  const left = shown && !phone ? Math.max(0, p.right - m.left) + 8 : 0;
  const bottom = shown && phone ? Math.max(0, m.bottom - p.top) + 8 : 0;
  return { tl: [left, top], br: [0, bottom] };
}
// A map that was laid out after a fit was requested (hidden tab, slow CSS) gets fitted once it has a size.
new ResizeObserver(() => { map.invalidateSize(); if (pendingFit && map.getSize().x) { const p = pendingFit; pendingFit = null; fitTo(p); } }).observe(map.getContainer());
on('fit', fitTo);

// ---------- Tools ----------

const MODE_TEXT = {
  draw: 'Click the map to add area corners',
  rect: 'Drag a rectangle on the map, or click two opposite corners',
  circle: 'Drag from the centre outwards, or click the centre then the edge',
  line: 'Click points along the road, river or fence line',
  center: 'Click the building you want to orbit',
  add: 'Click the map to add waypoints',
  home: 'Click the map where you will stand and take off',
};
let anchor = null, drag = null, suppressClick = false;
// What the shape tools (polygon / rectangle / circle) are drawing: the main area, another area or a keep-out zone.
let drawFor = 'main';
const SHAPE_MODES = ['draw', 'rect', 'circle'];
const FOR_TEXT = { area: 'the new area', keepout: 'the keep-out zone' };
const modeText = mode => {
  if (drawFor === 'main' || !SHAPE_MODES.includes(mode)) return MODE_TEXT[mode];
  const t = FOR_TEXT[drawFor];
  return { draw: `Click the map to add corners of ${t}`, rect: `Drag a rectangle for ${t}, or click two opposite corners`, circle: `Drag from the centre outwards for ${t}, or click the centre then the edge` }[mode];
};

// Extra areas and keep-outs that were started but never got three corners.
function pruneShapes() {
  state.areas = state.areas.filter(a => a.length >= 3);
  state.keepouts = state.keepouts.filter(a => a.length >= 3);
}

function clearPreview() { layers.preview.clearLayers(); }

export function setMode(mode) {
  if (state.mode === 'draw') pruneShapes();
  state.mode = state.mode === mode ? null : mode;
  if (!SHAPE_MODES.includes(state.mode)) drawFor = 'main';
  syncShapePick();
  anchor = drag = null;
  clearPreview();
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === state.mode));
  const banner = $('modeBanner'), text = modeText(state.mode);
  banner.hidden = !text;
  if (text) {
    banner.innerHTML = `${esc(text)}<button id="btnModeDone">${state.mode === 'draw' || state.mode === 'line' ? 'Done' : 'Cancel'}</button>`;
    $('btnModeDone').onclick = () => { const m = state.mode; setMode(null); if (m === 'draw' || m === 'line') emit('plan', { geometry: true }); };
  }
  const shape = state.mode === 'rect' || state.mode === 'circle';
  shape ? map.dragging.disable() : map.dragging.enable();
  map.getContainer().style.cursor = state.mode ? 'crosshair' : '';
  renderArea();
  emit('mode', state.mode);
}

// Picks the goal that fits a freshly drawn shape.
function setGoalFor(tool) {
  const want = tool === 'line' ? 'corridor' : tool === 'center' ? 'orbit' : (state.goal === 'orbit' || state.goal === 'corridor') ? 'grid' : state.goal;
  if (want !== state.goal) { state.goal = want; emit('goal'); }
}

export function startTool(tool, target = 'main') {
  if (target === 'area' && state.polygon.length < 3) target = 'main'; // nothing to add to yet
  if (state.mode === tool && drawFor === target) return setMode(null);
  if (state.mode === tool) setMode(null); // same tool for another purpose: restart it
  drawFor = SHAPE_MODES.includes(tool) ? target : 'main';
  if (tool === 'draw') {
    setGoalFor('draw'); pushUndo();
    if (drawFor === 'area') state.areas.push([]);
    else if (drawFor === 'keepout') state.keepouts.push([]);
    else state.polygon = [];
  }
  else if (tool === 'line') { setGoalFor('line'); pushUndo(); state.line = []; }
  else if (tool === 'center') setGoalFor('center');
  else if (tool === 'rect' || tool === 'circle') { if (!(tool === 'circle' && state.goal === 'orbit')) setGoalFor(tool); }
  setMode(tool);
  emit('render');
}

function previewShape(a, b) {
  clearPreview();
  const r = haversine(a, b);
  const style = { color: '#ff9f1c', weight: 2, fillOpacity: 0.12, interactive: false };
  if (state.mode === 'circle') L.circle(ll(a), { ...style, radius: r }).addTo(layers.preview);
  else L.rectangle([ll(a), ll(b)], style).addTo(layers.preview);
}

function finishShape(a, b) {
  const r = haversine(a, b);
  clearPreview();
  if (r < 2) { anchor = null; return; }
  pushUndo();
  const poly = state.mode === 'rect' ? rectPolygon(a, b) : circlePolygon(a, r);
  if (drawFor === 'area') state.areas.push(poly);
  else if (drawFor === 'keepout') state.keepouts.push(poly);
  else if (state.mode === 'rect') state.polygon = poly;
  else if (state.goal === 'orbit') { state.center = a; setLen('orbitRadius', Math.min(200, Math.max(10, r))); }
  else state.polygon = poly;
  setMode(null);
  emit('render');
  emit('plan', { geometry: true });
}

// ---------- Area ----------

const editable = () => state.mode === 'draw' || state.mode === 'line' || !state.waypoints.length || state.generated;

// Corner handles for one shape. Drag to move; tap or click for a "Remove this corner" button (so touch screens
// need no right-click); right-click also removes. `shape` is the Leaflet layer that follows the drag.
function vertexMarkers(list, onChange, shape, { min = 3, cls = '' } = {}) {
  const popups = state.mode !== 'draw' && state.mode !== 'line';
  list.forEach((p, i) => {
    const m = L.marker(ll(p), { icon: L.divIcon({ className: '', html: `<div class="vertex-icon ${cls}" style="width:${COARSE ? 22 : 12}px;height:${COARSE ? 22 : 12}px"></div>`, iconSize: [COARSE ? 22 : 12, COARSE ? 22 : 12] }), draggable: true, zIndexOffset: 500 }).addTo(layers.area);
    m.on('dragstart', pushUndo);
    m.on('drag', e => { list[i] = { lat: e.latlng.lat, lon: e.latlng.lng }; shape?.setLatLngs?.(list.map(ll)); });
    m.on('dragend', () => { emit('render'); onChange(); });
    m.on('contextmenu', () => { pushUndo(); list.splice(i, 1); emit('render'); onChange(); });
    if (popups) {
      const box = document.createElement('div');
      if (list.length <= min) box.textContent = `A shape needs at least ${min} corners.`;
      else {
        const b = document.createElement('button');
        b.textContent = 'Remove this corner';
        b.onclick = () => { m.closePopup(); pushUndo(); list.splice(i, 1); emit('render'); onChange(); };
        box.append(b);
      }
      m.bindPopup(box, { closeButton: false });
    }
  });
}

// ---------- Removing whole shapes ----------

function removeShape(kind, i) {
  pushUndo();
  if (kind === 'keepout') state.keepouts.splice(i, 1);
  else if (i === 0) state.polygon = state.areas.length ? state.areas.shift() : [];
  else state.areas.splice(i - 1, 1);
  if (!areaList().length && state.generated && state.goal !== 'orbit' && state.goal !== 'corridor') {
    state.waypoints = []; state.plan = null; state.generated = false;
  }
  emit('render');
  emit('plan', { geometry: true });
}

function shapeTag(poly, text, cls, kind, i) {
  const c = centroid(poly);
  L.marker([c.lat, c.lon], {
    icon: L.divIcon({ className: '', html: `<div class="shape-tag ${cls}" title="Tap to remove">${esc(text)} ✕</div>`, iconSize: [0, 0] }),
    zIndexOffset: 700, title: `Remove ${text}`,
  }).on('click', () => removeShape(kind, i)).addTo(layers.area);
}

// The Polygon / Rectangle / Circle chooser shown after "Add another area" or "Add keep-out zone".
let pickFor = null;
function syncShapePick() {
  if (SHAPE_MODES.includes(state.mode)) pickFor = drawFor === 'main' ? null : drawFor;
  else if (state.mode) pickFor = null; // another tool took over; with no tool the chooser stays as it is
  const box = $('shapePick');
  if (!box) return;
  box.hidden = !pickFor;
  $('shapePickText').textContent = pickFor === 'keepout' ? 'Draw the keep-out zone as:' : 'Draw the new area as:';
  box.querySelectorAll('[data-add-shape]').forEach(b => b.classList.toggle('active', state.mode === b.dataset.addShape && drawFor === pickFor));
  $('btnAddArea')?.classList.toggle('active', pickFor === 'area');
  $('btnAddKeepout')?.classList.toggle('active', pickFor === 'keepout');
}

export function initShapePick() {
  const open = kind => { pickFor = pickFor === kind ? null : kind; if (!pickFor && drawFor !== 'main') setMode(null); syncShapePick(); };
  $('btnAddArea').onclick = () => open('area');
  $('btnAddKeepout').onclick = () => open('keepout');
  $('shapePick').querySelectorAll('[data-add-shape]').forEach(b => b.onclick = () => startTool(b.dataset.addShape, pickFor));
}

const KEEPOUT_STYLE = { color: '#ff3b30', weight: 2, dashArray: '7 6', fillColor: '#ff3b30', fillOpacity: 0.28, interactive: false };

export function renderArea() {
  layers.area.clearLayers();
  const style = { color: '#ff9f1c', weight: 2, fillOpacity: 0.08, interactive: false };
  const shapes = [state.polygon, ...state.areas].map(p => ({ poly: p, layer: p.length >= 2 ? L.polygon(p.map(ll), style).addTo(layers.area) : null }));
  const holes = state.keepouts.map(p => ({ poly: p, layer: p.length >= 2 ? L.polygon(p.map(ll), KEEPOUT_STYLE).addTo(layers.area) : null }));
  const lineLayer = state.line.length >= 2 ? L.polyline(state.line.map(ll), { ...style, color: '#4cc9f0', weight: 4 }).addTo(layers.area) : null;
  if (state.center) {
    const r = settings().orbitRadius;
    L.circle(ll(state.center), { ...style, radius: r, fillOpacity: 0.04 }).addTo(layers.area);
    if (editable()) {
      const m = L.marker(ll(state.center), { icon: icon('vertex-icon', COARSE ? 24 : 14, '', 'border-radius:50%'), draggable: true, zIndexOffset: 500, title: 'Drag to move the orbit centre' }).addTo(layers.area);
      m.on('dragstart', pushUndo);
      m.on('dragend', e => { const p = e.target.getLatLng(); state.center = { lat: p.lat, lon: p.lng }; emit('render'); emit('plan', { geometry: true }); });
    } else {
      L.circleMarker(ll(state.center), { ...style, radius: 4, fillOpacity: 1 }).addTo(layers.area);
    }
  }
  if (!editable()) return;
  const changed = () => emit('plan', { geometry: true });
  shapes.forEach(sh => vertexMarkers(sh.poly, changed, sh.layer));
  holes.forEach(sh => vertexMarkers(sh.poly, changed, sh.layer, { cls: 'keepout' }));
  vertexMarkers(state.line, changed, lineLayer, { min: 2 });
  for (const { poly } of [...shapes, ...holes]) {
    if (poly.length < 3) continue;
    poly.forEach((p, i) => {
      const q = poly[(i + 1) % poly.length];
      const mid = { lat: (p.lat + q.lat) / 2, lon: (p.lon + q.lon) / 2 };
      L.marker(ll(mid), { icon: icon('mid-icon', COARSE ? 18 : 10), zIndexOffset: 400, title: 'Click to add a corner here' })
        .on('click', () => { pushUndo(); poly.splice(i + 1, 0, mid); emit('render'); changed(); })
        .addTo(layers.area);
    });
  }
  // A label on every shape (when there is more than one) to remove it. Not while a tool is waiting for clicks.
  if (!state.mode || state.mode === 'add') {
    const many = shapes.filter(sh => sh.poly.length >= 3).length > 1;
    shapes.forEach((sh, i) => { if (many && sh.poly.length >= 3) shapeTag(sh.poly, `Area ${i + 1}`, '', 'area', i); });
    holes.forEach((sh, i) => { if (sh.poly.length >= 3) shapeTag(sh.poly, 'Keep-out', 'keepout', 'keepout', i); });
  }
}

// ---------- Waypoints ----------

export function select(i) {
  state.selected = i;
  renderWaypoints();
  emit('selection');
}

export function renderWaypoints() {
  layers.route.clearLayers();
  layers.wp.clearLayers();
  layers.top.clearLayers();
  const wps = state.waypoints;
  const missions = computeMissions();

  const launches = state.launches?.length ? state.launches : null;
  if (launches) {
    // Each mission starts with a dashed leg from its own launch point.
    for (const m of missions) if (m.launch && m.points.length) L.polyline([ll(m.launch), ll(m.points[0])], { color: '#12b76a', weight: 2, dashArray: '6 6', renderer, interactive: false }).addTo(layers.route);
  } else if (state.home && wps.length) {
    L.polyline([ll(state.home), ll(wps[0])], { color: '#12b76a', weight: 2, dashArray: '6 6', renderer, interactive: false }).addTo(layers.route);
  }
  missions.forEach((m, k) => {
    // Flown missions and the already-flown part of a resumed one are drawn faint.
    if (m.resumedFrom) L.polyline(wps.slice(m.fullStart, m.start + 1).map(ll), { color: m.color, weight: 3, opacity: 0.3, dashArray: '2 6', renderer, interactive: false }).addTo(layers.route);
    L.polyline(m.points.map(ll), { color: m.color, weight: 3, opacity: m.flown ? 0.3 : 0.95, renderer, interactive: false }).addTo(layers.route);
    if (k > 0 && missions[k - 1].zone === m.zone) L.polyline([ll(wps[m.start - 1]), ll(wps[m.start])], { color: '#ffffff', weight: 1.5, dashArray: '3 6', renderer, interactive: false }).addTo(layers.route);
  });

  const missionOf = i => missions.find(m => i >= m.fullStart && i <= m.end);
  const colorOf = i => missionOf(i)?.color || '#fff';
  const faint = i => { const m = missionOf(i); return m && (m.flown || i < m.start); };
  wps.forEach((w, i) => {
    L.circleMarker(ll(w), {
      renderer, radius: w.terrainPoint ? 3 : 4.5, weight: 1.5,
      color: w.terrainPoint ? '#ff4d6d' : '#111', fillColor: w.photo ? colorOf(i) : '#555', fillOpacity: faint(i) ? 0.3 : 1, opacity: faint(i) ? 0.4 : 1,
    }).on('click', e => { L.DomEvent.stopPropagation(e); select(i); }).addTo(layers.wp);
  });

  missions.forEach(m => {
    const s = wps[m.start], e = wps[m.end];
    L.marker(ll(s), { icon: icon('end-icon', 16, 'S', `background:${m.color};color:#000`), interactive: false, zIndexOffset: 600 }).addTo(layers.top);
    if (m.end > m.start) L.marker(ll(e), { icon: icon('end-icon', 16, 'E', 'background:#222'), interactive: false, zIndexOffset: 600 }).addTo(layers.top);
  });

  if (state.selected >= 0 && wps[state.selected]) {
    const w = wps[state.selected];
    const m = L.marker(ll(w), { icon: icon('sel-icon', COARSE ? 26 : 16, '', `background:${colorOf(state.selected)}`), draggable: true, zIndexOffset: 1000 }).addTo(layers.top);
    m.on('dragstart', pushUndo);
    m.on('dragend', e => {
      const p = e.target.getLatLng();
      Object.assign(w, { lat: p.lat, lon: p.lng });
      if (w.ground !== undefined) { delete w.ground; state.terrainStale = true; }
      state.generated = false;
      emit('render');
    });
  }

  if (state.userLoc) L.circleMarker(ll(state.userLoc), { radius: 6, color: '#fff', weight: 2, fillColor: '#1f6feb', fillOpacity: 1, interactive: false }).addTo(layers.top);

  if (launches) {
    launches.forEach((p, k) => {
      const ms = missions.filter(m => m.zone === k).map(m => m.index + 1);
      const title = `Launch point L${k + 1}: take off here for mission${ms.length > 1 ? 's' : ''} ${ms.join(', ')} (drag to a spot you can reach)`;
      const h = L.marker(ll(p), { icon: icon('home-icon', COARSE ? 30 : 24, `L${k + 1}`), draggable: true, zIndexOffset: 900, title }).addTo(layers.top);
      h.on('dragstart', pushUndo);
      h.on('dragend', e => {
        const q = e.target.getLatLng();
        state.launches[k] = { lat: q.lat, lon: q.lng, user: true, ground: null };
        if (wps.some(w => w.ground !== undefined)) state.terrainStale = true;
        emit('render');
        emit('plan', { home: true });
      });
    });
  } else if (state.home) {
    const h = L.marker(ll(state.home), { icon: icon('home-icon', COARSE ? 30 : 22, 'H'), draggable: true, zIndexOffset: 900, title: 'Where you take off (drag to move)' }).addTo(layers.top);
    h.on('dragstart', pushUndo);
    h.on('dragend', e => {
      const p = e.target.getLatLng();
      state.home = { lat: p.lat, lon: p.lng };
      state.homeUser = true;
      if (state.homeGround !== null) { state.homeGround = null; state.terrainStale = true; }
      emit('render');
      emit('plan', { home: true });
    });
  }
}

// ---------- Search and location ----------

export async function searchPlace(q) {
  q = q.trim();
  if (!q) return;
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) return map.setView([+m[1], +m[2]], 17);
  // Saved offline areas can be found by name (any part of it when there is no signal).
  const lq = q.toLowerCase();
  const saved = (await store.all('areas')).find(a => a.name.toLowerCase() === lq || (!navigator.onLine && a.name.toLowerCase().includes(lq)));
  if (saved) return map.fitBounds([[saved.bounds.s, saved.bounds.w], [saved.bounds.n, saved.bounds.e]], { maxZoom: 18 });
  if (!navigator.onLine) return toast('No signal, so place search is not available. Type coordinates (lat, lon), the name of a saved area, or use "Use my location" (GPS works offline).', 7000);
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
    const [hit] = await r.json();
    if (!hit) return toast('Place not found');
    if (hit.boundingbox) map.fitBounds([[+hit.boundingbox[0], +hit.boundingbox[2]], [+hit.boundingbox[1], +hit.boundingbox[3]]], { maxZoom: 18 });
    else map.setView([+hit.lat, +hit.lon], 17);
  } catch (err) { toast('Search failed: ' + err.message); }
}

export function locateMe() {
  if (!navigator.geolocation) return toast('Your browser cannot share its location.');
  toast('Finding your location…');
  navigator.geolocation.getCurrentPosition(pos => {
    state.userLoc = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    map.setView(ll(state.userLoc), 18);
    emit('render');
  }, err => toast('Could not get your location: ' + err.message + '. You can type a place name instead.', 6000), { enableHighAccuracy: true, timeout: 15000 });
}

export function hullOfWaypoints() {
  if (state.waypoints.length < 3) return toast('Need at least 3 waypoints.');
  pushUndo();
  state.polygon = convexHull(state.waypoints);
  emit('render');
  emit('plan', { geometry: true });
}

// ---------- Map events ----------

export function initMapEvents() {
  map.on('mousedown', e => {
    if ((state.mode === 'rect' || state.mode === 'circle') && !anchor) drag = { start: pt(e), px: e.containerPoint };
  });
  map.on('mousemove', e => {
    if (drag) previewShape(drag.start, pt(e));
    else if (anchor) previewShape(anchor, pt(e));
  });
  map.on('mouseup', e => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (e.containerPoint.distanceTo(d.px) > 8) {
      finishShape(d.start, pt(e));
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 60);
    }
  });

  map.on('click', e => {
    if (suppressClick) return;
    const p = pt(e);
    const mode = state.mode;
    if (mode === 'draw') {
      pushUndo(); (drawFor === 'area' ? state.areas.at(-1) : drawFor === 'keepout' ? state.keepouts.at(-1) : state.polygon).push(p); emit('render'); emit('plan', { geometry: true });
    } else if (mode === 'line') {
      pushUndo(); state.line.push(p); emit('render'); emit('plan', { geometry: true });
    } else if (mode === 'center') {
      pushUndo(); state.center = p; setMode(null); emit('render'); emit('plan', { geometry: true });
    } else if (mode === 'rect' || mode === 'circle') {
      if (!anchor) { anchor = p; previewShape(p, p); } else finishShape(anchor, p);
    } else if (mode === 'add') {
      const s = settings();
      const at = state.selected >= 0 ? state.selected + 1 : state.waypoints.length;
      const prev = state.waypoints[at - 1];
      pushUndo();
      state.waypoints.splice(at, 0, { ...p, height: prev?.height ?? s.alt, speed: prev?.speed ?? s.speed, photo: true, gimbalPitch: s.gimbal, actions: null });
      if (!state.home) state.home = { ...p };
      state.generated = false;
      state.selected = at;
      emit('render');
    } else if (mode === 'home') {
      pushUndo();
      state.home = p;
      state.homeUser = true;
      state.homeGround = null;
      if (state.waypoints.some(w => w.ground !== undefined)) state.terrainStale = true;
      setMode(null);
      emit('render');
      emit('plan', { home: true });
    } else if (state.selected >= 0) {
      select(-1);
    }
  });
}
