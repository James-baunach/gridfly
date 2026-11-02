import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPhotoMeta, blurScore, flagBlurry, footprint, coverage } from '../web/js/photocheck.js';
import { CAMERAS } from '../web/js/grid.js';
import { makeProjection, haversine } from '../web/js/geo.js';

const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 };
function enc(le, type, vals) {
  if (type === 2) return [...Buffer.from(vals + '\0', 'latin1')];
  const b = Buffer.alloc(SIZE[type] * (type === 5 ? vals.length / 2 : vals.length));
  vals.forEach((v, i) => {
    if (type === 1) b.writeUInt8(v, i);
    else if (type === 3) le ? b.writeUInt16LE(v, i * 2) : b.writeUInt16BE(v, i * 2);
    else le ? b.writeUInt32LE(v, i * 4) : b.writeUInt32BE(v, i * 4);
  });
  return [...b];
}
const count = (type, vals) => type === 2 ? vals.length + 1 : type === 5 ? vals.length / 2 : vals.length;

// entries: {tag, type, vals}; offsets are relative to the TIFF header at `base`
function ifd(le, entries, base) {
  const head = 2 + entries.length * 12 + 4;
  const data = [], out = [...enc(le, 3, [entries.length])];
  for (const e of entries) {
    const bytes = enc(le, e.type, e.vals);
    out.push(...enc(le, 3, [e.tag]), ...enc(le, 3, [e.type]), ...enc(le, 4, [count(e.type, e.vals)]));
    if (bytes.length <= 4) out.push(...bytes, ...new Array(4 - bytes.length).fill(0));
    else { out.push(...enc(le, 4, [base + head + data.length])); data.push(...bytes); if (data.length % 2) data.push(0); }
  }
  out.push(0, 0, 0, 0, ...data);
  return out;
}

function makeJpeg(le, { xmp } = {}) {
  const exifE = [
    { tag: 0x9003, type: 2, vals: '2024:05:06 07:08:09' },
    { tag: 0xa002, type: 4, vals: [5280] }, { tag: 0xa003, type: 4, vals: [3956] },
    { tag: 0x920a, type: 5, vals: [1229, 100] },
  ];
  const ifd0Len = 2 + 2 * 12 + 4;
  const exOff = 8 + ifd0Len, gpsOff = exOff + ifd(le, exifE, exOff).length;
  const tiff = [le ? 0x49 : 0x4d, le ? 0x49 : 0x4d, ...enc(le, 3, [42]), ...enc(le, 4, [8]),
    ...ifd(le, [{ tag: 0x8769, type: 4, vals: [exOff] }, { tag: 0x8825, type: 4, vals: [gpsOff] }], 8),
    ...ifd(le, exifE, exOff),
    ...ifd(le, [
      { tag: 1, type: 2, vals: 'S' }, { tag: 2, type: 5, vals: [33, 1, 30, 1, 36, 1] },
      { tag: 3, type: 2, vals: 'E' }, { tag: 4, type: 5, vals: [151, 1, 12, 1, 0, 1] },
      { tag: 5, type: 1, vals: [0] }, { tag: 6, type: 5, vals: [1234, 10] },
    ], gpsOff)];
  const exif = [...Buffer.from('Exif\0\0', 'latin1'), ...tiff];
  const seg = (m, body) => [0xff, m, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
  const x = xmp ?? '<x:xmpmeta><rdf:Description drone-dji:AbsoluteAltitude="+85.50" drone-dji:RelativeAltitude="+60.10" drone-dji:GimbalYawDegree="+10.0" drone-dji:FlightYawDegree="+90.5" drone-dji:GimbalPitchDegree="-89.90"/></x:xmpmeta>';
  const xmpBody = [...Buffer.from('http://ns.adobe.com/xap/1.0/\0' + x, 'latin1')];
  return new Uint8Array([0xff, 0xd8, ...seg(0xe1, exif), ...seg(0xe1, xmpBody), 0xff, 0xd9]).buffer;
}

for (const le of [true, false]) {
  test(`readPhotoMeta ${le ? 'little' : 'big'} endian`, () => {
    const m = readPhotoMeta(makeJpeg(le));
    assert.ok(Math.abs(m.lat - -33.51) < 1e-9);
    assert.ok(Math.abs(m.lon - 151.2) < 1e-9);
    assert.equal(m.width, 5280);
    assert.equal(m.height, 3956);
    assert.ok(Math.abs(m.focal - 12.29) < 1e-9);
    assert.equal(m.time.toISOString(), '2024-05-06T07:08:09.000Z');
    assert.equal(m.relAlt, 60.1);
    assert.equal(m.absAlt, 85.5);
    assert.equal(m.gimbalPitch, -89.9);
    assert.equal(m.yaw, 90.5);
  });
}

test('readPhotoMeta element-style XMP, GimbalYaw fallback, garbage input', () => {
  const m = readPhotoMeta(makeJpeg(true, { xmp: '<drone-dji:RelativeAltitude>+12.5</drone-dji:RelativeAltitude><drone-dji:GimbalYawDegree>-45.0</drone-dji:GimbalYawDegree>' }));
  assert.equal(m.relAlt, 12.5);
  assert.equal(m.yaw, -45);
  assert.equal(m.gimbalPitch, null);
  assert.ok(Math.abs(m.absAlt - 123.4) < 1e-9); // falls back to GPS altitude
  assert.equal(readPhotoMeta(new Uint8Array([1, 2, 3]).buffer).lat, null);
  assert.equal(readPhotoMeta(makeJpeg(true).slice(0, 60)).relAlt, null); // truncated
});

const img = (w, h, f) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = f(x, y), i = (y * w + x) * 4; data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255; }
  return { width: w, height: h, data };
};

