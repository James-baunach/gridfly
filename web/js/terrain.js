// Ground elevation lookup and terrain-following heights.
// Two sources: Kentucky LiDAR (2 ft, see lidar-ky.js) where it covers the whole mission, otherwise
// Open-Meteo (Copernicus GLO-90, worldwide). One mission never mixes the two: heights are relative to the
// takeoff point, so a difference between the sources would show up as a height error.

import { haversine } from './geo.js';
import { latticeNodes } from './offline.js';
import * as ky from './lidar-ky.js';
import * as store from './store.js';

export const SOURCES = {
  ky: { name: ky.KY_NAME, short: 'Kentucky LiDAR (2 ft)', step: 10 },
  global: { name: 'Copernicus DEM via Open-Meteo (about 90 m)', short: 'worldwide data (about 90 m)', step: 40 },
};

const API = 'https://api.open-meteo.com/v1/elevation';
const BATCH = 100; // API limit per request
// The DEM is 30-90 m resolution, so sample a ~40 m lattice and interpolate between nodes
// instead of querying every waypoint (keeps big grids within the API's rate limits).
export const CELL = 0.0004;
const SAVE_HINT = 'Save the area for offline use while you have signal (Offline button), or turn "Follow the ground" off.';
const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
const cache = new Map();
const nodeKey = (i, j) => i + ',' + j;
const round1 = v => Math.round(v * 10) / 10;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchNodes(keys, onProgress) {
  for (let i = 0; i < keys.length; i += BATCH) {
    const chunk = keys.slice(i, i + BATCH).map(k => k.split(',').map(Number));
    const url = `${API}?latitude=${chunk.map(c => (c[0] * CELL).toFixed(6)).join(',')}&longitude=${chunk.map(c => (c[1] * CELL).toFixed(6)).join(',')}`;
    let res;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { res = await fetch(url); }
      catch {
        throw new Error(isOffline() ? `You are offline and the ground heights here were not saved. ${SAVE_HINT}`
          : `Could not reach the elevation service, and the ground heights here were not saved. ${SAVE_HINT}`);
      }
      if (res.status !== 429) break;
      await sleep(4000 * 2 ** attempt);
    }
    if (!res.ok) throw new Error(`Elevation service error ${res.status}${res.status === 429 ? ' (rate limited, try again in a minute)' : ''}`);
    const data = await res.json();
    if (!Array.isArray(data.elevation)) throw new Error(data.reason || 'Elevation service returned no data');
    const got = data.elevation.map((e, j) => [keys[i + j], e]);
    got.forEach(([k, e]) => cache.set(k, e));
    await store.setMany('elev', got); // kept for offline use
    onProgress?.(Math.min(keys.length, i + BATCH), keys.length);
    if (i + BATCH < keys.length) await sleep(250);
  }
}

// Moves nodes saved on this device into the memory cache and removes them from `need`.
async function loadStored(need) {
  if (!need.size) return;
  const keys = [...need];
  const vals = await store.getMany('elev', keys);
  vals.forEach((v, i) => { if (typeof v === 'number') { cache.set(keys[i], v); need.delete(keys[i]); } });
}

/**
 * Saves the ground heights for a whole area so plans there can follow the terrain offline.
 * Returns the number of lattice nodes covering the area, or throws if the area is too big.
 */
export async function prefetchArea(bounds, onProgress, maxNodes = 12000) {
  // In Kentucky, save the LiDAR tiles; the worldwide data is only needed if they don't cover the area.
  const corners = [{ lat: bounds.s, lon: bounds.w }, { lat: bounds.n, lon: bounds.e }];
  if (ky.inKentuckyBox(corners)) {
    const tiles = ky.tilesFor(bounds);
    if (tiles.length > 60) throw new Error(`The area is too large to save Kentucky LiDAR for (${tiles.length} tiles, limit 60). Save it in parts.`);
    try {
      await kyLoad(tiles, onProgress);
      if (tiles.every(t => kyTiles.get(ky.tileKey(t.i, t.j)))) return { source: 'ky', tiles: tiles.length };
    } catch { /* fall through to the worldwide data */ }
  }
  const keys = latticeNodes(bounds, CELL);
  if (keys.length > maxNodes) throw new Error(`The area is too large to save every ground height (${keys.length} points, limit ${maxNodes}).`);
  const need = new Set(keys.filter(k => !cache.has(k)));
  await loadStored(need);
  await fetchNodes([...need], onProgress);
  return { source: 'global', nodes: keys.length };
}

/** How many of the area's ground heights are saved on this device (0..1). */
export async function storedFraction(bounds) {
  if (ky.inKentuckyBox([{ lat: bounds.s, lon: bounds.w }, { lat: bounds.n, lon: bounds.e }])) {
    const tiles = ky.tilesFor(bounds);
    const vals = await store.getMany('elev', tiles.map(t => ky.tileKey(t.i, t.j)));
    if (vals.every(v => v && v !== 'none')) return 1;
  }
  const keys = latticeNodes(bounds, CELL);
  if (!keys.length || keys.length > 50000) return 0;
  const vals = await store.getMany('elev', keys);
  return vals.filter(v => typeof v === 'number').length / keys.length;
}

// ---------- Kentucky LiDAR tiles ----------

const kyTiles = new Map(); // tile key -> Uint16Array, or null where the tile has no data

