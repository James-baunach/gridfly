// Pure helpers behind the guided flow: goal presets, quality mapping, geometry shortcuts and site-check verdicts.

import { makeProjection, centroid, polygonAreaM2 } from './geo.js';
import { bufferPolygon } from './patterns.js';
import { findWindows } from './sitecheck.js';
import { fmtSmall } from './units.js';

export const GOALS = {
  grid: { title: 'Land / field (2D map)', text: 'A flat top-down map of land, a field or a site.', front: 75, side: 65 },
  '3d': { title: 'Buildings & 3D model', text: 'Crossing passes so buildings and trees come out as a 3D model.', front: 80, side: 70, crosshatch: true },
  orbit: { title: 'Single building orbit', text: 'Circles around one building or object, looking at it from all sides.', front: 80, side: 70 },
  corridor: { title: 'Road / river / fence line', text: 'A strip of passes along a line you draw.', front: 75, side: 65 },
};

export const QUALITY = [
  { id: 'fast', label: 'Fast', alt: 90, d: -5 },
  { id: 'balanced', label: 'Balanced', alt: 70, d: 0 },
  { id: 'detailed', label: 'Detailed', alt: 50, d: 5 },
];

export function qualityParams(goal, level) {
  const g = GOALS[goal] || GOALS.grid, q = QUALITY[level] || QUALITY[1];
  return { alt: q.alt, front: g.front + q.d, side: g.side + q.d };
}

// Index of the quality preset matching these values, or -1 when custom.
export function qualityMatch(goal, alt, front, side) {
  return QUALITY.findIndex((_, i) => {
    const p = qualityParams(goal, i);
    return Math.abs(p.alt - alt) < 0.5 && p.front === front && p.side === side;
  });
}

export function detailWords(gsdCm, unit = 'm') {
  return `you'll see things about ${fmtSmall(gsdCm, unit)} across`;
}

// Half the photo footprint across the flight line, so the edges of the area get covered too.
export const autoMargin = metrics => Math.round(metrics.across / 2);

// Timer photos are recommended when photo-at-every-waypoint would need more than about two full missions.
export const recommendTimer = (count, perMission = 200) => count > 2 * perMission;

export const CONTROLLERS = {
  rc: 'DJI RC (no USB file access)',
  rc2: 'DJI RC 2 / RC Pro',
  'rcn-android': 'RC-N1/N2/N3 + Android phone',
  'rcn-ios': 'RC-N1/N2/N3 + iPhone',
};

export const HELPER_CONTROLLERS = ['rc2', 'rcn-android'];

export const coverageCellSize = areaM2 => Math.max(4, Math.sqrt(Math.max(0, areaM2) / 25000));

// ---------- Geometry ----------

export function circlePolygon(center, radiusM, n = 36) {
  const proj = makeProjection(center.lat, center.lon);
  return Array.from({ length: n }, (_, k) => {
    const t = 2 * Math.PI * k / n;
    return proj.toLL(radiusM * Math.sin(t), radiusM * Math.cos(t));
  });
}

export function rectPolygon(a, b) {
  const [s, n] = [Math.min(a.lat, b.lat), Math.max(a.lat, b.lat)];
  const [w, e] = [Math.min(a.lon, b.lon), Math.max(a.lon, b.lon)];
  return [{ lat: n, lon: w }, { lat: n, lon: e }, { lat: s, lon: e }, { lat: s, lon: w }];
}

export function pointInPolygon(p, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.lat > p.lat) !== (b.lat > p.lat) && p.lon < (b.lon - a.lon) * (p.lat - a.lat) / (b.lat - a.lat) + a.lon) c = !c;
  }
  return c;
}

// Closest point on the polygon outline (or on a polyline when `closed` is false) to `target`.
export function nearestEdgePoint(points, target, closed = true) {
  const c = centroid(points);
  const proj = makeProjection(c.lat, c.lon);
  const xy = points.map(p => proj.toXY(p.lat, p.lon));
  const [tx, ty] = proj.toXY(target.lat, target.lon);
  let best = null, bd = Infinity;
  const m = closed ? xy.length : xy.length - 1;
  for (let i = 0; i < m; i++) {
    const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length];
    const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((tx - x1) * dx + (ty - y1) * dy) / L2)) : 0;
    const px = x1 + t * dx, py = y1 + t * dy, d = Math.hypot(px - tx, py - ty);
    if (d < bd) { bd = d; best = [px, py]; }
  }
  return best ? proj.toLL(best[0], best[1]) : { ...points[0] };
}

export const areaOf = polygon => polygonAreaM2(polygon);

// ---------- Curved-path rule ----------

// DJI Fly ignores photo actions on curved paths. Says what to do with the chosen path style.
export function curvedRule({ turnMode, sourceCurved, hasPhoto, edited }) {
  const curved = turnMode === 'curved' || (turnMode === 'keep' && sourceCurved);
  return {
    disableCurved: hasPhoto,
    switchToStraight: hasPhoto && curved && edited,
    warnLoaded: hasPhoto && curved && !edited,
  };
}

// ---------- Site-check verdicts ----------

export const metresToFeet = m => m / 0.3048;

// Obstacles whose top (+10 m safety) reaches the flight height, inside or within `near` metres of the area.
export function obstacleWarnings(obstacles, area, aglM, near = 60) {
  if (!area?.length || !obstacles?.length) return [];
  const zone = area.length >= 3 ? bufferPolygon(area, near) : null;
  const close = o => !zone || pointInPolygon(o, zone) || (o.geometry || []).some(g => pointInPolygon(g, zone));
  return obstacles.filter(o => o.height + 10 > aglM && close(o));
}

// FAA grid cells whose ceiling (ft AGL) is below the flight height.
export function airspaceWarnings(cells, maxAglM) {
  const ft = metresToFeet(maxAglM);
  return (cells || []).filter(c => Number.isFinite(c.ceiling) && c.ceiling < ft);
}

const RANK = { good: 2, ok: 1, bad: 0 };

// Best windows and an overall verdict for today and tomorrow (local calendar days).
export function weatherDays(hours, now = new Date()) {
  const day = d => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  const t0 = day(now), t1 = day(new Date(now.getTime() + 86400000));
  return [[t0, 'Today'], [t1, 'Tomorrow']].map(([key, label]) => {
    const hs = hours.filter(h => day(h.time) === key);
    const windows = findWindows(hs).filter(w => w.end - w.start >= 3600000);
    const verdict = hs.reduce((v, h) => RANK[h.verdict] > RANK[v] ? h.verdict : v, 'bad');
    return { label, verdict: hs.length ? verdict : null, windows, hours: hs };
  });
}

export function nowVerdict(hours, now = new Date()) {
  return hours.find(h => h.time.getTime() + 3600000 > now.getTime()) || null;
}
