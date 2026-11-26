// Quick map ("mosaic") from geotagged drone photos, made in the browser.
//
// This is not photogrammetry: every nadir photo is laid on the ground where its GPS position, height and heading
// say it looked, and only the middle of each photo is used (the part nearest straight down), so neighbours meet
// with small seams. It is good for checking coverage and seeing the site on the day; for a survey-grade map use
// OpenDroneMap. Pure maths here (testable in Node); drawing is in ui-mapmake.js.

const RAD = Math.PI / 180;
export const R_EARTH = 6378137; // Web Mercator sphere radius, metres

/** Web Mercator, in metres (EPSG:3857). */
export const toMerc = (lat, lon) => [R_EARTH * lon * RAD, R_EARTH * Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2))];
export const fromMerc = (x, y) => ({ lat: (2 * Math.atan(Math.exp(y / R_EARTH)) - Math.PI / 2) / RAD, lon: x / R_EARTH / RAD });

/**
 * Ground corners of a nadir photo, in Web Mercator metres, ordered like the image: top-left, top-right,
 * bottom-right, bottom-left. The top of the image points along `yaw` (degrees clockwise from north).
 * `crop` (0..1] keeps only that middle fraction of the photo.
 */
export function photoQuad({ lat, lon, height, yaw = 0 }, cam, crop = 1) {
  const hw = cam.sensorW * height / cam.focal / 2 * crop; // half the ground width (image left-right)
  const hh = cam.sensorH * height / cam.focal / 2 * crop; // half the ground height (image up-down)
  // Mercator stretches distances by 1/cos(lat): scale the ground metres to match.
  const k = 1 / Math.cos(lat * RAD);
  const [cx, cy] = toMerc(lat, lon);
  const a = yaw * RAD;
  const up = [Math.sin(a), Math.cos(a)], right = [Math.cos(a), -Math.sin(a)];
  const at = (sx, sy) => [cx + k * (right[0] * sx * hw + up[0] * sy * hh), cy + k * (right[1] * sx * hw + up[1] * sy * hh)];
  return [at(-1, 1), at(1, 1), at(1, -1), at(-1, -1)];
}

/** Which photos can go in a quick map: GPS, a height above takeoff and the camera looking (nearly) straight down. */
export function usablePhoto(meta) {
  if (meta.lat == null || meta.lon == null || !(meta.relAlt > 2)) return false;
  return meta.gimbalPitch == null || Math.abs(meta.gimbalPitch + 90) <= 12;
}

/**
 * Lays the photos out on one canvas.
 * items: [{ lat, lon, height, yaw }]. Returns the canvas size, its corners (lat/lon and Mercator) and, per photo,
 * the affine transform [a, b, c, d, e, f] (canvas setTransform order) that maps the unit square onto its quad.
 * The canvas is at most maxPx on its long side and never finer than the photos themselves (minMpp metres/pixel).
 */
export function mosaicLayout(items, cam, { maxPx = 4096, crop = 0.62, minMpp = 0 } = {}) {
  const quads = items.map(it => photoQuad(it, cam, crop));
  if (!quads.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of quads) for (const [x, y] of q) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const w = x1 - x0, h = y1 - y0;
  if (!(w > 0 && h > 0)) return null;
  const mpp = Math.max(Math.max(w, h) / maxPx, minMpp); // Mercator metres per canvas pixel
  const width = Math.max(1, Math.ceil(w / mpp)), height = Math.max(1, Math.ceil(h / mpp));
  const px = ([x, y]) => [(x - x0) / mpp, (y1 - y) / mpp];
  const place = quads.map(q => {
    const [tl, tr, , bl] = q.map(px);
    return [tr[0] - tl[0], tr[1] - tl[1], bl[0] - tl[0], bl[1] - tl[1], tl[0], tl[1]];
  });
  const sw = fromMerc(x0, y0), ne = fromMerc(x1, y1);
  return { width, height, mpp, merc: { x0, y0, x1, y1 }, bounds: { s: sw.lat, w: sw.lon, n: ne.lat, e: ne.lon }, place, quads };
}

/** Pixels a photo needs to be drawn without wasting detail: the ground width of its quad on the canvas. */
export function drawWidth(place) {
  const [a, b] = place;
  return Math.hypot(a, b);
}

/** World file (.pgw) for the canvas in EPSG:3857: pixel size, rotation terms, then the centre of the top-left pixel. */
export function worldFile({ mpp, merc }) {
  return [mpp, 0, 0, -mpp, merc.x0 + mpp / 2, merc.y1 - mpp / 2].map(v => v.toFixed(6)).join('\n') + '\n';
}

export const WEB_MERCATOR_PRJ = 'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1],AXIS["X",EAST],AXIS["Y",NORTH],EXTENSION["PROJ4","+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs"]]';

/** KML that lays the image on Google Earth. Google Earth stretches an overlay linearly in latitude, which for a
 *  site-sized map differs from Web Mercator by far less than a pixel. */
export function groundOverlayKml({ bounds }, { name = 'GridFly quick map', href = 'quickmap.png' } = {}) {
  const e = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<GroundOverlay>
  <name>${e(name)}</name>
  <Icon><href>${e(href)}</href></Icon>
  <LatLonBox><north>${bounds.n.toFixed(8)}</north><south>${bounds.s.toFixed(8)}</south><east>${bounds.e.toFixed(8)}</east><west>${bounds.w.toFixed(8)}</west></LatLonBox>
</GroundOverlay>
</kml>
`;
}

// ---------- OpenDroneMap ----------

/** Processing options matched to the mission: the detail it was flown for, and a 3D model for 3D goals. */
export function odmOptions({ goal = 'grid', gsdCm = null, boundary = null } = {}) {
  const o = [];
  if (gsdCm > 0) o.push({ name: 'orthophoto-resolution', value: +gsdCm.toFixed(2) });
  if (goal === '3d' || goal === 'orbit') o.push({ name: 'dsm', value: true }, { name: 'pc-quality', value: 'high' });
  if (boundary) o.push({ name: 'boundary', value: JSON.stringify(boundary) });
  return o;
}

/** The same options as command-line flags, for ODM or WebODM's custom settings. */
export function odmFlags(options) {
  return options.filter(o => o.name !== 'boundary').map(o => o.value === true ? `--${o.name}` : o.value === false ? '' : `--${o.name} ${o.value}`).filter(Boolean).join(' ');
}

/** GeoJSON polygon of the survey area (outer ring of the first area), for ODM's --boundary. */
export function boundaryGeoJson(polygon) {
  if (!polygon || polygon.length < 3) return null;
  const ring = polygon.map(p => [+p.lon.toFixed(8), +p.lat.toFixed(8)]);
  ring.push(ring[0]);
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'GridFly survey area' }, geometry: { type: 'Polygon', coordinates: [ring] } }] };
}

/** NodeODM task status codes. */
export const ODM_STATUS = { 10: 'queued', 20: 'running', 30: 'failed', 40: 'completed', 50: 'canceled' };
