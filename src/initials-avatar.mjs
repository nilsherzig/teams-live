import { deflateSync } from 'node:zlib';

// A tiny bitmap font keeps generated PNGs self-contained and deterministic.
const FONT = {
  A: ['01110','10001','10001','11111','10001','10001','10001'], B: ['11110','10001','10001','11110','10001','10001','11110'],
  C: ['01111','10000','10000','10000','10000','10000','01111'], D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'], F: ['11111','10000','10000','11110','10000','10000','10000'],
  G: ['01111','10000','10000','10111','10001','10001','01111'], H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['11111','00100','00100','00100','00100','00100','11111'], J: ['00111','00010','00010','00010','10010','10010','01100'],
  K: ['10001','10010','10100','11000','10100','10010','10001'], L: ['10000','10000','10000','10000','10000','10000','11111'],
  M: ['10001','11011','10101','10101','10001','10001','10001'], N: ['10001','11001','10101','10011','10001','10001','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'], P: ['11110','10001','10001','11110','10000','10000','10000'],
  Q: ['01110','10001','10001','10001','10101','10010','01101'], R: ['11110','10001','10001','11110','10100','10010','10001'],
  S: ['01111','10000','10000','01110','00001','00001','11110'], T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'], V: ['10001','10001','10001','10001','10001','01010','00100'],
  W: ['10001','10001','10001','10101','10101','10101','01010'], X: ['10001','10001','01010','00100','01010','10001','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'], Z: ['11111','00001','00010','00100','01000','10000','11111'],
  '?': ['01110','10001','00001','00010','00100','00000','00100'],
};

export function nameInitials(name) {
  const parts = String(name).trim().split(/\s+/u).filter(Boolean);
  return [parts[0], ...(parts.length > 1 ? [parts.at(-1)] : [])]
    .filter(Boolean).map((part) => Array.from(part)[0].toLocaleUpperCase()).join('');
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const tag = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([length, tag, data, checksum]);
}

export function initialsAvatar(name) {
  const initials = Array.from(nameInitials(name)).slice(0, 2);
  const glyphs = initials.map((letter) => FONT[letter.normalize('NFD').replace(/\p{M}/gu, '')]);
  if (!glyphs.length || glyphs.some((glyph) => !glyph)) return null;
  const size = 36;
  const pixels = Buffer.alloc((size * 3 + 1) * size);
  const origin = Math.floor((size - (glyphs.length * 10 + (glyphs.length - 1) * 2)) / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const lit = glyphs.some((glyph, i) => {
        const gx = Math.floor((x - origin - i * 12) / 2);
        const gy = Math.floor((y - 11) / 2);
        return gx >= 0 && gx < 5 && gy >= 0 && gy < 7 && glyph[gy][gx] === '1';
      });
      const offset = y * (size * 3 + 1) + 1 + x * 3;
      pixels.set(lit ? [255, 255, 255] : [91, 102, 120], offset);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 2;
  return `data:image/png;base64,${Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')}`;
}
