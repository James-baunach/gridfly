import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGeoJSON, toKml, projectToJson, projectFromJson, bytesToBase64, base64ToBytes, microSdReadme } from '../web/js/exporters.js';

const polygon = [{ lat: 45, lon: 10 }, { lat: 45, lon: 10.001 }, { lat: 45.001, lon: 10.001 }];
const home = { lat: 44.999, lon: 10 };
const missions = [
  { points: [{ lat: 45, lon: 10, height: 60, photo: true }, { lat: 45.0005, lon: 10, height: 60, photo: false }], time: 120.4, distance: 55.5 },
  { points: [{ lat: 45, lon: 10.0005, height: 60, photo: true }], time: 30, distance: 0, name: 'A & <B>' },
];

test('toGeoJSON', () => {
  const g = toGeoJSON({ polygon, missions, home });
  assert.equal(g.type, 'FeatureCollection');
  const by = k => g.features.filter(f => f.properties.kind === k);
  assert.equal(by('survey_area')[0].geometry.coordinates[0].length, 4);
  assert.deepEqual(by('mission').map(f => f.properties.mission), [1, 2]);
  assert.equal(by('mission')[0].properties.waypoints, 2);
  assert.equal(by('mission')[0].properties.distance_m, 56);
  assert.equal(by('mission')[0].properties.time_s, 120);
  assert.equal(by('photo').length, 2);
  assert.equal(by('photo')[0].properties.height, 60);
  assert.deepEqual(by('home')[0].geometry.coordinates, [10, 44.999]);
  assert.equal(toGeoJSON({}).features.length, 0);
});

test('toKml', () => {
  const k = toKml({ polygon, missions, home, name: 'Field <1> & co' });
  assert.ok(k.startsWith('<?xml'));
  assert.ok(k.includes('<name>Field &lt;1&gt; &amp; co</name>'));
  assert.ok(k.includes('A &amp; &lt;B&gt;'));
  assert.equal((k.match(/<LineString>/g) || []).length, 2);
  assert.ok(k.includes('#m0') && k.includes('#m1'));
  assert.ok(k.includes('10,45,0 10.001,45,0'));
  assert.ok(k.includes('clampToGround'));
});

test('base64 round trip', () => {
  const u8 = new Uint8Array(70000).map((_, i) => i * 7);
  assert.deepEqual(base64ToBytes(bytesToBase64(u8)), u8);
});

test('project round trip', () => {
  const p = { polygon, waypoints: missions[0].points, home, homeGround: 12.5, settings: { alt: 60 }, generated: { x: 1 }, fileName: 'a.kmz', sourceKmzBase64: 'AAEC', junk: 1 };
  const out = projectFromJson(projectToJson(p));
  assert.equal(out.junk, undefined);
  assert.equal(out.app, 'gridfly');
  assert.deepEqual(out.polygon, polygon);
  assert.deepEqual(out.waypoints, p.waypoints);
  assert.equal(out.homeGround, 12.5);
  assert.equal(out.sourceKmzBase64, 'AAEC');
  assert.equal(out.fileName, 'a.kmz');
});

test('project tolerates missing optional fields', () => {
  const out = projectFromJson('{"app":"gridfly","version":1}');
  assert.deepEqual(out.polygon, []);
  assert.deepEqual(out.waypoints, []);
  assert.equal(out.home, null);
  assert.deepEqual(out.settings, {});
});

test('project validation errors', () => {
  assert.throws(() => projectFromJson('nope'), /valid GridFly project/);
  assert.throws(() => projectFromJson('{"app":"other","version":1}'), /not a GridFly/);
  assert.throws(() => projectFromJson('{"app":"gridfly"}'), /version/);
  assert.throws(() => projectFromJson('{"app":"gridfly","version":9}'), /newer/);
  assert.throws(() => projectFromJson('{"app":"gridfly","version":1,"polygon":[{"lat":1}]}'), /point 1/);
  assert.throws(() => projectFromJson('{"app":"gridfly","version":1,"waypoints":5}'), /list/);
  assert.throws(() => projectFromJson('{"app":"gridfly","version":1,"home":{"lat":"x"}}'), /home/);
});

test('microSdReadme', () => {
  const t = microSdReadme([{ name: 'a_1-of-2.kmz' }, { name: 'a_2-of-2.kmz' }]);
  assert.ok(t.includes('2 mission files'));
  assert.ok(t.includes('a_2-of-2.kmz'));
  assert.ok(t.includes('Android'));
  assert.ok(t.includes('dji.go.v5'));
  assert.ok(t.includes('EXACTLY'));
  assert.ok(microSdReadme([{ name: 'x.kmz' }]).includes('1 mission file '));
});
