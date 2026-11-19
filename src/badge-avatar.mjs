/**
 * A round profile picture with a small round badge on its top-right corner, as one PNG data URI.
 *
 * Adaptive Cards cannot layer one image over another, so the badge is baked into the picture. Used to
 * mark a person whose approval the MS Teams bot made on their behalf. Pure functions: no I/O, no
 * network; the pictures come in as data URIs (JPEG or PNG) and go out as a PNG data URI.
 */

import { createRequire } from 'node:module';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const decodeJpeg = require('./vendor/jpeg-decoder.cjs');

export const BADGED_SIZE = 40; // pixels of the generated image
// The picture takes this share of the image and is centred in it, the rest is the margin the badge uses.
// Showing the image at `badgedDisplayPx(18)` puts the picture at exactly 18px, like every plain picture.
const AVATAR_SHARE = 18 / 22; // an 18px picture in a 22px image: about 2px of margin on each side
export const badgedDisplayPx = (avatarPx) => Math.round(avatarPx / AVATAR_SHARE);
const MAX_DECODE_PIXELS = 512 * 512;

/** @returns {{width:number,height:number,data:Uint8Array}|null} RGBA pixels, or null when it cannot be read */
export function decodeImageDataUri(uri) {
  const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(uri ?? ''));
  if (!match) return null;
  try {
    const bytes = Buffer.from(match[2], 'base64');
    const image = bytes[0] === 0xff && bytes[1] === 0xd8 ? decodeJpegBytes(bytes) : decodePngBytes(bytes);
    return image && image.width > 0 && image.height > 0 && image.width * image.height <= MAX_DECODE_PIXELS ? image : null;
  } catch {
    return null;
  }
}

function decodeJpegBytes(bytes) {
  const image = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 1 });
  return { width: image.width, height: image.height, data: image.data };
}

// Non-interlaced 8-bit PNG (grey, grey+alpha, RGB, RGBA, palette): all this repository produces or fetches.
function decodePngBytes(bytes) {
  if (bytes.readUInt32BE(0) !== 0x89504e47) return null;
  let offset = 8;
  let header = null;
  let palette = null;
  let alpha = null;
  const idat = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') alpha = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!header || header.depth !== 8 || header.interlace !== 0 || header.width * header.height > MAX_DECODE_PIXELS) return null;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.color];
  if (!channels) return null;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = header.width * channels;
  const out = new Uint8Array(header.width * header.height * 4);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = (line[i] + predictor) & 255;
    }
    for (let x = 0; x < header.width; x++) {
      const o = (y * header.width + x) * 4;
      const p = x * channels;
      if (header.color === 6) out.set([line[p], line[p + 1], line[p + 2], line[p + 3]], o);
      else if (header.color === 2) out.set([line[p], line[p + 1], line[p + 2], 255], o);
      else if (header.color === 0) out.set([line[p], line[p], line[p], 255], o);
      else if (header.color === 4) out.set([line[p], line[p], line[p], line[p + 1]], o);
      else {
        const i = line[p] * 3;
        out.set([palette?.[i] ?? 0, palette?.[i + 1] ?? 0, palette?.[i + 2] ?? 0, alpha?.[line[p]] ?? 255], o);
      }
    }
    previous = line;
  }
  return { width: header.width, height: header.height, data: out };
}

function encodePng({ width, height, data }) {
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (width * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(rows, y * (width * 4 + 1) + 1);
  }
  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'latin1');
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const SUBSAMPLES = 4; // per axis: smooth edges and a clean downscale of the logo

// Colour of an image at a fractional position (nearest pixel; the supersampling averages the rest),
// premultiplied; transparent outside the picture.
function pixel(image, fx, fy) {
  const x = Math.floor(fx);
  const y = Math.floor(fy);
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return [0, 0, 0, 0];
  const o = (y * image.width + x) * 4;
  const a = image.data[o + 3] / 255;
  return [image.data[o] * a, image.data[o + 1] * a, image.data[o + 2] * a, a];
}

export const TEAMS_PURPLE = [0x5b, 0x5f, 0xc7];

/**
 * @param {string} avatarUri  the person's picture (JPEG or PNG data URI)
 * @param {object} [opts]
 * @param {number} [opts.size]          output size in pixels (square)
 * @param {number[]} [opts.color]       badge colour as [r, g, b] (default Teams purple)
 * @param {number} [opts.badgeFraction] badge diameter as a share of the picture (default 0.4)
 * @returns {string|null} a PNG data URI, or null when the picture cannot be read (the caller keeps the plain picture)
 *
 * The result is a round picture (centred, about 82% of the image) with a solid round badge on its top-right rim, like a
 * notification badge, with a thin white outline so it reads on any picture. Edges are anti-aliased by
 * supersampling. Show it WITHOUT the card's `style: Person` (a circular crop would cut the badge off).
 */
export function badgeAvatar(avatarUri, { size = BADGED_SIZE, color = TEAMS_PURPLE, badgeFraction = 0.4 } = {}) {
  const avatar = decodeImageDataUri(avatarUri);
  if (!avatar) return null;
  const out = new Uint8Array(size * size * 4);
  const radius = (size * AVATAR_SHARE) / 2;
  const centreX = size / 2;
  const centreY = size / 2;
  const discRadius = (size * badgeFraction) / 2;
  const outline = Math.max(1, size / 32);
  // On the picture's top-right rim (45 degrees), and never past the image edge, outline included.
  const discX = Math.min(centreX + radius * Math.SQRT1_2, size - discRadius - outline);
  const discY = Math.max(centreY - radius * Math.SQRT1_2, discRadius + outline);
  const crop = Math.min(avatar.width, avatar.height);
  const cropX = (avatar.width - crop) / 2;
  const cropY = (avatar.height - crop) / 2;
  const n = SUBSAMPLES;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const px = x + (sx + 0.5) / n;
          const py = y + (sy + 0.5) / n;
          let cr = 0;
          let cg = 0;
          let cb = 0;
          let ca = 0;
          if (Math.hypot(px - centreX, py - centreY) <= radius) {
            [cr, cg, cb, ca] = pixel(avatar, cropX + ((px - (centreX - radius)) / (radius * 2)) * crop, cropY + ((py - (centreY - radius)) / (radius * 2)) * crop);
          }
          const d = Math.hypot(px - discX, py - discY);
          if (d <= discRadius + outline) {
            [cr, cg, cb] = d <= discRadius ? color : [255, 255, 255];
            ca = 1;
          }
          r += cr;
          g += cg;
          b += cb;
          a += ca;
        }
      }
      const count = n * n;
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.min(255, Math.round(r / a));
        out[o + 1] = Math.min(255, Math.round(g / a));
        out[o + 2] = Math.min(255, Math.round(b / a));
        out[o + 3] = Math.round((a / count) * 255);
      }
    }
  }
  return `data:image/png;base64,${encodePng({ width: size, height: size, data: out }).toString('base64')}`;
}
