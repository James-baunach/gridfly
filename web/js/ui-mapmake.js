/* global L, JSZip */
// Step 7, after the photo check: turn the photos into a map. A quick map stitched in the browser (shown on the map,
// downloadable for QGIS and Google Earth), processing settings for OpenDroneMap, and an experimental straight-to-NodeODM
// upload. Photos only leave the device in that last case, and only to the server the user types in.

import { usablePhoto, mosaicLayout, drawWidth, worldFile, WEB_MERCATOR_PRJ, groundOverlayKml, odmOptions, odmFlags, boundaryGeoJson, ODM_STATUS } from './mosaic.js';
import { gridMetrics } from './grid.js';
import { fmtSmall } from './units.js';
import { $, state, areaList, toast, esc, download, pref, setPref } from './state.js';
import { settings } from './plan.js';
import { map, fitTo } from './ui-map.js';

const CROP = 0.62; // middle of each photo used in the quick map
let photoSet = null; // { files, photos } from the last photo check
let overlay = null, overlayUrl = null, made = null, busy = false, odmTimer = null;

map.createPane('mosaic').style.zIndex = 350; // above the satellite map, under the plan

/** Called by the photo check with the files it read and what it found in them. */
export function setPhotos(files, photos) {
  photoSet = { files, photos };
  $('mapMake').hidden = !files.length;
  $('btnOdmSend').disabled = !files.length;
}

function baseName() {
  return (state.projectName || 'gridfly').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'gridfly';
}

// ---------- Quick map ----------

async function quickMap() {
  if (busy || !photoSet) return;
  const cam = settings().cam;
  const use = photoSet.photos.map((p, i) => ({ meta: p.meta, blurry: p.blurry, file: photoSet.files[i] })).filter(x => usablePhoto(x.meta));
  const sharp = use.filter(x => !x.blurry);
  const pick = sharp.length >= use.length * 0.6 ? sharp : use; // leave blurry ones out unless that drops too many
  if (!pick.length) return toast('None of these photos can be placed on the map: they need GPS, a recorded height and the camera looking straight down.', 7000);
  const items = pick.map(x => ({ lat: x.meta.lat, lon: x.meta.lon, height: x.meta.relAlt, yaw: x.meta.gimbalYaw ?? x.meta.yaw ?? 0 }));
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  // Never finer than the photos: their ground detail, in Mercator metres.
  const h = items.reduce((a, it) => a + it.height, 0) / items.length;
  const native = gridMetrics(cam, h, 0, 0).gsd / 100 / Math.cos(items[0].lat * Math.PI / 180);
  const lay = mosaicLayout(items, cam, { maxPx: coarse ? 2560 : 4096, crop: CROP, minMpp: native });
  if (!lay) return toast('Could not lay these photos out.');

  busy = true;
  const bar = $('mosaicBar');
  bar.hidden = false; bar.max = pick.length; bar.value = 0;
  $('btnQuickMap').disabled = true;
  $('mosaicResult').innerHTML = `<p class="small muted">Stitching ${pick.length} photos… keep this tab open.</p>`;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = lay.width; canvas.height = lay.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    for (let i = 0; i < pick.length; i++) {
      const p = lay.place[i];
      const want = Math.max(32, Math.min(2048, Math.round(drawWidth(p) / CROP * 1.15)));
      let bmp;
      try { bmp = await createImageBitmap(pick[i].file, { resizeWidth: want, resizeQuality: 'medium' }); } catch { bar.value = i + 1; continue; }
      const sw = bmp.width * CROP, sh = bmp.height * CROP;
      ctx.setTransform(...p);
      ctx.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, 1, 1);
      bmp.close?.();
      bar.value = i + 1;
      if (i % 8 === 7) await new Promise(r => setTimeout(r)); // let the page breathe
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    showOverlay(blob, lay);
    made = { blob, lay, count: pick.length, skipped: use.length - pick.length + (photoSet.photos.length - use.length) };
    renderMade();
  } catch (e) {
    $('mosaicResult').innerHTML = `<p class="small">The quick map failed: ${esc(e.message)}. Try on a computer, or with fewer photos.</p>`;
  } finally {
    busy = false;
    bar.hidden = true;
    $('btnQuickMap').disabled = false;
  }
}

