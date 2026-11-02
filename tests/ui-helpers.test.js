import test from 'node:test';
import assert from 'node:assert/strict';
import { toDisplay, fromDisplay, fmtLen, fmtDistance, fmtSmall, tidy } from '../web/js/units.js';
import {
  GOALS, qualityParams, qualityMatch, detailWords, autoMargin, recommendTimer, circlePolygon, rectPolygon, pointInPolygon,
  nearestEdgePoint, curvedRule, obstacleWarnings, airspaceWarnings, weatherDays, coverageCellSize,
} from '../web/js/presets.js';
import { haversine, polygonAreaM2 } from '../web/js/geo.js';

test('units convert both ways and format', () => {
  assert.equal(toDisplay(100, 'm'), 100);
  assert.ok(Math.abs(fromDisplay(toDisplay(60, 'ft'), 'ft') - 60) < 1e-9);
  assert.equal(fmtLen(30.48, 'ft'), '100 ft');
  assert.equal(fmtDistance(1500, 'm'), '1.50 km');
  assert.equal(fmtDistance(300, 'ft'), '984 ft');
  assert.equal(fmtSmall(2.1, 'm'), '2.1 cm');
  assert.equal(fmtSmall(2.54, 'ft'), '1.0 in');
  assert.ok(Math.abs(tidy(91, 'ft', 50) - 91.44) < 1e-9);
});

test('quality presets map to altitude and overlap per goal', () => {
  assert.deepEqual(qualityParams('grid', 1), { alt: 70, front: 75, side: 65 });
  assert.deepEqual(qualityParams('3d', 1), { alt: 70, front: 80, side: 70 });
  assert.deepEqual(qualityParams('grid', 0), { alt: 90, front: 70, side: 60 });
  assert.deepEqual(qualityParams('grid', 2), { alt: 50, front: 80, side: 70 });
  assert.equal(qualityMatch('grid', 70, 75, 65), 1);
  assert.equal(qualityMatch('grid', 71, 75, 65), -1);
  assert.equal(GOALS['3d'].crosshatch, true);
  assert.match(detailWords(2, 'm'), /2\.0 cm/);
});

test('margin and timer recommendation', () => {
  assert.equal(autoMargin({ across: 98.6 }), 49);
  assert.equal(recommendTimer(400), false);
  assert.equal(recommendTimer(401), true);
  assert.equal(recommendTimer(250, 100), true);
});

test('shapes', () => {
  const c = { lat: 40, lon: -105 };
  const poly = circlePolygon(c, 100, 36);
  assert.equal(poly.length, 36);
  assert.ok(poly.every(p => Math.abs(haversine(c, p) - 100) < 0.5));
  assert.ok(Math.abs(polygonAreaM2(poly) - Math.PI * 100 * 100) < 300);
  const r = rectPolygon({ lat: 1, lon: 2 }, { lat: 0, lon: 3 });
  assert.equal(r.length, 4);
  assert.ok(pointInPolygon({ lat: 0.5, lon: 2.5 }, r));
  assert.ok(!pointInPolygon({ lat: 2, lon: 2.5 }, r));
});

test('nearestEdgePoint snaps onto the outline', () => {
  const sq = rectPolygon({ lat: 0.001, lon: 0 }, { lat: 0, lon: 0.001 });
  const p = nearestEdgePoint(sq, { lat: 0.0005, lon: -0.002 });
  assert.ok(Math.abs(p.lon - 0) < 1e-7);
  assert.ok(Math.abs(p.lat - 0.0005) < 1e-6);
  const line = [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }];
  const q = nearestEdgePoint(line, { lat: 0.001, lon: 0.002 }, false);
  assert.ok(Math.abs(q.lon - 0.001) < 1e-7);
});

test('curved path rule', () => {
  assert.deepEqual(curvedRule({ turnMode: 'curved', hasPhoto: true, edited: false }), { disableCurved: true, switchToStraight: false, warnLoaded: true });
  assert.equal(curvedRule({ turnMode: 'curved', hasPhoto: true, edited: true }).switchToStraight, true);
  assert.equal(curvedRule({ turnMode: 'keep', sourceCurved: true, hasPhoto: true, edited: true }).switchToStraight, true);
  assert.equal(curvedRule({ turnMode: 'keep', sourceCurved: false, hasPhoto: true, edited: true }).switchToStraight, false);
  assert.equal(curvedRule({ turnMode: 'curved', hasPhoto: false, edited: true }).switchToStraight, false);
});

test('site check warnings', () => {
  const area = rectPolygon({ lat: 0.001, lon: 0 }, { lat: 0, lon: 0.001 });
  const obs = [
    { type: 'tower', lat: 0.0005, lon: 0.0005, height: 80 },
    { type: 'building', lat: 0.0005, lon: 0.0005, height: 20 },
    { type: 'tower', lat: 0.05, lon: 0.05, height: 200 },
  ];
  assert.deepEqual(obstacleWarnings(obs, area, 60).map(o => o.height), [80]);
  assert.equal(obstacleWarnings(obs, area, 90).length, 0);
  const cells = [{ ceiling: 0 }, { ceiling: 200 }, { ceiling: 400 }];
  assert.equal(airspaceWarnings(cells, 65).length, 2); // 65 m = 213 ft
  assert.equal(airspaceWarnings(cells, 140).length, 3); // 459 ft
});

test('weather days summarise windows', () => {
  const now = new Date(2026, 5, 10, 8, 30);
  const hours = [];
  for (let h = 8; h < 20; h++) hours.push({ time: new Date(2026, 5, 10, h), verdict: h < 10 ? 'bad' : h < 15 ? 'good' : 'ok', reasons: [] });
  for (let h = 8; h < 12; h++) hours.push({ time: new Date(2026, 5, 11, h), verdict: 'bad', reasons: [] });
  const [today, tomorrow] = weatherDays(hours, now);
  assert.equal(today.verdict, 'good');
  assert.equal(today.windows.length, 1);
  assert.equal(today.windows[0].start.getHours(), 10);
  assert.equal(today.windows[0].end.getHours(), 15);
  assert.equal(tomorrow.verdict, 'bad');
});

test('coverage cell size grows with area', () => {
  assert.equal(coverageCellSize(10000), 4);
  assert.ok(coverageCellSize(5e7) > 40);
});
