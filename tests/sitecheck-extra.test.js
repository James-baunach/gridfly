import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKp, kpAt, kpWords, kpLevel, kpSummary, judgeHour, laancAdvice, parseParks } from '../web/js/sitecheck.js';
import { weatherDays } from '../web/js/presets.js';

// Captured from services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json (shortened).
const KP_SAMPLE = [
  { time_tag: '2026-11-17T00:00:00', kp: 3.00, observed: 'observed', noaa_scale: null },
  { time_tag: '2026-11-17T03:00:00', kp: 2.67, observed: 'observed', noaa_scale: null },
  { time_tag: '2026-11-17T06:00:00', kp: 3.33, observed: 'estimated', noaa_scale: null },
  { time_tag: '2026-11-17T09:00:00', kp: 5.33, observed: 'predicted', noaa_scale: 'G1' },
  { time_tag: '2026-11-17T12:00:00', kp: 7.00, observed: 'predicted', noaa_scale: 'G3' },
  { time_tag: 'garbage', kp: 1 },
];

test('parseKp reads NOAA rows as UTC slots and drops junk', () => {
  const s = parseKp(KP_SAMPLE);
  assert.equal(s.length, 5);
  assert.equal(s[0].time, Date.UTC(2026, 10, 17, 0));
  assert.equal(s[4].kp, 7);
  assert.deepEqual(parseKp(null), []);
  assert.equal(parseKp([{ time_tag: '2026-11-09T00:00:00', Kp: 3.33 }])[0].kp, 3.33); // observed-index spelling
});

test('kpAt finds the 3 hour slot', () => {
  const s = parseKp(KP_SAMPLE);
  assert.equal(kpAt(s, Date.UTC(2026, 10, 17, 10, 30)), 5.33);
  assert.equal(kpAt(s, Date.UTC(2026, 10, 17, 14, 59)), 7);
  assert.equal(kpAt(s, Date.UTC(2026, 10, 17, 15, 0)), null);
  assert.equal(kpAt(null, Date.now()), null);
});

test('kp words and levels', () => {
  assert.equal(kpWords(2), 'quiet');
  assert.equal(kpWords(5), 'minor geomagnetic storm');
  assert.equal(kpWords(7.33), 'strong geomagnetic storm');
  assert.equal(kpLevel(4.67), 'good');
  assert.equal(kpLevel(5), 'ok');
  assert.equal(kpLevel(7), 'bad');
});

test('kpSummary gives now and the peak ahead', () => {
  const s = parseKp(KP_SAMPLE);
  const r = kpSummary(s, new Date(Date.UTC(2026, 10, 17, 7)), 24);
  assert.equal(r.now, 3.33);
  assert.equal(r.peak, 7);
  assert.equal(r.peakAt.getTime(), Date.UTC(2026, 10, 17, 12));
  assert.equal(kpSummary(s, new Date(Date.UTC(2026, 10, 20)), 24), null);
});

test('Kp 5+ is a caution, 7+ is bad in the hourly verdict', () => {
  const base = { wind10: 3, wind80: 4, wind120: 5, gusts: 5, cloud: 20, rain: 0, temp: 15, sunElevation: 50 };
  assert.equal(judgeHour({ ...base, kp: 4.67 }).verdict, 'good');
  const ok = judgeHour({ ...base, kp: 5 });
  assert.equal(ok.verdict, 'ok');
  assert.match(ok.reasons[0], /Kp 5/);
  assert.equal(judgeHour({ ...base, kp: 7 }).verdict, 'bad');
  assert.equal(judgeHour({ ...base, kp: null }).verdict, 'good');
});

test('laancAdvice', () => {
  assert.equal(laancAdvice([], 60), null);
  assert.equal(laancAdvice(undefined, 60), null);
  const a = laancAdvice([{ ceiling: 200, airport: 'BLUEGRASS' }, { ceiling: 400, airport: 'BLUEGRASS' }], 70);
  assert.equal(a.lowestFt, 200);
  assert.equal(a.overCeiling, true); // 70 m = 230 ft
  assert.deepEqual(a.airports, ['BLUEGRASS']);
  assert.equal(laancAdvice([{ ceiling: 400, airport: '' }], 70).overCeiling, false);
  assert.equal(laancAdvice([{ ceiling: 0, airport: 'X' }], 30).zero, true);
});

test('parseParks keeps NPS land and drops wilderness overlays', () => {
  const els = [
    { type: 'relation', tags: { boundary: 'protected_area', name: 'Yosemite National Park', operator: 'National Park Service', protect_class: '2' } },
    { type: 'relation', tags: { boundary: 'protected_area', name: 'Yosemite Wilderness', operator: 'National Park Service', protect_class: '1b', protected_area: 'wilderness_preserve' } },
    { type: 'relation', tags: { boundary: 'protected_area', name: 'Yosemite National Park', operator: 'National Park Service' } },
  ];
  assert.deepEqual(parseParks(els), ['Yosemite National Park']);
  assert.deepEqual(parseParks([]), []);
  assert.deepEqual(parseParks(undefined), []);
});

test('weatherDays can cover seven days with short labels after tomorrow', () => {
  const now = new Date(2026, 5, 10, 8, 30);
  const hours = [];
  for (let d = 0; d < 7; d++) for (let h = 9; h < 13; h++) hours.push({ time: new Date(2026, 5, 10 + d, h), verdict: 'good', reasons: [] });
  const days = weatherDays(hours, now, 7);
  assert.equal(days.length, 7);
  assert.deepEqual(days.slice(0, 2).map(d => d.label), ['Today', 'Tomorrow']);
  assert.ok(days[2].label.length > 3 && days.every(d => d.verdict === 'good' && d.windows.length === 1));
});
