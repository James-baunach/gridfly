import test from 'node:test';
import assert from 'node:assert/strict';
import { sunPosition, sunTimes, goodLightWindow } from '../web/js/sun.js';

const DEN = [39.7392, -104.9903];
const minutesApart = (a, iso) => Math.abs(a.getTime() - Date.parse(iso)) / 60000;

test('Denver summer solstice sunrise/sunset (5:32 and 20:31 MDT)', () => {
  const t = sunTimes(new Date('2026-06-21T18:00:00Z'), ...DEN);
  assert.ok(minutesApart(t.sunrise, '2026-06-21T11:32:00Z') < 4);
  assert.ok(minutesApart(t.sunset, '2026-06-22T02:31:00Z') < 4);
  assert.ok(minutesApart(t.solarNoon, '2026-06-21T19:02:00Z') < 4);
});

test('Denver winter solstice sunrise/sunset (7:17 and 16:38 MST)', () => {
  const t = sunTimes(new Date('2026-12-21T18:00:00Z'), ...DEN);
  assert.ok(minutesApart(t.sunrise, '2026-12-21T14:17:00Z') < 4);
  assert.ok(minutesApart(t.sunset, '2026-12-21T23:38:00Z') < 4);
});

test('sun position', () => {
  const noon = sunPosition(new Date('2026-06-21T19:02:00Z'), ...DEN);
  assert.ok(Math.abs(noon.elevation - (90 - 39.74 + 23.44)) < 0.5);
  assert.ok(Math.abs(noon.azimuth - 180) < 2);
  const night = sunPosition(new Date('2026-06-21T08:00:00Z'), ...DEN);
  assert.ok(night.elevation < 0);
  const morning = sunPosition(new Date('2026-06-21T14:00:00Z'), ...DEN);
  assert.ok(morning.azimuth > 60 && morning.azimuth < 120);
});

test('polar day and night give null', () => {
  const day = sunTimes(new Date('2026-06-21T12:00:00Z'), 80, 0);
  assert.equal(day.sunrise, null);
  assert.equal(day.sunset, null);
  assert.equal(sunTimes(new Date('2026-12-21T12:00:00Z'), 80, 0).sunrise, null);
});

test('good light window', () => {
  const w = goodLightWindow(new Date('2026-06-21T18:00:00Z'), ...DEN, 30);
  assert.ok(w.start < w.end);
  assert.ok(Math.abs(sunPosition(w.start, ...DEN).elevation - 30) < 0.5);
  assert.equal(goodLightWindow(new Date('2026-12-21T18:00:00Z'), ...DEN, 30), null);
});
