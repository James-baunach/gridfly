// Small geodesy helpers. Distances in metres, angles in degrees unless noted.

const R = 6378137;
const RAD = Math.PI / 180;

// Local equirectangular projection around an origin; accurate to well under 0.1%
// over the few-kilometre extents of a drone mission.
export function makeProjection(lat0, lon0) {
  const k = Math.cos(lat0 * RAD);
  return {
    toXY: (lat, lon) => [(lon - lon0) * RAD * R * k, (lat - lat0) * RAD * R],
    toLL: (x, y) => ({ lat: lat0 + (y / R) / RAD, lon: lon0 + (x / (R * k)) / RAD }),
  };
}

export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function rotate([x, y], deg) {
  const t = deg * RAD, c = Math.cos(t), s = Math.sin(t);
  return [x * c - y * s, x * s + y * c];
}

export function centroid(points) {
  let lat = 0, lon = 0;
  for (const p of points) { lat += p.lat; lon += p.lon; }
  return { lat: lat / points.length, lon: lon / points.length };
}

export function polygonAreaM2(polygon) {
  if (polygon.length < 3) return 0;
  const c = centroid(polygon);
  const proj = makeProjection(c.lat, c.lon);
  const xy = polygon.map(p => proj.toXY(p.lat, p.lon));
  let a = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

// Andrew's monotone chain on lat/lon points (projected locally).
export function convexHull(points) {
  if (points.length < 3) return points.slice();
  const c = centroid(points);
  const proj = makeProjection(c.lat, c.lon);
  const pts = points.map(p => proj.toXY(p.lat, p.lon)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1)).map(([x, y]) => proj.toLL(x, y));
}

export function pathLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversine(points[i - 1], points[i]);
  return d;
}