function showOverlay(blob, lay) {
  removeOverlay();
  overlayUrl = URL.createObjectURL(blob);
  const b = [[lay.bounds.s, lay.bounds.w], [lay.bounds.n, lay.bounds.e]];
  overlay = L.imageOverlay(overlayUrl, b, { pane: 'mosaic', opacity: 1, interactive: false }).addTo(map);
  fitTo([{ lat: lay.bounds.s, lon: lay.bounds.w }, { lat: lay.bounds.n, lon: lay.bounds.e }]);
}

function removeOverlay() {
  if (overlay) map.removeLayer(overlay);
  if (overlayUrl) URL.revokeObjectURL(overlayUrl);
  overlay = overlayUrl = null;
}

function renderMade() {
  if (!made) { $('mosaicResult').innerHTML = ''; return; }
  const cm = made.lay.mpp * Math.cos(made.lay.bounds.s * Math.PI / 180) * 100;
  $('mosaicResult').innerHTML = `<div class="mosaic-ok">
      <div class="ready ok"><b>Quick map ready</b><span>${made.count} photos · about ${esc(fmtSmall(cm, state.unit))} per pixel${made.skipped ? ` · ${made.skipped} left out (blurry, tilted or no position)` : ''}</span></div>
      <label class="small">See through<input id="mosaicOpacity" type="range" min="0" max="100" value="100"></label>
      <div class="row">
        <button id="btnMosaicPng" title="PNG with a world file and projection, opens in QGIS and other GIS programs">Download for GIS</button>
        <button id="btnMosaicKmz" title="Opens in Google Earth">Google Earth (KMZ)</button>
        <button id="btnMosaicHide">${overlay ? 'Hide' : 'Show'} on map</button>
      </div>
      <p class="small muted">A quick look, not a survey: photos are placed by GPS, so expect seams and a few metres of drift. For an accurate map use OpenDroneMap below.</p>
    </div>`;
  $('mosaicOpacity').oninput = e => overlay?.setOpacity(e.target.value / 100);
  $('btnMosaicPng').onclick = async () => {
    const zip = new JSZip(), n = `${baseName()}-quickmap`;
    zip.file(`${n}.png`, made.blob);
    zip.file(`${n}.pgw`, worldFile(made.lay));
    zip.file(`${n}.prj`, WEB_MERCATOR_PRJ);
    download(await zip.generateAsync({ type: 'blob' }), `${n}.zip`);
  };
  $('btnMosaicKmz').onclick = async () => {
    const zip = new JSZip();
    zip.file('doc.kml', groundOverlayKml(made.lay, { name: `${state.projectName || 'GridFly'} quick map`, href: 'files/quickmap.png' }));
    zip.file('files/quickmap.png', made.blob);
    download(await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.google-earth.kmz' }), `${baseName()}-quickmap.kmz`);
  };
  $('btnMosaicHide').onclick = () => {
    if (overlay) removeOverlay();
    else showOverlay(made.blob, made.lay);
    renderMade();
  };
}

// ---------- OpenDroneMap ----------

function currentOdmOptions() {
  const s = settings();
  const gsd = state.plan?.gsd ?? gridMetrics(s.cam, s.alt, s.front, s.side).gsd;
  return odmOptions({ goal: state.plan?.goal || state.goal, gsdCm: gsd, boundary: boundaryGeoJson(areaList()[0]) });
}

async function odmKit() {
  const opts = currentOdmOptions();
  const boundary = opts.find(o => o.name === 'boundary');
  const zip = new JSZip();
  if (boundary) zip.file('boundary.geojson', JSON.stringify(JSON.parse(boundary.value), null, 2));
  zip.file('odm-options.json', JSON.stringify(opts.filter(o => o.name !== 'boundary'), null, 2));
  zip.file('README.txt', [
    'Processing your GridFly photos with OpenDroneMap',
    '',
    'WebODM (desktop app or https://webodm.net):',
    '  1. Create a project, then Select Images and Ground Control Points: pick every photo from all missions.',
    '  2. Edit the options: choose "Custom" and set the values in odm-options.json.',
    boundary ? '  3. Under "boundary", choose boundary.geojson so only your survey area is processed.' : '',
    '  4. Start processing. Download the orthophoto (GeoTIFF) when it finishes.',
    '',
    'ODM on the command line:',
    `  docker run -ti --rm -v /path/to/project:/datasets/code opendronemap/odm --project-path /datasets ${odmFlags(opts)}${boundary ? ' --boundary /datasets/code/boundary.geojson' : ''}`,
    '',
    'Put the photos in /path/to/project/images.',
  ].filter(l => l !== '').join('\r\n'));
  download(await zip.generateAsync({ type: 'blob' }), `${baseName()}-opendronemap.zip`);
}

const odmSay = (html, pct) => {
  $('odmStatus').innerHTML = html;
  const bar = $('odmBar');
  bar.hidden = pct == null;
  if (pct != null) bar.value = pct;
};

function odmBase() {
  let url = $('odmUrl').value.trim() || 'http://localhost:3000';
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  return url.replace(/\/+$/, '');
}
const odmQ = () => { const t = $('odmToken').value.trim(); return t ? `?token=${encodeURIComponent(t)}` : ''; };

function upload(url, form, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => { try { resolve(JSON.parse(x.responseText)); } catch { reject(new Error(`the server answered ${x.status}`)); } };
    x.onerror = () => reject(new Error('the upload was blocked or the connection dropped'));
    x.send(form);
  });
}

