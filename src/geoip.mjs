// Offline IP geolocation from a MaxMind DB file (.mmdb): the DB-IP "City Lite" database or any other
// database in that format. A small reader, no dependency: it looks an address up in the search tree and
// decodes the record. Nothing is sent anywhere, so an approver's address never leaves this machine.
//
// Format: https://maxmind.github.io/MaxMind-DB/

import fs from 'node:fs';
import { isIP } from 'node:net';

const METADATA_MARKER = Buffer.from('\xAB\xCD\xEFMaxMind.com', 'latin1');
const DATA_SEPARATOR = 16;

class Decoder {
  constructor(buffer, base) {
    this.buffer = buffer;
    this.base = base; // pointers are relative to the start of the data section
  }

  /** @returns {[any, number]} the value and the offset after it */
  decode(offset) {
    const control = this.buffer[offset++];
    let type = control >> 5;
    if (type === 1) return this.pointer(control, offset);
    if (type === 0) type = this.buffer[offset++] + 7;
    let size = control & 31;
    if (size === 29) size = 29 + this.buffer[offset++];
    else if (size === 30) {
      size = 285 + this.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (size === 31) {
      size = 65821 + this.buffer.readUIntBE(offset, 3);
      offset += 3;
    }
    return this.value(type, size, offset);
  }

  pointer(control, offset) {
    const sizeBits = (control >> 3) & 3;
    const low = control & 7;
    let target;
    if (sizeBits === 0) target = (low << 8) + this.buffer[offset];
    else if (sizeBits === 1) target = ((low << 16) + this.buffer.readUIntBE(offset, 2)) + 2048;
    else if (sizeBits === 2) target = ((low << 24) + this.buffer.readUIntBE(offset, 3)) + 526336;
    else target = this.buffer.readUInt32BE(offset);
    const length = sizeBits === 3 ? 4 : sizeBits + 1;
    const [value] = this.decode(this.base + target);
    return [value, offset + length];
  }

  value(type, size, offset) {
    const b = this.buffer;
    switch (type) {
      case 2: return [b.toString('utf8', offset, offset + size), offset + size];
      case 3: return [b.readDoubleBE(offset), offset + 8];
      case 4: return [b.subarray(offset, offset + size), offset + size];
      case 5:
      case 6:
      case 8: return [size === 0 ? 0 : b.readUIntBE(offset, size), offset + size];
      case 9:
      case 10: {
        let n = 0n;
        for (let i = 0; i < size; i++) n = (n << 8n) | BigInt(b[offset + i]);
        return [n, offset + size];
      }
      case 7: {
        const map = {};
        for (let i = 0; i < size; i++) {
          const [key, afterKey] = this.decode(offset);
          const [val, afterVal] = this.decode(afterKey);
          map[key] = val;
          offset = afterVal;
        }
        return [map, offset];
      }
      case 11: {
        const list = [];
        for (let i = 0; i < size; i++) {
          const [val, after] = this.decode(offset);
          list.push(val);
          offset = after;
        }
        return [list, offset];
      }
      case 14: return [size !== 0, offset];
      case 15: return [b.readFloatBE(offset), offset + 4];
      default: throw new Error(`unsupported MaxMind DB type ${type}`);
    }
  }
}

/** Opens a database from a file path or a Buffer. Throws when it is not a MaxMind DB. */
export function openGeoIp(source) {
  const buffer = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
  const marker = buffer.lastIndexOf(METADATA_MARKER);
  if (marker < 0) throw new Error('not a MaxMind DB file (no metadata)');
  const [meta] = new Decoder(buffer, marker + METADATA_MARKER.length).decode(marker + METADATA_MARKER.length);
  const nodeCount = Number(meta.node_count);
  const recordSize = Number(meta.record_size);
  const ipVersion = Number(meta.ip_version);
  if (![24, 28, 32].includes(recordSize) || !nodeCount) throw new Error('unsupported MaxMind DB layout');
  const nodeBytes = (recordSize * 2) / 8;
  const treeSize = nodeCount * nodeBytes;
  const dataBase = treeSize + DATA_SEPARATOR;
  const decoder = new Decoder(buffer, dataBase);

  const record = (node, right) => {
    const o = node * nodeBytes;
    if (recordSize === 24) return buffer.readUIntBE(o + (right ? 3 : 0), 3);
    if (recordSize === 32) return buffer.readUInt32BE(o + (right ? 4 : 0));
    // 28 bits: the middle byte holds the high nibbles of both records.
    const middle = buffer[o + 3];
    return right ? ((middle & 0x0f) << 24) + buffer.readUIntBE(o + 4, 3) : ((middle >> 4) << 24) + buffer.readUIntBE(o, 3);
  };

  const bitsOf = (ip) => {
    const version = isIP(ip);
    let bytes;
    if (version === 4) bytes = ip.split('.').map(Number);
    else if (version === 6) {
      // Expand "::" and an embedded dotted tail.
      let text = ip.toLowerCase();
      const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
      if (tail) {
        const [a, b, c, d] = tail[1].split('.').map(Number);
        text = text.replace(tail[1], `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`);
      }
      const [head, rest] = text.split('::');
      const left = head ? head.split(':') : [];
      const right = rest === undefined ? [] : rest ? rest.split(':') : [];
      const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
      bytes = groups.flatMap((g) => [parseInt(g || '0', 16) >> 8, parseInt(g || '0', 16) & 255]);
    } else return null;
    // An IPv4 address in an IPv6 database lives under ::/96.
    if (version === 4 && ipVersion === 6) bytes = [...Array(12).fill(0), ...bytes];
    if (version === 6 && ipVersion === 4) return null;
    return bytes;
  };

  return {
    metadata: meta,
    /** The raw record of an address, or null when the database has none. */
    lookupRaw(ip) {
      const bytes = bitsOf(String(ip || '').trim());
      if (!bytes) return null;
      let node = 0;
      for (let i = 0; i < bytes.length * 8 && node < nodeCount; i++) {
        const bit = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
        node = record(node, bit === 1);
      }
      if (node === nodeCount) return null;
      if (node < nodeCount) return null;
      const [value] = decoder.decode(treeSize + (node - nodeCount));
      return value;
    },
    /** `{city, region, country, countryCode}` of an address (English names), or null when unknown. */
    lookup(ip) {
      let raw;
      try {
        raw = this.lookupRaw(ip);
      } catch {
        return null;
      }
      if (!raw || typeof raw !== 'object') return null;
      const name = (x) => x?.names?.en || x?.name || '';
      const place = {
        city: name(raw.city),
        region: name(raw.subdivisions?.[0]),
        country: name(raw.country) || name(raw.registered_country),
        countryCode: raw.country?.iso_code || raw.registered_country?.iso_code || '',
      };
      return place.city || place.region || place.country ? place : null;
    },
  };
}

/** "Frankfurt am Main, Hesse, Germany 🇩🇪" from a lookup; the parts that are known, without repeats. */
export function formatPlace(place) {
  if (!place) return '';
  const parts = [place.city, place.region, place.country].filter(Boolean).filter((p, i, all) => all.indexOf(p) === i);
  const flag = /^[A-Za-z]{2}$/.test(place.countryCode || '')
    ? String.fromCodePoint(...place.countryCode.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))
    : '';
  return [parts.join(', '), flag].filter(Boolean).join(' ');
}
