import test from 'node:test';
import assert from 'node:assert/strict';
import { toMerc, fromMerc, photoQuad, usablePhoto, mosaicLayout, drawWidth, worldFile, groundOverlayKml, odmOptions, odmFlags, boundaryGeoJson } from '../web/js/mosaic.js';

const cam = { sensorW: 17.3, sensorH: 13.0, focal: 12.29, imageW: 5280 };
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('web mercator round trip', () => {
  const [x, y] = toMerc(38.15, -84.52);
  const p = fromMerc(x, y);
  close(p.lat, 38.15, 1e-9, 'lat');
  close(p.lon, -84.52, 1e-9, 'lon');
});

test('photo quad has the ground size of the photo, scaled for Mercator, with the top towards the heading', () => {
  const lat = 38.15, h = 100;
  const k = 1 / Math.cos(lat * Math.PI / 180);
  const q = photoQuad({ lat, lon: -84.5, height: h, yaw: 0 }, cam);
  const [tl, tr, br, bl] = q;
  close(tr[0] - tl[0], cam.sensorW * h / cam.focal * k, 1e-6, 'width along x when facing north');
  close(tl[1] - bl[1], cam.sensorH * h / cam.focal * k, 1e-6, 'height along y when facing north');
  assert.ok(tl[1] > br[1], 'top of the image is north');
  // Facing east, the top edge is on the east side.
  const e = photoQuad({ lat, lon: -84.5, height: h, yaw: 90 }, cam);
  assert.ok(e[0][0] > e[3][0] && e[1][0] > e[2][0], 'top of the image is east');
  // Cropping keeps the middle.
  const c = photoQuad({ lat, lon: -84.5, height: h, yaw: 0 }, cam, 0.5);
  close(c[1][0] - c[0][0], (tr[0] - tl[0]) / 2, 1e-6, 'crop halves the width');
});

test('only nadir photos with a position and height are usable', () => {
  assert.equal(usablePhoto({ lat: 1, lon: 2, relAlt: 80, gimbalPitch: -90 }), true);
  assert.equal(usablePhoto({ lat: 1, lon: 2, relAlt: 80, gimbalPitch: null }), true);
  assert.equal(usablePhoto({ lat: 1, lon: 2, relAlt: 80, gimbalPitch: -45 }), false);
  assert.equal(usablePhoto({ lat: null, lon: 2, relAlt: 80 }), false);
  assert.equal(usablePhoto({ lat: 1, lon: 2, relAlt: null }), false);
});

test('layout fits every photo on the canvas, within the size limit', () => {
  const items = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) items.push({ lat: 38.15 + i * 0.0004, lon: -84.52 + j * 0.0006, height: 70, yaw: 0 });
  const lay = mosaicLayout(items, cam, { maxPx: 2000, crop: 0.6 });
  assert.ok(Math.max(lay.width, lay.height) <= 2000);
  assert.equal(lay.place.length, items.length);
  for (const [a, b, c, d, e, f] of lay.place) {
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const x = a * u + c * v + e, y = b * u + d * v + f;
      assert.ok(x >= -1e-6 && x <= lay.width + 1e-6 && y >= -1e-6 && y <= lay.height + 1e-6, 'corner inside the canvas');
    }
  }
  // Facing north, the image's top edge runs along +x and its left edge down +y.
  const [a, b, c, d] = lay.place[0];
  assert.ok(a > 0 && Math.abs(b) < 1e-9 && Math.abs(c) < 1e-9 && d > 0);
  assert.ok(drawWidth(lay.place[0]) > 0);
  assert.ok(lay.bounds.n > lay.bounds.s && lay.bounds.e > lay.bounds.w);
  // Never finer than asked.
  const coarse = mosaicLayout(items, cam, { maxPx: 100000, crop: 0.6, minMpp: 0.5 });
  close(coarse.mpp, 0.5, 1e-12, 'minMpp');
});

test('world file and KML describe the same corners', () => {
  const lay = mosaicLayout([{ lat: 38.15, lon: -84.52, height: 70, yaw: 30 }], cam, { maxPx: 1000 });
  const w = worldFile(lay).trim().split('\n').map(Number);
  close(w[0], lay.mpp, 1e-6, 'pixel width');
  close(w[3], -lay.mpp, 1e-6, 'pixel height');
  close(w[4] - lay.mpp / 2, lay.merc.x0, 1e-5, 'left edge');
  close(w[5] + lay.mpp / 2, lay.merc.y1, 1e-5, 'top edge');
  const kml = groundOverlayKml(lay, { name: 'A & B' });
  assert.match(kml, /<north>38\.\d+<\/north>/);
  assert.match(kml, /A &amp; B/);
});

test('OpenDroneMap options follow the mission', () => {
  const b = boundaryGeoJson([{ lat: 1, lon: 2 }, { lat: 1, lon: 3 }, { lat: 2, lon: 3 }]);
  assert.deepEqual(b.features[0].geometry.coordinates[0][0], b.features[0].geometry.coordinates[0].at(-1));
  const grid = odmOptions({ goal: 'grid', gsdCm: 1.934, boundary: b });
  assert.deepEqual(grid.find(o => o.name === 'orthophoto-resolution'), { name: 'orthophoto-resolution', value: 1.93 });
  assert.ok(grid.find(o => o.name === 'boundary'));
  assert.ok(!grid.find(o => o.name === 'dsm'));
  const three = odmOptions({ goal: '3d', gsdCm: 2 });
  assert.ok(three.find(o => o.name === 'dsm'));
  assert.equal(odmFlags(three), '--orthophoto-resolution 2 --dsm --pc-quality high');
  assert.equal(boundaryGeoJson([]), null);
});
