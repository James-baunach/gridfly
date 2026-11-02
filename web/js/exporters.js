// Export helpers: GeoJSON, KML, project files and the microSD bundle.

const closed = poly => {
  const ring = poly.map(p => [p.lon, p.lat]);
  if (ring.length) ring.push(ring[0]);
  return ring;
};

export function toGeoJSON({ polygon = [], missions = [], home = null }) {
  const features = [];
  if (polygon.length >= 3) features.push({ type: 'Feature', properties: { kind: 'survey_area' }, geometry: { type: 'Polygon', coordinates: [closed(polygon)] } });
  missions.forEach((m, i) => {
    features.push({
      type: 'Feature',
      properties: { kind: 'mission', mission: i + 1, waypoints: m.points.length, distance_m: Math.round(m.distance || 0), time_s: Math.round(m.time || 0) },
      geometry: { type: 'LineString', coordinates: m.points.map(p => [p.lon, p.lat]) },
    });
    for (const p of m.points) {
      if (p.photo) features.push({ type: 'Feature', properties: { kind: 'photo', mission: i + 1, height: p.height }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } });
    }
  });
  if (home) features.push({ type: 'Feature', properties: { kind: 'home' }, geometry: { type: 'Point', coordinates: [home.lon, home.lat] } });
  return { type: 'FeatureCollection', features };
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
// KML colours are aabbggrr.
const LINE_COLORS = ['ff0080ff', 'ffff8000', 'ff00c800', 'ffc800c8', 'ff0000ff', 'ff00c8c8', 'ffc8c800', 'ff808080'];
const coords = pts => pts.map(p => `${p.lon},${p.lat},0`).join(' ');

export function toKml({ polygon = [], missions = [], home = null, name = 'GridFly mission' }) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<kml xmlns="http://www.opengis.net/kml/2.2">', '<Document>', `<name>${esc(name)}</name>`];
  out.push('<Style id="area"><LineStyle><color>ff0080ff</color><width>3</width></LineStyle><PolyStyle><color>4d0080ff</color></PolyStyle></Style>');
  LINE_COLORS.forEach((c, i) => out.push(`<Style id="m${i}"><LineStyle><color>${c}</color><width>3</width></LineStyle></Style>`));
  if (polygon.length >= 3) {
    const ring = polygon.concat([polygon[0]]);
    out.push(`<Placemark><name>Survey area</name><styleUrl>#area</styleUrl><Polygon><tessellate>1</tessellate><altitudeMode>clampToGround</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${coords(ring)}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`);
  }
  missions.forEach((m, i) => {
    const label = m.name || `Mission ${i + 1}`;
    out.push(`<Placemark><name>${esc(label)}</name><description>${m.points.length} waypoints, ${Math.round(m.distance || 0)} m, ${Math.round(m.time || 0)} s</description><styleUrl>#m${i % LINE_COLORS.length}</styleUrl><LineString><tessellate>1</tessellate><altitudeMode>clampToGround</altitudeMode><coordinates>${coords(m.points)}</coordinates></LineString></Placemark>`);
  });
  if (home) out.push(`<Placemark><name>Home</name><Point><coordinates>${home.lon},${home.lat},0</coordinates></Point></Placemark>`);
  out.push('</Document>', '</kml>');
  return out.join('\n');
}

// ---------- Project file ----------

export function bytesToBase64(u8) {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(str) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'base64'));
  const s = atob(str);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

const isLL = p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon);

export function projectToJson(project) {
  const { polygon = [], waypoints = [], home = null, homeGround = null, settings = {}, generated = null, fileName = null, sourceKmzBase64 } = project;
  const out = { app: 'gridfly', version: 1, savedAt: new Date().toISOString(), polygon, waypoints, home, homeGround, settings, generated, fileName };
  if (sourceKmzBase64) out.sourceKmzBase64 = sourceKmzBase64;
  return JSON.stringify(out);
}

