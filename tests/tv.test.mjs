import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { setRichMessages, transport } from '../src/teams.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import {
  TvProgrammeService,
  buildProgrammeCard,
  currentAndNext,
  formatProgrammeText,
  loadProgrammes,
  normalizeTvConfig,
  parseArdProgram,
  parseTvArgs,
  parseXmltv,
  parseXmltvTime,
} from '../src/tv.mjs';

beforeEach(() => setRichMessages(false));

const CONV = '19:test@thread.v2';
const NOW = new Date('2026-01-15T12:30:00Z'); // 13:30 in Europe/Berlin

// Generic fixtures: nothing here comes from a real installation.
const XMLTV = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="chan-a.example"><display-name>Channel A</display-name></channel>
  <programme start="20260115120000 +0000" stop="20260115130000 +0000" channel="chan-a.example">
    <title lang="de">Rock &amp; Roll &lt;Live&gt;</title>
    <sub-title lang="de">Folge 1</sub-title>
    <desc lang="de">Eine   Show.</desc>
  </programme>
  <programme start="20260115130000 +0000" stop="20260115140000 +0000" channel="chan-a.example">
    <title>News</title>
  </programme>
  <programme start="20260115120000 +0000" stop="20260115130000 +0000" channel="chan-b.example">
    <title>Other channel</title>
  </programme>
