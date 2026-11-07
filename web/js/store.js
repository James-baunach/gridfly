// Small IndexedDB key-value store for data kept for offline use: ground elevations, site check results,
// the list of saved areas, and My projects. Falls back to memory where IndexedDB is missing (tests, private modes).

const DB = 'gridfly';
const STORES = ['elev', 'site', 'areas', 'projects'];
let dbPromise = null;
const memory = new Map(STORES.map(s => [s, new Map()]));

function open() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  dbPromise ||= new Promise(resolve => {
    let req;
    try { req = indexedDB.open(DB, 2); } catch { return resolve(null); }
    req.onupgradeneeded = () => { for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s); };
    // Let a newer version of the app (in another tab) upgrade the database.
    req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); dbPromise = null; }; resolve(req.result); };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

const done = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function tx(store, mode, fn) {
  const db = await open();
  if (!db) return fn(null);
  const t = db.transaction(store, mode);
  const finished = new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  const [result] = await Promise.all([fn(t.objectStore(store)), finished]);
  return result;
}

export async function get(store, key) {
  try {
    return await tx(store, 'readonly', os => os ? done(os.get(key)) : memory.get(store).get(key));
  } catch { return undefined; }
}

export async function getMany(store, keys) {
  if (!keys.length) return [];
  try {
    return await tx(store, 'readonly', os => os ? Promise.all(keys.map(k => done(os.get(k)))) : keys.map(k => memory.get(store).get(k)));
  } catch { return keys.map(() => undefined); }
}

export async function set(store, key, value) {
  return setMany(store, [[key, value]]);
}

export async function setMany(store, entries) {
  if (!entries.length) return true;
  try {
    await tx(store, 'readwrite', os => {
      if (!os) { for (const [k, v] of entries) memory.get(store).set(k, v); return; }
      for (const [k, v] of entries) os.put(v, k);
    });
    return true;
  } catch { return false; }
}

export async function del(store, key) {
  try { await tx(store, 'readwrite', os => os ? os.delete(key) : memory.get(store).delete(key)); } catch { /* ignore */ }
}

/** All values of a store. */
export async function all(store) {
  try {
    return await tx(store, 'readonly', os => os ? done(os.getAll()) : [...memory.get(store).values()]);
  } catch { return []; }
}

export async function count(store) {
  try {
    return await tx(store, 'readonly', os => os ? done(os.count()) : memory.get(store).size);
  } catch { return 0; }
}
