import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChecklist, checklistHtml, checklistText } from '../web/js/checklist.js';

const home = { lat: 40, lon: -105 };
const pt = (dx, h) => ({ lat: 40, lon: -105 + dx / 85300, height: h, speed: 5, photo: true, gimbalPitch: -90 }); // ~85.3 km per degree lon at 40N
const base = (over = {}) => ({
  missions: [{ points: [pt(0, 60), pt(450, 64.2)], time: 300, distance: 450 }, { points: [pt(100, 60)], time: 100, distance: 100 }],
  home, homeGround: 1600, droneKey: 'mavic3', controller: 'rc', captureMode: 'waypoint', interval: null, alt: 60, gsd: 1.6, photoCount: 500, finishAction: 'return to home', ...over,
});
const find = (c, id, re) => c.sections.find(s => s.id === id).items.find(i => re.test(i.text));

test('batteries and SD card', () => {
  const c = buildChecklist(base());
  assert.equal(find(c, 'home', /Charge/).value, '3');
  assert.equal(find(c, 'home', /SD card/).value, '6.0 GB');
  assert.equal(find(c, 'home', /placeholder/).value, '2');
  assert.equal(buildChecklist(base({ photoCount: 2000 })).sections[0].items.find(i => /SD card/.test(i.text)).value, '24 GB');
});

test('safety settings rounding', () => {
  const c = buildChecklist(base());
  // max height 64.2 -> (74.2/10) ceil -> 80; RTH 79.2 -> 80; farthest ~450 m +100 -> 600
  assert.equal(find(c, 'settings', /Max altitude/).value, '80 m or more');
  assert.equal(find(c, 'settings', /Return-to-home/).value, '80 m or more');
  assert.match(find(c, 'settings', /Max distance/).value, /^600 m/);
  const exact = buildChecklist(base({ missions: [{ points: [pt(0, 60), pt(50, 60)] }] }));
  assert.equal(find(exact, 'settings', /Max altitude/).value, '70 m or more');
  assert.equal(find(exact, 'settings', /Return-to-home/).value, '75 m or more');
  assert.match(find(exact, 'settings', /Max distance/).value, /^200 m/);
});

test('timer vs waypoint camera mode', () => {
  assert.match(find(buildChecklist(base()), 'camera', /Photo mode/).text, /Single shot/);
  const t = find(buildChecklist(base({ captureMode: 'timer', interval: 2.5 })), 'camera', /Photo mode/);
  assert.match(t.text, /Timed Shot/);
  assert.match(t.value, /2\.5 s/);
});

test('stop items', () => {
  assert.equal(buildChecklist(base()).ready, true);
  const empty = buildChecklist(base({ missions: [] }));
  assert.equal(empty.ready, false);
  assert.ok(empty.sections[0].items.some(i => i.level === 'stop'));
  const high = buildChecklist(base({ missions: [{ points: [pt(0, 121)] }] }));
  assert.equal(high.ready, false);
  assert.ok(high.sections[0].items.some(i => i.level === 'stop' && /120 m/.test(i.text)));
  const low = buildChecklist(base({ missions: [{ points: [pt(0, 2)] }] }));
  assert.equal(low.ready, false);
  assert.equal(buildChecklist(base({ missions: [{ points: [pt(0, 120)] }] })).ready, true);
});

test('html is escaped and text renders', () => {
  const c = buildChecklist(base());
  c.sections[0].items.push({ text: '<script>alert(1)</script>', level: 'todo' });
  const html = checklistHtml(c, { title: 'A & B' });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('A &amp; B'));
  assert.ok(html.includes('type="checkbox"'));
  const txt = checklistText(c);
  assert.match(txt, /BEFORE YOU LEAVE HOME/);
  assert.match(txt, /\[ \] Charge 3 batteries/);
});
