// Keeps the user's ROM in IndexedDB so the page does not ask for it on every visit.
// All failures resolve to null/false: the page then simply asks for the file again.

const DB = 'zelda-port';
const STORE = 'rom';
const KEY = 'zelda.nes';

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** @returns {Promise<ArrayBuffer|null>} */
export async function getStoredRom() {
  try { return (await run('readonly', (s) => s.get(KEY))) ?? null; } catch { return null; }
}

/** @param {ArrayBuffer} buffer */
export async function storeRom(buffer) {
  try { await run('readwrite', (s) => s.put(buffer, KEY)); return true; } catch { return false; }
}

export async function forgetRom() {
  try { await run('readwrite', (s) => s.delete(KEY)); return true; } catch { return false; }
}
