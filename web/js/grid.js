// Survey grid generation: camera footprint math, lawnmower flight lines, path straightening.

import { makeProjection, rotate, centroid, haversine } from './geo.js';

// Sensor sizes in mm, focal length in mm (real, not 35mm-equivalent), image width in px.
export const CAMERAS = {
  mavic3: { name: 'Mavic 3 / 3 Classic / 3 Pro / 3E (4/3", 24 mm)', sensorW: 17.3, sensorH: 13.0, focal: 12.29, imageW: 5280 },
  mavic3pro70: { name: 'Mavic 3 Pro medium tele (1/1.3", 70 mm)', sensorW: 9.6, sensorH: 7.2, focal: 19.4, imageW: 4032 },
  mini4: { name: 'Mini 4 Pro / Mini 3 Pro / Air 3 (1/1.3", 24 mm)', sensorW: 9.6, sensorH: 7.2, focal: 6.72, imageW: 4032 },
  custom: { name: 'Custom…', sensorW: 17.3, sensorH: 13.0, focal: 12.29, imageW: 5280 },
};

// With heading "follow wayline" and a nadir gimbal, the sensor's long side lies across the flight line.
export function gridMetrics(cam, altitude, frontOverlap, sideOverlap) {
  const across = cam.sensorW * altitude / cam.focal;
  const along = cam.sensorH * altitude / cam.focal;
  return {
    across, along,
    gsd: cam.sensorW * altitude * 100 / (cam.focal * cam.imageW), // cm/px
    lineSpacing: Math.max(1, across * (1 - sideOverlap / 100)),
    photoSpacing: Math.max(1, along * (1 - frontOverlap / 100)),
  };
}

// Polygon rotated so that a flight bearing of `angle` points along +Y.
function rotatedPolygon(polygon, angle) {
  const c = centroid(polygon);
  const proj = makeProjection(c.lat, c.lon);
  return { proj, xy: polygon.map(p => rotate(proj.toXY(p.lat, p.lon), angle)) };
}

// Bearing (0-179) that needs the fewest flight lines, i.e. the narrowest width across track.
export function autoAngle(polygon) {
  let best = 0, bestW = Infinity;
  for (let a = 0; a < 180; a++) {
    const { xy } = rotatedPolygon(polygon, a);
    const xs = xy.map(p => p[0]);
    const w = Math.max(...xs) - Math.min(...xs);
    if (w < bestW - 1e-6) { bestW = w; best = a; }
  }
  return best;
}

function crossings(xy, x) {
  const ys = [];
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length];
    if ((x1 <= x && x < x2) || (x2 <= x && x < x1)) ys.push(y1 + (x - x1) * (y2 - y1) / (x2 - x1));
  }
  ys.sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < ys.length; i += 2) out.push([ys[i], ys[i + 1]]);
  return out;
}

/**
 * Lawnmower pattern over a polygon.
 * @param polygon [{lat, lon}]
 * @param opts {angle: flight bearing in degrees (0 = north-south lines, 90 = east-west),
 *              lineSpacing, photoSpacing, overshoot (m past the boundary), home: {lat, lon} | null}
 * @returns [{lat, lon, line, seg}] in flight order; `seg` numbers each straight run (a line crossing a concave area has several)
 */
export function generateGrid(polygon, { angle, lineSpacing, photoSpacing, overshoot = 0, home = null }) {
  const { proj, xy } = rotatedPolygon(polygon, angle);
  const xs = xy.map(p => p[0]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const width = maxX - minX;
  const nLines = Math.max(1, Math.ceil(width / lineSpacing) + 1);
  const step = nLines > 1 ? width / (nLines - 1) : 0;
  const eps = Math.min(0.05, width / 1000);

  // One entry per flight line; concave areas can give a line several intervals.
  const lines = [];
  for (let k = 0; k < nLines; k++) {
    const x = nLines > 1 ? Math.min(maxX - eps, Math.max(minX + eps, minX + k * step)) : (minX + maxX) / 2;
    const iv = crossings(xy, x).map(([y1, y2]) => [y1 - overshoot, y2 + overshoot]);
    if (iv.length) lines.push({ x, iv });
  }
  if (!lines.length) return [];

  // Four candidate orderings (reverse line order and/or start direction); pick the one that
  // begins closest to the takeoff point.
  const build = (reverseOrder, startDown) => {
    const ordered = reverseOrder ? lines.slice().reverse() : lines;
    const pts = [];
    let seg = 0;
    ordered.forEach((ln, i) => {
      const down = startDown !== (i % 2 === 1);
      const intervals = down ? ln.iv.slice().reverse() : ln.iv;
      for (const [y1, y2] of intervals) {
        const len = y2 - y1;
        const n = Math.max(1, Math.ceil(len / photoSpacing));
        for (let j = 0; j <= n; j++) {
          const t = down ? 1 - j / n : j / n;
          pts.push({ xy: [ln.x, y1 + t * len], line: i, seg });
        }
        seg++;
      }
    });
    return pts;
  };
  const candidates = [build(false, false), build(false, true), build(true, false), build(true, true)];
  let chosen = candidates[0];
  if (home) {
    const homeXY = rotate(proj.toXY(home.lat, home.lon), angle);
    const d = c => Math.hypot(c[0].xy[0] - homeXY[0], c[0].xy[1] - homeXY[1]);
    chosen = candidates.reduce((a, b) => d(b) < d(a) ? b : a);
  }
  return chosen.map(p => {
    const [x, y] = rotate(p.xy, -angle);
    return { ...proj.toLL(x, y), line: p.line, seg: p.seg };
  });
}

// Snap runs of nearly-collinear waypoints onto the straight line between the run's endpoints.
// Points where the path turns by more than `maxTurn` degrees are kept as corners.
export function snapStraight(waypoints, maxTurn = 15, maxDeviation = 15) {
  const n = waypoints.length;
  if (n < 3) return { waypoints, moved: 0 };
  const proj = makeProjection(waypoints[0].lat, waypoints[0].lon);
  const xy = waypoints.map(w => proj.toXY(w.lat, w.lon));
  const out = waypoints.map(w => ({ ...w }));
  const turn = i => {
    const a = Math.atan2(xy[i][1] - xy[i - 1][1], xy[i][0] - xy[i - 1][0]);
    const b = Math.atan2(xy[i + 1][1] - xy[i][1], xy[i + 1][0] - xy[i][0]);
    let d = Math.abs(b - a) * 180 / Math.PI;
    return d > 180 ? 360 - d : d;
  };
  let moved = 0, s = 0;
  for (let i = 1; i < n; i++) {
    const interior = i < n - 1 && turn(i) < maxTurn;
    if (interior) continue;
    if (i - s >= 2) {
      const [ax, ay] = xy[s], dx = xy[i][0] - ax, dy = xy[i][1] - ay;
      const L2 = dx * dx + dy * dy;
      if (L2 > 0) {
        const proj2 = [];
        let ok = true;
        for (let j = s + 1; j < i; j++) {
          const t = ((xy[j][0] - ax) * dx + (xy[j][1] - ay) * dy) / L2;
          const px = ax + t * dx, py = ay + t * dy;
          if (Math.hypot(px - xy[j][0], py - xy[j][1]) > maxDeviation) { ok = false; break; }
          proj2.push([j, px, py]);
        }
        if (ok) for (const [j, px, py] of proj2) {
          const ll = proj.toLL(px, py);
          if (haversine(ll, out[j]) > 0.01) moved++;
          out[j].lat = ll.lat; out[j].lon = ll.lon;
        }
      }
    }
    s = i;
  }
  return { waypoints: out, moved };
}
