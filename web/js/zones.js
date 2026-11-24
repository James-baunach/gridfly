// Range zones: split a big survey into pieces that can each be flown from one launch point without the
// drone going farther than the controller's reliable signal range. Pure geometry, no app state.

import { makeProjection, rotate, centroid, haversine } from './geo.js';

/** Default reliable range from the pilot: 2000 ft. */
export const DEFAULT_RANGE = 609.6;

/**
 * Fewest tiles (nx across × ny along) that cut a W × H box into rectangles whose half-diagonal is at most r,
 * so a launch point in the middle of each tile reaches every corner. Ties prefer squarer tiles.
 */
export function tileCounts(W, H, r) {
  if (!(r > 0)) return [1, 1];
  if (Math.hypot(W, H) / 2 <= r) return [1, 1];
  let best = null;
  for (let nx = 1; nx <= 80; nx++) {
    const w = W / nx;
    if (w / 2 >= r) continue;
    const h = 2 * Math.sqrt(r * r - (w / 2) ** 2);
    const ny = Math.max(1, Math.ceil(H / h - 1e-9));
    const n = nx * ny, sq = Math.abs(Math.log((W / nx) / Math.max(1e-9, H / ny)));
    if (!best || n < best.n || (n === best.n && sq < best.sq)) best = { nx, ny, n, sq };
  }
  return best ? [best.nx, best.ny] : [80, 80];
}

/**
 * Rectangular tiles over a polygon, lined up with the flight lines (bearing `angle`), each small enough to be
 * flown within `radius` metres of its centre. Every tile is grown by `pad` metres on all sides so
 * neighbouring zones overlap and the map has no seams. Returns null when one tile is enough.
 * @returns [{clip: [{lat, lon}] (4 corners), center: {lat, lon}}] in no particular order
 */
export function rangeTiles(polygon, angle, radius, { pad = 0 } = {}) {
  if (!polygon || polygon.length < 3 || !(radius > 0)) return null;
  const c = centroid(polygon);
  const proj = makeProjection(c.lat, c.lon);
  const xy = polygon.map(p => rotate(proj.toXY(p.lat, p.lon), angle));
  const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const W = maxX - minX, H = maxY - minY;
  const r = Math.max(radius * 0.3, radius - Math.SQRT2 * pad);
  const [nx, ny] = tileCounts(W, H, r);
  if (nx * ny === 1 && Math.hypot(W, H) / 2 <= radius) return null;
  const toLL = (x, y) => { const [a, b] = rotate([x, y], -angle); return proj.toLL(a, b); };
  const tiles = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const x0 = minX + W * i / nx - pad, x1 = minX + W * (i + 1) / nx + pad;
      const y0 = minY + H * j / ny - pad, y1 = minY + H * (j + 1) / ny + pad;
      tiles.push({ clip: [toLL(x0, y0), toLL(x1, y0), toLL(x1, y1), toLL(x0, y1)], center: toLL((x0 + x1) / 2, (y0 + y1) / 2) });
    }
  }
  return tiles;
}

/**
 * Launch point for a set of waypoints: the middle of their bounding box (lined up with `angle`), which keeps
 * the farthest waypoint about as close as possible.
 */
export function launchFor(points, angle = 0) {
  if (!points.length) return null;
  const c = centroid(points);
  const proj = makeProjection(c.lat, c.lon);
  const xy = points.map(p => rotate(proj.toXY(p.lat, p.lon), angle));
  const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
  const [x, y] = rotate([(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2], -angle);
  return proj.toLL(x, y);
}

/** Farthest distance (m) from `from` to any of `points`. */
export const farthest = (from, points) => points.reduce((a, p) => Math.max(a, haversine(from, p)), 0);

/**
 * Group consecutive pieces (each a list of waypoints) into zones that fit within `radius` of one launch point.
 * Small neighbouring areas end up sharing a launch point; big tiled areas get one each.
 * @returns [{pieces: [index], launch: {lat, lon}, far: metres}]
 */
export function groupPieces(pieces, radius, angle = 0) {
  const zones = [];
  let cur = null;
  pieces.forEach((pts, i) => {
    if (!pts.length) return;
    if (cur) {
      const all = cur.points.concat(pts);
      const launch = launchFor(all, angle);
      const far = farthest(launch, all);
      if (far <= radius) { Object.assign(cur, { points: all, launch, far }); cur.pieces.push(i); return; }
    }
    const launch = launchFor(pts, angle);
    cur = { pieces: [i], points: pts, launch, far: farthest(launch, pts) };
    zones.push(cur);
  });
  return zones.map(({ pieces: p, launch, far }) => ({ pieces: p, launch, far }));
}
