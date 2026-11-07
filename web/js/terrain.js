// Ground elevation lookup (Open-Meteo, Copernicus GLO-90 DEM) and terrain-following heights.

import { haversine } from './geo.js';
import { latticeNodes } from './offline.js';
import * as store from './store.js';

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
  const keys = latticeNodes(bounds, CELL);
  if (keys.length > maxNodes) throw new Error(`The area is too large to save every ground height (${keys.length} points, limit ${maxNodes}).`);
  const need = new Set(keys.filter(k => !cache.has(k)));
  await loadStored(need);
  await fetchNodes([...need], onProgress);
  return keys.length;
}

/** How many of the area's ground heights are saved on this device (0..1). */
export async function storedFraction(bounds) {
  const keys = latticeNodes(bounds, CELL);
  if (!keys.length || keys.length > 50000) return 0;
  const vals = await store.getMany('elev', keys);
  return vals.filter(v => typeof v === 'number').length / keys.length;
}

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
export async function applyTerrain(waypoints, home, agl, { densify = false, tolerance = 5, sampleStep = 40, onProgress } = {}) {
  const wps = waypoints.filter(w => !w.terrainPoint).map(w => ({ ...w }));
  const [homeGround, ...grounds] = await getElevations([home, ...wps], onProgress);
  wps.forEach((w, i) => { w.ground = grounds[i]; w.height = round1(agl + grounds[i] - homeGround); });
  if (!densify || wps.length < 2) return { waypoints: wps, homeGround, inserted: 0 };

  const samples = [];
  for (let i = 0; i + 1 < wps.length; i++) {
    const a = wps[i], b = wps[i + 1];
    const n = Math.floor(haversine(a, b) / sampleStep);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      samples.push({ seg: i, t, lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
    }
  }
  const elev = await getElevations(samples, onProgress);
  const worst = new Map();
  samples.forEach((s, j) => {
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
  return { waypoints: out, homeGround, inserted: worst.size };
}
