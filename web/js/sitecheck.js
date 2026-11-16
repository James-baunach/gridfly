// Pre-flight site checks: weather (Open-Meteo), nearby obstacles (OSM Overpass), US airspace (FAA UAS Facility Map).

import { sunPosition } from './sun.js';
import { fmtSpeed } from './units.js';

const WEATHER_API = 'https://api.open-meteo.com/v1/forecast';
// Public Overpass instances, tried in order.
const OVERPASS_APIS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const FAA_API = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/ArcGIS/rest/services/FAA_UAS_FacilityMap_Data/FeatureServer/0/query';
export const FAA_VIEWER = 'https://faa.maps.arcgis.com/apps/webappviewer/index.html?id=9c2e4406710048e19806ebf6a06754ad';
// NOAA Space Weather Prediction Center: planetary K index, observed + 3-day forecast (CORS: Access-Control-Allow-Origin *).
const KP_API = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json';
// The FAA's TFR list and geometry services send no CORS headers, so a browser cannot read them: we only link to the site.
export const FAA_TFR_SITE = 'https://tfr.faa.gov/';
export const FAA_LAANC_PAGE = 'https://www.faa.gov/uas/getting_started/laanc';

const M_PER_DEG = 111320;
const lerp = (a, b, t) => a + (b - a) * t;

async function getJson(url, init, what) {
  let res;
  try { res = await fetch(url, init); }
  catch { throw new Error(`Could not reach the ${what} service. Check your internet connection and try again.`); }
  if (res.status === 429) throw new Error(`The ${what} service is busy (rate limited). Try again in a minute.`);
  if (!res.ok) throw new Error(`The ${what} service returned an error (${res.status}). Try again later.`);
  try { return await res.json(); }
  catch { throw new Error(`The ${what} service sent an unreadable answer.`); }
}

// Wind speed at `alt` m above ground, interpolated between the 10, 80 and 120 m forecast levels.
function windAt(h, alt) {
  const pts = [[10, h.wind10], [80, h.wind80], [120, h.wind120]].filter(p => p[1] != null);
  if (!pts.length) return null;
  if (alt <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (alt <= pts[i][0]) return lerp(pts[i - 1][1], pts[i][1], (alt - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]));
  }
  return pts[pts.length - 1][1];
}

export function judgeHour(h, flightAlt = 60, unit = 'm') {
  const sp = (ms, d = 1) => fmtSpeed(ms, unit, d);
  const bad = [], ok = [];
  const w = windAt(h, flightAlt);
  if (w != null) {
    if (w > 10) bad.push(`Wind at flight height ${sp(w)} (over ${sp(10, 0)})`);
    else if (w > 7) ok.push(`Breezy at flight height (${sp(w)})`);
  }
  if (h.gusts != null) {
    if (h.gusts > 12) bad.push(`Gusts ${sp(h.gusts)} (over ${sp(12, 0)})`);
    else if (h.gusts > 10) ok.push(`Gusty (${sp(h.gusts)})`);
  }
  if (h.rain != null && h.rain > 40) bad.push(`${Math.round(h.rain)}% chance of rain`);
  if (h.temp != null && h.temp < -10) bad.push(`Too cold (${Math.round(h.temp)} °C)`);
  if (h.temp != null && h.temp > 40) bad.push(`Too hot (${Math.round(h.temp)} °C)`);
  if (h.kp != null) {
    if (h.kp >= 7) bad.push(`Strong geomagnetic storm (Kp ${fmtKp(h.kp)}): GPS and compass may fail`);
    else if (h.kp >= 5) ok.push(`Geomagnetic storm (Kp ${fmtKp(h.kp)}): watch GPS and compass`);
  }
  if (h.sunElevation <= 0) bad.push('Sun below the horizon');
  else if (h.sunElevation < 25 && (h.cloud == null || h.cloud < 70)) ok.push(`Low sun (${Math.round(h.sunElevation)}°) makes long shadows`);
  return bad.length ? { verdict: 'bad', reasons: bad } : ok.length ? { verdict: 'ok', reasons: ok } : { verdict: 'good', reasons: [] };
}

