// Armazenamento local com IndexedDB (transcrições + áudio ficam só no navegador).
const DB_NAME = 'transcritor-mari';
const STORE = 'transcricoes';
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listAll() {
  const items = await tx('readonly', (s) => reqToPromise(s.getAll()));
  return (items || []).sort((a, b) => b.createdAt - a.createdAt);
}

export async function get(id) {
  return tx('readonly', (s) => reqToPromise(s.get(id)));
}

export async function save(item) {
  item.updatedAt = Date.now();
  await tx('readwrite', (s) => reqToPromise(s.put(item)));
  return item;
}

export async function remove(id) {
  await tx('readwrite', (s) => reqToPromise(s.delete(id)));
}

export function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
}
