import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  lon2x, lat2y, tileUrl, boundsOf, bufferBounds, tileRange, countTiles, tilesOf, downloadPlan, chooseMaxZoom,
  planHasTile, latticeNodes, fmtBytes, TILE_LAYERS, TILE_BUDGET,
} from '../web/js/offline.js';
import * as store from '../web/js/store.js';

const WEB = new URL('../web/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

test('tile maths matches the standard web-mercator scheme', () => {
  assert.equal(lon2x(-180, 0), 0);
  assert.equal(lat2y(0, 1), 1);
  assert.equal(lon2x(0, 1), 1);
  // London at zoom 10: x 511, y 340.
  assert.equal(lon2x(-0.1276, 10), 511);
  assert.equal(lat2y(51.5072, 10), 340);
  assert.equal(lat2y(89.9, 3), 0);
  assert.equal(lat2y(-89.9, 3), 7);
  assert.equal(tileUrl(TILE_LAYERS.satellite.url, { z: 3, x: 1, y: 2 }).endsWith('/tile/3/2/1'), true);
  assert.equal(tileUrl(TILE_LAYERS.streets.url, { z: 3, x: 1, y: 2 }).endsWith('/3/1/2.png'), true);
});

test('bounds and buffers', () => {
  assert.equal(boundsOf([]), null);
  const b = boundsOf([{ lat: 40, lon: -105 }, { lat: 40.01, lon: -104.99 }]);
  assert.deepEqual(b, { s: 40, w: -105, n: 40.01, e: -104.99 });
  const g = bufferBounds(b, 1000);
  assert.ok(Math.abs((b.s - g.s) * 111320 - 1000) < 1);
  assert.ok(g.w < b.w && g.e > b.e);
});

test('download plans count distinct tiles and stay within budget', () => {
  const b = boundsOf([{ lat: 40, lon: -105 }, { lat: 40.01, lon: -104.99 }]); // ~1 km square
  const plan = downloadPlan(b, 18);
  const n = countTiles(plan);
  assert.equal([...tilesOf(plan)].length, n);
  assert.ok(n > 100 && n < 3000, `tile count ${n}`);
  const z = chooseMaxZoom(b);
  assert.ok(z >= 18 && countTiles(downloadPlan(b, z)) <= TILE_BUDGET);
  // A huge area falls back to a coarse zoom.
  const big = boundsOf([{ lat: 39, lon: -106 }, { lat: 41, lon: -104 }]);
  assert.ok(chooseMaxZoom(big) < 15);
  const t = [...tilesOf(plan)].at(-1);
  assert.equal(planHasTile(plan, t), true);
  assert.equal(planHasTile(plan, { ...t, z: 20 }), false);
  const r = tileRange(b, 18);
  assert.ok(r.x1 >= r.x0 && r.y1 >= r.y0);
});

test('elevation lattice and byte formatting', () => {
  const keys = latticeNodes({ s: 0, w: 0, n: 0.001, e: 0.001 }, 0.0004);
  assert.equal(keys.length, 16);
  assert.equal(fmtBytes(2048), '2 KB');
  assert.equal(fmtBytes(5 * 1024 * 1024), '5.0 MB');
});

test('store falls back to memory without IndexedDB', async () => {
  await store.setMany('elev', [['1,2', 100], ['1,3', 101]]);
  assert.deepEqual(await store.getMany('elev', ['1,2', '9,9']), [100, undefined]);
  await store.set('areas', 'a', { id: 'a' });
  assert.deepEqual(await store.all('areas'), [{ id: 'a' }]);
  await store.del('areas', 'a');
  assert.equal(await store.count('areas'), 0);
});

test('service worker precaches every app file', () => {
  const sw = readFileSync(join(WEB, 'sw.js'), 'utf8');
  const list = JSON.parse('[' + sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].replace(/'/g, '"').replace(/,\s*$/, '') + ']');
  const files = [];
  const walk = d => readdirSync(d).forEach(f => { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(relative(WEB, p).split(sep).join('/')); });
  walk(WEB);
  const needed = files.filter(f => f !== 'sw.js' && !/LICENSE$/.test(f));
  const missing = needed.filter(f => !list.includes(f));
  assert.deepEqual(missing, [], 'add these to SHELL in web/sw.js and bump VERSION');
  const extra = list.filter(f => f !== './' && !files.includes(f));
  assert.deepEqual(extra, [], 'SHELL lists files that do not exist');
});

test('manifest is valid and its icons exist', () => {
  const m = JSON.parse(readFileSync(join(WEB, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some(i => i.sizes === '512x512' && i.purpose === 'maskable'));
  for (const i of m.icons) assert.ok(statSync(join(WEB, i.src)).size > 0, i.src);
});
