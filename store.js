// Inera Edit Flow — persistent local storage (IndexedDB) for projects and output files.
// Data stays in this browser on this device. There are no accounts, so nothing can "sign you out".

const DB_NAME = 'inera-edit-flow';
const DB_VERSION = 1;
let dbPromise = null;
let memoryFallback = null; // used only if IndexedDB is unavailable (e.g. some private modes)

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  }).then((db) => {
    if (!db) memoryFallback = { projects: new Map(), blobs: new Map() };
    return db;
  });
  return dbPromise;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error || new Error('Storage error'));
    t.onabort = () => reject(t.error || new Error('Storage aborted (storage may be full)'));
  });
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function isPersistentAvailable() { return !!(await openDB()); }

export async function saveProject(p) {
  p.updatedAt = Date.now();
  const db = await openDB();
  if (!db) { memoryFallback.projects.set(p.id, structuredClone(p)); return p; }
  await tx(db, 'projects', 'readwrite', (s) => s.put(p));
  return p;
}

export async function getProject(id) {
  const db = await openDB();
  if (!db) return memoryFallback.projects.get(id) || null;
  return tx(db, 'projects', 'readonly', (s) => reqP(s.get(id)));
}

export async function listProjects() {
  const db = await openDB();
  let all;
  if (!db) all = [...memoryFallback.projects.values()];
  else all = await tx(db, 'projects', 'readonly', (s) => reqP(s.getAll()));
  return (all || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function putBlob(key, blob) {
  const db = await openDB();
  if (!db) { memoryFallback.blobs.set(key, blob); return; }
  await tx(db, 'blobs', 'readwrite', (s) => s.put(blob, key));
}

export async function getBlob(key) {
  const db = await openDB();
  if (!db) return memoryFallback.blobs.get(key) || null;
  return tx(db, 'blobs', 'readonly', (s) => reqP(s.get(key)));
}

export async function deleteProject(id) {
  const p = await getProject(id);
  const db = await openDB();
  const keys = [];
  if (p) {
    for (const o of p.outputs || []) { if (o.blobKey) keys.push(o.blobKey); if (o.opfs) await removeOpfs(o.opfs); }
    if (p.thumbKey) keys.push(p.thumbKey);
  }
  if (!db) {
    keys.forEach((k) => memoryFallback.blobs.delete(k));
    memoryFallback.projects.delete(id);
    return;
  }
  await tx(db, 'blobs', 'readwrite', (s) => { keys.forEach((k) => k && s.delete(k)); });
  await tx(db, 'projects', 'readwrite', (s) => s.delete(id));
}

// Large video outputs live in the Origin Private File System (no size duplication in IndexedDB)
async function removeOpfs(name) { try { const dir = await navigator.storage.getDirectory(); await dir.removeEntry(name); } catch (e) { /* gone */ } }
export async function getOutputBlob(o) {
  if (o.opfs) { try { const dir = await navigator.storage.getDirectory(); const h = await dir.getFileHandle(o.opfs); return await h.getFile(); } catch (e) { return null; } }
  return o.blobKey ? getBlob(o.blobKey) : null;
}
// Delete render files on disk that no project references (cancelled / crashed renders, temp audio)
export async function cleanOrphanFiles(activeNames = new Set()) {
  let dir; try { dir = await navigator.storage.getDirectory(); } catch (e) { return 0; }
  const used = new Set(activeNames);
  for (const p of await listProjects()) for (const o of p.outputs || []) if (o.opfs) used.add(o.opfs);
  let n = 0;
  const names = []; try { for await (const [name] of dir.entries()) names.push(name); } catch (e) { return 0; }
  // only files untouched for 12 h: another open tab may be rendering right now
  for (const name of names) {
    if (used.has(name)) continue;
    try { const f = await (await dir.getFileHandle(name)).getFile(); if (Date.now() - f.lastModified < 12 * 3600e3) continue; await dir.removeEntry(name); n++; } catch (e) { /* in use / folder */ }
  }
  return n;
}

export async function clearAll() {
  for (const p of await listProjects()) for (const o of p.outputs || []) if (o.opfs) await removeOpfs(o.opfs);
  const db = await openDB();
  if (!db) { memoryFallback.projects.clear(); memoryFallback.blobs.clear(); return; }
  await tx(db, 'blobs', 'readwrite', (s) => s.clear());
  await tx(db, 'projects', 'readwrite', (s) => s.clear());
}

// Mark jobs that were running when the tab closed as interrupted
export async function recoverInterrupted() {
  const all = await listProjects();
  for (const p of all) {
    if (p.status === 'processing' || p.status === 'queued') {
      p.status = 'interrupted';
      p.error = 'The page was closed or reloaded while this job was running. Open the mode and run it again.';
      await saveProject(p);
    }
  }
}

// Keep storage tidy: remove the oldest finished projects beyond the configured limit
export async function enforceHistoryLimit(maxProjects) {
  const all = await listProjects();
  const done = all.filter((p) => p.status !== 'processing');
  for (const p of done.slice(maxProjects)) await deleteProject(p.id);
}

export async function storageEstimate() {
  try {
    const e = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    return { usage: e.usage || 0, quota: e.quota || 0, persisted };
  } catch (e) { return { usage: 0, quota: 0, persisted: false }; }
}

export async function requestPersistence() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) {}
  return false;
}

// Simple settings in localStorage (with safe fallbacks)
const SETTINGS_KEY = 'inera-edit-flow-settings';
export const DEFAULT_SETTINGS = {
  imageFormat: 'image/jpeg',
  imageQuality: 0.92,
  historyLimit: 30,
  showSafeAreas: false,
};
export function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')) }; }
  catch (e) { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
}
