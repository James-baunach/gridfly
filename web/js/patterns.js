// Mission patterns built on the survey grid: buffered grids, timed-shot grids, oblique/orbit/corridor passes.

import { makeProjection, centroid } from './geo.js';
import { gridMetrics, generateGrid } from './grid.js';

const RAD = Math.PI / 180;

// Timed Shot intervals (s) offered by DJI Fly.
export const TIMER_INTERVALS = [2, 3, 5, 7, 10, 15, 20, 30, 60];

// ---------- Offsetting ----------

// Offset vector at a vertex joining edges with left normals n1, n2; the miter length is clamped.
function miter(n1, n2, d, limit = 3) {
  const k = 1 + n1[0] * n2[0] + n1[1] * n2[1];
  if (k < 1e-9) return [n1[0] * d, n1[1] * d];
  let vx = (n1[0] + n2[0]) / k, vy = (n1[1] + n2[1]) / k;
  const mag = Math.hypot(vx, vy);
  if (mag > limit) { vx *= limit / mag; vy *= limit / mag; }
  return [vx * d, vy * d];
}

function dedupe(xy, closed) {
  const out = xy.filter((p, i) => i === 0 || Math.hypot(p[0] - xy[i - 1][0], p[1] - xy[i - 1][1]) > 1e-6);
  if (closed && out.length > 1 && Math.hypot(out[0][0] - out.at(-1)[0], out[0][1] - out.at(-1)[1]) <= 1e-6) out.pop();
  return out;
}

// Move every vertex d metres to the left of the path direction.
function offsetPath(xy, d, closed) {
  const n = xy.length, m = closed ? n : n - 1;
  const nrm = [];
  for (let i = 0; i < m; i++) {
    const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % n];
    const L = Math.hypot(x2 - x1, y2 - y1);
    nrm.push([-(y2 - y1) / L, (x2 - x1) / L]);
  }
  return xy.map((p, k) => {
    const a = closed ? nrm[(k + n - 1) % n] : nrm[Math.max(k - 1, 0)];
    const b = closed ? nrm[k] : nrm[Math.min(k, m - 1)];
    const [dx, dy] = miter(a, b, d);
    return [p[0] + dx, p[1] + dy];
  });
}

