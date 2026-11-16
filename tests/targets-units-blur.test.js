import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMERAS, gridMetrics } from '../web/js/grid.js';
import { altForGsd, clampAlt, solveForDetail, solveForBatteries } from '../web/js/targets.js';
import { blurPixels, movingPhotos, neededShutter, speedForShutter } from '../web/js/blur.js';
import { fmtSpeed, fmtArea, toSpeed, fromSpeed, toGsd, fromGsd, qtyText, FT } from '../web/js/units.js';
import { buildChecklist, checklistText } from '../web/js/checklist.js';
import { judgeHour } from '../web/js/sitecheck.js';

const cam = CAMERAS.mavic3;

test('height for a detail target is the inverse of gridMetrics', () => {
  const alt = altForGsd(cam, 2);
  assert.ok(Math.abs(gridMetrics(cam, alt, 75, 65).gsd - 2) < 1e-9);
  const r = solveForDetail(cam, 2);
  assert.equal(r.alt, Math.round(alt));
  assert.equal(r.clamped, null);
  assert.equal(solveForDetail(cam, 0.01).clamped, 'low');
  assert.equal(solveForDetail(cam, 0.01).alt, 5);
  assert.equal(solveForDetail(cam, 50).clamped, 'high');
  assert.equal(solveForDetail(cam, 50).alt, 500);
  assert.equal(solveForDetail(cam, -1), null);
  assert.deepEqual(clampAlt(70), { alt: 70, clamped: null });
});

test('battery solver finds the lowest height that fits', () => {
  const missionsAt = alt => Math.ceil(10000 / (alt * alt)) ; // monotonic, falls with height
  const r = solveForBatteries(3, missionsAt);
  assert.equal(r.fits, true);
  assert.ok(missionsAt(r.alt) <= 3 && missionsAt(r.alt - 1) > 3);
  assert.equal(r.missions, missionsAt(r.alt));
  const none = solveForBatteries(1, () => 4);
  assert.deepEqual(none, { fits: false, alt: 120, missions: 4 });
  // Not monotonic: fits only in a middle band of heights. The lowest fitting height is still found.
  const band = solveForBatteries(2, alt => (alt >= 60 && alt <= 90 ? 2 : 3));
  assert.deepEqual(band, { fits: true, alt: 60, missions: 2 });
  const easy = solveForBatteries(5, () => 1);
  assert.equal(easy.alt, 5);
  assert.equal(solveForBatteries(2, () => Infinity).fits, false);
  const ft = solveForBatteries(3, missionsAt, { step: FT });
  assert.ok(Math.abs(ft.alt / FT - Math.round(ft.alt / FT)) < 1e-9);
});

test('speed, area and detail follow the unit', () => {
  assert.equal(fmtSpeed(5, 'm'), '5.0 m/s');
  assert.equal(fmtSpeed(4.4704, 'ft'), '10.0 mph');
  assert.ok(Math.abs(fromSpeed(toSpeed(7, 'ft'), 'ft') - 7) < 1e-9);
  assert.equal(fmtArea(20000, 'm'), '2.00 ha');
  assert.ok(!/acre/.test(fmtArea(20000, 'm')));
  assert.equal(fmtArea(20234.28, 'ft'), '5.00 acres');
  assert.ok(!/ ha/.test(fmtArea(20000, 'ft')));
  assert.ok(Math.abs(fromGsd(toGsd(2, 'ft'), 'ft') - 2) < 1e-9);
  assert.equal(qtyText('speed', 5, 'm'), '5');
  assert.equal(qtyText('speed', 5, 'ft'), '11.2');
  assert.equal(qtyText('gsd', 2.54, 'ft'), '1');
  assert.equal(qtyText('len', 70, 'ft'), '230');
});

test('wind messages follow the unit', () => {
  const h = { wind10: 12, wind80: 12, wind120: 12, gusts: 13, sunElevation: 50 };
  assert.match(judgeHour(h, 60, 'm').reasons.join(' '), /m\/s/);
  const f = judgeHour(h, 60, 'ft').reasons.join(' ');
  assert.match(f, /mph/);
  assert.ok(!/m\/s/.test(f));
});

test('motion blur maths and shutter choice', () => {
  assert.ok(Math.abs(blurPixels(5, 1 / 1000, 1) - 0.5) < 1e-9);
  assert.equal(movingPhotos({ turnMode: 'straight-stop', captureMode: 'waypoint' }), false);
  assert.equal(movingPhotos({ turnMode: 'straight-pass', captureMode: 'waypoint' }), true);
  assert.equal(movingPhotos({ turnMode: 'straight-stop', captureMode: 'timer' }), true);
  assert.equal(neededShutter({ speed: 5, gsdCm: 2, moving: false }), null);
  const slow = neededShutter({ speed: 5, gsdCm: 2 }); // needs 1/400, but never slower than 1/1000
  assert.equal(slow.denominator, 1000);
  assert.equal(slow.tooFast, false);
  const fast = neededShutter({ speed: 15, gsdCm: 0.5 }); // 1/3000 -> next stop 1/3200
  assert.equal(fast.denominator, 3200);
  assert.equal(fast.tooFast, true);
  assert.equal(neededShutter({ speed: 15, gsdCm: 0.1 }).beyondCamera, true);
  assert.equal(speedForShutter(0.5), 5);
  assert.ok(blurPixels(speedForShutter(0.5), 1 / 1000, 0.5) <= 1);
});

const pt = (dx, h) => ({ lat: 40, lon: -105 + dx / 85300, height: h, speed: 5, photo: true });
const ctx = (over = {}) => ({ missions: [{ points: [pt(0, 60), pt(450, 64.2)] }], home: { lat: 40, lon: -105 }, homeGround: 1600, alt: 60, gsd: 1.6, photoCount: 100, ...over });
const shutter = c => c.sections.find(s => s.id === 'camera').items.find(i => /shutter/.test(i.text));

test('checklist shutter follows the planned speed and detail', () => {
  assert.equal(shutter(buildChecklist(ctx())).value, '1/1000 s+');
  assert.equal(shutter(buildChecklist(ctx({ moving: true, speed: 5, gsd: 2 }))).value, '1/1000 s+');
  const c = buildChecklist(ctx({ moving: true, speed: 15, gsd: 0.5 }));
  assert.equal(shutter(c).value, '1/3200 s+');
  assert.match(shutter(c).text, /1\/3200 s or faster/);
});

test('checklist uses feet and mph in feet mode', () => {
  const c = buildChecklist(ctx({ unit: 'ft', moving: true, speed: 15, gsd: 0.5 }));
  const txt = checklistText(c);
  assert.match(txt, /ft or more/);
  assert.match(txt, /mph/);
  assert.match(txt, /400 ft \(120 m\)|in per pixel/);
  assert.ok(!/\d m or more/.test(txt));
  const high = buildChecklist(ctx({ unit: 'ft', missions: [{ points: [pt(0, 121)] }] }));
  assert.ok(high.sections[0].items.some(i => i.level === 'stop' && /397 ft/.test(i.text) && /400 ft/.test(i.text)));
  assert.match(checklistText(buildChecklist(ctx())), /\d m or more/);
});
