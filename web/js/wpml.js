// Read and write DJI WPML mission files (.kmz containing wpmz/template.kml + wpmz/waylines.wpml).
//
// Strategy for compatibility: when a KMZ saved by DJI Fly is loaded, we keep its XML and use its
// first Placemark as a prototype for every generated waypoint, so whatever fields that firmware
// version expects (drone enum, payload info, heading params...) are carried over untouched.
// Only missions created from scratch fall back to the built-in defaults below.

/* global JSZip */

export const WPML_NS = 'http://www.dji.com/wpmz/1.0.6';
const KML_NS = 'http://www.opengis.net/kml/2.2';

// Aircraft identifiers for <wpml:droneInfo>. Left null on purpose: the values must be copied from
// real DJI Fly KMZ files (waiting on a sample), never guessed. Until then the defaults in missionConfigXml apply.
export const DRONES = {
  mavic3: { name: 'Mavic 3 / 3 Cine', droneEnum: null, droneSub: null },
  mavic3classic: { name: 'Mavic 3 Classic', droneEnum: null, droneSub: null },
  mavic3pro: { name: 'Mavic 3 Pro', droneEnum: null, droneSub: null },
};

// UI path styles -> WPML turn settings.
export const TURN_MODES = {
  'straight-stop': { mode: 'toPointAndStopWithDiscontinuityCurvature', straight: 1, label: 'Straight lines, stop at each point' },
  'straight-pass': { mode: 'toPointAndPassWithContinuityCurvature', straight: 1, label: 'Straight lines, fly through points' },
  'curved': { mode: 'toPointAndPassWithContinuityCurvature', straight: 0, label: 'Curved (DJI Fly default)' },
};

export function turnModeKey(mode, straight) {
  if (mode === 'toPointAndStopWithDiscontinuityCurvature') return 'straight-stop';
  if (straight === 1 && /^toPoint/.test(mode || '')) return mode.includes('Stop') ? 'straight-stop' : 'straight-pass';
  if (mode) return 'curved';
  return null;
}

// ---------- XML helpers ----------

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error('Invalid XML: ' + err.textContent.slice(0, 200));
  return doc;
}

function serialize(doc) {
  const s = new XMLSerializer().serializeToString(doc);
  return s.startsWith('<?xml') ? s : '<?xml version="1.0" encoding="UTF-8"?>\n' + s;
}

const first = (node, name) => node && node.getElementsByTagNameNS('*', name)[0] || null;
const kids = (node, name) => node ? [...node.children].filter(c => c.localName === name) : [];
const kid = (node, name) => kids(node, name)[0] || null;
const kidText = (node, name) => { const k = kid(node, name); return k ? k.textContent.trim() : null; };
const num = v => (v === null || v === undefined || v === '' || isNaN(+v)) ? null : +v;

function wpmlNs(doc) {
  return doc.documentElement.lookupNamespaceURI('wpml') || WPML_NS;
}

function make(doc, name, value) {
  const el = doc.createElementNS(wpmlNs(doc), 'wpml:' + name);
  if (value !== undefined) el.textContent = String(value);
  return el;
}

// Set the text of a direct child; create it (before `before`, else appended) when `create` is true.
function setKid(parent, name, value, create = false, before = null) {
  let el = kid(parent, name);
  if (!el) {
    if (!create) return null;
    el = make(parent.ownerDocument, name);
    parent.insertBefore(el, before && before.parentNode === parent ? before : null);
  }
  el.textContent = String(value);
  return el;
}

const fmt = (v, d = 6) => String(+(+v).toFixed(d));

// ---------- Reading ----------

