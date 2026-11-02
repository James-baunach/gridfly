// Client for the local helper (server.py), which copies missions onto a USB-connected
// DJI controller. The custom header makes browsers preflight cross-site requests, which the
// helper never approves, so other web pages cannot drive it.

const HEADERS = { 'X-GridFly': '1' };

async function call(path, init = {}) {
  const res = await fetch(path, { ...init, headers: { ...HEADERS, ...(init.headers || {}) } });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return res;
}

export async function status() {
  try {
    return await (await call('/api/status')).json();
  } catch {
    return { installer: false, helper: false };
  }
}

// -> [{device, storage, missions: [{id, kmzName, modified, size}]}]
export async function listControllers() {
  return (await call('/api/devices')).json();
}

export async function fetchMission(target, id) {
  const q = new URLSearchParams({ device: target.device, storage: target.storage, id });
  const buf = await (await call('/api/mission?' + q)).arrayBuffer();
  return new File([buf], id + '.kmz');
}

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function post(path, body) {
  return call(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
}

// -> {ok, verified, backup, warning}
export async function installMission(target, id, blob) {
  return post('/api/install', { device: target.device, storage: target.storage, id, kmz: await toBase64(blob) });
}

// -> [{folder, mission, file, size, created}], newest first
export async function listBackups() {
  return (await call('/api/backups')).json();
}

// Reinstalls a backup onto mission slot `id`. -> {ok, verified, backup, warning}
export async function restoreBackup(target, id, folder) {
  return post('/api/restore', { device: target.device, storage: target.storage, id, backup: folder });
}

// EXPERIMENTAL: makes a new mission folder on the controller. -> {ok, id, verified, warning}
export async function createMission(target, templateId, blob) {
  return post('/api/create', { device: target.device, storage: target.storage, template: templateId, kmz: await toBase64(blob) });
}