function signedArea(xy) {
  let a = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/**
 * Offset a polygon outward by `meters` (negative shrinks) with clamped miter joins.
 * Concave polygons work as long as the offset stays smaller than their narrowest feature.
 */
export function bufferPolygon(polygon, meters) {
  if (!meters || polygon.length < 3) return polygon.slice();
  const c = centroid(polygon);
  const proj = makeProjection(c.lat, c.lon);
  const xy = dedupe(polygon.map(p => proj.toXY(p.lat, p.lon)), true);
  if (xy.length < 3) return polygon.slice();
  const outwardIsRight = signedArea(xy) > 0;
  return offsetPath(xy, outwardIsRight ? -meters : meters, true).map(([x, y]) => proj.toLL(x, y));
}

// ---------- Shared ----------

function makeWp(p, o) {
  const wp = {
    lat: p.lat, lon: p.lon, height: o.height, speed: o.speed, photo: o.photo ?? true,
    gimbalPitch: o.pitch, actions: null,
  };
  if (o.heading !== undefined) wp.heading = o.heading;
  return wp;
}

// ---------- Survey grid ----------

/**
 * Lawnmower survey over a polygon.
 * @param opts {cam, alt, front, side, angle, overshoot, home, speed, gimbal, margin, crosshatch,
 *              captureMode: 'waypoint' (photo at every point) | 'timer' (DJI Fly Timed Shot)}
 * @returns {waypoints, metrics, interval (s, timer mode only, else null), speed (m/s used), lines}
 */
export function planGrid(polygon, opts) {
  const {
    cam, alt, front, side, angle = 0, overshoot = 0, home = null, speed = 5, gimbal = -90,
    margin = 0, crosshatch = false, captureMode = 'waypoint',
  } = opts;
  const area = margin ? bufferPolygon(polygon, margin) : polygon;
  const metrics = gridMetrics(cam, alt, front, side);
  const gen = { lineSpacing: metrics.lineSpacing, photoSpacing: metrics.photoSpacing, overshoot };

  let pts = generateGrid(area, { ...gen, angle, home });
  if (crosshatch && pts.length) {
    const last = pts.at(-1);
    const second = generateGrid(area, { ...gen, angle: angle + 90, home: last })
      .map(p => ({ ...p, line: p.line + last.line + 1, seg: p.seg + last.seg + 1 }));
    pts = pts.concat(second);
  }

  const timer = captureMode === 'timer';
  let interval = null, flySpeed = speed;
  if (timer) {
    const need = Math.max(2, metrics.photoSpacing / speed);
    interval = TIMER_INTERVALS.find(s => s >= need) ?? TIMER_INTERVALS.at(-1);
    flySpeed = Math.max(1, Math.floor(metrics.photoSpacing / interval * 10) / 10);
    pts = pts.filter((p, i) => pts[i - 1]?.seg !== p.seg || pts[i + 1]?.seg !== p.seg);
  }

  const waypoints = pts.map(p => makeWp(p, { height: alt, speed: flySpeed, photo: !timer, pitch: gimbal }));
  return { waypoints, metrics, interval, speed: flySpeed, lines: pts.length ? pts.at(-1).line + 1 : 0 };
}

// ---------- Oblique (3D model) ----------

/**
 * Four grids over the area, camera facing N, E, S, W with the gimbal tilted to opts.pitch.
 * Each grid covers the polygon grown by alt*tan(90+pitch) so the tilted view reaches the whole area.
 * @param opts {cam, alt, front, side, overshoot, home, speed, pitch (default -45), margin}
 */
export function planOblique(polygon, opts) {
  const { cam, alt, front, side, overshoot = 0, speed = 5, pitch = -45, margin = 0 } = opts;
  const metrics = gridMetrics(cam, alt, front, side);
  const area = bufferPolygon(polygon, margin + alt * Math.tan((90 + pitch) * RAD));
  const waypoints = [];
  let home = opts.home || null;
  for (const facing of [0, 90, 180, 270]) {
    // Flying along the facing direction keeps the sensor's wide side across the track, as gridMetrics assumes.
    const pts = generateGrid(area, {
      angle: facing, lineSpacing: metrics.lineSpacing, photoSpacing: metrics.photoSpacing, overshoot, home,
    });
    for (const p of pts) waypoints.push(makeWp(p, { height: alt, speed, pitch, heading: facing }));
    if (pts.length) home = pts.at(-1);
  }
  return { waypoints };
}

// ---------- Orbit ----------

/**
 * Concentric circles around a point of interest, camera aimed at the centre (assumed at takeoff level).
 * @param opts {radius, rings, ringStep (m of height per ring), radiusStep (m of radius per ring),
 *              baseHeight, photosPerRing, speed}
 */
export function planOrbit(center, opts = {}) {
  const { radius = 40, rings = 2, ringStep = 10, radiusStep = 0, baseHeight = 30, photosPerRing = 24, speed = 3 } = opts;
  const proj = makeProjection(center.lat, center.lon);
  const waypoints = [];
  for (let r = 0; r < rings; r++) {
    const height = baseHeight + r * ringStep, rad = radius + r * radiusStep;
    const pitch = Math.max(-90, Math.min(0, -Math.atan2(height, rad) / RAD));
    for (let k = 0; k < photosPerRing; k++) {
      const theta = k * 360 / photosPerRing;
      const p = proj.toLL(rad * Math.sin(theta * RAD), rad * Math.cos(theta * RAD));
      waypoints.push(makeWp(p, { height, speed, pitch, heading: (theta + 180) % 360 }));
    }
  }
  return { waypoints };
}

// ---------- Corridor ----------

function resample(xy, step) {
  const out = [];
  for (let i = 0; i + 1 < xy.length; i++) {
    const [x1, y1] = xy[i], [x2, y2] = xy[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step));
    for (let j = 0; j < n; j++) out.push([x1 + (x2 - x1) * j / n, y1 + (y2 - y1) * j / n]);
  }
  out.push(xy.at(-1));
  return out;
}

/**
 * Parallel passes along a polyline (road, river) covering `width` metres, flown back and forth.
 * @param opts {cam, alt, front, side, width, home, speed, gimbal}
 */
export function planCorridor(line, opts) {
  const { cam, alt, front, side, width, home = null, speed = 5, gimbal = -90 } = opts;
  const c = centroid(line);
  const proj = makeProjection(c.lat, c.lon);
  const xy = dedupe(line.map(p => proj.toXY(p.lat, p.lon)), false);
  if (xy.length < 2) return { waypoints: [] };

  const m = gridMetrics(cam, alt, front, side);
  const span = Math.max(0, width - m.across);
  const n = Math.max(1, Math.ceil(span / m.lineSpacing) + 1);
  const passes = Array.from({ length: n }, (_, k) =>
    resample(offsetPath(xy, n > 1 ? -span / 2 + k * span / (n - 1) : 0, false), m.photoSpacing));

  const sequence = (reverseOrder, flipFirst) => {
    const ordered = reverseOrder ? passes.slice().reverse() : passes;
    return ordered.flatMap((p, i) => (i % 2 === 0) !== flipFirst ? p : p.slice().reverse());
  };
  let chosen = sequence(false, false);
  if (home) {
    const h = proj.toXY(home.lat, home.lon);
    const d = s => Math.hypot(s[0][0] - h[0], s[0][1] - h[1]);
    chosen = [sequence(false, false), sequence(false, true), sequence(true, false), sequence(true, true)]
      .reduce((a, b) => d(b) < d(a) ? b : a);
  }
  return { waypoints: chosen.map(([x, y]) => makeWp(proj.toLL(x, y), { height: alt, speed, pitch: gimbal })) };
}