export async function readFile(file) {
  const name = file.name || 'mission.kmz';
  if (/\.kml$/i.test(name)) return parseKmlArea(await file.text(), name);

  const zip = await JSZip.loadAsync(file);
  const paths = Object.keys(zip.files).filter(p => !zip.files[p].dir);
  const tPath = paths.find(p => /(^|\/)template\.kml$/i.test(p)) || null;
  const wPath = paths.find(p => /(^|\/)waylines\.wpml$/i.test(p)) || null;

  if (!tPath && !wPath) {
    const kml = paths.find(p => /\.kml$/i.test(p));
    if (kml) return parseKmlArea(await zip.file(kml).async('string'), name);
    throw new Error('This KMZ has no DJI mission (wpmz/template.kml or waylines.wpml) or KML polygon.');
  }

  const templateXml = tPath ? await zip.file(tPath).async('string') : null;
  const waylinesXml = wPath ? await zip.file(wPath).async('string') : null;
  const tDoc = templateXml ? parseXml(templateXml) : null;
  const wDoc = waylinesXml ? parseXml(waylinesXml) : null;

  const wFolder = first(wDoc, 'Folder');
  const tFolder = first(tDoc, 'Folder');
  const useWaylines = wFolder && kids(wFolder, 'Placemark').length > 0;
  const folder = useWaylines ? wFolder : tFolder;
  const pms = kids(folder, 'Placemark');

  const globalHeight = num(kidText(tFolder, 'globalHeight'));
  const autoSpeed = num(kidText(folder, 'autoFlightSpeed'));
  const ser = new XMLSerializer();

  const waypoints = pms.map(pm => {
    const c = (first(pm, 'coordinates')?.textContent || '').trim().split(',').map(Number);
    const height = num(kidText(pm, 'executeHeight')) ?? num(kidText(pm, 'height')) ??
      num(kidText(pm, 'ellipsoidHeight')) ?? globalHeight ?? 50;
    const funcs = [...pm.getElementsByTagNameNS('*', 'actionActuatorFunc')].map(e => e.textContent.trim());
    const pitch = num(first(pm, 'gimbalPitchRotateAngle')?.textContent) ??
      num(first(pm, 'waypointGimbalPitchAngle')?.textContent) ?? num(kidText(pm, 'gimbalPitchAngle'));
    const groups = kids(pm, 'actionGroup');
    return {
      lat: c[1], lon: c[0], height,
      speed: num(kidText(pm, 'waypointSpeed')) ?? autoSpeed ?? 5,
      photo: funcs.includes('takePhoto'),
      gimbalPitch: pitch,
      actions: groups.length ? groups.map(g => ser.serializeToString(g)) : null,
    };
  }).filter(w => isFinite(w.lat) && isFinite(w.lon));

  const firstPm = pms[0];
  const turn = firstPm ? turnModeKey(first(firstPm, 'waypointTurnMode')?.textContent.trim(), num(kidText(firstPm, 'useStraightLine'))) : null;
  const info = {
    droneEnum: num(first(tDoc || wDoc, 'droneEnumValue')?.textContent),
    droneSub: num(first(tDoc || wDoc, 'droneSubEnumValue')?.textContent),
    author: first(tDoc, 'author')?.textContent.trim() || null,
    finishAction: first(tDoc || wDoc, 'finishAction')?.textContent.trim() || null,
    rcLostAction: first(tDoc || wDoc, 'executeRCLostAction')?.textContent.trim() || null,
    heightMode: (first(wDoc, 'executeHeightMode') || first(tDoc, 'heightMode'))?.textContent.trim() || null,
    speed: autoSpeed,
    turnMode: turn,
    folders: wDoc ? wDoc.getElementsByTagNameNS('*', 'Folder').length : 1,
  };

  return { kind: 'mission', name, zip, tPath, wPath, templateXml, waylinesXml, waypoints, info };
}

// Accept any KML polygon (e.g. drawn in Google Earth) as a survey area.
function parseKmlArea(text, name) {
  const doc = parseXml(text);
  const poly = first(doc, 'Polygon');
  const coordsEl = poly ? first(first(poly, 'outerBoundaryIs') || poly, 'coordinates') : first(doc, 'coordinates');
  if (!coordsEl) throw new Error('No polygon found in ' + name);
  const pts = coordsEl.textContent.trim().split(/\s+/).map(t => t.split(',').map(Number))
    .filter(c => isFinite(c[0]) && isFinite(c[1])).map(c => ({ lat: c[1], lon: c[0] }));
  if (pts.length > 1 && pts[0].lat === pts.at(-1).lat && pts[0].lon === pts.at(-1).lon) pts.pop();
  if (pts.length < 3) throw new Error('The polygon in ' + name + ' has fewer than 3 points.');
  return { kind: 'area', name, polygon: pts };
}

// ---------- Writing ----------

const HEADING_PARAM = `
        <wpml:waypointHeadingParam>
          <wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode>
          <wpml:waypointHeadingAngle>0</wpml:waypointHeadingAngle>
          <wpml:waypointPoiPoint>0.000000,0.000000,0.000000</wpml:waypointPoiPoint>
          <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
          <wpml:waypointHeadingPoiIndex>0</wpml:waypointHeadingPoiIndex>
        </wpml:waypointHeadingParam>`;

const TURN_PARAM = `
        <wpml:waypointTurnParam>
          <wpml:waypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:waypointTurnMode>
          <wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist>
        </wpml:waypointTurnParam>`;

