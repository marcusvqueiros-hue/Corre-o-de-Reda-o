// IndexedDB com fallback em memória (modo privado / armazenamento bloqueado).
const STORES = { kv: {}, msgs: { keyPath: 'id' }, outbox: { keyPath: 'id' }, locq: { keyPath: 'k', autoIncrement: true }, users: { keyPath: 'id' } };
let dbp = null;
let persistent = true;
const mem = Object.fromEntries(Object.keys(STORES).map((k) => [k, new Map()]));
let memAuto = 1;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    if (!('indexedDB' in window)) { persistent = false; return resolve(null); }
    let req;
    try { req = indexedDB.open('elo', 1); } catch (_) { persistent = false; return resolve(null); }
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const [name, opts] of Object.entries(STORES)) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, opts);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = req.onblocked = () => { persistent = false; resolve(null); };
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then((d) => {
    if (!d) return null;
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      const r = fn(s);
      if (r) r.onsuccess = () => { result = r.result; };
      t.oncomplete = () => resolve(result);
      t.onerror = t.onabort = () => reject(t.error);
    });
  });
}

export const db = {
  get persistent() { return persistent; },
  init: open,
  async get(store, key) {
    const r = await tx(store, 'readonly', (s) => s.get(key)).catch(() => null);
    return persistent ? r ?? undefined : mem[store].get(key);
  },
  async put(store, val, key) {
    if (!persistent) {
      const kp = STORES[store].keyPath;
      if (kp === 'k' && val.k == null) val.k = memAuto++;
      mem[store].set(kp ? val[kp] : key, val);
      return;
    }
    await tx(store, 'readwrite', (s) => (STORES[store].keyPath ? s.put(val) : s.put(val, key))).catch(() => {});
  },
  async del(store, key) {
    if (!persistent) return void mem[store].delete(key);
    await tx(store, 'readwrite', (s) => s.delete(key)).catch(() => {});
  },
  async all(store) {
    const r = await tx(store, 'readonly', (s) => s.getAll()).catch(() => []);
    return persistent ? r || [] : [...mem[store].values()];
  },
  async count(store) {
    const r = await tx(store, 'readonly', (s) => s.count()).catch(() => 0);
    return persistent ? r || 0 : mem[store].size;
  },
  async clear(store) {
    if (!persistent) return void mem[store].clear();
    await tx(store, 'readwrite', (s) => s.clear()).catch(() => {});
  },
};
