// Keep-out zones: geometry for flying around polygons the drone must not enter.
// Everything here works on local x/y metres ([x, y] pairs); the lat/lon wrappers are at the bottom.

import { makeProjection, centroid, polygonAreaM2 } from './geo.js';

const EPS = 0.02; // metres a point must be inside a keep-out before it counts as "inside"

const cross = (ax, ay, bx, by) => ax * by - ay * bx;

export function pointInXY(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function distToEdges(poly, x, y) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(x1 + t * dx - x, y1 + t * dy - y));
  }
  return best;
}

/** True when the point is more than EPS inside the polygon. */
export const deepInside = (poly, x, y) => pointInXY(poly, x, y) && distToEdges(poly, x, y) > EPS;

/** True when the straight segment a-b passes through the interior of the polygon. */
export function segmentBlocked(a, b, poly) {
  const rx = b[0] - a[0], ry = b[1] - a[1];
  const ts = [0, 1];
  for (let i = 0; i < poly.length; i++) {
    const c = poly[i], d = poly[(i + 1) % poly.length];
    const sx = d[0] - c[0], sy = d[1] - c[1];
    const den = cross(rx, ry, sx, sy);
    if (Math.abs(den) < 1e-12) continue;
    const t = cross(c[0] - a[0], c[1] - a[1], sx, sy) / den;
    const u = cross(c[0] - a[0], c[1] - a[1], rx, ry) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) ts.push(t);
  }
  ts.sort((p, q) => p - q);
  for (let i = 0; i + 1 < ts.length; i++) {
    if (ts[i + 1] - ts[i] < 1e-9) continue;
    const m = (ts[i] + ts[i + 1]) / 2;
    if (deepInside(poly, a[0] + rx * m, a[1] + ry * m)) return true;
  }
  return false;
}

const anyBlocked = (a, b, polys) => polys.some(p => segmentBlocked(a, b, p));

function edgeIntersections(p, q) {
  const out = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    for (let j = 0; j < q.length; j++) {
      const c = q[j], d = q[(j + 1) % q.length];
      const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
      const den = cross(rx, ry, sx, sy);
      if (Math.abs(den) < 1e-12) continue;
      const t = cross(c[0] - a[0], c[1] - a[1], sx, sy) / den;
      const u = cross(c[0] - a[0], c[1] - a[1], rx, ry) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) out.push([a[0] + t * rx, a[1] + t * ry]);
    }
  }
  return out;
}

/**
 * Shortest path around the keep-out polygons (a visibility graph over their corners).
 * @returns route(a, b) -> the intermediate [x, y] points between a and b ([] when the straight line is clear)
 */
export function makeRouter(polys) {
  let nodes = null, vis = null;
  const build = () => {
    nodes = [];
    for (const p of polys) nodes.push(...p);
    for (let i = 0; i < polys.length; i++) for (let j = i + 1; j < polys.length; j++) nodes.push(...edgeIntersections(polys[i], polys[j]));
    nodes = nodes.filter(n => !polys.some(p => deepInside(p, n[0], n[1])));
    vis = nodes.map(() => new Map());
  };
  const visible = (i, j) => {
    let v = vis[i].get(j);
    if (v === undefined) { v = !anyBlocked(nodes[i], nodes[j], polys); vis[i].set(j, v); vis[j].set(i, v); }
    return v;
  };
  return function route(a, b) {
    if (!polys.length || !anyBlocked(a, b, polys)) return [];
    if (!nodes) build();
    const N = nodes.length, S = N, T = N + 1;
    const pt = k => k === S ? a : k === T ? b : nodes[k];
    const see = (i, j) => (i < N && j < N) ? visible(i, j) : !anyBlocked(pt(i), pt(j), polys);
    const dist = new Array(N + 2).fill(Infinity), prev = new Array(N + 2).fill(-1), done = new Array(N + 2).fill(false);
    dist[S] = 0;
    for (;;) {
      let u = -1;
      for (let k = 0; k < N + 2; k++) if (!done[k] && dist[k] < Infinity && (u < 0 || dist[k] < dist[u])) u = k;
      if (u < 0 || u === T) break;
      done[u] = true;
      for (let v = 0; v < N + 2; v++) {
        if (done[v] || v === u || !see(u, v)) continue;
        const d = dist[u] + Math.hypot(pt(u)[0] - pt(v)[0], pt(u)[1] - pt(v)[1]);
        if (d < dist[v]) { dist[v] = d; prev[v] = u; }
      }
    }
    if (prev[T] < 0) return []; // no way round (an end point is inside a keep-out): leave the straight line
    const path = [];
    for (let k = prev[T]; k !== S && k >= 0; k = prev[k]) path.unshift(nodes[k]);
    return path;
  };
}

/** Remove the [lo, hi] intervals in `cuts` from the intervals in `iv` (both lists of [lo, hi]). */
export function subtractIntervals(iv, cuts) {
  let out = iv;
  for (const [c0, c1] of cuts.slice().sort((p, q) => p[0] - q[0])) {
    const next = [];
    for (const [lo, hi] of out) {
      if (c1 <= lo || c0 >= hi) { next.push([lo, hi]); continue; }
      if (c0 > lo) next.push([lo, c0]);
      if (c1 < hi) next.push([c1, hi]);
    }
    out = next;
  }
  return out;
}

// ---------- lat/lon wrappers ----------

/** True when any straight segment of the path (a list of {lat, lon}) enters a keep-out polygon. */
export function pathHitsKeepouts(path, keepouts) {
  const kos = (keepouts || []).filter(k => k.length >= 3);
  if (!kos.length || path.length < 1) return false;
  const proj = makeProjection(path[0].lat, path[0].lon);
  const xy = path.map(p => proj.toXY(p.lat, p.lon));
  const polys = kos.map(k => k.map(p => proj.toXY(p.lat, p.lon)));
  if (xy.length === 1) return polys.some(p => deepInside(p, xy[0][0], xy[0][1]));
  for (let i = 1; i < xy.length; i++) if (anyBlocked(xy[i - 1], xy[i], polys)) return true;
  return false;
}

export function pointInKeepouts(p, keepouts) {
  return pathHitsKeepouts([p], keepouts);
}

/**
 * Area left to map in m²: the union of the areas minus the keep-outs. One plain area is exact; the rest is
 * sampled on a grid (within about 1%).
 */
export function netAreaM2(areas, keepouts = []) {
  const as = areas.filter(a => a.length >= 3), ks = keepouts.filter(k => k.length >= 3);
  if (!as.length) return 0;
  if (as.length === 1 && !ks.length) return polygonAreaM2(as[0]);
  const c = centroid(as.flat());
  const proj = makeProjection(c.lat, c.lon);
  const A = as.map(a => a.map(p => proj.toXY(p.lat, p.lon))), K = ks.map(k => k.map(p => proj.toXY(p.lat, p.lon)));
  const all = A.flat();
  const x0 = Math.min(...all.map(p => p[0])), x1 = Math.max(...all.map(p => p[0]));
  const y0 = Math.min(...all.map(p => p[1])), y1 = Math.max(...all.map(p => p[1]));
  const n = 200, dx = (x1 - x0) / n, dy = (y1 - y0) / n;
  let count = 0;
  for (let j = 0; j < n; j++) {
    const y = y0 + (j + 0.5) * dy;
    for (let i = 0; i < n; i++) {
      const x = x0 + (i + 0.5) * dx;
      if (A.some(p => pointInXY(p, x, y)) && !K.some(p => pointInXY(p, x, y))) count++;
    }
  }
  return count * dx * dy;
}