function missionConfigXml(o) {
  return `
    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>${o.finishAction || 'goHome'}</wpml:finishAction>
      <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>${o.rcLostAction || 'goBack'}</wpml:executeRCLostAction>
      <wpml:globalTransitionalSpeed>${o.transitionalSpeed || 10}</wpml:globalTransitionalSpeed>
      <wpml:droneInfo>
        <wpml:droneEnumValue>${o.droneEnum ?? 77}</wpml:droneEnumValue>
        <wpml:droneSubEnumValue>${o.droneSub ?? 0}</wpml:droneSubEnumValue>
      </wpml:droneInfo>
    </wpml:missionConfig>`;
}

function defaultTemplate(o) {
  const t = Date.now();
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="${KML_NS}" xmlns:wpml="${WPML_NS}">
  <Document>
    <wpml:author>GridFly</wpml:author>
    <wpml:createTime>${t}</wpml:createTime>
    <wpml:updateTime>${t}</wpml:updateTime>${missionConfigXml(o)}
    <Folder>
      <wpml:templateType>waypoint</wpml:templateType>
      <wpml:templateId>0</wpml:templateId>
      <wpml:waylineCoordinateSysParam>
        <wpml:coordinateMode>WGS84</wpml:coordinateMode>
        <wpml:heightMode>relativeToStartPoint</wpml:heightMode>
      </wpml:waylineCoordinateSysParam>
      <wpml:autoFlightSpeed>5</wpml:autoFlightSpeed>
      <wpml:globalHeight>60</wpml:globalHeight>
      <wpml:caliFlightEnable>0</wpml:caliFlightEnable>
      <wpml:gimbalPitchMode>usePointSetting</wpml:gimbalPitchMode>
      <wpml:globalWaypointHeadingParam>
        <wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode>
        <wpml:waypointHeadingAngle>0</wpml:waypointHeadingAngle>
        <wpml:waypointPoiPoint>0.000000,0.000000,0.000000</wpml:waypointPoiPoint>
        <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
        <wpml:waypointHeadingPoiIndex>0</wpml:waypointHeadingPoiIndex>
      </wpml:globalWaypointHeadingParam>
      <wpml:globalWaypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:globalWaypointTurnMode>
      <wpml:globalUseStraightLine>1</wpml:globalUseStraightLine>
      <Placemark>
        <Point><coordinates>0,0</coordinates></Point>
        <wpml:index>0</wpml:index>
        <wpml:ellipsoidHeight>60</wpml:ellipsoidHeight>
        <wpml:height>60</wpml:height>
        <wpml:useGlobalHeight>0</wpml:useGlobalHeight>
        <wpml:useGlobalSpeed>0</wpml:useGlobalSpeed>
        <wpml:waypointSpeed>5</wpml:waypointSpeed>
        <wpml:useGlobalHeadingParam>0</wpml:useGlobalHeadingParam>${HEADING_PARAM}
        <wpml:useGlobalTurnParam>0</wpml:useGlobalTurnParam>${TURN_PARAM}
        <wpml:useStraightLine>1</wpml:useStraightLine>
        <wpml:gimbalPitchAngle>-90</wpml:gimbalPitchAngle>
        <wpml:isRisky>0</wpml:isRisky>
      </Placemark>
    </Folder>
  </Document>
</kml>`;
}

function defaultWaylines(o) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="${KML_NS}" xmlns:wpml="${WPML_NS}">
  <Document>${missionConfigXml(o)}
    <Folder>
      <wpml:templateId>0</wpml:templateId>
      <wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>
      <wpml:waylineId>0</wpml:waylineId>
      <wpml:distance>0</wpml:distance>
      <wpml:duration>0</wpml:duration>
      <wpml:autoFlightSpeed>5</wpml:autoFlightSpeed>
      <Placemark>
        <Point><coordinates>0,0</coordinates></Point>
        <wpml:index>0</wpml:index>
        <wpml:executeHeight>60</wpml:executeHeight>
        <wpml:waypointSpeed>5</wpml:waypointSpeed>${HEADING_PARAM}${TURN_PARAM}
        <wpml:useStraightLine>1</wpml:useStraightLine>
        <wpml:waypointGimbalHeadingParam>
          <wpml:waypointGimbalPitchAngle>-90</wpml:waypointGimbalPitchAngle>
          <wpml:waypointGimbalYawAngle>0</wpml:waypointGimbalYawAngle>
        </wpml:waypointGimbalHeadingParam>
      </Placemark>
    </Folder>
  </Document>
</kml>`;
}

