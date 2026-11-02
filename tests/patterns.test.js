import test from 'node:test';
import assert from 'node:assert/strict';
import { bufferPolygon, planGrid, planOblique, planOrbit, planCorridor, TIMER_INTERVALS } from '../web/js/patterns.js';
import { polygonAreaM2, makeProjection, haversine } from '../web/js/geo.js';
import { CAMERAS } from '../web/js/grid.js';

const origin = { lat: 47.0, lon: 8.0 };
const proj = makeProjection(origin.lat, origin.lon);
const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => proj.toLL(x, y));
const cam = CAMERAS.mavic3;
const base = { cam, alt: 80, front: 80, side: 70, angle: 0, speed: 8 };

test('bufferPolygon grows and shrinks', () => {
  const sq = rect(200, 200);
  const a0 = polygonAreaM2(sq);
  assert.ok(Math.abs(polygonAreaM2(bufferPolygon(sq, 20)) - 240 * 240) < 240 * 240 * 0.01);
  assert.ok(Math.abs(polygonAreaM2(bufferPolygon(sq, -20)) - 160 * 160) < 160 * 160 * 0.01);
  assert.ok(polygonAreaM2(bufferPolygon(sq, 10)) > a0);
  // winding order must not matter
  assert.ok(Math.abs(polygonAreaM2(bufferPolygon(sq.slice().reverse(), 20)) - 240 * 240) < 240 * 240 * 0.01);
});

test('bufferPolygon handles a concave polygon and clamps sharp miters', () => {
  const L = [[0, 0], [200, 0], [200, 100], [100, 100], [100, 200], [0, 200]].map(([x, y]) => proj.toLL(x, y));
  assert.ok(polygonAreaM2(bufferPolygon(L, 10)) > polygonAreaM2(L));
  const spike = [[0, 0], [200, 5], [0, 10]].map(([x, y]) => proj.toLL(x, y));
  const maxDist = Math.max(...bufferPolygon(spike, 10).map(p => haversine(p, proj.toLL(100, 5))));
  assert.ok(maxDist < 200 + 3 * 10 + 5);
});

test('planGrid waypoint mode photographs every point', () => {
  const r = planGrid(rect(300, 200), base);
  assert.equal(r.interval, null);
  assert.equal(r.speed, 8);
  assert.ok(r.waypoints.length > 4);
  assert.ok(r.waypoints.every(w => w.photo && w.height === 80 && w.gimbalPitch === -90));
});

test('planGrid timer mode keeps line ends and picks a valid interval', () => {
  const r = planGrid(rect(300, 200), { ...base, captureMode: 'timer' });
  assert.equal(r.waypoints.length, r.lines * 2);
  assert.ok(r.waypoints.every(w => !w.photo && w.speed === r.speed));
  assert.ok(TIMER_INTERVALS.includes(r.interval));
  const ps = r.metrics.photoSpacing;
  assert.ok(r.speed <= base.speed);
  assert.ok(r.speed * r.interval <= ps + 1e-9);
  assert.ok(r.speed * r.interval > ps * 0.95);
  // the next shorter interval would have exceeded the requested speed
  const shorter = TIMER_INTERVALS[TIMER_INTERVALS.indexOf(r.interval) - 1];
  if (shorter && r.interval > 2) assert.ok(ps / shorter > base.speed);
});

test('planGrid timer mode never goes below 2 s or 1 m/s', () => {
  const fast = planGrid(rect(300, 200), { ...base, speed: 15, captureMode: 'timer' });
  assert.ok(fast.interval >= 2);
  const slow = planGrid(rect(300, 200), { ...base, speed: 0.2, captureMode: 'timer' });
  assert.ok(slow.speed >= 1);
});

test('planGrid timer mode keeps both ends of each run on concave shapes', () => {
  const U = [[0, 0], [300, 0], [300, 200], [200, 200], [200, 60], [100, 60], [100, 200], [0, 200]].map(([x, y]) => proj.toLL(x, y));
  const wp = planGrid(U, { ...base, angle: 90 }).waypoints.length;
  const r = planGrid(U, { ...base, angle: 90, captureMode: 'timer' });
  assert.ok(r.waypoints.length > r.lines * 2 && r.waypoints.length % 2 === 0 && r.waypoints.length < wp);
});

test('crosshatch roughly doubles the lines', () => {
  const one = planGrid(rect(300, 300), base);
  const two = planGrid(rect(300, 300), { ...base, crosshatch: true });
  assert.ok(Math.abs(two.lines - 2 * one.lines) <= 2, `${one.lines} -> ${two.lines}`);
  assert.ok(two.waypoints.length > 1.8 * one.waypoints.length);
});

test('margin enlarges the covered area', () => {
  const a = planGrid(rect(300, 200), base).waypoints.length;
  const b = planGrid(rect(300, 200), { ...base, margin: 40 }).waypoints.length;
  assert.ok(b > a);
});

test('planOblique makes four headed passes', () => {
  const r = planOblique(rect(200, 200), { ...base, pitch: -45 });
  const headings = [...new Set(r.waypoints.map(w => w.heading))];
  assert.deepEqual(headings, [0, 90, 180, 270]);
  assert.ok(r.waypoints.every(w => w.gimbalPitch === -45 && w.photo));
  const north = r.waypoints.filter(w => w.heading === 0);
  const maxLat = Math.max(...north.map(w => w.lat));
  assert.ok(haversine({ lat: maxLat, lon: origin.lon }, proj.toLL(0, 200)) > 70); // buffered by about alt
});

test('planOrbit headings point at the centre', () => {
  const r = planOrbit(origin, { radius: 50, rings: 2, ringStep: 15, baseHeight: 30, photosPerRing: 12 });
  assert.equal(r.waypoints.length, 24);
  for (const w of r.waypoints) {
    const [x, y] = proj.toXY(w.lat, w.lon);
    const toCenter = (Math.atan2(-x, -y) * 180 / Math.PI + 360) % 360;
    const diff = Math.abs(((w.heading - toCenter + 540) % 360) - 180);
    assert.ok(diff < 0.01, `${w.heading} vs ${toCenter}`);
    assert.ok(Math.abs(Math.hypot(x, y) - 50) < 0.1);
    assert.ok(w.gimbalPitch <= 0 && w.gimbalPitch >= -90);
  }
  assert.ok(r.waypoints[12].height > r.waypoints[0].height);
  assert.ok(Math.abs(r.waypoints[0].gimbalPitch + Math.atan(30 / 50) * 180 / Math.PI) < 0.01);
});

test('planCorridor stays within the width of the line', () => {
  const line = [[0, 0], [200, 0], [400, 100]].map(([x, y]) => proj.toLL(x, y));
  const width = 300;
  const r = planCorridor(line, { ...base, width });
  assert.ok(r.waypoints.length > 6);
  const segs = [[[0, 0], [200, 0]], [[200, 0], [400, 100]]];
  const dist = ([px, py]) => Math.min(...segs.map(([[ax, ay], [bx, by]]) => {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  }));
  const worst = Math.max(...r.waypoints.map(w => dist(proj.toXY(w.lat, w.lon))));
  assert.ok(worst <= width / 2 * 1.1, `worst ${worst}`);
  assert.ok(worst > width / 2 * 0.5);
});
