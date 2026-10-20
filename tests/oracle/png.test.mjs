import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePng, decodePng, crc32 } from '../../tools/oracle/lib/png.mjs';

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')) ^ 0xffffffff, 0xcbf43926 | 0);
});

test('encodePng/decodePng round-trip an RGB image', () => {
  const w = 7, h = 5;
  const rgb = new Uint8Array(w * h * 3).map((_, i) => (i * 37) & 0xff);
  const png = encodePng(w, h, rgb);
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  const back = decodePng(png);
  assert.equal(back.width, w);
  assert.equal(back.height, h);
  assert.deepEqual(back.rgb, rgb);
});

test('encodePng rejects a wrong buffer size', () => {
  assert.throws(() => encodePng(2, 2, new Uint8Array(5)));
});
