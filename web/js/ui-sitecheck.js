/* global L */
// Step 5: weather, light, airspace and obstacle checks for the planned area.

import { fetchWeather, fetchObstacles, fetchAirspace, judgeHour, FAA_VIEWER } from './sitecheck.js';
import { goodLightWindow, sunTimes } from './sun.js';
import { centroid } from './geo.js';
import { weatherDays, nowVerdict, obstacleWarnings, airspaceWarnings, metresToFeet } from './presets.js';
import { $, state, on, emit, esc, debounce, fmtLen } from './state.js';
import * as store from './store.js';
import { settings } from './plan.js';
import { layers } from './ui-map.js';

const S = { weather: null, wkey: null, obstacles: null, airspace: null, gkey: null, busy: {}, err: {}, savedAt: {} };
const hm = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const LABEL = { good: 'Good', ok: 'OK', bad: 'Not good' };

export function siteArea() {
  if (state.polygon.length >= 3) return state.polygon;
  if (state.waypoints.length) return state.waypoints;
  if (state.line.length >= 2) return state.line;
  if (state.center) return [state.center];
  return null;
}

// Flight height above ground used for the checks.
export function flightAgl() {
  const s = settings();
  return state.source && !state.plan && state.waypoints.length ? Math.max(...state.waypoints.map(w => w.height)) : s.alt;
}

// A saved forecast may be old and for another flight height: keep the hours still ahead and judge them again.
const upcoming = hours => {
  const agl = flightAgl();
  return hours.filter(h => new Date(h.time).getTime() >= Date.now() - 3600000)
    .map(h => ({ ...h, time: new Date(h.time), ...judgeHour(h, agl) }));
};

const pill = v => `<span class="pill ${v}">${LABEL[v] || '—'}</span>`;

// Results are saved per area so the checks can still be shown with no signal.
// A fresh answer replaces the saved one; a failed check falls back to the saved copy and says how old it is.
async function check(kind, key, fetcher, isCurrent) {
  const skey = kind + ':' + key;
  S.busy[kind] = true; S.err[kind] = null; S.savedAt[kind] = null;
  render();
  try {
    const data = await fetcher();
    if (!isCurrent()) return false;
    S[kind] = data;
    await store.set('site', skey, { at: Date.now(), data });
    return true;
  } catch (e) {
    if (!isCurrent()) return false;
    const saved = await store.get('site', skey);
    if (saved) { S[kind] = saved.data; S.savedAt[kind] = saved.at; }
    else { S[kind] = null; S.err[kind] = e.message; }
    return false;
  } finally {
    if (isCurrent()) { S.busy[kind] = false; render(); }
  }
}

function run(force = false) {
  const area = siteArea();
  if (!area) { render(); return Promise.resolve(); }
  const c = centroid(area);
  const agl = flightAgl();
  const gkey = JSON.stringify([c.lat.toFixed(3), c.lon.toFixed(3), area.length]);
  const wkey = gkey + Math.round(agl / 10);
  const jobs = [];
  if (force || wkey !== S.wkey) {
    S.wkey = wkey;
    // Saved by location only: the hours are judged again for the current height when shown.
    jobs.push(check('weather', gkey, () => fetchWeather(c.lat, c.lon, agl), () => S.wkey === wkey));
  }
  if (force || gkey !== S.gkey) {
    S.gkey = gkey;
    jobs.push(check('obstacles', gkey, () => fetchObstacles(area), () => S.gkey === gkey));
    jobs.push(check('airspace', gkey, () => fetchAirspace(area), () => S.gkey === gkey));
  }
  render();
  return Promise.all(jobs);
}

