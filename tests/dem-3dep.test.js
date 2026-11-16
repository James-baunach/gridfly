import test from 'node:test';
import assert from 'node:assert/strict';
import { TILE, PX, tileOf, tileBounds, tilesFor, tileUrl, decodeTile, sampleTile, covers3dep } from '../web/js/dem-3dep.js';
import { decodeTile as decodeDsm, analyzeClearance, clearanceMessage, tileUrl as dsmUrl } from '../web/js/dsm-ky.js';
import { sampleTile as sampleKy, PX as KPX } from '../web/js/lidar-ky.js';
import { groundHeights, SOURCES } from '../web/js/terrain.js';

function fakeTile(fn, px = PX) {
  const f = new Float32Array(px * px);
  for (let r = 0; r < px; r++) for (let c = 0; c < px; c++) f[r * px + c] = fn(r, c);
  const buf = new ArrayBuffer(f.byteLength + px * px / 8);
  new Float32Array(buf, 0, f.length).set(f);
  return buf;
}

test('3DEP tile maths and url', () => {
  const t = tileOf(38.2009, -84.8733), b = tileBounds(t.i, t.j);
  assert.ok(b.s <= 38.2009 && 38.2009 < b.n && b.w <= -84.8733 && -84.8733 < b.e);
  assert.equal(tilesFor({ s: b.s + 0.001, w: b.w + 0.001, n: b.n + 0.001, e: b.e + 0.001 }).length, 4);
  const u = new URL(tileUrl(t.i, t.j));
  assert.equal(u.host, 'elevation.nationalmap.gov');
  assert.equal(u.searchParams.get('format'), 'bsq');
  assert.equal(u.searchParams.get('size'), `${PX},${PX}`);
});

test('3DEP gate is the Kentucky box for now', () => {
  assert.equal(covers3dep([{ lat: 38.2, lon: -84.87 }]), true);
  assert.equal(covers3dep([{ lat: 38.2, lon: -84.87 }, { lat: 40, lon: -84 }]), false);
  assert.equal(covers3dep([]), false);
});

test('3DEP decode and sample, no-data never blended', () => {
  const data = decodeTile(fakeTile((r, c) => 150 + c * 0.5));
  const i = 1910, j = -4244, b = tileBounds(i, j);
  const lonAt = c => b.w + (c + 0.5) / PX * TILE, latAt = r => b.n - (r + 0.5) / PX * TILE;
  assert.ok(Math.abs(sampleTile(data, i, j, latAt(10), lonAt(20)) - 160) < 0.06);
  assert.ok(Math.abs(sampleTile(data, i, j, latAt(10), (lonAt(20) + lonAt(21)) / 2) - 160.25) < 0.06);
  assert.equal(sampleTile(null, i, j, latAt(1), lonAt(1)), null);
  const half = decodeTile(fakeTile(r => (r < PX / 2 ? 0 : 200)));
  assert.equal(sampleTile(half, i, j, b.n - TILE * 0.1, b.w + TILE / 2), null);
  assert.ok(Math.abs(sampleTile(half, i, j, b.s + TILE * 0.1, b.w + TILE / 2) - 200) < 0.06);
  assert.equal(decodeTile(fakeTile(() => 0)), null);
  assert.throws(() => decodeTile(new ArrayBuffer(16)), /incomplete/);
});

test('DSM decode converts US survey feet to metres and shares the ground tile sampling', () => {
  const data = decodeDsm(fakeTile(() => 1000, KPX));
  const v = sampleKy(data, 1910, -4244, 1910.5 * TILE, -4243.5 * TILE);
  assert.ok(Math.abs(v - 304.8006) < 0.06);
  assert.ok(dsmUrl(1910, -4244).includes('Ky_DSM_First_Return_2FT_Phase2'));
});

test('clearance analysis and messages', () => {
  const mk = clear => [{ d: 0, drone: 300, ground: 250, surface: 260 }, { d: 50, drone: 300, ground: 250, surface: 300 - clear }];
  assert.equal(analyzeClearance([]), null);
  assert.equal(analyzeClearance([{ d: 0, drone: 300, ground: null, surface: null }]), null);
  const ok = analyzeClearance(mk(40));
  assert.equal(ok.level, 'ok'); assert.equal(clearanceMessage(ok), null);
  const low = analyzeClearance(mk(10));
  assert.equal(low.level, 'low'); assert.equal(low.minClear, 10); assert.equal(low.tallest, 40); assert.equal(low.minAt, 50);
  assert.match(clearanceMessage(low), /40 m high.*10 m above/);
  const hit = analyzeClearance(mk(-2));
  assert.equal(hit.level, 'hit'); assert.match(clearanceMessage(hit), /will hit/);
  assert.equal(analyzeClearance(mk(5)).level, 'low'); // exactly 5 m is not "hit"
});

// ---- source selection, with fake services ----
function service({ ky = 'ok', d3 = 'ok', om = 'ok' } = {}) {
  const calls = [];
  globalThis.fetch = async url => {
    url = String(url);
    const host = new URL(url).host;
    calls.push(host);
    const png = (px, v) => ({ ok: true, status: 200, arrayBuffer: async () => fakeTile(() => v, px) });
    if (host === 'kyraster.ky.gov') return ky === 'ok' ? png(KPX, 200) : ky === 'down' ? { ok: false, status: 404 } : png(KPX, 0);
    if (host === 'elevation.nationalmap.gov') return d3 === 'ok' ? png(PX, 210) : d3 === 'down' ? { ok: false, status: 404 } : png(PX, 0);
    return om === 'ok' ? { ok: true, status: 200, json: async () => ({ elevation: Array(100).fill(220) }) } : { ok: false, status: 500 };
  };
  return calls;
}
// distinct points per test so tile caches in terrain.js never hide a service
const P = n => [{ lat: 37.0 + n * 0.1, lon: -85.0 }, { lat: 37.001 + n * 0.1, lon: -85.001 }];

test('source order: Kentucky LiDAR, then 3DEP, then worldwide', async () => {
  service();
  let r = await groundHeights(P(1));
  assert.equal(r.source, 'ky'); assert.equal(r.note, null); assert.equal(r.all[0], 200);
  service({ ky: 'nodata' });
  r = await groundHeights(P(2));
  assert.equal(r.source, 'd3'); assert.match(r.note, /outside the Kentucky LiDAR/); assert.ok(Math.abs(r.all[0] - 210) < 0.06);
  service({ ky: 'down', d3: 'down' });
  r = await groundHeights(P(3));
  assert.equal(r.source, 'global'); assert.match(r.note, /Kentucky LiDAR not available.*USGS 3DEP not available/);
});

test('outside the gate goes straight to worldwide and never mixes sources', async () => {
  const calls = service();
  const r = await groundHeights([{ lat: 41, lon: -85 }, { lat: 41.001, lon: -85 }]);
  assert.equal(r.source, 'global');
  assert.ok(!calls.includes('kyraster.ky.gov') && !calls.includes('elevation.nationalmap.gov'));
  assert.ok(r.all.every(v => v === 220));
  assert.ok(SOURCES.d3.short.includes('3DEP'));
});
