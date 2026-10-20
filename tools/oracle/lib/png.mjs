// Minimal PNG encoder/decoder (8-bit RGB / RGBA / palette, non-interlaced) using node:zlib.
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes, crc = 0xffffffff) {
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  Buffer.from(data.buffer, data.byteOffset, data.length).copy(out, 8);
  out.writeUInt32BE((crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}

/** Encodes an RGB image. `rgb` is a Uint8Array of width*height*3 bytes. */
export function encodePng(width, height, rgb) {
  if (rgb.length !== width * height * 3) throw new Error('encodePng: expected width*height*3 bytes');
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilter(data, height, stride, bpp) {
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const type = data[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const raw = data[src + x];
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[dst - stride + x - bpp] : 0;
      let v;
      switch (type) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: v = raw + paeth(a, b, c); break;
        default: throw new Error(`decodePng: bad filter type ${type}`);
      }
      out[dst + x] = v & 0xff;
    }
  }
  return out;
}

/** Decodes a PNG to {width, height, rgb} (8-bit color types 2, 3, 6; no interlace). */
export function decodePng(buf) {
  buf = Buffer.from(buf);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('decodePng: not a PNG');
  let pos = 8, width = 0, height = 0, colorType = 0, palette = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('decodePng: only 8-bit non-interlaced supported');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = { 2: 3, 3: 1, 6: 4 }[colorType];
  if (!bpp) throw new Error(`decodePng: unsupported color type ${colorType}`);
  const px = unfilter(inflateSync(Buffer.concat(idat)), height, width * bpp, bpp);
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    if (colorType === 3) {
      rgb.set(palette.subarray(px[i] * 3, px[i] * 3 + 3), i * 3);
    } else {
      rgb[i * 3] = px[i * bpp];
      rgb[i * 3 + 1] = px[i * bpp + 1];
      rgb[i * 3 + 2] = px[i * bpp + 2];
    }
  }
  return { width, height, rgb };
}
