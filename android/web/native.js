// Bridge to the Android app (MainActivity.kt injects `ZeldaNative`, @JavascriptInterface) with browser
// fallbacks, so the same shell also runs in a desktop browser for development
// (npm run serve -> http://localhost:8080/android/web/).
//
// Android -> page calls go to window.ZeldaApp (app.js): onBack, onPause, onResume, onPad, onInsets,
// onRomPicked.

import { getStoredRom, storeRom } from '../../src/core/romstore.js';
import { loadSram as loadLocal, saveSram as saveLocal } from '../../src/core/savestore.js';

const N = globalThis.ZeldaNative ?? null;

export const isAndroid = N !== null;

/** URL of a file kept by the app (served by MainActivity's WebViewAssetLoader under /native/). */
const nativeUrl = (path) => `/native/${path}`;

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

async function fetchBytes(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

let pickResolve = null;

export const native = {
  /**
   * Android: the ROM packed into the APK at build time (scripts/android/rom-asset.mjs, assets/rom/zelda.nes).
   * @returns {Promise<Uint8Array|null>} null in a browser or when the APK has none
   */
  async bundledRom() {
    if (!N) return null;
    try {
      return await fetchBytes('/assets/rom/zelda.nes');
    } catch {
      return null;
    }
  },

  /** @returns {Promise<Uint8Array|null>} the ROM kept from a previous run */
  async storedRom() {
    if (N) return N.hasRom() ? fetchBytes(nativeUrl('rom/zelda.nes')) : null;
    const b = await getStoredRom();
    return b ? new Uint8Array(b) : null;
  },

  /**
   * Opens the system file picker. Resolves with the picked bytes (not stored yet: validate, then
   * commitRom/discardRom); bytes is null when the player cancels ('cancel') or the file could not be
   * read ('error', 'too-big').
   * @returns {Promise<{status: string, bytes: Uint8Array|null}>}
   */
  pickRom() {
    if (N) {
      return new Promise((resolve) => {
        pickResolve = resolve;
        N.pickRom();
      });
    }
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.nes';
      input.onchange = async () => {
        const file = input.files[0];
        resolve(file ? { status: 'ok', bytes: new Uint8Array(await file.arrayBuffer()) } : { status: 'cancel', bytes: null });
      };
      input.oncancel = () => resolve({ status: 'cancel', bytes: null });
      input.click();
    });
  },

  /** Android: MainActivity copied the picked document to rom/candidate.nes ('ok') or not. */
  async romPicked(status) {
    const resolve = pickResolve;
    pickResolve = null;
    if (!resolve) return;
    const bytes = status === 'ok' ? await fetchBytes(nativeUrl('rom/candidate.nes')) : null;
    resolve({ status: status === 'ok' && !bytes ? 'error' : status, bytes });
  },

  /** Keeps the validated candidate as the app's ROM. */
  async commitRom(bytes) {
    if (N) return N.commitRom();
    return storeRom(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  },

  discardRom() { N?.discardRom(); },

  /** Restores the battery SRAM into `sram`; true when there was a save. */
  loadSram(sram) {
    if (!N) return loadLocal(sram);
    const text = N.loadSram();
    if (!text) return false;
    const data = fromBase64(text);
    if (data.length !== sram.length) return false;
    sram.set(data);
    return true;
  },

  /** Writes the battery SRAM (atomically, in the app's private storage on Android). */
  saveSram(sram) {
    if (!N) return saveLocal(sram);
    return N.saveSram(toBase64(sram));
  },

  vibrate(ms) {
    if (N) N.vibrate(ms);
    else navigator.vibrate?.(ms);
  },

  keepScreenOn(on) { N?.setKeepScreenOn(on); },

  /** Areas (CSS px) where the system back gesture is disabled (D-pad and buttons near the edges). */
  setGestureExclusion(rects) {
    if (!N) return;
    const dpr = globalThis.devicePixelRatio || 1;
    N.setGestureExclusion(JSON.stringify(rects.map((r) => [r.x, r.y, r.x + r.w, r.y + r.h].map((v) => Math.round(v * dpr)))));
  },

  exit() {
    if (N) N.exitApp();
    else location.reload();
  },

  /** The page is ready for Android -> page calls (insets, pad state). */
  ready() { N?.pageReady(); },

  isDebug() { return N ? N.isDebug() : true; },
};