const ago = t => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 90 ? `${Math.max(1, m)} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `on ${new Date(t).toLocaleDateString()}`;
};
const savedNote = kind => S.savedAt[kind] ? `<p class="small saved-note">No connection: showing what was saved ${ago(S.savedAt[kind])}.</p>` : '';

function weatherCard(c) {
  if (S.busy.weather && !S.weather) return '<p class="muted small">Checking the forecast…</p>';
  if (S.err.weather) return `<p class="small">${esc(S.err.weather)}</p>`;
  if (!S.weather) return '<p class="muted small">Waiting for an area.</p>';
  const hours = upcoming(S.weather.hours);
  if (!hours.length) return `${savedNote('weather')}<p class="small">The saved forecast has run out. Check again when you have signal.</p>`;
  const now = nowVerdict(hours);
  const days = weatherDays(hours);
  const rows = days.map(d => `<div class="wxrow"><b>${d.label}</b> ${d.verdict ? pill(d.verdict) : ''}
    <span class="small">${d.windows.length ? d.windows.map(w => `${hm(w.start)}–${hm(w.end)}`).join(', ') : d.verdict ? 'no good window' : 'no data'}</span>
    <div class="strip">${d.hours.map(h => `<i class="${h.verdict}" title="${esc(hm(h.time) + ': ' + (h.reasons.join('; ') || 'looks good'))}"></i>`).join('')}</div></div>`).join('');
  const sun = sunTimes(new Date(), c.lat, c.lon), light = goodLightWindow(new Date(), c.lat, c.lon, 30);
  return `${savedNote('weather')}<div class="row between"><b>Right now</b> ${now ? pill(now.verdict) : ''}</div>
    ${now?.reasons.length ? `<p class="small muted">${esc(now.reasons.join('; '))}</p>` : ''}${rows}
    <p class="small"><b>Light:</b> ${sun.sunrise ? `sunrise ${hm(sun.sunrise)}, sunset ${hm(sun.sunset)}` : 'no sunrise or sunset today'}.
    ${light ? `Best light (sun above 30°): ${hm(light.start)}–${hm(light.end)}.` : 'The sun stays low today, so shadows will be long.'} Times are in your computer's time zone.</p>`;
}

function airspaceCard(agl) {
  const link = `<a href="${FAA_VIEWER}" target="_blank" rel="noopener">Open the FAA UAS Facility Map</a>`;
  if (S.busy.airspace && !S.airspace) return '<p class="muted small">Checking airspace…</p>';
  if (S.err.airspace) return `<p class="small">${esc(S.err.airspace)}</p><p class="small">${link} to check by hand.</p>`;
  if (!S.airspace) return '<p class="muted small">Waiting for an area.</p>';
  return savedNote('airspace') + airspaceBody(agl, link);
}

function airspaceBody(agl, link) {
  if (!S.airspace.length) return `<p class="small">No FAA grid cells here. That map only covers the United States, so elsewhere check your country's rules and an airspace app (for example Drone Assist or Altitude Angel). Also remember airports, parks and no-fly zones are not all in this data.</p><p class="small">${link}.</p>`;
  const low = airspaceWarnings(S.airspace, agl);
  const ceil = c => c.ceiling === 0 ? '0 ft (no flying without FAA authorisation)' : `${c.ceiling} ft`;
  return (low.length
    ? `<p class="bad-note"><b>Check before you fly:</b> the lowest ceiling here is ${ceil(low[0])}${low[0].airport ? ` near ${esc(low[0].airport)}` : ''}, below your flight height of ${Math.round(metresToFeet(agl))} ft. Lower the flight height or get authorisation (LAANC).</p>`
    : `<p class="small">Your flight height (${Math.round(metresToFeet(agl))} ft) is under the ceilings shown on the map.</p>`) +
    `<p class="small">${link} for the official picture.</p>`;
}