test('blurScore: sharp checkerboard beats smooth gradient and flat', () => {
  const sharp = blurScore(img(64, 64, (x, y) => ((x >> 1) + (y >> 1)) % 2 ? 255 : 0));
  const soft = blurScore(img(64, 64, x => x * 4));
  assert.ok(sharp > soft * 100);
  assert.equal(blurScore(img(64, 64, () => 128)), 0);
});

test('flagBlurry', () => {
  assert.deepEqual(flagBlurry([100, 100, 10, 100]), []);
  assert.deepEqual(flagBlurry([100, 110, 20, 105, 95, 40]), [2, 5]);
  assert.deepEqual(flagBlurry([100, 110, 90, 105, 95, NaN]), []);
});

test('footprint size and orientation', () => {
  const cam = CAMERAS.mavic3;
  const meta = { lat: 45, lon: 10, relAlt: 100, gimbalPitch: -90, yaw: 0 };
  const f = footprint(meta, cam);
  assert.ok(Math.abs(haversine(f[0], f[1]) - 17.3 * 100 / 12.29) < 0.5);
  assert.ok(Math.abs(haversine(f[1], f[2]) - 13 * 100 / 12.29) < 0.5);
  const f90 = footprint({ ...meta, yaw: 90 }, cam); // heading east: long side runs north-south
  assert.ok(Math.abs(haversine(f90[0], f90[1]) - 17.3 * 100 / 12.29) < 0.5);
  assert.equal(footprint({ ...meta, gimbalPitch: -45 }, cam), null);
  assert.equal(footprint({ ...meta, relAlt: null }, cam), null);
});

const proj = makeProjection(45, 10);
const sq = (cx, cy, hx, hy) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => proj.toLL(cx + a * hx, cy + b * hy));
const area = sq(0, 0, 50, 50);

test('coverage: full, partial and none', () => {
  const full = coverage(area, [sq(0, 0, 80, 80)], 4, 1);
  assert.equal(full.pctCovered, 100);
  assert.equal(full.pctGood, 100);
  assert.equal(full.gaps.length, 0);
  const half = coverage(area, [sq(-50, 0, 50, 80)], 4, 1);
  assert.ok(half.pctCovered > 45 && half.pctCovered < 55);
  assert.equal(half.gaps.length, 1);
  assert.ok(half.gaps[0].length >= 4);
  const none = coverage(area, [], 4, 4);
  assert.equal(none.pctCovered, 0);
  assert.equal(none.gaps.length, 1);
});

test('coverage: minOverlapCount', () => {
  const fps = [sq(0, 0, 80, 80), sq(0, 0, 80, 80)];
  assert.equal(coverage(area, fps, 4, 2).pctGood, 100);
  assert.equal(coverage(area, fps, 4, 3).pctGood, 0);
});