async function kyTile({ i, j }) {
  const key = ky.tileKey(i, j);
  if (kyTiles.has(key)) return kyTiles.get(key);
  const saved = await store.get('elev', key);
  if (saved !== undefined) { kyTiles.set(key, saved === 'none' ? null : saved); return kyTiles.get(key); }
  let res;
  for (let attempt = 0; ; attempt++) {
    try { res = await fetch(ky.tileUrl(i, j)); }
    catch { throw new Error(isOffline() ? 'offline and not saved' : 'could not reach the Kentucky elevation service'); }
    if (res.ok || attempt >= 2 || (res.status !== 429 && res.status < 500)) break;
    await sleep(2000 * (attempt + 1));
  }
  if (!res.ok) throw new Error(`Kentucky elevation service error ${res.status}`);
  const data = ky.decodeTile(await res.arrayBuffer());
  kyTiles.set(key, data);
  await store.set('elev', key, data || 'none'); // kept for offline use
  return data;
}

async function kyLoad(tiles, onProgress) {
  let done = 0;
  const queue = [...tiles];
  const worker = async () => { while (queue.length) { await kyTile(queue.shift()); onProgress?.(++done, tiles.length); } };
  await Promise.all([worker(), worker(), worker()]);
}

/** Kentucky LiDAR heights for the points (null where there is no data). Throws if tiles cannot be loaded. */
export async function kyElevations(points, onProgress) {
  const seen = new Map();
  for (const p of points) { const t = ky.tileOf(p.lat, p.lon); seen.set(ky.tileKey(t.i, t.j), t); }
  await kyLoad([...seen.values()], onProgress);
  return points.map(p => { const t = ky.tileOf(p.lat, p.lon); return ky.sampleTile(kyTiles.get(ky.tileKey(t.i, t.j)), t.i, t.j, p.lat, p.lon); });
}

// ---------- Worldwide (Open-Meteo) ----------

export async function getElevations(points, onProgress) {
  const cells = points.map(p => {
    const fi = p.lat / CELL, fj = p.lon / CELL;
    const i = Math.floor(fi), j = Math.floor(fj);
    return { i, j, u: fi - i, v: fj - j };
  });
  const need = new Set();
  for (const c of cells) for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const k = nodeKey(c.i + di, c.j + dj);
    if (!cache.has(k)) need.add(k);
  }
  await loadStored(need);
  await fetchNodes([...need], onProgress);
  return cells.map(({ i, j, u, v }) => {
    const e = (di, dj) => cache.get(nodeKey(i + di, j + dj));
    return (1 - u) * ((1 - v) * e(0, 0) + v * e(0, 1)) + u * ((1 - v) * e(1, 0) + v * e(1, 1));
  });
}

/**
 * Set each waypoint's height (relative to the takeoff point, as DJI Fly expects) so the drone
 * stays `agl` metres above the ground beneath it.
 * With `densify`, extra waypoints (no photo) are inserted where the ground between two
 * waypoints rises more than `tolerance` metres into the planned clearance.
 */
export async function applyTerrain(waypoints, home, agl, { densify = false, tolerance = 5, sampleStep, onProgress } = {}) {
  const wps = waypoints.filter(w => !w.terrainPoint).map(w => ({ ...w }));
  const pts = [home, ...wps];
  let source = 'global', note = null, all = null;
  if (ky.inKentuckyBox(pts)) {
    try {
      const g = await kyElevations(pts, onProgress);
      if (g.every(v => v !== null)) { all = g; source = 'ky'; }
      else note = 'Part of this mission or the takeoff point is outside the Kentucky LiDAR data, so the coarser worldwide data was used for all of it.';
    } catch (e) {
      note = `Kentucky LiDAR not available (${e.message}), so the coarser worldwide data was used.`;
    }
  }
  if (!all) all = await getElevations(pts, onProgress);
  const [homeGround, ...grounds] = all;
  wps.forEach((w, i) => { w.ground = grounds[i]; w.height = round1(agl + grounds[i] - homeGround); });
  if (!densify || wps.length < 2) return { waypoints: wps, homeGround, inserted: 0, source, note };
  const step = sampleStep ?? SOURCES[source].step;

  const samples = [];
  for (let i = 0; i + 1 < wps.length; i++) {
    const a = wps[i], b = wps[i + 1];
    const n = Math.floor(haversine(a, b) / step);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      samples.push({ seg: i, t, lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
    }
  }
  const elev = source === 'ky' ? await kyElevations(samples, onProgress) : await getElevations(samples, onProgress);
  const worst = new Map();
  samples.forEach((s, j) => {
    if (elev[j] === null) return;
    const a = wps[s.seg], b = wps[s.seg + 1];
    const need = agl + elev[j] - homeGround;
    const excess = need - (a.height + (b.height - a.height) * s.t);
    if (excess > tolerance && excess > (worst.get(s.seg)?.excess ?? 0)) worst.set(s.seg, { excess, need, s, ground: elev[j] });
  });

  const out = [];
  wps.forEach((w, i) => {
    out.push(w);
    const x = worst.get(i);
    if (x) out.push({
      lat: x.s.lat, lon: x.s.lon, height: round1(x.need), ground: x.ground, speed: w.speed,
      photo: false, gimbalPitch: w.gimbalPitch, actions: null, terrainPoint: true,
    });
  });
  return { waypoints: out, homeGround, inserted: worst.size, source, note };
}
