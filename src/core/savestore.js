// Battery SRAM persistence in localStorage (base64). Every access is guarded: storage may
// be unavailable (private mode, quota, Node tests) and the game must still run.

const DEFAULT_KEY = 'zelda-port.sram.v1';

function getStorage(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Load saved SRAM into `sram` (Uint8Array). Returns true if something was restored. */
export function loadSram(sram, { key = DEFAULT_KEY, storage } = {}) {
  try {
    const st = getStorage(storage);
    const text = st?.getItem(key);
    if (!text) return false;
    const data = fromBase64(text);
    if (data.length !== sram.length) return false;
    sram.set(data);
    return true;
  } catch {
    return false;
  }
}

/** Save `sram`. Returns true on success. */
export function saveSram(sram, { key = DEFAULT_KEY, storage } = {}) {
  try {
    const st = getStorage(storage);
    if (!st) return false;
    st.setItem(key, toBase64(sram));
    return true;
  } catch {
    return false;
  }
}

/**
 * Save only when SRAM changed since the last call (cheap enough to call once per second).
 * Returns a function () => boolean (true when it wrote).
 */
export function createAutoSaver(sram, opts = {}) {
  let last = sram.slice();
  return () => {
    for (let i = 0; i < sram.length; i++) {
      if (sram[i] !== last[i]) {
        last = sram.slice();
        return saveSram(sram, opts);
      }
    }
    return false;
  };
}