</tv>`;

const ardDay = (items, id = 'chan-x') => ({
  channels: [
    { id, timeSlots: [items.slice(0, 1), items.slice(1)] },
    { id: 'other', timeSlots: [[{ title: 'Nope', broadcastedOn: '2026-01-15T13:00:00+01:00', broadcastEnd: '2026-01-15T14:00:00+01:00' }]] },
  ],
});
const ardItem = (title, from, to, extra = {}) => ({ title, broadcastedOn: from, broadcastEnd: to, ...extra });

const config = (extra = {}) =>
  normalizeTvConfig({
    channels: {
      ard: { type: 'ard-api', url: 'https://epg.example/api/program', channel_id: 'chan-x', name: 'Channel X' },
      zdf: { type: 'xmltv', url: 'https://epg.example/guide.xml', channel_id: 'chan-a.example', name: 'Channel A' },
    },
    ...extra,
  });

function fakeFetch(routes, seen = []) {
  return async (url) => {
    seen.push(String(url));
    const hit = Object.entries(routes).find(([prefix]) => String(url).startsWith(prefix));
    if (!hit) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const body = typeof hit[1] === 'function' ? hit[1](String(url)) : hit[1];
    if (body instanceof Error) throw body;
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
}

test('normalizeTvConfig: defaults, overrides, and a bad value never throws', () => {
  const d = normalizeTvConfig(undefined);
  assert.equal(d.timezone, 'Europe/Berlin');
  assert.equal(d.cache_ttl_seconds, 300);
  assert.equal(d.channels.ard.type, 'ard-api');
  assert.equal(d.channels.zdf.type, 'xmltv');

  const o = normalizeTvConfig({ timezone: 'Not/AZone', cache_ttl_seconds: -4, channels: { zdf: { name: 'Zwei' } } });
  assert.equal(o.timezone, 'Europe/Berlin');
  assert.equal(o.cache_ttl_seconds, 300);
  assert.equal(o.channels.zdf.name, 'Zwei');
  assert.equal(o.channels.zdf.url, d.channels.zdf.url);

  // A different source type does not inherit the URL or channel id of the default type.
  const t = normalizeTvConfig({ channels: { ard: { type: 'xmltv' } } });
  assert.equal(t.channels.ard.type, 'xmltv');
  assert.equal(t.channels.ard.url, '');
  assert.equal(normalizeTvConfig('junk').channels.ard.name, 'Das Erste');
});

test('parseXmltvTime handles offsets and rejects junk', () => {
  assert.equal(parseXmltvTime('20260115120000 +0000').toISOString(), '2026-01-15T12:00:00.000Z');
  assert.equal(parseXmltvTime('20260115130000 +0100').toISOString(), '2026-01-15T12:00:00.000Z');
  assert.equal(parseXmltvTime('2026011512'), null);
  assert.equal(parseXmltvTime('nope'), null);
});

test('parseXmltv keeps one channel, decodes entities and sorts', () => {
  const list = parseXmltv(XMLTV, 'chan-a.example');
  assert.deepEqual(list.map((p) => p.title), ['Rock & Roll <Live>', 'News']);
  assert.equal(list[0].subtitle, 'Folge 1');
  assert.equal(list[0].description, 'Eine Show.');
  assert.deepEqual(parseXmltv(XMLTV, ''), []);
  assert.deepEqual(parseXmltv(XMLTV, 'missing'), []);
});

test('parseArdProgram reads one channel, falls back to duration, skips broken items', () => {
  const json = ardDay([
    ardItem('B', '2026-01-15T14:00:00+01:00', '2026-01-15T15:00:00+01:00', { subline: 'sub' }),
    { coreTitle: 'A', beginNet: '2026-01-15T13:00:00+01:00', duration: 3600 },
    { title: 'no times' },
  ]);
  const list = parseArdProgram(json, 'chan-x');
  assert.deepEqual(list.map((p) => p.title), ['A', 'B']);
  assert.equal(list[0].end.toISOString(), '2026-01-15T13:00:00.000Z');
  assert.equal(list[1].subtitle, 'sub');
  assert.deepEqual(parseArdProgram({}, 'chan-x'), []);
});

test('currentAndNext', () => {
  const list = parseXmltv(XMLTV, 'chan-a.example');
  const mid = currentAndNext(list, new Date('2026-01-15T12:30:00Z'));
  assert.equal(mid.current.title, 'Rock & Roll <Live>');
  assert.equal(mid.next.title, 'News');
  const last = currentAndNext(list, new Date('2026-01-15T13:30:00Z'));
  assert.equal(last.current.title, 'News');
  assert.equal(last.next, null);
  const gap = currentAndNext(list, new Date('2026-01-15T11:00:00Z'));
  assert.equal(gap.current, null);
  assert.equal(gap.next.title, 'Rock & Roll <Live>');
});

test('loadProgrammes: XMLTV (plain and gzip), and the ARD neighbouring day', async () => {
  const cfg = config();
  const plain = await loadProgrammes(cfg.channels.zdf, { fetchImpl: fakeFetch({ 'https://epg.example/guide.xml': XMLTV }), now: NOW });
  assert.equal(plain.length, 2);
  const gz = await loadProgrammes(cfg.channels.zdf, { fetchImpl: fakeFetch({ 'https://epg.example/guide.xml': zlib.gzipSync(XMLTV) }), now: NOW });
  assert.equal(gz.length, 2);

  // 00:30 local: the running programme belongs to the previous programme day.
  const seen = [];
  const night = new Date('2026-01-15T23:30:00Z'); // 00:30 on the 16th in Berlin
  const fetchImpl = fakeFetch(
    {
      'https://epg.example/api/program?day=2026-01-16': ardDay([ardItem('Morning', '2026-01-16T05:30:00+01:00', '2026-01-16T09:00:00+01:00')]),
      'https://epg.example/api/program?day=2026-01-15': ardDay([ardItem('Late', '2026-01-15T23:00:00+01:00', '2026-01-16T01:00:00+01:00')]),
    },
    seen
  );
  const list = await loadProgrammes(cfg.channels.ard, { fetchImpl, now: night });
  assert.deepEqual(seen, ['https://epg.example/api/program?day=2026-01-16', 'https://epg.example/api/program?day=2026-01-15']);
  const { current, next } = currentAndNext(list, night);
  assert.equal(current.title, 'Late');
  assert.equal(next.title, 'Morning');
});

test('loadProgrammes fails clearly without a source', async () => {
  await assert.rejects(
    loadProgrammes({ type: 'xmltv', url: '', channel_id: 'x' }, { fetchImpl: fakeFetch({}) }),
    /no programme source configured/
  );
  await assert.rejects(
    loadProgrammes({ type: 'xmltv', url: 'https://epg.example/x', channel_id: '' }, { fetchImpl: fakeFetch({}) }),
    /no channel id configured/
  );
  await assert.rejects(
    loadProgrammes({ type: 'xmltv', url: 'https://epg.example/x', channel_id: 'c' }, { fetchImpl: fakeFetch({}) }),
    /HTTP 404/
  );
});

const ardRoutes = () => ({
  'https://epg.example/api/program': ardDay([
    ardItem('Quiz', '2026-01-15T13:00:00+01:00', '2026-01-15T14:00:00+01:00'),
    ardItem('Krimi', '2026-01-15T14:00:00+01:00', '2026-01-15T15:00:00+01:00'),
  ]),
});

test('TvProgrammeService caches, isolates a failing channel and serves stale data', async () => {
  let clock = NOW;
  const seen = [];
  const routes = { ...ardRoutes(), 'https://epg.example/guide.xml': XMLTV };
  const svc = new TvProgrammeService(config(), { fetchImpl: fakeFetch(routes, seen), now: () => clock });

  const first = await svc.getProgramme();
  assert.deepEqual(first.channels.map((c) => [c.key, c.current?.title, c.next?.title, c.error]), [
    ['ard', 'Quiz', 'Krimi', null],
    ['zdf', 'Rock & Roll <Live>', 'News', null],
  ]);
  const requests = seen.length;
  await svc.getProgramme();
  assert.equal(seen.length, requests, 'second call is served from the cache');

  // Source goes down after the cache expired: the stale list still answers, no error shown.
  clock = new Date(NOW.getTime() + 10 * 60_000);
  const down = new TvProgrammeService(config(), { fetchImpl: fakeFetch({}), now: () => clock });
  const failed = await down.getProgramme();
  assert.ok(failed.channels.every((c) => /HTTP 404/.test(c.error)));

  const flaky = new TvProgrammeService(config(), { fetchImpl: fakeFetch({ ...ardRoutes(), 'https://epg.example/guide.xml': new Error('boom') }), now: () => NOW });
  const partial = await flaky.getProgramme();
  assert.equal(partial.channels[0].error, null);
  assert.equal(partial.channels[1].error, 'boom');
});

test('formatProgrammeText: regular markdown with escaping, progress and errors', async () => {
  const svc = new TvProgrammeService(config(), { fetchImpl: fakeFetch({ ...ardRoutes(), 'https://epg.example/guide.xml': XMLTV }), now: () => NOW });
  const text = formatProgrammeText(await svc.getProgramme());
  assert.match(text, /^\u{1F4FA} \*\*TV programme\*\* \(13:30\)/u);
  assert.ok(text.includes('- Now: **Quiz** (13:00–14:00, 50%)'));
  assert.ok(text.includes('- Next: 14:00 **Krimi**'));
  assert.ok(text.includes('Rock &amp; Roll &lt;Live&gt;'), 'source text is escaped');
  assert.ok(text.includes('— Folge 1'));

  const withError = formatProgrammeText({ now: NOW, timezone: 'Europe/Berlin', channels: [{ key: 'ard', name: 'Channel X', error: 'HTTP 500', current: null, next: null }] });
  assert.ok(withError.includes('HTTP 500'));
});

test('buildProgrammeCard: a card per channel, text progress bar, null without channels', async () => {
  const svc = new TvProgrammeService(config(), { fetchImpl: fakeFetch({ ...ardRoutes(), 'https://epg.example/guide.xml': XMLTV }), now: () => NOW });
  const data = await svc.getProgramme();
  const card = buildProgrammeCard(data);
  assert.equal(card.type, 'AdaptiveCard');
  const json = JSON.stringify(card);
  assert.ok(json.includes('Channel X') && json.includes('Channel A'));
  assert.ok(json.includes('▰') && json.includes('50%'));
  assert.ok(json.includes('NOW') && json.includes('NEXT'));
  assert.equal(buildProgrammeCard({ now: NOW, timezone: 'Europe/Berlin', channels: [] }), null);
  assert.ok(card.fallbackText.includes('Quiz'));
});

test('parseTvArgs', () => {
  for (const a of ['program', 'programm', 'programme', 'PROGRAMM']) assert.equal(parseTvArgs([a]).action, 'programme');
  assert.equal(parseTvArgs([]).action, 'help');
  assert.equal(parseTvArgs(['ard']).action, 'ard');
  assert.equal(parseTvArgs(['ZDF']).action, 'zdf');
  assert.equal(parseTvArgs(['off']).action, 'off');
  assert.deepEqual(parseTvArgs(['wat']), { action: 'unknown', arg: 'wat' });
});

// ------------------------------------------------------------------ watcher

function recordTransport() {
  const calls = [];
  const original = { ...transport };
  transport.sendMessage = (...args) => {
    calls.push(args);
    return Promise.resolve({ ok: true, value: { messageId: '1700000000001', timestamp: '1700000000001' } });
  };
  return { calls, restore: () => Object.assign(transport, original) };
}

function newWatcher(teams = {}, tvFetch = fakeFetch({ ...ardRoutes(), 'https://epg.example/guide.xml': XMLTV })) {
  const watcher = new MergeRequestWatcher({
    config: { conversations: [], gitlab: { group: 'group' }, teams, tv: config() },
    gitlab: { findMrLinks: () => [], getMr: async () => null },
    jira: null,
    opsgenie: null,
  });
  watcher.saveState = () => {};
  watcher.tv = new TvProgrammeService(config(), { fetchImpl: tvFetch, now: () => NOW });
  const reactions = [];
  watcher.setCommandReaction = async (conv, msg, key) => reactions.push(key);
  return { watcher, reactions };
}

const event = { conversationId: CONV, messageId: '1700000000000', from: 'Alice Example' };

async function runCommand(teams, args, tvFetch) {
  const rec = recordTransport();
  const { watcher, reactions } = newWatcher(teams, tvFetch);
  try {
    await watcher.executeTvCommand(event, args);
  } finally {
    rec.restore();
  }
  return { calls: rec.calls, reactions };
}

test('/tv program: regular text without rich messages', async () => {
  const { calls, reactions } = await runCommand({}, ['program']);
  assert.equal(calls.length, 1);
  const [, html, options] = calls[0];
  assert.ok(html.includes('Quiz'));
  assert.equal(options.properties.cards, '[]');
  assert.equal(reactions.length, 1);
  assert.match(reactions[0], /whiteheavycheckmark/);
});

test('/tv programm: a card in rich mode, with the markdown as fallback', async () => {
  const { calls } = await runCommand({ rich_messages: true }, ['programm']);
  assert.equal(calls.length, 1);
  const [, html, options] = calls[0];
  assert.ok(html.includes('InputExtension'));
  const card = JSON.parse(options.properties.cards)[0].content;
  assert.ok(JSON.stringify(card).includes('NOW'));
  assert.ok(JSON.stringify(card).includes('Quiz'));
  assert.ok(card.fallbackText.includes('Quiz'), 'the card carries the text as its fallback');
});

test('/tv program: both sources down is a failure reaction, not a crash', async () => {
  const { calls, reactions } = await runCommand({}, ['program'], fakeFetch({}));
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /HTTP 404/);
  assert.match(reactions[0], /crossmark/);
});

test('/tv without a known argument shows the usage', async () => {
  for (const args of [[], ['wat']]) {
    const { calls, reactions } = await runCommand({}, args);
    assert.equal(calls.length, 1);
    assert.ok(calls[0][1].includes('/tv program'));
    assert.match(reactions[0], /warning/);
  }
});

test('/tv is a known command and listed in /help', async () => {
  const { watcher } = newWatcher();
  assert.equal(watcher.parseSlashCommand('/tv program').command, '/tv');
  const rec = recordTransport();
  try {
    await watcher.executeHelpCommand(event, ['tools']);
  } finally {
    rec.restore();
  }
  assert.ok(rec.calls[0][1].includes('/tv program'));
});

test('loadConfig carries the tv section with defaults', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { loadConfig } = await import('../src/config.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-config-'));
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ tv: { timezone: 'Europe/London', channels: { zdf: { channel_id: 'chan-z' } } } }));
    const tv = loadConfig(file).tv;
    assert.equal(tv.timezone, 'Europe/London');
    assert.equal(tv.channels.zdf.channel_id, 'chan-z');
    assert.equal(tv.channels.ard.type, 'ard-api');
    fs.writeFileSync(file, '{}');
    assert.equal(loadConfig(file).tv.timezone, 'Europe/Berlin');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