function defaultProto(doc, kind, o) {
  const xml = (kind === 'template' ? defaultTemplate(o) : defaultWaylines(o)).split(WPML_NS).join(wpmlNs(doc));
  return doc.importNode(first(parseXml(xml), 'Placemark'), true);
}

// Build <wpml:actionGroup> elements for one waypoint.
function buildActionGroups(doc, wp, index, nextGroupId, opts) {
  if (wp.actions) {
    return wp.actions.map(xml => {
      const g = doc.importNode(parseXml(xml).documentElement, true);
      for (const a of [...g.attributes]) if (a.name.startsWith('xmlns')) g.removeAttribute(a.name);
      const start = num(kidText(g, 'actionGroupStartIndex')) ?? index;
      const end = num(kidText(g, 'actionGroupEndIndex')) ?? start;
      setKid(g, 'actionGroupId', nextGroupId(), true);
      setKid(g, 'actionGroupStartIndex', index, true);
      setKid(g, 'actionGroupEndIndex', index + Math.max(0, end - start), true);
      return g;
    });
  }
  const actions = [];
  if (wp.gimbalPitch !== null && wp.gimbalPitch !== undefined && (opts.gimbalEvery || index === 0)) {
    actions.push(['gimbalRotate', [
      ['gimbalHeadingYawBase', 'aircraft'], ['gimbalRotateMode', 'absoluteAngle'],
      ['gimbalPitchRotateEnable', 1], ['gimbalPitchRotateAngle', wp.gimbalPitch],
      ['gimbalRollRotateEnable', 0], ['gimbalRollRotateAngle', 0],
      ['gimbalYawRotateEnable', 0], ['gimbalYawRotateAngle', 0],
      ['gimbalRotateTimeEnable', 0], ['gimbalRotateTime', 0],
      ['payloadPositionIndex', 0],
    ]]);
  }
  if (wp.photo) {
    if (opts.hoverSeconds > 0) actions.push(['hover', [['hoverTime', opts.hoverSeconds]]]);
    actions.push(['takePhoto', [['payloadPositionIndex', 0], ['useGlobalPayloadLensIndex', 0]]]);
  }
  if (!actions.length) return [];
  const g = make(doc, 'actionGroup');
  g.append(make(doc, 'actionGroupId', nextGroupId()), make(doc, 'actionGroupStartIndex', index),
    make(doc, 'actionGroupEndIndex', index), make(doc, 'actionGroupMode', 'sequence'));
  const trig = make(doc, 'actionTrigger');
  trig.append(make(doc, 'actionTriggerType', 'reachPoint'));
  g.append(trig);
  actions.forEach(([func, params], id) => {
    const a = make(doc, 'action');
    const p = make(doc, 'actionActuatorFuncParam');
    for (const [k, v] of params) p.append(make(doc, k, v));
    a.append(make(doc, 'actionId', id), make(doc, 'actionActuatorFunc', func), p);
    g.append(a);
  });
  return [g];
}

function fillPlacemark(doc, pm, wp, index, kind, opts, nextGroupId) {
  const coords = first(pm, 'coordinates');
  coords.textContent = `${fmt(wp.lon, 8)},${fmt(wp.lat, 8)}`;
  setKid(pm, 'index', index, true, kid(pm, 'Point')?.nextSibling);
  const h = fmt(wp.height, 1);
  if (kind === 'waylines') {
    setKid(pm, 'executeHeight', h, true, kid(pm, 'waypointSpeed'));
  } else {
    setKid(pm, 'height', h, true, kid(pm, 'waypointSpeed'));
    setKid(pm, 'ellipsoidHeight', h);
    setKid(pm, 'useGlobalHeight', 0);
  }
  setKid(pm, 'waypointSpeed', fmt(wp.speed, 1), true);
  setKid(pm, 'useGlobalSpeed', 0);

  if (Number.isFinite(wp.heading)) {
    let hp = kid(pm, 'waypointHeadingParam');
    if (!hp) {
      hp = make(doc, 'waypointHeadingParam');
      pm.insertBefore(hp, kid(pm, 'useGlobalTurnParam') || kid(pm, 'waypointTurnParam') || null);
    }
    setKid(hp, 'waypointHeadingMode', 'smoothTransition', true);
    setKid(hp, 'waypointHeadingAngle', fmt(((wp.heading + 180) % 360 + 360) % 360 - 180, 1), true);
    setKid(hp, 'waypointHeadingAngleEnable', 1, true, kid(hp, 'waypointPoiPoint'));
    setKid(pm, 'useGlobalHeadingParam', 0);
  } else if (opts.headingMode) {
    const hp = kid(pm, 'waypointHeadingParam');
    if (hp) setKid(hp, 'waypointHeadingMode', opts.headingMode, true);
    setKid(pm, 'useGlobalHeadingParam', 0);
  }

  const turn = TURN_MODES[opts.turnMode];
  if (turn) {
    let tp = kid(pm, 'waypointTurnParam');
    if (!tp) { tp = make(doc, 'waypointTurnParam'); pm.appendChild(tp); }
    setKid(tp, 'waypointTurnMode', turn.mode, true);
    setKid(tp, 'waypointTurnDampingDist', 0, true);
    setKid(pm, 'useGlobalTurnParam', 0);
    setKid(pm, 'useStraightLine', turn.straight, true, tp.nextSibling);
  }

  if (wp.gimbalPitch !== null && wp.gimbalPitch !== undefined) {
    const gp = kid(pm, 'waypointGimbalHeadingParam');
    if (gp) setKid(gp, 'waypointGimbalPitchAngle', wp.gimbalPitch, true);
    setKid(pm, 'gimbalPitchAngle', wp.gimbalPitch);
  }

  kids(pm, 'actionGroup').forEach(g => pm.removeChild(g));
  const before = kid(pm, 'waypointGimbalHeadingParam') || kid(pm, 'isRisky') || null;
  for (const g of buildActionGroups(doc, wp, index, nextGroupId, opts)) pm.insertBefore(g, before);
}