async function odmSend() {
  if (!photoSet?.files.length) return toast('Check your photos first (above), then send them.');
  const base = odmBase(), q = odmQ();
  setPref('odmUrl', $('odmUrl').value.trim());
  odmSay('Connecting…', null);
  try {
    const r = await fetch(`${base}/info${q}`);
    if (!r.ok) throw new Error(`the server answered ${r.status}`);
  } catch (e) {
    return odmSay(`Could not reach NodeODM at <b>${esc(base)}</b> (${esc(e.message)}). Check it is running and allows requests from this page (CORS). If it does not, use <b>Download processing settings</b> and WebODM instead.`, null);
  }
  const form = new FormData();
  photoSet.files.forEach(f => form.append('images', f, f.name));
  form.append('name', state.projectName || 'GridFly map');
  form.append('options', JSON.stringify(currentOdmOptions()));
  $('btnOdmSend').disabled = true;
  try {
    const res = await upload(`${base}/task/new${q}`, form, f => odmSay(`Sending ${photoSet.files.length} photos… ${Math.round(f * 100)}%`, f * 100));
    if (!res.uuid) throw new Error(res.error || 'no task was created');
    setPref('odmTask', { base, uuid: res.uuid });
    watchTask(base, res.uuid);
  } catch (e) {
    odmSay(`Sending failed: ${esc(e.message)}.`, null);
  } finally {
    $('btnOdmSend').disabled = false;
  }
}

function watchTask(base, uuid) {
  clearTimeout(odmTimer);
  $('btnOdmStop').hidden = false;
  const q = odmQ();
  const poll = async () => {
    try {
      const info = await (await fetch(`${base}/task/${uuid}/info${q}`)).json();
      const code = info.status?.code, what = ODM_STATUS[code] || 'working';
      if (code === 40) {
        odmSay(`<b>Your map is ready.</b> <a href="${esc(`${base}/task/${uuid}/download/orthophoto.tif${q}`)}" target="_blank" rel="noopener">Orthophoto (GeoTIFF)</a> · <a href="${esc(`${base}/task/${uuid}/download/all.zip${q}`)}" target="_blank" rel="noopener">Everything (zip)</a>`, null);
        $('btnOdmStop').hidden = true;
        return;
      }
      if (code === 30 || code === 50) {
        odmSay(`Processing ${what}${info.status?.errorMessage ? `: ${esc(info.status.errorMessage)}` : ''}.`, null);
        $('btnOdmStop').hidden = true;
        return;
      }
      odmSay(`Processing on NodeODM: ${what}, ${Math.round(info.progress || 0)}%. You can close this panel; GridFly keeps watching while the app is open.`, info.progress || 0);
    } catch (e) {
      odmSay(`Lost touch with NodeODM (${esc(e.message)}). Retrying…`, null);
    }
    odmTimer = setTimeout(poll, 5000);
  };
  poll();
}

// ---------- Init ----------

export function initMapMake() {
  $('btnQuickMap').onclick = quickMap;
  $('btnOdmKit').onclick = odmKit;
  $('btnOdmSend').onclick = odmSend;
  $('btnOdmStop').onclick = () => { clearTimeout(odmTimer); $('btnOdmStop').hidden = true; odmSay('Stopped watching. The server keeps processing.', null); };
  $('odmUrl').value = pref('odmUrl', '');
  const task = pref('odmTask', null);
  if (task?.uuid) $('odmBox').addEventListener('toggle', function once() { $('odmBox').removeEventListener('toggle', once); if ($('odmBox').open && !$('odmStatus').textContent) watchTask(task.base, task.uuid); });
}
