// Size and position of the 256x240 picture on the phone screen, in DEVICE pixels so that every NES pixel
// becomes an exact block of physical pixels (integer scale, nearest neighbour, 1:1 pixel aspect ratio
// like the web page), centred on a black background.

export const NES_W = 256;
export const NES_H = 240;

/**
 * @param {{cssWidth: number, cssHeight: number, dpr: number, mode?: 'integer'|'fit', devWidth?: number, devHeight?: number}} o
 *   integer: the largest whole multiple that fits (default); fit: as large as possible (non-integer).
 *   devWidth/devHeight: the exact size in device pixels when known (Android sends the WebView's size:
 *   innerWidth/innerHeight are rounded CSS pixels, 411 instead of 411.43 on a 1440 px tall screen).
 * @returns {{scale: number, devW: number, devH: number, devX: number, devY: number,
 *   css: {x: number, y: number, w: number, h: number}}}
 */
export function fitScreen({ cssWidth, cssHeight, dpr, mode = 'integer', devWidth = Math.round(cssWidth * dpr), devHeight = Math.round(cssHeight * dpr) }) {
  const max = Math.min(devWidth / NES_W, devHeight / NES_H);
  const scale = mode === 'fit' ? max : Math.max(1, Math.floor(max));
  const devW = Math.floor(NES_W * scale);
  const devH = Math.floor(NES_H * scale);
  const devX = Math.floor((devWidth - devW) / 2);
  const devY = Math.floor((devHeight - devH) / 2);
  return { scale, devW, devH, devX, devY, css: { x: devX / dpr, y: devY / dpr, w: devW / dpr, h: devH / dpr } };
}
