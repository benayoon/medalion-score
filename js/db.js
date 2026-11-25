// Tiny IndexedDB key-value store: 'kv' for JSON state, 'blobs' for imported files.
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open('medalion-score', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('kv');
      r.result.createObjectStore('blobs');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(r => { out = r; });
    t.oncomplete = () => resolve(out && out.result !== undefined && out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
  });
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function get(key, store = 'kv') {
  const db = await open();
  return req(db.transaction(store).objectStore(store).get(key));
}
export async function set(key, val, store = 'kv') {
  return tx(store, 'readwrite', s => { s.put(val, key); });
}
export async function del(key, store = 'kv') {
  return tx(store, 'readwrite', s => { s.delete(key); });
}
export async function keys(store = 'kv') {
  const db = await open();
  return req(db.transaction(store).objectStore(store).getAllKeys());
}
export const getBlob = k => get(k, 'blobs');
export const setBlob = (k, v) => set(k, v, 'blobs');
export const delBlob = k => del(k, 'blobs');
