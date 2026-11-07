// Offline maths with no browser dependencies: map tile ranges for an area, download plans and size estimates.
// The service worker (sw.js) keeps its own copy of the tile URL patterns, because it cannot import modules everywhere.

export const TILE_LAYERS = {
  satellite: {
    name: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    avgBytes: 22000,
  },
  streets: {
    name: 'Streets',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    avgBytes: 12000,
  },
};

export const MAX_NATIVE_ZOOM = 19;
export const TILE_BUDGET = 6000;   // tiles saved per area by default (roughly 130 MB of satellite imagery)
export const TILE_HARD_CAP = 20000;
const M_PER_DEG = 111320;
const MAX_LAT = 85.05112878;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const lon2x = (lon, z) => clamp(Math.floor((lon + 180) / 360 * 2 ** z), 0, 2 ** z - 1);
export function lat2y(lat, z) {
  const r = clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI / 180;
  return clamp(Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z), 0, 2 ** z - 1);
}

export const tileUrl = (tpl, { z, x, y }) => tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);

/** Bounds {s, w, n, e} of a list of {lat, lon} points, or null. */
export function boundsOf(points) {
  const pts = (points || []).filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (!pts.length) return null;
  const lats = pts.map(p => p.lat), lons = pts.map(p => p.lon);
  return { s: Math.min(...lats), w: Math.min(...lons), n: Math.max(...lats), e: Math.max(...lons) };
}

/** Bounds grown by `m` metres on every side. */
export function bufferBounds(b, m) {
  const dLat = m / M_PER_DEG;
  const dLon = m / (M_PER_DEG * Math.max(0.01, Math.cos(((b.s + b.n) / 2) * Math.PI / 180)));
  return { s: clamp(b.s - dLat, -MAX_LAT, MAX_LAT), n: clamp(b.n + dLat, -MAX_LAT, MAX_LAT), w: clamp(b.w - dLon, -180, 180), e: clamp(b.e + dLon, -180, 180) };
}

export function tileRange(b, z) {
  return { z, x0: lon2x(b.w, z), x1: lon2x(b.e, z), y0: lat2y(b.n, z), y1: lat2y(b.s, z) };
}

const rangeCount = r => (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);

/** Tile ranges per zoom for a download plan: [{bounds, zMin, zMax}]. */
export function planRanges(parts) {
  const out = [];
  for (const p of parts) for (let z = p.zMin; z <= p.zMax; z++) out.push(tileRange(p.bounds, z));
  return out;
}

/** Number of distinct tiles in a plan (zoom levels in different parts may overlap). */
export function countTiles(parts) {
  const byZ = new Map();
  for (const r of planRanges(parts)) {
    const cur = byZ.get(r.z);
    // Parts are nested (detail inside context) so the union per zoom is the larger range.
    byZ.set(r.z, cur ? { z: r.z, x0: Math.min(cur.x0, r.x0), x1: Math.max(cur.x1, r.x1), y0: Math.min(cur.y0, r.y0), y1: Math.max(cur.y1, r.y1) } : r);
  }
  let n = 0;
  for (const r of byZ.values()) n += rangeCount(r);
  return n;
}

/** Every distinct tile {z, x, y} of a plan, lowest zoom first. */
export function* tilesOf(parts) {
  const seen = new Set();
  const ranges = planRanges(parts).sort((a, b) => a.z - b.z);
  for (const r of ranges) {
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) {
      const k = `${r.z}/${x}/${y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      yield { z: r.z, x, y };
    }
  }
}

/**
 * What to save for an area: a wide, coarse view for finding your way to the site, plus full detail
 * around the area itself, up to `maxZoom`.
 */
export function downloadPlan(bounds, maxZoom) {
  const detailFrom = Math.min(14, maxZoom);
  const parts = [{ bounds: bufferBounds(bounds, 5000), zMin: 8, zMax: Math.min(12, maxZoom) }];
  if (maxZoom >= 13) parts.push({ bounds: bufferBounds(bounds, 1500), zMin: 13, zMax: 13 });
  if (maxZoom >= 14) parts.push({ bounds: bufferBounds(bounds, 300), zMin: detailFrom, zMax: maxZoom });
  return parts;
}

/** The sharpest zoom whose download stays within `budget` tiles. */
export function chooseMaxZoom(bounds, budget = TILE_BUDGET) {
  for (let z = MAX_NATIVE_ZOOM; z > 12; z--) if (countTiles(downloadPlan(bounds, z)) <= budget) return z;
  return 12;
}

/** Ground size of one pixel at zoom z (metres), for describing detail in plain words. */
export const metresPerPixel = (lat, z) => 156543.03 * Math.cos(lat * Math.PI / 180) / 2 ** z;

/** True if tile t lies inside any range of the plan. */
export function planHasTile(parts, t) {
  return parts.some(p => {
    if (t.z < p.zMin || t.z > p.zMax) return false;
    const r = tileRange(p.bounds, t.z);
    return t.x >= r.x0 && t.x <= r.x1 && t.y >= r.y0 && t.y <= r.y1;
  });
}

/** Elevation lattice nodes (see terrain.js) covering the bounds. */
export function latticeNodes(b, cell) {
  const i0 = Math.floor(b.s / cell), i1 = Math.floor(b.n / cell) + 1;
  const j0 = Math.floor(b.w / cell), j1 = Math.floor(b.e / cell) + 1;
  const keys = [];
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) keys.push(i + ',' + j);
  return keys;
}

export function fmtBytes(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
