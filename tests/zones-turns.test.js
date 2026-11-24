import test from 'node:test';
import assert from 'node:assert/strict';
import { tileCounts, rangeTiles, launchFor, farthest, groupPieces } from '../web/js/zones.js';
import { planGrid } from '../web/js/patterns.js';
import { CAMERAS, gridMetrics, intersectIntervals } from '../web/js/grid.js';
import { makeProjection, haversine } from '../web/js/geo.js';
import { autoSpeed, MAX_AUTO_SPEED, MIN_PHOTO_GAP } from '../web/js/presets.js';

const origin = { lat: 37.5, lon: -84.5 };
const proj = makeProjection(origin.lat, origin.lon);
const rect = (w, h, x0 = 0, y0 = 0) => [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]].map(([x, y]) => proj.toLL(x, y));
const cam = CAMERAS.mavic3;
const base = { cam, alt: 120, front: 70, side: 60, angle: 0, speed: 10 };

test('tileCounts keeps every tile corner within the radius', () => {
  assert.deepEqual(tileCounts(400, 300, 600), [1, 1]);
  for (const [W, H, r] of [[3000, 2000, 600], [1500, 400, 300], [5000, 5000, 750]]) {
    const [nx, ny] = tileCounts(W, H, r);
    assert.ok(Math.hypot(W / nx, H / ny) / 2 <= r + 1e-6, `${W}x${H}`);
    assert.ok(nx * ny > 1);
  }
});

test('intersectIntervals', () => {
  assert.deepEqual(intersectIntervals([[0, 10], [20, 30]], [[5, 25]]), [[5, 10], [20, 25]]);
  assert.deepEqual(intersectIntervals([[0, 10]], [[11, 12]]), []);
});

test('rangeTiles returns null for a small area and covering tiles for a big one', () => {
  assert.equal(rangeTiles(rect(500, 500), 0, 610), null);
  const big = rect(2500, 1800);
  const tiles = rangeTiles(big, 0, 610, { pad: 30 });
  assert.ok(tiles.length >= 4);
  for (const t of tiles) assert.ok(farthest(t.center, t.clip) <= 610 + 1, 'tile corner beyond range');
});

test('a big grid split into tiles: every waypoint is within range of its zone launch point, and coverage is kept', () => {
  const big = rect(2400, 1600);
  const range = 610;
  const m = gridMetrics(cam, base.alt, base.front, base.side);
  const pad = Math.max(m.lineSpacing * 0.51, m.photoSpacing);
  const tiles = rangeTiles(big, 0, range, { pad });
  const pieces = tiles.map(t => planGrid(big, { ...base, clip: t.clip }).waypoints).filter(p => p.length);
  const zones = groupPieces(pieces, range);
  assert.ok(zones.length > 1);
  for (const z of zones) {
    const pts = z.pieces.flatMap(i => pieces[i]);
    assert.ok(farthest(z.launch, pts) <= range + 1);
  }
  // Every photo point of the unsplit plan has a photo point nearby in the split plan.
  const whole = planGrid(big, base).waypoints;
  const split = pieces.flat();
  const tol = Math.hypot(m.lineSpacing, m.photoSpacing);
  for (const w of whole.filter((_, i) => i % 7 === 0)) {
    assert.ok(split.some(p => haversine(p, w) <= tol), 'gap in coverage');
  }
});

test('groupPieces lets nearby small pieces share one launch point', () => {
  const a = planGrid(rect(200, 200), base).waypoints;
  const b = planGrid(rect(200, 200, 300, 0), base).waypoints;
  const far = planGrid(rect(200, 200, 3000, 0), base).waypoints;
  const zones = groupPieces([a, b, far], 610);
  assert.equal(zones.length, 2);
  assert.deepEqual(zones[0].pieces, [0, 1]);
});

test('launchFor is the middle of the points', () => {
  const l = launchFor(rect(1000, 400));
  assert.ok(haversine(l, proj.toLL(500, 200)) < 1);
});

test('planGrid marks line ends as corners and keeps the heading locked', () => {
  const r = planGrid(rect(400, 300), { ...base, alt: 60, lockHeading: true, angle: 30 });
  const w = r.waypoints;
  assert.ok(w[0].corner && w.at(-1).corner);
  assert.ok(w.some(p => !p.corner), 'points along a line are not corners');
  assert.ok(w.every(p => p.heading === 30));
  // Corners come in pairs at each line end.
  assert.equal(w.filter(p => p.corner).length % 2, 0);
  const free = planGrid(rect(400, 300), { ...base, alt: 60 });
  assert.ok(free.waypoints.every(p => p.heading === undefined));
});

test('crosshatch with locked heading turns 90 degrees for the second pass', () => {
  const r = planGrid(rect(300, 300), { ...base, alt: 60, lockHeading: true, crosshatch: true, angle: 0 });
  const hs = new Set(r.waypoints.map(p => p.heading));
  assert.deepEqual([...hs].sort((a, b) => a - b), [0, 90]);
});

test('autoSpeed is capped by blur, photo gap and the maximum', () => {
  const high = gridMetrics(cam, 120, 70, 60);
  assert.equal(autoSpeed(high), MAX_AUTO_SPEED);
  const low = gridMetrics(cam, 35, 80, 70);
  const s = autoSpeed(low);
  assert.ok(s < MAX_AUTO_SPEED);
  assert.ok(s <= low.photoSpacing / MIN_PHOTO_GAP + 1e-9);
  assert.ok(s <= 0.5 * low.gsd / 100 * 1000 + 1e-9);
  assert.ok(autoSpeed(low, { moving: false }) >= s);
});