const fmtKp = kp => (Math.round(kp * 10) / 10).toString();

// ---------- Geomagnetic activity (Kp) ----------

// NOAA rows -> [{ time (ms, start of the 3 h slot), kp, kind: 'observed'|'estimated'|'predicted' }], oldest first. Times are UTC.
export function parseKp(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(r => ({ time: Date.parse(String(r.time_tag ?? '') + 'Z'), kp: Number(r.kp ?? r.Kp), kind: r.observed || 'observed' }))
    .filter(r => Number.isFinite(r.time) && Number.isFinite(r.kp) && r.kp >= 0 && r.kp <= 9)
    .sort((a, b) => a.time - b.time);
}

// Kp of the 3-hour slot containing `time` (Date or ms), or null when the forecast does not reach it.
export function kpAt(slots, time) {
  const t = +time;
  const s = (slots || []).find(x => t >= x.time && t < x.time + 3 * 3600000);
  return s ? s.kp : null;
}

// Plain words for a Kp value.
export function kpWords(kp) {
  if (kp == null) return 'unknown';
  if (kp >= 8) return 'severe geomagnetic storm';
  if (kp >= 7) return 'strong geomagnetic storm';
  if (kp >= 6) return 'moderate geomagnetic storm';
  if (kp >= 5) return 'minor geomagnetic storm';
  if (kp >= 4) return 'a little unsettled';
  return 'quiet';
}

export const kpLevel = kp => kp == null ? null : kp >= 7 ? 'bad' : kp >= 5 ? 'ok' : 'good';

// Current Kp and the highest Kp in the next `hours` hours.
export function kpSummary(slots, now = new Date(), hours = 24) {
  const t = +now;
  const cur = (slots || []).find(x => t >= x.time && t < x.time + 3 * 3600000) || null;
  const ahead = (slots || []).filter(x => x.time + 3 * 3600000 > t && x.time < t + hours * 3600000);
  if (!cur && !ahead.length) return null;
  const peak = ahead.reduce((m, x) => (!m || x.kp > m.kp ? x : m), null);
  return { now: cur ? cur.kp : null, peak: peak ? peak.kp : null, peakAt: peak ? new Date(peak.time) : null, hours };
}

export async function fetchKp() {
  const slots = parseKp(await getJson(KP_API, undefined, 'geomagnetic (NOAA)'));
  if (!slots.length) throw new Error('The geomagnetic (NOAA) service returned no data.');
  return slots;
}

// ---------- LAANC ----------

// FAA grid cells (see fetchAirspace) -> what to tell the pilot, or null when the grid has nothing here.
// Any grid cell means controlled airspace near an airport, where authorisation is needed.
export function laancAdvice(cells, aglM) {
  const list = (cells || []).filter(c => Number.isFinite(c.ceiling));
  if (!list.length) return null;
  const lowest = Math.min(...list.map(c => c.ceiling));
  const aglFt = aglM / 0.3048;
  const airports = [...new Set(list.map(c => c.airport).filter(Boolean))];
  return { lowestFt: lowest, aglFt, airports, zero: lowest === 0, overCeiling: lowest < aglFt };
}

// ---------- US national parks ----------

// Overpass elements -> names of National Park Service land (drone launches are prohibited there). Wilderness overlays are ignored.
export function parseParks(elements) {
  const names = new Set();
  for (const el of elements || []) {
    const t = el.tags || {};
    if (!/National Park Service/i.test(t.operator || '')) continue;
    if (t.protected_area === 'wilderness_preserve' || t.protect_class === '1b') continue;
    names.add(t.name || 'a National Park Service area');
  }
  return [...names];
}

