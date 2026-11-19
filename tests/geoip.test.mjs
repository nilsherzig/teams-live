import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPlace, openGeoIp } from '../src/geoip.mjs';

// A tiny MaxMind DB built here: IPv4, 24-bit records, two nodes.
//   0.0.0.0/2   -> place A;   64.0.0.0/2 -> nothing;   128.0.0.0/1 -> place B (its country is a pointer to A's).
const str = (s) => Buffer.concat([Buffer.from([(2 << 5) | s.length]), Buffer.from(s)]);
const map = (entries) => Buffer.concat([Buffer.from([(7 << 5) | entries.length]), ...entries.flatMap(([k, v]) => [str(k), v])]);
const uint = (type, n) => {
  const bytes = n === 0 ? [] : n <= 0xff ? [n] : n <= 0xffff ? [n >> 8, n & 0xff] : [n >> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  return Buffer.from([(type << 5) | bytes.length, ...bytes]);
};
const array = (items) => Buffer.concat([Buffer.from([items.length, 4]), ...items]);

function buildDb() {
  const country = map([['iso_code', str('AA')], ['names', map([['en', str('Alphaland')]])]]);
  const a = map([
    ['city', map([['names', map([['en', str('Alpha City')]])]])],
    ['country', country],
    ['subdivisions', array([map([['names', map([['en', str('Alpha Region')]])]])])],
  ]);
  // B's country is a pointer into A's data (offset of the country map inside A).
  const countryOffset = a.indexOf(country);
  const pointer = Buffer.from([0x20 | (countryOffset >> 8), countryOffset & 0xff]);
  const b = map([['city', map([['names', map([['en', str('Beta Town')]])]])], ['country', pointer]]);
  const nodeCount = 2;
  const record = (value) => Buffer.from([(value >> 16) & 255, (value >> 8) & 255, value & 255]);
  const dataOffsetB = a.length;
  const tree = Buffer.concat([
    record(1), record(nodeCount + 16 + dataOffsetB), // node 0: left -> node 1, right -> B
    record(nodeCount + 16 + 0), record(nodeCount), // node 1: left -> A, right -> no data
  ]);
  const meta = map([['node_count', uint(6, nodeCount)], ['record_size', uint(5, 24)], ['ip_version', uint(5, 4)], ['database_type', str('Test')]]);
  return Buffer.concat([tree, Buffer.alloc(16), a, b, Buffer.from('\xAB\xCD\xEFMaxMind.com', 'latin1'), meta]);
}

test('a MaxMind DB is read: records, pointers, nested maps and arrays', () => {
  const db = openGeoIp(buildDb());
  assert.equal(db.metadata.database_type, 'Test');
  assert.deepEqual(db.lookup('10.1.2.3'), { city: 'Alpha City', region: 'Alpha Region', country: 'Alphaland', countryCode: 'AA' });
  assert.deepEqual(db.lookup('200.0.0.1'), { city: 'Beta Town', region: '', country: 'Alphaland', countryCode: 'AA' }, 'the country comes through a pointer');
  assert.equal(db.lookup('64.0.0.1'), null, 'an address the database has no record for');
  assert.equal(db.lookup('not an ip'), null);
  assert.equal(db.lookup('2001:db8::1'), null, 'an IPv6 address in an IPv4 database');
  assert.equal(db.lookup(''), null);
});

test('a file that is not a MaxMind DB is refused', () => {
  assert.throws(() => openGeoIp(Buffer.from('definitely not a database')), /not a MaxMind DB/);
});

test('places read as text: the known parts, no repeats, and a flag', () => {
  assert.equal(formatPlace({ city: 'Berlin', region: 'Berlin', country: 'Germany', countryCode: 'DE' }), 'Berlin, Germany \u{1F1E9}\u{1F1EA}');
  assert.equal(formatPlace({ city: '', region: '', country: 'Canada', countryCode: 'CA' }), 'Canada \u{1F1E8}\u{1F1E6}');
  assert.equal(formatPlace({ city: 'X', region: '', country: '', countryCode: '' }), 'X');
  assert.equal(formatPlace(null), '');
});
