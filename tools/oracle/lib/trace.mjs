// Binary trace format (.ztrace) shared by the oracle and the port runner.
//
//   header : "ZTRC" | u16 version | u16 0 | u32 jsonLength | JSON metadata (utf8)
//   record : u32 frame | u32 videoFrame | u8 p1 | u8 p2 | u8 flags | u8 0
//            | RAM[0x800] | SRAM[0x2000] if flags&1 | framebuffer[256*240] if flags&2
//
// SRAM is only written when it changed since the previous record (readers carry it forward).
// Framebuffers hold canonical NES color indices (see palette.mjs). All integers little-endian.
import { openSync, writeSync, closeSync, readFileSync } from 'node:fs';
import { FB_SIZE } from './palette.mjs';

export const MAGIC = 'ZTRC';
export const VERSION = 1;
export const RAM_SIZE = 0x800;
export const SRAM_SIZE = 0x2000;
const FLAG_SRAM = 1;
const FLAG_FB = 2;
const REC_HEADER = 12;

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class TraceWriter {
  constructor(path, meta) {
    this.fd = openSync(path, 'w');
    this.lastSram = null;
    this.count = 0;
    const json = Buffer.from(JSON.stringify(meta), 'utf8');
    const head = Buffer.alloc(12);
    head.write(MAGIC, 0, 'latin1');
    head.writeUInt16LE(VERSION, 4);
    head.writeUInt32LE(json.length, 8);
    writeSync(this.fd, head);
    writeSync(this.fd, json);
  }

  /** frame: {frame, videoFrame, p1, p2, ram, sram, fb?} */
  write(f) {
    const writeSram = f.sram && !sameBytes(f.sram, this.lastSram);
    const flags = (writeSram ? FLAG_SRAM : 0) | (f.fb ? FLAG_FB : 0);
    const head = Buffer.alloc(REC_HEADER);
    head.writeUInt32LE(f.frame >>> 0, 0);
    head.writeUInt32LE((f.videoFrame ?? 0) >>> 0, 4);
    head[8] = f.p1 ?? 0;
    head[9] = f.p2 ?? 0;
    head[10] = flags;
    writeSync(this.fd, head);
    writeSync(this.fd, f.ram);
    if (writeSram) {
      writeSync(this.fd, f.sram);
      this.lastSram = Uint8Array.from(f.sram);
    }
    if (f.fb) writeSync(this.fd, f.fb);
    this.count++;
  }

  close() {
    closeSync(this.fd);
  }
}

/** Parses a whole trace into memory. Returns {meta, frames}. */
export function parseTrace(buf) {
  buf = Buffer.from(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength ?? buf.length);
  if (buf.toString('latin1', 0, 4) !== MAGIC) throw new Error('trace: bad magic (not a .ztrace file)');
  const version = buf.readUInt16LE(4);
  if (version !== VERSION) throw new Error(`trace: unsupported version ${version}`);
  const jsonLen = buf.readUInt32LE(8);
  const meta = JSON.parse(buf.toString('utf8', 12, 12 + jsonLen));
  const frames = [];
  let pos = 12 + jsonLen;
  let sram = null;
  while (pos < buf.length) {
    if (pos + REC_HEADER + RAM_SIZE > buf.length) throw new Error(`trace: truncated record at byte ${pos}`);
    const flags = buf[pos + 10];
    const rec = {
      frame: buf.readUInt32LE(pos),
      videoFrame: buf.readUInt32LE(pos + 4),
      p1: buf[pos + 8],
      p2: buf[pos + 9],
    };
    pos += REC_HEADER;
    rec.ram = new Uint8Array(buf.buffer, buf.byteOffset + pos, RAM_SIZE);
    pos += RAM_SIZE;
    if (flags & FLAG_SRAM) {
      sram = new Uint8Array(buf.buffer, buf.byteOffset + pos, SRAM_SIZE);
      pos += SRAM_SIZE;
    }
    rec.sram = sram;
    rec.fb = null;
    if (flags & FLAG_FB) {
      rec.fb = new Uint8Array(buf.buffer, buf.byteOffset + pos, FB_SIZE);
      pos += FB_SIZE;
    }
    frames.push(rec);
  }
  return { meta, frames };
}

export function readTrace(path) {
  return parseTrace(readFileSync(path));
}

/** In-memory collector with the same interface as TraceWriter (for tests and APIs). */
export class TraceCollector {
  constructor(meta) {
    this.meta = meta;
    this.frames = [];
  }

  write(f) {
    this.frames.push({
      frame: f.frame,
      videoFrame: f.videoFrame ?? 0,
      p1: f.p1 ?? 0,
      p2: f.p2 ?? 0,
      ram: Uint8Array.from(f.ram),
      sram: f.sram ? Uint8Array.from(f.sram) : null,
      fb: f.fb ? Uint8Array.from(f.fb) : null,
    });
  }

  close() {}
}