export async function fetchNationalPark(polygon) {
  if (!polygon?.length) return [];
  // The centre and up to 5 spread-out outline points: if any lies inside a park, the area touches it.
  const step = Math.max(1, Math.floor(polygon.length / 5));
  const pts = [centreOf(polygon), ...polygon.filter((_, i) => i % step === 0).slice(0, 5)];
  const q = '[out:json][timeout:25];' + pts.map((p, i) => `is_in(${p.lat.toFixed(5)},${p.lon.toFixed(5)})->.a${i};`).join('') +
    '(' + pts.map((_, i) => `rel(pivot.a${i})[boundary~"^(national_park|protected_area)$"][operator~"National Park Service"];`).join('') + ');out tags;';
  let d, lastErr;
  for (const url of OVERPASS_APIS) {
    try { d = await getJson(url, { method: 'POST', body: new URLSearchParams({ data: q }) }, 'national park (OpenStreetMap)'); break; }
    catch (e) { lastErr = e; }
  }
  if (!d) throw lastErr;
  if (!Array.isArray(d.elements)) throw new Error('The national park service returned no data.');
  return parseParks(d.elements);
}

function centreOf(poly) {
  return { lat: poly.reduce((a, p) => a + p.lat, 0) / poly.length, lon: poly.reduce((a, p) => a + p.lon, 0) / poly.length };
}

// Consecutive runs of 'good' hours; falls back to 'ok' runs when there are none.
export function findWindows(hours) {
  const runs = want => {
    const out = [];
    for (const h of hours) {
      if (h.verdict !== want) continue;
      const end = new Date(h.time.getTime() + 3600000);
      const last = out[out.length - 1];
      if (last && last.end.getTime() === h.time.getTime()) last.end = end;
      else out.push({ start: h.time, end, verdict: want });
    }
    return out;
  };
  const good = runs('good');
  return good.length ? good : runs('ok');
}

export async function fetchWeather(lat, lon, flightAlt = 60) {
  const p = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4),
    hourly: 'wind_speed_10m,wind_speed_80m,wind_speed_120m,wind_gusts_10m,cloud_cover,precipitation_probability,temperature_2m',
    wind_speed_unit: 'ms', timezone: 'auto', timeformat: 'unixtime', forecast_days: '7',
  });
  const d = await getJson(`${WEATHER_API}?${p}`, undefined, 'weather');
  const t = d.hourly?.time;
  if (!Array.isArray(t) || !t.length) throw new Error(d.reason || 'The weather service returned no forecast for this location.');
  const H = d.hourly;
  const since = Date.now() - 3600000;
  const hours = [];
  t.forEach((sec, i) => {
    const time = new Date(sec * 1000);
    if (time.getTime() < since) return;
    const h = {
      time, wind10: H.wind_speed_10m?.[i] ?? null, wind80: H.wind_speed_80m?.[i] ?? null, wind120: H.wind_speed_120m?.[i] ?? null,
      gusts: H.wind_gusts_10m?.[i] ?? null, cloud: H.cloud_cover?.[i] ?? null, rain: H.precipitation_probability?.[i] ?? null,
      temp: H.temperature_2m?.[i] ?? null,
      sunElevation: sunPosition(new Date(time.getTime() + 1800000), lat, lon).elevation, // mid-hour
    };
    hours.push({ ...h, ...judgeHour(h, flightAlt) });
  });
  return { hours, bestWindows: findWindows(hours) };
}

function bbox(polygon, bufferM) {
  const lats = polygon.map(p => p.lat), lons = polygon.map(p => p.lon);
  const s = Math.min(...lats), n = Math.max(...lats), w = Math.min(...lons), e = Math.max(...lons);
  const dLat = bufferM / M_PER_DEG, dLon = bufferM / (M_PER_DEG * Math.cos(((s + n) / 2) * Math.PI / 180));
  return { s: s - dLat, n: n + dLat, w: w - dLon, e: e + dLon };
}