function obstacleCard(agl) {
  if (S.busy.obstacles && !S.obstacles) return '<p class="muted small">Looking for towers, power lines and tall buildings… (can take up to a minute)</p>';
  if (S.err.obstacles) return `<p class="small">${esc(S.err.obstacles)}</p>`;
  if (!S.obstacles) return '<p class="muted small">Waiting for an area.</p>';
  const warn = obstacleWarnings(S.obstacles, siteArea(), agl);
  return savedNote('obstacles') + `<p class="small">${S.obstacles.length} mapped obstacle${S.obstacles.length === 1 ? '' : 's'} nearby (from OpenStreetMap, which is not complete: always look around on site).</p>` +
    (warn.length ? `<p class="bad-note"><b>${warn.length} obstacle${warn.length === 1 ? '' : 's'} reach${warn.length === 1 ? 'es' : ''} your flight height:</b></p><ul class="small tight">${warn.slice(0, 6).map(o => `<li>${esc(o.type)}${o.name ? ' ' + esc(o.name) : ''}, about ${fmtLen(o.height)} tall</li>`).join('')}${warn.length > 6 ? `<li>…and ${warn.length - 6} more</li>` : ''}</ul>` +
      `<p class="small">Fly higher than these by at least ${fmtLen(10)}, or keep the area clear of them.</p>`
      : `<p class="small">None are tall enough to reach ${fmtLen(agl)} (plus a ${fmtLen(10)} safety gap).</p>`);
}

function drawLayers(agl) {
  layers.site.clearLayers();
  (S.airspace || []).forEach(cell => {
    const low = Number.isFinite(cell.ceiling) && cell.ceiling < metresToFeet(agl);
    const color = low ? '#e5484d' : '#f5a524';
    cell.geometry.forEach(ring => {
      const poly = L.polygon(ring.map(p => [p.lat, p.lon]), { color, weight: 1, fillOpacity: low ? 0.18 : 0.08, interactive: false }).addTo(layers.site);
      poly.bindTooltip(`${cell.ceiling} ft`, { permanent: true, direction: 'center', className: 'ceil-label' });
    });
  });
  const warn = new Set(obstacleWarnings(S.obstacles || [], siteArea(), agl));
  (S.obstacles || []).forEach(o => {
    const color = warn.has(o) ? '#e5484d' : '#8b95a5';
    const tip = `${o.type}${o.name ? ' ' + o.name : ''}, ~${fmtLen(o.height)}`;
    if (o.geometry && o.geometry.length > 1) L.polyline(o.geometry.map(p => [p.lat, p.lon]), { color, weight: 2, dashArray: '4 4', interactive: false }).addTo(layers.site);
    L.circleMarker([o.lat, o.lon], { radius: warn.has(o) ? 6 : 3, color, weight: 1.5, fillColor: color, fillOpacity: 0.7 }).bindTooltip(tip).addTo(layers.site);
  });
}

function render() {
  const box = $('siteBody');
  const area = siteArea();
  const agl = flightAgl();
  const low = airspaceWarnings(S.airspace, agl);
  const obs = obstacleWarnings(S.obstacles || [], area, agl);
  state.site = { airspaceBlock: low, obstacleWarn: obs, now: S.weather ? nowVerdict(upcoming(S.weather.hours)) : null };
  drawLayers(agl);
  if (!area) {
    box.innerHTML = '<p class="muted">Draw your area first. These checks run by themselves once there is one.</p>';
  } else {
    const c = centroid(area);
    box.innerHTML = `
      <div class="card"><h3>Weather</h3>${weatherCard(c)}</div>
      <div class="card"><h3>Airspace</h3>${airspaceCard(agl)}</div>
      <div class="card"><h3>Obstacles</h3>${obstacleCard(agl)}</div>
      <p class="muted small">These checks send the approximate location of your area to Open-Meteo (weather), the FAA and OpenStreetMap (Overpass). They help, but they are not a substitute for looking at the site and knowing your local rules.</p>`;
  }
  emit('site');
}

export function initSiteCheck() {
  const later = debounce(() => run(false), 1500);
  on('plan', later);
  $('btnSiteRefresh').onclick = () => run(true);
  $('alt').addEventListener('change', later);
  render();
}

export const siteCheckNow = () => run(false);
/** Runs every check again and waits for them, so the results are saved for offline use. Resolves to [true, …] per check that worked. */
export const siteCheckSave = () => run(true);
