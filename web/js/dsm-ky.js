// Kentucky first-return surface model (KyFromAbove DSM, 2 ft, Phase 2): the tops of trees and buildings.
// Used with the LiDAR ground model (lidar-ky.js) to warn when a planned route passes close to them.
// Same tiles, encoding and sampling as lidar-ky.js (Uint16 decimetres, 0 = no data), so tileOf/tilesFor/sampleTile
// are shared. The service stores heights in US survey feet; decodeTile converts to metres.
// No browser dependencies here, so the maths is testable in Node.

import { PX, tileBounds } from './lidar-ky.js';

export { tileOf, tilesFor, sampleTile } from './lidar-ky.js';

export const DSM_NAME = 'Kentucky LiDAR surface model (KyFromAbove first return, 2 ft)';
export const DSM_SERVICE = 'https://kyraster.ky.gov/arcgis/rest/services/ElevationServices/Ky_DSM_First_Return_2FT_Phase2/ImageServer/exportImage';
export const CLEAR_WARN = 15; // m: warn when the drone is closer than this above the surface
export const CLEAR_HIT = 5;   // m: "will hit" below this
const FT = 1200 / 3937;       // US survey foot in metres

export const tileKey = (i, j) => `kys:${i},${j}`;

export function tileUrl(i, j) {
  const b = tileBounds(i, j);
  const p = new URLSearchParams({
    bbox: [b.w, b.s, b.e, b.n].map(v => v.toFixed(6)).join(','), bboxSR: '4326', imageSR: '4326', size: `${PX},${PX}`,
    format: 'bsq', pixelType: 'F32', interpolation: 'RSP_BilinearInterpolation', f: 'image',
  });
  return `${DSM_SERVICE}?${p}`;
}

/** Raw answer (PX*PX float32 US survey feet, then a mask) -> Uint16Array of decimetres (0 = no data), or null if empty. */
export function decodeTile(buffer) {
  const n = PX * PX;
  if (buffer.byteLength < n * 4) throw new Error('The Kentucky surface service sent an incomplete tile.');
  const f = new Float32Array(buffer.slice(0, n * 4));
  const out = new Uint16Array(n);
  let any = false;
  for (let k = 0; k < n; k++) {
    const v = f[k] * FT;
    if (v > 1 && v < 6000) { out[k] = Math.round(v * 10); any = true; }
  }
  return any ? out : null;
}

/**
 * samples: [{ d, drone, ground, surface }] along the route (d = metres from the start, heights above sea level,
 * surface/ground null where unknown). Returns null if nothing could be checked, else
 * { tallest, minClear, minAt, level: 'ok' | 'low' | 'hit' }.
 * tallest = tallest thing (surface above ground) under the route; minClear = smallest drone height above the surface.
 */
export function analyzeClearance(samples) {
  let tallest = 0, minClear = Infinity, minAt = 0, n = 0;
  for (const s of samples) {
    if (s.surface === null || s.surface === undefined || s.drone === null || s.drone === undefined) continue;
    n++;
    if (s.ground !== null && s.ground !== undefined) tallest = Math.max(tallest, s.surface - s.ground);
    const c = s.drone - s.surface;
    if (c < minClear) { minClear = c; minAt = s.d; }
  }
  if (!n) return null;
  return { tallest, minClear, minAt, level: minClear < CLEAR_HIT ? 'hit' : minClear < CLEAR_WARN ? 'low' : 'ok' };
}

/** Plain-language warning for a clearance result (or null when nothing needs saying). */
export function clearanceMessage(c, fmt = v => `${Math.round(v)} m`) {
  if (!c || c.level === 'ok') return null;
  const tall = `The tallest thing under the route is about ${fmt(c.tallest)} high (trees or buildings)`;
  if (c.level === 'hit') {
    return `${tall}, and at the closest point the drone would be ${c.minClear < 0 ? `${fmt(-c.minClear)} below its top` : `only ${fmt(c.minClear)} above it`}. It will hit it. Raise the flight height or move the route.`;
  }
  return `${tall}. At the closest point the drone passes only ${fmt(c.minClear)} above it (less than ${fmt(CLEAR_WARN)}). Raise the flight height or check that spot.`;
}