function updateDoc(doc, waypoints, kind, opts) {
  const mc = first(doc, 'missionConfig');
  if (mc) {
    if (opts.finishAction) setKid(mc, 'finishAction', opts.finishAction);
    if (opts.rcLostAction) setKid(mc, 'executeRCLostAction', opts.rcLostAction);
  }
  const docEl = first(doc, 'Document');
  if (docEl) setKid(docEl, 'updateTime', Date.now());

  const folder = first(doc, 'Folder');
  if (!folder) return doc;
  const pms = kids(folder, 'Placemark');
  const proto = pms[0] ? pms[0].cloneNode(true) : defaultProto(doc, kind, opts);
  pms.forEach(p => folder.removeChild(p));

  setKid(folder, 'autoFlightSpeed', fmt(opts.speed ?? waypoints[0]?.speed ?? 5, 1));
  if (kind === 'template') {
    if (waypoints.length) setKid(folder, 'globalHeight', fmt(waypoints[0].height, 1));
    const turn = TURN_MODES[opts.turnMode];
    if (turn) {
      setKid(folder, 'globalWaypointTurnMode', turn.mode);
      setKid(folder, 'globalUseStraightLine', turn.straight);
    }
  } else {
    setKid(folder, 'distance', fmt(opts.distance ?? 0, 1));
    setKid(folder, 'duration', fmt(opts.duration ?? 0, 1));
  }

  let gid = 0;
  const nextGroupId = () => gid++;
  waypoints.forEach((wp, i) => {
    const pm = proto.cloneNode(true);
    fillPlacemark(doc, pm, wp, i, kind, opts, nextGroupId);
    folder.appendChild(pm);
  });
  return doc;
}

/**
 * Build a DJI Fly compatible KMZ.
 * @param waypoints [{lat, lon, height, speed, photo, gimbalPitch, actions, heading?}] (heading: fixed yaw in degrees clockwise from north)
 * @param opts {turnMode, finishAction, rcLostAction, speed, headingMode, distance, duration, droneEnum, droneSub, gimbalEvery,
 *             hoverSeconds (hover this long before each generated takePhoto)}
 * @param source result of readFile() for the mission being edited (or a placeholder from the controller), or null
 */
export async function buildKmz(waypoints, opts, source) {
  const tDoc = updateDoc(parseXml(source?.templateXml || defaultTemplate(opts)), waypoints, 'template', opts);
  const wDoc = updateDoc(parseXml(source?.waylinesXml || defaultWaylines(opts)), waypoints, 'waylines', opts);
  const tPath = source?.tPath || 'wpmz/template.kml';
  const wPath = source?.wPath || 'wpmz/waylines.wpml';

  const zip = new JSZip();
  if (source?.zip) {
    for (const [path, f] of Object.entries(source.zip.files)) {
      if (f.dir || path === tPath || path === wPath) continue;
      zip.file(path, await f.async('uint8array'));
    }
  }
  zip.file(tPath, serialize(tDoc));
  zip.file(wPath, serialize(wDoc));
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: 'application/vnd.google-earth.kmz' });
}
