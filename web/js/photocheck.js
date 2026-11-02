// Post-flight photo check: EXIF/XMP parsing, blur scoring, ground coverage and gap detection.

import { makeProjection, centroid, convexHull } from './geo.js';

const RAD = Math.PI / 180;
const HEAD_BYTES = 131072;

// ---------- JPEG metadata ----------

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8 };

function readIfd(dv, tiff, offset, le) {
  const out = {};
  const n = dv.getUint16(tiff + offset, le);
  for (let i = 0; i < n; i++) {
    const e = tiff + offset + 2 + i * 12;
    if (e + 12 > dv.byteLength) break;
    const tag = dv.getUint16(e, le), type = dv.getUint16(e + 2, le), count = dv.getUint32(e + 4, le);
    const size = (TYPE_SIZE[type] || 0) * count;
    if (!size || size > 1024) continue;
    const at = size <= 4 ? e + 8 : tiff + dv.getUint32(e + 8, le);
    if (at + size > dv.byteLength) continue;
    let v;
    if (type === 2) {
      v = '';
      for (let k = 0; k < count; k++) { const c = dv.getUint8(at + k); if (c) v += String.fromCharCode(c); }
    } else {
      v = [];
      for (let k = 0; k < count; k++) {
        if (type === 1 || type === 7) v.push(dv.getUint8(at + k));
        else if (type === 3) v.push(dv.getUint16(at + k * 2, le));
        else if (type === 4) v.push(dv.getUint32(at + k * 4, le));
        else if (type === 9) v.push(dv.getInt32(at + k * 4, le));
        else if (type === 5) { const d = dv.getUint32(at + k * 8 + 4, le); v.push(d ? dv.getUint32(at + k * 8, le) / d : 0); }
        else if (type === 10) { const d = dv.getInt32(at + k * 8 + 4, le); v.push(d ? dv.getInt32(at + k * 8, le) / d : 0); }
      }
    }
    out[tag] = v;
  }
  return out;
}

const dms = (v, ref) => {
  if (!Array.isArray(v) || v.length < 3) return null;
  const d = v[0] + v[1] / 60 + v[2] / 3600;
  return ref === 'S' || ref === 'W' ? -d : d;
};

function parseExif(dv, tiff, meta) {
  const bo = dv.getUint16(tiff);
  const le = bo === 0x4949;
  if (!le && bo !== 0x4d4d) return;
  if (dv.getUint16(tiff + 2, le) !== 42) return;
  const ifd0 = readIfd(dv, tiff, dv.getUint32(tiff + 4, le), le);
  if (ifd0[0x8769]) {
    const ex = readIfd(dv, tiff, ifd0[0x8769][0], le);
    const dt = typeof ex[0x9003] === 'string' && ex[0x9003].match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
    if (dt) meta.time = new Date(Date.UTC(+dt[1], dt[2] - 1, +dt[3], +dt[4], +dt[5], +dt[6]));
    if (ex[0xa002]) meta.width = ex[0xa002][0];
    if (ex[0xa003]) meta.height = ex[0xa003][0];
    if (ex[0x920a]) meta.focal = ex[0x920a][0];
  }
  if (ifd0[0x8825]) {
    const g = readIfd(dv, tiff, ifd0[0x8825][0], le);
    const lat = dms(g[2], g[1]), lon = dms(g[4], g[3]);
    if (lat != null && lon != null) { meta.lat = lat; meta.lon = lon; }
    if (g[6]) meta.gpsAlt = g[6][0] * (g[5] && g[5][0] === 1 ? -1 : 1);
  }
}

function xmpNum(xml, name) {
  const m = xml.match(new RegExp(`drone-dji:${name}\\s*=\\s*["']([^"']*)["']`)) ||
    xml.match(new RegExp(`<drone-dji:${name}>([^<]*)<`));
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : null;
}

