import test from 'node:test';
import assert from 'node:assert/strict';
import { TILE, PX, tileOf, tileBounds, tilesFor, tileUrl, decodeTile, sampleTile, inKentuckyBox } from '../web/js/lidar-ky.js';

// A synthetic service answer: heights rising 1 m per pixel eastwards from 150 m, plus a mask block.
function fakeTile(fn) {
  const f = new Float32Array(PX * PX);
  for (let r = 0; r < PX; r++) for (let c = 0; c < PX; c++) f[r * PX + c] = fn(r, c);
  const buf = new ArrayBuffer(f.byteLength + PX * PX / 8);
  new Float32Array(buf, 0, f.length).set(f);
  return buf;
}

test('tiles cover a point and its bounds', () => {
  const t = tileOf(38.2009, -84.8733);
  const b = tileBounds(t.i, t.j);
  assert.ok(b.s <= 38.2009 && 38.2009 < b.n && b.w <= -84.8733 && -84.8733 < b.e);
  assert.equal(tilesFor({ s: 38.2009, w: -84.8733, n: 38.2009, e: -84.8733 }).length, 1);
  assert.equal(tilesFor({ s: b.s + 0.001, w: b.w + 0.001, n: b.n + 0.001, e: b.e + 0.001 }).length, 4);
  const u = new URL(tileUrl(t.i, t.j));
  assert.equal(u.searchParams.get('size'), `${PX},${PX}`);
  assert.equal(u.searchParams.get('bbox').split(',').length, 4);
});

test('Kentucky box', () => {
  assert.equal(inKentuckyBox([{ lat: 38.2, lon: -84.87 }, { lat: 37.0, lon: -83.0 }]), true);
  assert.equal(inKentuckyBox([{ lat: 38.2, lon: -84.87 }, { lat: 40.0, lon: -83.0 }]), false);
  assert.equal(inKentuckyBox([]), false);
});

test('decode and sample interpolate between pixel centres', () => {
  const data = decodeTile(fakeTile((r, c) => 150 + c));
  const i = 1910, j = -4244; // tile containing 38.2, -84.87
  const b = tileBounds(i, j);
  const lonAt = c => b.w + (c + 0.5) / PX * TILE;
  const latAt = r => b.n - (r + 0.5) / PX * TILE;
  assert.ok(Math.abs(sampleTile(data, i, j, latAt(10), lonAt(20)) - 170) < 1e-6);
  assert.ok(Math.abs(sampleTile(data, i, j, latAt(10), (lonAt(20) + lonAt(21)) / 2) - 170.5) < 0.06);
  assert.equal(sampleTile(null, i, j, latAt(1), lonAt(1)), null);
});

test('no-data pixels (0 m) are never blended into a height', () => {
  // North half has no data, like a tile across the Ohio River.
  const data = decodeTile(fakeTile(r => (r < PX / 2 ? 0 : 200)));
  const i = 1954, j = -4226;
  const b = tileBounds(i, j);
  assert.equal(sampleTile(data, i, j, b.n - TILE * 0.1, b.w + TILE / 2), null);
  assert.equal(sampleTile(data, i, j, b.s + TILE * 0.1, b.w + TILE / 2), 200);
  assert.equal(sampleTile(data, i, j, b.n - TILE * 0.5, b.w + TILE / 2), null); // on the boundary
  assert.equal(decodeTile(fakeTile(() => 0)), null);
  assert.throws(() => decodeTile(new ArrayBuffer(16)), /incomplete/);
});