function classify(tags) {
  const h = parseFloat(tags.height);
  if (tags.power === 'line' || tags.power === 'minor_line') return { type: 'power line', line: true, height: h || 15 };
  if (tags.power === 'tower') return { type: 'power tower', height: h || 30 };
  if (tags['generator:source'] === 'wind') return { type: 'wind turbine', height: h || parseFloat(tags['height:hub']) || 80 };
  if (tags.man_made === 'communications_tower') return { type: 'communications tower', height: h || 50 };
  if (tags.man_made === 'mast') return { type: 'mast', height: h || 30 };
  if (tags.man_made === 'tower') return { type: 'tower', height: h || 30 };
  if (tags.aeroway) return { type: 'aeroway: ' + tags.aeroway, height: h || 0 };
  if (tags.building) {
    const lv = parseFloat(tags['building:levels']);
    return { type: 'building', height: h || (lv ? lv * 3 : null) };
  }
  return null;
}

export async function fetchObstacles(polygon, bufferM = 150) {
  if (!polygon?.length) return [];
  const b = bbox(polygon, bufferM), box = `(${b.s},${b.w},${b.n},${b.e})`;
  const q = '[out:json][timeout:25];(' +
    `way[power~"^(line|minor_line)$"]${box};node[power=tower]${box};way[power=tower]${box};` +
    `node[man_made~"^(mast|tower|communications_tower)$"]${box};way[man_made~"^(mast|tower|communications_tower)$"]${box};` +
    `nwr[aeroway]${box};nwr["generator:source"=wind]${box};` +
    `way[building][height]${box};way[building]["building:levels"]${box};` +
    ');out tags geom;';
  let d, lastErr;
  for (const url of OVERPASS_APIS) {
    try { d = await getJson(url, { method: 'POST', body: new URLSearchParams({ data: q }) }, 'obstacle (OpenStreetMap)'); break; }
    catch (e) { lastErr = e; }
  }
  if (!d) throw lastErr;
  if (!Array.isArray(d.elements)) throw new Error('The obstacle service returned no data.');
  const out = [];
  for (const el of d.elements) {
    const tags = el.tags || {};
    const c = classify(tags);
    if (!c || c.height === null) continue;
    const geom = el.geometry?.map(g => ({ lat: g.lat, lon: g.lon })) ?? null;
    let { lat, lon } = el;
    if (lat === undefined && geom?.length) {
      lat = geom.reduce((a, g) => a + g.lat, 0) / geom.length;
      lon = geom.reduce((a, g) => a + g.lon, 0) / geom.length;
    }
    if (lat === undefined) continue;
    out.push({ type: c.type, name: tags.name || tags.ref || '', lat, lon, height: Math.round(c.height), geometry: c.line || (geom && geom.length <= 12) ? geom : null });
  }
  // when over the cap, keep non-building obstacles first, tallest first
  const rank = o => (o.type === 'building' ? 1 : 0);
  return out.sort((a, b) => rank(a) - rank(b) || b.height - a.height).slice(0, 300);
}

// US only: [] elsewhere. ceiling = feet AGL (0 means no flying without FAA authorisation).
// Throws a readable error if the FAA service fails; callers can fall back to FAA_VIEWER.
export async function fetchAirspace(polygon) {
  if (!polygon?.length) return [];
  const b = bbox(polygon, 0);
  const p = new URLSearchParams({
    f: 'json', where: '1=1', spatialRel: 'esriSpatialRelIntersects', geometryType: 'esriGeometryEnvelope',
    geometry: JSON.stringify({ xmin: b.w, ymin: b.s, xmax: b.e, ymax: b.n, spatialReference: { wkid: 4326 } }),
    outFields: 'CEILING,APT1_NAME,APT2_NAME,APT3_NAME', returnGeometry: 'true', outSR: '4326', resultRecordCount: '200',
  });
  const d = await getJson(`${FAA_API}?${p}`, undefined, 'FAA airspace');
  if (d.error) throw new Error('The FAA airspace service reported an error: ' + (d.error.message || d.error.code));
  return (d.features || []).map(f => {
    const a = f.attributes || {};
    return {
      ceiling: a.CEILING,
      airport: [a.APT1_NAME, a.APT2_NAME, a.APT3_NAME].filter(Boolean).join(', '),
      geometry: (f.geometry?.rings || []).map(r => r.map(([lon, lat]) => ({ lat, lon }))),
    };
  }).sort((x, y) => x.ceiling - y.ceiling);
}