/** Parse EXIF + DJI XMP from the head of a JPEG. Missing values are null. */
export function readPhotoMeta(buf) {
  const meta = { lat: null, lon: null, absAlt: null, relAlt: null, gimbalPitch: null, yaw: null, time: null, width: null, height: null, focal: null };
  let gpsAlt = null, xmp = '';
  try {
    const dv = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer, buf.byteOffset || 0, buf.byteLength);
    if (dv.getUint16(0) !== 0xffd8) return meta;
    const ascii = (at, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(at + i)); return s; };
    let p = 2;
    while (p + 4 <= dv.byteLength && dv.getUint8(p) === 0xff) {
      const type = dv.getUint8(p + 1);
      if (type === 0xff) { p++; continue; }
      if (type === 0xda || type === 0xd9) break;
      if (type === 0x01 || (type >= 0xd0 && type <= 0xd7)) { p += 2; continue; }
      const len = dv.getUint16(p + 2);
      const body = p + 4, n = Math.min(len - 2, dv.byteLength - body);
      if (type === 0xe1 && n > 6) {
        if (ascii(body, 6) === 'Exif\0\0') {
          const tmp = { ...meta };
          try { parseExif(dv, body + 6, tmp); } catch { /* truncated EXIF: keep what we have */ }
          Object.assign(meta, tmp);
          gpsAlt = tmp.gpsAlt ?? null;
        } else if (ascii(body, 28) === 'http://ns.adobe.com/xap/1.0/') {
          xmp += ascii(body + 29, n - 29);
        }
      }
      p += 2 + len;
    }
  } catch { /* return what we parsed */ }
  delete meta.gpsAlt;
  if (xmp) {
    meta.relAlt = xmpNum(xmp, 'RelativeAltitude');
    meta.absAlt = xmpNum(xmp, 'AbsoluteAltitude');
    meta.gimbalPitch = xmpNum(xmp, 'GimbalPitchDegree');
    meta.yaw = xmpNum(xmp, 'FlightYawDegree') ?? xmpNum(xmp, 'GimbalYawDegree');
    if (meta.lat == null) {
      const la = xmpNum(xmp, 'GpsLatitude'), lo = xmpNum(xmp, 'GpsLongitude') ?? xmpNum(xmp, 'GpsLongtitude');
      if (la != null && lo != null) { meta.lat = la; meta.lon = lo; }
    }
  }
  if (meta.absAlt == null) meta.absAlt = gpsAlt;
  return meta;
}

// ---------- Blur ----------

/** Variance of the Laplacian of the grayscale image; higher = sharper. */
export function blurScore({ width, height, data }) {
  if (width < 3 || height < 3) return 0;
  const g = new Float32Array(width * height);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const l = g[i - 1] + g[i + 1] + g[i - width] + g[i + width] - 4 * g[i];
      sum += l; sum2 += l * l; n++;
    }
  }
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

export async function scorePhoto(file, maxSize = 640) {
  const bmp = await createImageBitmap(file, { resizeWidth: maxSize, resizeQuality: 'medium' });
  try {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    return blurScore(ctx.getImageData(0, 0, bmp.width, bmp.height));
  } finally {
    bmp.close?.();
  }
}

/** Indices of photos much softer than the typical one. Needs at least 5 photos. */
export function flagBlurry(scores) {
  if (scores.length < 5) return [];
  const v = scores.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length < 5) return [];
  const mid = v.length >> 1;
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  const out = [];
  scores.forEach((s, i) => { if (Number.isFinite(s) && s < 0.45 * median) out.push(i); });
  return out;
}

// ---------- Footprints and coverage ----------

/** Ground quad for a roughly nadir photo, or null if oblique / unusable. */
export function footprint(meta, cam, home) {
  const h = meta.relAlt;
  if (meta.lat == null || meta.lon == null || h == null || h <= 0) return null;
  if (meta.gimbalPitch != null && Math.abs(meta.gimbalPitch + 90) > 15) return null;
  const hw = cam.sensorW * h / cam.focal / 2; // across the drone's left-right axis
  const hh = cam.sensorH * h / cam.focal / 2; // along the nose
  const yaw = (meta.yaw ?? 0) * RAD;
  const fwd = [Math.sin(yaw), Math.cos(yaw)], right = [Math.cos(yaw), -Math.sin(yaw)];
  const proj = makeProjection(meta.lat, meta.lon);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) =>
    proj.toLL(right[0] * sx * hw + fwd[0] * sy * hh, right[1] * sx * hw + fwd[1] * sy * hh));
}

