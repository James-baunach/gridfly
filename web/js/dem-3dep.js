// USGS 3DEP ground heights (bare earth, NAVD88 metres) from the National Map elevation image service.
// Same idea as lidar-ky.js: fetch fixed tiles, keep them on the device, sample locally.
// 3DEP is a mosaic: 1 m LiDAR-derived where it exists (all of Kentucky), 1/3 arc-second (~10 m) elsewhere,
// so the label says "about 5 m" (the tile sampling), not a guaranteed accuracy.
// No browser dependencies here, so the maths is testable in Node.

export const D3_NAME = 'USGS 3DEP (National Map elevation service)';
export const D3_SERVICE = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
export const TILE = 0.02;   // degrees: about 2.2 km north-south, 1.7 km east-west
export const PX = 400;      // pixels per tile side: about 5.6 m x 4.4 m per pixel
const OFFSET = 500;         // stored as Uint16 of (metres + 500) * 10; 0 = no data
const LO = -500, HI = 6000; // plausible heights (m)

export const tileKey = (i, j) => `d3:${i},${j}`;
export const tileOf = (lat, lon) => ({ i: Math.floor(lat / TILE), j: Math.floor(lon / TILE) });
export const tileBounds = (i, j) => ({ s: i * TILE, n: (i + 1) * TILE, w: j * TILE, e: (j + 1) * TILE });

/**
 * Where 3DEP is used. Kentucky only for now (the only place it has been checked against other sources).
 * Widen this one function (e.g. to the lower 48 states) to use it elsewhere; nothing else needs to change.
 * Outside the US the service returns 0 for no data, which decodeTile treats as missing.
 */
export const covers3dep = points => points.length > 0 && points.every(p => p.lat >= 36.49 && p.lat <= 39.16 && p.lon >= -89.58 && p.lon <= -81.95);

/** Tiles {i, j} covering the bounds {s, w, n, e}. */
export function tilesFor(b) {
  const a = tileOf(b.s, b.w), z = tileOf(b.n, b.e);
  const out = [];
  for (let i = a.i; i <= z.i; i++) for (let j = a.j; j <= z.j; j++) out.push({ i, j });
  return out;
}

export function tileUrl(i, j) {
  const b = tileBounds(i, j);
  const p = new URLSearchParams({
    bbox: [b.w, b.s, b.e, b.n].map(v => v.toFixed(6)).join(','), bboxSR: '4326', imageSR: '4326', size: `${PX},${PX}`,
    format: 'bsq', pixelType: 'F32', interpolation: 'RSP_BilinearInterpolation', f: 'image',
  });
  return `${D3_SERVICE}?${p}`;
}

/** Raw answer (PX*PX little-endian float32 metres, row 0 at the north edge, then a mask) -> Uint16Array, or null if no data at all. */
export function decodeTile(buffer) {
  const n = PX * PX;
  if (buffer.byteLength < n * 4) throw new Error('The USGS elevation service sent an incomplete tile.');
  const f = new Float32Array(buffer.slice(0, n * 4));
  const out = new Uint16Array(n);
  let any = false;
  for (let k = 0; k < n; k++) {
    const v = f[k];
    if (v !== 0 && v > LO && v < HI) { out[k] = Math.round((v + OFFSET) * 10); any = true; }
  }
  return any ? out : null;
}

/** Ground height (m) at lat/lon from tile (i, j), bilinear between pixel centres; null where there is no data. */
export function sampleTile(data, i, j, lat, lon) {
  if (!data) return null;
  const x = (lon - j * TILE) / TILE * PX - 0.5;
  const y = ((i + 1) * TILE - lat) / TILE * PX - 0.5;
  const cx = Math.min(PX - 1, Math.max(0, x)), cy = Math.min(PX - 1, Math.max(0, y));
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const x1 = Math.min(PX - 1, x0 + 1), y1 = Math.min(PX - 1, y0 + 1);
  const u = cx - x0, v = cy - y0;
  const a = data[y0 * PX + x0], b = data[y0 * PX + x1], c = data[y1 * PX + x0], d = data[y1 * PX + x1];
  if (!a || !b || !c || !d) return null;
  return ((1 - v) * ((1 - u) * a + u * b) + v * ((1 - u) * c + u * d)) / 10 - OFFSET;
}
