import test from 'node:test';
import assert from 'node:assert/strict';
import { planGrid, planOblique, transitWaypoints } from '../web/js/patterns.js';
import { pathHitsKeepouts, pointInKeepouts, netAreaM2, makeRouter, subtractIntervals, pointInXY } from '../web/js/avoid.js';
import { makeProjection, polygonAreaM2 } from '../web/js/geo.js';
import { CAMERAS, gridMetrics } from '../web/js/grid.js';
import { toGeoJSON, toKml, projectToJson, projectFromJson } from '../web/js/exporters.js';

const proj = makeProjection(47.0, 8.0);
const poly = pts => pts.map(([x, y]) => proj.toLL(x, y));
const base = { cam: CAMERAS.mavic3, alt: 80, front: 80, side: 70, angle: 0, speed: 8 };
const xy = p => proj.toXY(p.lat, p.lon);

// Independent check: walk every segment in 0.5 m steps and make sure no sample is inside a keep-out.
function assertClear(wps, keepouts, label) {
  const K = keepouts.map(k => k.map(xy));
  for (let i = 1; i < wps.length; i++) {
    const [ax, ay] = xy(wps[i - 1]), [bx, by] = xy(wps[i]);
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.5));
    for (let s = 0; s <= n; s++) {
      const x = ax + (bx - ax) * s / n, y = ay + (by - ay) * s / n;
      assert.ok(!K.some(k => pointInXY(k, x, y)), `${label}: segment ${i} enters a keep-out at ${x.toFixed(1)}, ${y.toFixed(1)}`);
    }
  }
  assert.ok(!pathHitsKeepouts(wps, keepouts), `${label}: pathHitsKeepouts`);
}

// Every sample point of (area minus keep-outs) must lie inside the footprint of some photo.
function assertCovered(wps, area, keepouts, label, angle) {
  const photos = wps.filter(w => w.photo).map(xy);
  const A = area.map(xy), K = keepouts.map(k => k.map(xy));
  const xs = A.map(p => p[0]), ys = A.map(p => p[1]);
  const m = gridMetrics(base.cam, base.alt, base.front, base.side);
  const t = angle * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  let tested = 0;
  for (let x = Math.min(...xs) + 2; x < Math.max(...xs); x += 6) {
    for (let y = Math.min(...ys) + 2; y < Math.max(...ys); y += 6) {
      if (!pointInXY(A, x, y) || K.some(k => pointInXY(k, x, y))) continue;
      tested++;
      const seen = photos.some(p => { // offset in the flight frame: u across the lines, v along them
        const dx = x - p[0], dy = y - p[1];
        return Math.abs(dx * c - dy * s) <= m.across / 2 && Math.abs(dx * s + dy * c) <= m.along / 2;
      });
      assert.ok(seen, `${label}: ${x.toFixed(0)}, ${y.toFixed(0)} is not inside any photo footprint`);
    }
  }
  assert.ok(tested > 50, `${label}: too few samples`);
}

const SHAPES = {
  'hole in the middle': { area: poly([[0, 0], [300, 0], [300, 200], [0, 200]]), keepouts: [poly([[110, 60], [190, 60], [190, 140], [110, 140]])] },
  'keep-out cutting the edge': { area: poly([[0, 0], [300, 0], [300, 200], [0, 200]]), keepouts: [poly([[250, -40], [340, -40], [340, 90], [250, 90]])] },
  'two keep-outs': { area: poly([[0, 0], [300, 0], [300, 200], [0, 200]]), keepouts: [poly([[60, 50], [120, 50], [120, 150], [60, 150]]), poly([[180, 20], [260, 20], [230, 120]])] },
  'concave area': { area: poly([[0, 0], [300, 0], [300, 200], [200, 200], [200, 80], [100, 80], [100, 200], [0, 200]]), keepouts: [poly([[130, 20], [170, 20], [170, 60], [130, 60]])] },
  'overlapping keep-outs': { area: poly([[0, 0], [300, 0], [300, 200], [0, 200]]), keepouts: [poly([[100, 50], [170, 50], [170, 120], [100, 120]]), poly([[140, 90], [220, 90], [220, 160], [140, 160]])] },
  'concave keep-out': { area: poly([[0, 0], [300, 0], [300, 200], [0, 200]]), keepouts: [poly([[100, 40], [200, 40], [200, 160], [170, 160], [170, 80], [130, 80], [130, 160], [100, 160]])] },
};

for (const [name, { area, keepouts }] of Object.entries(SHAPES)) {
  for (const angle of [0, 90, 37]) {
    test(`keep-out: ${name}, angle ${angle}: path stays out and photos cover the rest`, () => {
      const r = planGrid(area, { ...base, angle, keepouts });
      assert.ok(r.waypoints.length > 20);
      assertClear(r.waypoints, keepouts, name);
      assertCovered(r.waypoints, area, keepouts, name, angle);
      assert.ok(r.waypoints.filter(w => w.transit).every(w => !w.photo));
      assert.ok(r.waypoints.every(w => w.transit || w.photo));
    });
  }
}

test('keep-out: a hole in the middle really needs transit detours', () => {
  const { area, keepouts } = SHAPES['hole in the middle'];
  const r = planGrid(area, { ...base, keepouts });
  assert.ok(r.waypoints.some(w => w.transit));
  const plain = planGrid(area, base);
  assert.ok(!plain.waypoints.some(w => w.transit));
});