function inside(xy, x, y) {
  let c = false;
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) {
    const [xi, yi] = xy[i], [xj, yj] = xy[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// Convex polygon grown by `d` metres: hull of a ring of points around every vertex.
function bufferPolygon(poly, d) {
  const c = centroid(poly);
  const proj = makeProjection(c.lat, c.lon);
  const pts = [];
  for (const p of poly) {
    const [x, y] = proj.toXY(p.lat, p.lon);
    for (let k = 0; k < 12; k++) {
      const a = k * Math.PI / 6;
      pts.push(proj.toLL(x + d * Math.cos(a), y + d * Math.sin(a)));
    }
  }
  return convexHull(pts);
}

/**
 * Count footprint coverage over the survey polygon on a cellM grid.
 * Gaps are convex hulls of connected under-covered cells, grown by half a footprint.
 */
export function coverage(polygon, footprints, cellM = 4, minOverlapCount = 4) {
  const c = centroid(polygon);
  const proj = makeProjection(c.lat, c.lon);
  const poly = polygon.map(p => proj.toXY(p.lat, p.lon));
  const fps = footprints.map(f => f.map(p => proj.toXY(p.lat, p.lon)))
    .map(xy => ({ xy, minX: Math.min(...xy.map(p => p[0])), maxX: Math.max(...xy.map(p => p[0])), minY: Math.min(...xy.map(p => p[1])), maxY: Math.max(...xy.map(p => p[1])) }));
  const x0 = Math.min(...poly.map(p => p[0])), x1 = Math.max(...poly.map(p => p[0]));
  const y0 = Math.min(...poly.map(p => p[1])), y1 = Math.max(...poly.map(p => p[1]));
  const nx = Math.max(1, Math.ceil((x1 - x0) / cellM)), ny = Math.max(1, Math.ceil((y1 - y0) / cellM));
  const grid = new Array(nx * ny).fill(null); // cell index -> cell object
  const cells = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) * cellM, y = y0 + (j + 0.5) * cellM;
      if (!inside(poly, x, y)) continue;
      let count = 0;
      for (const f of fps) if (x >= f.minX && x <= f.maxX && y >= f.minY && y <= f.maxY && inside(f.xy, x, y)) count++;
      const cell = { ...proj.toLL(x, y), count, i, j };
      grid[j * nx + i] = cell;
      cells.push(cell);
    }
  }
  const total = cells.length || 1;
  const pctCovered = 100 * cells.filter(k => k.count >= 1).length / total;
  const pctGood = 100 * cells.filter(k => k.count >= minOverlapCount).length / total;

  let sizeM = 0;
  for (const f of fps) sizeM += Math.sqrt((f.maxX - f.minX) * (f.maxY - f.minY));
  const buffer = fps.length ? sizeM / fps.length / 2 : 20;

  const seen = new Set(), gaps = [];
  for (const start of cells) {
    if (start.count >= minOverlapCount || seen.has(start)) continue;
    const comp = [], stack = [start];
    seen.add(start);
    while (stack.length) {
      const k = stack.pop();
      comp.push(k);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const i = k.i + di, j = k.j + dj;
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        const n = grid[j * nx + i];
        if (n && n.count < minOverlapCount && !seen.has(n)) { seen.add(n); stack.push(n); }
      }
    }
    if (comp.length >= 3) gaps.push(bufferPolygon(comp.map(({ lat, lon }) => ({ lat, lon })), buffer));
  }
  return { cells: cells.map(({ lat, lon, count }) => ({ lat, lon, count })), pctCovered, pctGood, gaps };
}

// ---------- Orchestrator ----------

export async function analyzePhotos(files, { polygon, cam, home, minOverlapCount = 4, cellM = 4, onProgress } = {}) {
  const photos = [], fps = [];
  let oblique = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let meta;
    try { meta = readPhotoMeta(await file.slice(0, HEAD_BYTES).arrayBuffer()); } catch { meta = readPhotoMeta(new ArrayBuffer(0)); }
    let blur = null;
    try { blur = await scorePhoto(file); } catch { /* undecodable: skip blur check */ }
    const fp = footprint(meta, cam, home);
    if (fp) fps.push(fp);
    else if (meta.gimbalPitch != null && Math.abs(meta.gimbalPitch + 90) > 15) oblique++;
    photos.push({ name: file.name, meta, blur, blurry: false });
    onProgress?.(i + 1, files.length);
  }
  flagBlurry(photos.map(p => p.blur ?? NaN)).forEach(i => { photos[i].blurry = true; });
  const cov = coverage(polygon, fps, cellM, minOverlapCount);
  const count = photos.length;
  const withGps = photos.filter(p => p.meta.lat != null).length;
  const blurry = photos.filter(p => p.blurry).length;
  const pctGood = Math.round(cov.pctGood), pctCovered = Math.round(cov.pctCovered);
  const verdict = !count || cov.pctCovered < 90 || cov.pctGood < 50 ? 'poor'
    : cov.pctGood >= 85 && blurry <= count * 0.05 ? 'great' : 'ok';

  const advice = [];
  if (!count) advice.push('No photos found - drop the JPEG photos from the flight here.');
  else {
    if (withGps < count) advice.push(`${count - withGps} photos have no GPS position, so they can't be checked for coverage.`);
    if (!fps.length && withGps) advice.push('No photos could be placed on the map - their height or camera angle was not recorded.');
    if (blurry) advice.push(`${blurry} photos look blurry - fly slower or use stop-at-each-point.`);
    if (oblique) advice.push(`${oblique} photos were taken at a tilt and were left out of the coverage check.`);
    if (cov.gaps.length) advice.push(`${cov.gaps.length} gap${cov.gaps.length > 1 ? 's' : ''} found - use 'Re-fly gaps'.`);
    else if (fps.length && cov.pctGood < 85) advice.push('Some of the area has thin overlap - consider more overlap on the next flight.');
    if (verdict === 'great') advice.push(`${pctGood}% of the area has strong overlap - the map should come out well.`);
    else if (verdict === 'ok') advice.push(`${pctCovered}% of the area is covered, ${pctGood}% with strong overlap - the map should work but may have weak spots.`);
    else if (fps.length) advice.push(`Only ${pctGood}% of the area has strong overlap - the map is likely to have holes or distortion.`);
  }
  return { photos, coverage: cov, summary: { count, withGps, blurry, oblique, pctGood, verdict, advice } };
}