export function projectFromJson(text) {
  let d;
  try { d = JSON.parse(text); } catch { throw new Error('This is not a valid GridFly project file (could not read it as JSON).'); }
  if (!d || typeof d !== 'object' || Array.isArray(d) || d.app !== 'gridfly') throw new Error('This file is not a GridFly project.');
  if (!Number.isInteger(d.version) || d.version < 1) throw new Error('The project file has no valid version number.');
  if (d.version > 1) throw new Error(`This project was saved by a newer GridFly (version ${d.version}). Please update the app.`);
  const list = (v, label) => {
    if (v == null) return [];
    if (!Array.isArray(v)) throw new Error(`Project ${label} should be a list.`);
    v.forEach((p, i) => { if (!isLL(p)) throw new Error(`Project ${label} point ${i + 1} has no valid latitude/longitude.`); });
    return v;
  };
  const polygon = list(d.polygon, 'survey area');
  const waypoints = list(d.waypoints, 'waypoints');
  if (d.home != null && !isLL(d.home)) throw new Error('Project home position is not valid.');
  if (d.homeGround != null && !Number.isFinite(d.homeGround)) throw new Error('Project home ground height is not valid.');
  if (d.settings != null && (typeof d.settings !== 'object' || Array.isArray(d.settings))) throw new Error('Project settings are not valid.');
  if (d.sourceKmzBase64 != null && typeof d.sourceKmzBase64 !== 'string') throw new Error('Project source KMZ data is not valid.');
  const out = {
    app: 'gridfly', version: 1, savedAt: typeof d.savedAt === 'string' ? d.savedAt : null,
    polygon, waypoints, home: d.home ?? null, homeGround: d.homeGround ?? null,
    settings: d.settings ?? {}, generated: d.generated ?? null,
    fileName: typeof d.fileName === 'string' ? d.fileName : null,
  };
  if (d.sourceKmzBase64) out.sourceKmzBase64 = d.sourceKmzBase64;
  return out;
}

// ---------- microSD bundle ----------

export function microSdReadme(missions) {
  const n = missions.length;
  const names = missions.map((m, i) => `  ${i + 1}. ${m.name || `mission ${i + 1}`}`).join('\r\n');
  return [
    'GRIDFLY - READ ME FIRST',
    '=======================',
    '',
    `This folder holds ${n} mission file${n === 1 ? '' : 's'} (.kmz):`,
    names,
    '',
    'How to get them onto your DJI RC (the standard controller with the built-in screen):',
    '',
    '1. Copy this whole GridFly folder to the top level (root) of a microSD card.',
    '2. Switch the controller off, put the card in its microSD slot, switch it on.',
    '3. On the controller, swipe down from the top of the screen, then open the Files app',
    '   (it may be under the "..." / more menu).',
    '4. Open the microSD card and open the GridFly folder. Long-press the KMZ file and choose Copy.',
    '5. In Files, go to: Internal storage > Android > data > dji.go.v5 > files > waypoint',
    '6. Inside "waypoint" you will see folders with long ID-like names. You need a mission to',
    '   exist already: in DJI Fly, create any quick waypoint mission (Waypoint > new > add two points > save).',
    '   Then open the folder it created (the newest one, or the only one).',
    '7. Paste your KMZ into that folder. You will see the old file there named <ID>.kmz',
    '   (the ID is the same as the folder name).',
    '8. Delete the old <ID>.kmz, then rename your pasted file to EXACTLY the old name, e.g. <ID>.kmz.',
    '   The name must match letter for letter.',
    n > 1 ? '9. Repeat steps 6-8 for each extra mission file (one mission slot per file), or load them one flight at a time.' : '9. Close Files.',
    '10. Fully close DJI Fly (swipe it away from recent apps) and open it again.',
    '11. Open the waypoint mission in DJI Fly, check the map and settings, then fly it.',
    '',
    'Always check the flight area, height and battery before you take off.',
    '',
  ].join('\r\n');
}

export async function microSdPackage(missions, { baseName = 'gridfly' } = {}) {
  const zip = new JSZip();
  const dir = zip.folder('GridFly');
  const named = missions.map((m, i) => ({ ...m, name: `${baseName}_${i + 1}-of-${missions.length}.kmz` }));
  for (const m of named) dir.file(m.name, m.blob);
  dir.file('READ ME FIRST.txt', microSdReadme(named));
  return zip.generateAsync({ type: 'blob' });
}