test('keep-out: margin, crosshatch and timer mode stay clear', () => {
  const { area, keepouts } = SHAPES['two keep-outs'];
  for (const extra of [{ margin: 40 }, { crosshatch: true }, { captureMode: 'timer' }, { crosshatch: true, margin: 30, captureMode: 'timer' }]) {
    const r = planGrid(area, { ...base, keepouts, ...extra });
    assertClear(r.waypoints, keepouts, JSON.stringify(extra));
    if (extra.captureMode === 'timer') assert.ok(r.waypoints.every(w => !w.photo));
  }
  const grown = planGrid(area, { ...base, keepouts, margin: 60 }).waypoints.filter(w => w.photo).map(xy);
  assert.ok(grown.some(p => p[0] < -30 || p[0] > 330), 'margin still grows outside the area');
});

test('keep-out: oblique passes stay clear', () => {
  const { area, keepouts } = SHAPES['hole in the middle'];
  const r = planOblique(area, { ...base, keepouts, pitch: -45 });
  assertClear(r.waypoints, keepouts, 'oblique');
  assert.deepEqual([...new Set(r.waypoints.map(w => w.heading))], [0, 90, 180, 270]);
  assert.ok(r.waypoints.some(w => w.transit && !w.photo));
});

test('keep-out: transitWaypoints goes round a keep-out between two areas', () => {
  const ko = [poly([[40, -50], [60, -50], [60, 50], [40, 50]])];
  const a = { ...proj.toLL(0, 0), height: 70, speed: 5, photo: true, gimbalPitch: -90 };
  const b = { ...proj.toLL(100, 0), height: 70, speed: 5, photo: true, gimbalPitch: -90 };
  const t = transitWaypoints(a, b, ko);
  assert.ok(t.length >= 2 && t.every(w => !w.photo && w.transit && w.height === 70));
  assertClear([a, ...t, b], ko, 'transit');
  assert.deepEqual(transitWaypoints(a, b, []), []);
  assert.deepEqual(transitWaypoints(a, proj.toLL(0, 100), ko), []);
});

test('keep-out: router and interval helpers', () => {
  assert.deepEqual(subtractIntervals([[0, 100]], [[20, 30], [50, 60]]), [[0, 20], [30, 50], [60, 100]]);
  assert.deepEqual(subtractIntervals([[0, 10]], [[-5, 20]]), []);
  const route = makeRouter([[[40, -10], [60, -10], [60, 10], [40, 10]]]);
  assert.deepEqual(route([0, 20], [100, 20]), []);
  const path = route([0, 0], [100, 0]);
  assert.ok(path.length >= 2);
});

test('keep-out: path and point checks, net area', () => {
  const ko = [poly([[40, -10], [60, -10], [60, 10], [40, 10]])];
  assert.ok(pathHitsKeepouts([proj.toLL(0, 0), proj.toLL(100, 0)], ko));
  assert.ok(!pathHitsKeepouts([proj.toLL(0, 20), proj.toLL(100, 20)], ko));
  assert.ok(pointInKeepouts(proj.toLL(50, 0), ko));
  assert.ok(!pointInKeepouts(proj.toLL(0, 0), ko));
  const area = poly([[0, 0], [200, 0], [200, 100], [0, 100]]);
  assert.ok(Math.abs(netAreaM2([area], []) - polygonAreaM2(area)) < 1);
  const net = netAreaM2([area], [poly([[50, 25], [150, 25], [150, 75], [50, 75]])]);
  assert.ok(Math.abs(net - (20000 - 5000)) < 20000 * 0.03, String(net));
  const two = netAreaM2([area, poly([[500, 0], [600, 0], [600, 100], [500, 100]])], []);
  assert.ok(Math.abs(two - 30000) < 30000 * 0.03, String(two));
});

test('keep-out: project files keep areas and keep-outs, old files still open', () => {
  const areas = [poly([[0, 0], [10, 0], [10, 10]])], keepouts = [poly([[1, 1], [2, 1], [2, 2]])];
  const out = projectFromJson(projectToJson({ polygon: poly([[0, 0], [5, 0], [5, 5]]), areas, keepouts }));
  assert.equal(out.areas.length, 1);
  assert.equal(out.keepouts.length, 1);
  assert.equal(out.keepouts[0].length, 3);
  const old = projectFromJson('{"app":"gridfly","version":1,"polygon":[{"lat":1,"lon":2}]}');
  assert.deepEqual([old.areas, old.keepouts], [[], []]);
  assert.throws(() => projectFromJson('{"app":"gridfly","version":1,"keepouts":[[{"lat":1}]]}'), /keep-out/);
});

test('keep-out: KML and GeoJSON include extra areas and keep-outs', () => {
  const polygon = poly([[0, 0], [5, 0], [5, 5]]), areas = [poly([[20, 0], [25, 0], [25, 5]])], keepouts = [poly([[1, 1], [2, 1], [2, 2]])];
  const g = toGeoJSON({ polygon, areas, keepouts });
  assert.equal(g.features.filter(f => f.properties.kind === 'survey_area').length, 2);
  assert.equal(g.features.filter(f => f.properties.kind === 'keep_out').length, 1);
  const kml = toKml({ polygon, areas, keepouts });
  assert.match(kml, /Survey area 1/);
  assert.match(kml, /Survey area 2/);
  assert.match(kml, /Keep-out zone/);
  assert.match(toKml({ polygon }), /<name>Survey area<\/name>/);
});
