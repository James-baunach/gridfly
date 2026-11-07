// Kentucky LiDAR ground heights (KyFromAbove 2 ft bare-earth DEM, Phase 2, statewide).
// The state's image service returns raw 32-bit heights in metres for any box, so GridFly fetches the
// area in fixed tiles of TILE degrees, keeps them on the device, and samples them locally.
// No browser dependencies here, so the maths is testable in Node.

export const KY_NAME = 'Kentucky LiDAR (KyFromAbove, 2 ft)';
export const KY_SERVICE = 'https://kyraster.ky.gov/arcgis/rest/services/ElevationServices/Ky_DEM_KYAPED_2FT_Phase2_ZMeters_WGS84WM/ImageServer/exportImage';
// Generous box around the state; real coverage is decided by the data itself (outside it the service returns 0).
export const KY_BOX = { s: 36.49, n: 39.16, w: -89.58, e: -81.95 };
export const TILE = 0.02;   // degrees: about 2.2 km north-south, 1.7 km east-west
export const PX = 800;      // pixels per tile side: about 2.8 m x 2.2 m per pixel
const MIN_VALID = 1;        // NoData comes back as 0 m; Kentucky's lowest ground is about 78 m

export const tileKey = (i, j) => `ky:${i},${j}`;
export const tileOf = (lat, lon) => ({ i: Math.floor(lat / TILE), j: Math.floor(lon / TILE) });
export const tileBounds = (i, j) => ({ s: i * TILE, n: (i + 1) * TILE, w: j * TILE, e: (j + 1) * TILE });

export const inKentuckyBox = points => points.length > 0 && points.every(p => p.lat >= KY_BOX.s && p.lat <= KY_BOX.n && p.lon >= KY_BOX.w && p.lon <= KY_BOX.e);

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
  return `${KY_SERVICE}?${p}`;
}

/**
 * Raw service answer (PX*PX little-endian float32 metres, row 0 at the north edge, then a validity mask)
 * -> Uint16Array of decimetres (0 = no data), half the size to keep on the device. Null if the tile has no data at all.
 */
export function decodeTile(buffer) {
  const n = PX * PX;
  if (buffer.byteLength < n * 4) throw new Error('The Kentucky elevation service sent an incomplete tile.');
  const f = new Float32Array(buffer.slice(0, n * 4));
  const out = new Uint16Array(n);
  let any = false;
  for (let k = 0; k < n; k++) {
    const v = f[k];
    if (v > MIN_VALID && v < 6000) { out[k] = Math.round(v * 10); any = true; }
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
  return ((1 - v) * ((1 - u) * a + u * b) + v * ((1 - u) * c + u * d)) / 10;
}
