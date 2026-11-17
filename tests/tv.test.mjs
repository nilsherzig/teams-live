import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { setRichMessages, transport } from '../src/teams.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import {
  TvProgrammeService,
  TvSwitch,
  buildProgrammeCard,
  currentAndNext,
  formatProgrammeText,
  loadProgrammes,
  normalizeTvConfig,
  parseArdProgram,
  TV_SWITCH_TARGETS,
  TV_USAGE,
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

test('normalizeTvConfig: the switch section is empty by default and idempotent', () => {
  const d = normalizeTvConfig(undefined);
  assert.deepEqual(d.switch.webhooks, {});
  assert.equal(d.switch.base_url, '', 'there is no built-in base URL');
  assert.equal(d.switch.off_scene, 'brb');
  assert.equal(d.switch.timeout_seconds, 10);

  const raw = {
    switch: { base_url: 'https://ha.example/', webhooks: { ard: ' id-a ', zdf: '', off: 7, bogus: 'x' }, off_scene: 'away' },
  };
  const n = normalizeTvConfig(raw);
  assert.equal(n.switch.base_url, 'https://ha.example');
  assert.deepEqual(n.switch.webhooks, { ard: 'id-a' });
  assert.equal(n.switch.off_scene, 'away');
  assert.deepEqual(normalizeTvConfig(n), n);

  // An explicit base URL wins over the fallback; a junk base URL is dropped.
  assert.equal(normalizeTvConfig(raw, { baseUrl: 'https://other.example' }).switch.base_url, 'https://ha.example');
  assert.equal(normalizeTvConfig({}, { baseUrl: 'https://other.example/' }).switch.base_url, 'https://other.example');
  assert.equal(normalizeTvConfig({ switch: { base_url: 'ha.example' } }, { baseUrl: 'nope' }).switch.base_url, '');
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

// ------------------------------------------------------------------ switching

const SECRET_ID = 'secret-webhook-id-0123';
const SECRET_URL = 'https://ha.example/api/webhook/' + SECRET_ID;
const OWNER_MRI = '8:orgid:00000000-0000-0000-0000-000000000001';
const OTHER_MRI = '8:orgid:00000000-0000-0000-0000-000000000002';

const switchConfig = (extra = {}) =>
  config({
    switch: {
      base_url: 'https://ha.example',
      webhooks: { ard: SECRET_ID + '-ard', zdf: SECRET_ID + '-zdf', off: SECRET_ID + '-off' },
      ...extra,
    },
  });

function recordingFetch(handler = () => ({ ok: true, status: 200 })) {
  const requests = [];
  const impl = async (url, init) => {
    requests.push({ url: String(url), init });
    const out = await handler(String(url), init);
    if (out instanceof Error) throw out;
    return out;
  };
  return { requests, impl };
}

test('TvSwitch builds the webhook URL from the base URL and an id, or takes a full URL', () => {
  const sw = new TvSwitch(
    normalizeTvConfig({
      switch: { base_url: 'https://ha.example', webhooks: { ard: 'a b/c', zdf: 'https://hooks.example/h/zdf', off: 'ftp://x' } },
    }).switch
  );
  assert.equal(sw.webhookUrl('ard'), 'https://ha.example/api/webhook/a%20b%2Fc');
  assert.equal(sw.webhookUrl('zdf'), 'https://hooks.example/h/zdf');
  assert.equal(sw.webhookUrl('off'), 'https://ha.example/api/webhook/ftp%3A%2F%2Fx');
  assert.equal(sw.isConfigured('ard'), true);
  // An id without any base URL cannot be used.
  const bare = new TvSwitch(normalizeTvConfig({ switch: { webhooks: { ard: 'id' } } }).switch);
  assert.equal(bare.webhookUrl('ard'), null);
  assert.equal(bare.isConfigured('zdf'), false);
});

test('TvSwitch posts the target, sends the scene for off, and maps errors without leaking', async () => {
  const cfg = switchConfig().switch;
  const ok = recordingFetch();
  const sw = new TvSwitch(cfg, { fetchImpl: ok.impl });
  assert.deepEqual(await sw.switchTo('ard'), { ok: true });
  assert.deepEqual(await sw.switchTo('off'), { ok: true });
  assert.equal(ok.requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(ok.requests[0].init.body), { action: 'ard' });
  assert.deepEqual(JSON.parse(ok.requests[1].init.body), { action: 'off', scene: 'brb' });
  assert.ok(ok.requests[1].url.endsWith('-off'));

  const down = await new TvSwitch(cfg, { fetchImpl: recordingFetch(() => ({ ok: false, status: 503 })).impl }).switchTo('zdf');
  assert.deepEqual(down, { ok: false, error: 'HTTP 503' });

  const dns = await new TvSwitch(cfg, {
    fetchImpl: recordingFetch(() => new Error(`getaddrinfo ENOTFOUND ${SECRET_URL}`)).impl,
  }).switchTo('zdf');
  assert.deepEqual(dns, { ok: false, error: 'request failed' });

  const slow = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
  assert.deepEqual(
    await new TvSwitch(cfg, { fetchImpl: recordingFetch(() => slow).impl }).switchTo('ard'),
    { ok: false, error: 'timeout' }
  );
  assert.deepEqual(await new TvSwitch(normalizeTvConfig({}).switch).switchTo('ard'), { ok: false, error: 'not configured' });
});

async function runSwitch(action, { as = OWNER_MRI, tv = switchConfig(), handler, teams = {} } = {}) {
  const rec = recordTransport();
  const { watcher, reactions } = newWatcher(teams);
  watcher.selfMri = OWNER_MRI;
  watcher.selfOid = '00000000-0000-0000-0000-000000000001';
  const fetched = recordingFetch(handler);
  watcher.tvSwitch = new TvSwitch(tv.switch, { fetchImpl: fetched.impl });
  const logged = [];
  const origError = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    await watcher.executeTvCommand({ ...event, fromMri: as }, Array.isArray(action) ? action : [action]);
  } finally {
    console.error = origError;
    rec.restore();
  }
  const replies = rec.calls.map((c) => c[1]).join('\n');
  return { replies, reactions, requests: fetched.requests, logged: logged.join('\n') };
}

test('/tv ard|zdf|off: the owner switches; off asks for the brb scene', async () => {
  for (const action of ['ard', 'zdf', 'off']) {
    const r = await runSwitch(action);
    assert.equal(r.requests.length, 1, action);
    assert.ok(r.requests[0].url.endsWith(`-${action}`));
    assert.match(r.replies, /Switched to/);
    assert.match(r.reactions[0], /whiteheavycheckmark/);
  }
  const off = await runSwitch('off');
  assert.deepEqual(JSON.parse(off.requests[0].init.body), { action: 'off', scene: 'brb' });
  assert.match(off.replies, /brb/);
});

test('/tv ard: anyone but the owner is refused fail-closed and nothing is called', async () => {
  const r = await runSwitch('ard', { as: OTHER_MRI });
  assert.equal(r.requests.length, 0);
  assert.match(r.replies, /not in the sudoers file/);
  assert.match(r.reactions[0], /crossmark/);
  const anon = await runSwitch('off', { as: '' });
  assert.equal(anon.requests.length, 0);
  assert.match(anon.reactions[0], /crossmark/);
});

test('/tv ard: a configured admin may switch', async () => {
  const rec = recordTransport();
  const { watcher } = newWatcher();
  watcher.adminOids = new Set(['00000000-0000-0000-0000-000000000002']);
  const fetched = recordingFetch();
  watcher.tvSwitch = new TvSwitch(switchConfig().switch, { fetchImpl: fetched.impl });
  try {
    await watcher.executeTvCommand({ ...event, fromMri: OTHER_MRI }, ['zdf']);
  } finally {
    rec.restore();
  }
  assert.equal(fetched.requests.length, 1);
});

test('/tv ard: not configured is explained, not attempted', async () => {
  const r = await runSwitch('ard', { tv: config() });
  assert.equal(r.requests.length, 0);
  assert.match(r.replies, /not configured/);
  assert.match(r.reactions[0], /warning/);
  const partial = await runSwitch('zdf', { tv: config({ switch: { base_url: 'https://ha.example', webhooks: { ard: 'x' } } }) });
  assert.equal(partial.requests.length, 0);
  assert.match(partial.replies, /not configured/);
});

test('/tv ard: a failing Home Assistant is a failure reaction without a URL or id in the reply or log', async () => {
  for (const handler of [
    () => ({ ok: false, status: 500 }),
    () => new Error(`connect ECONNREFUSED ${SECRET_URL}`),
  ]) {
    const r = await runSwitch('ard', { handler });
    assert.match(r.replies, /Switching to ARD failed/);
    assert.match(r.reactions[0], /crossmark/);
    for (const text of [r.replies, r.logged]) {
      assert.ok(!text.includes(SECRET_ID), 'no webhook id');
      assert.ok(!text.includes('ha.example'), 'no host');
      assert.ok(!text.includes('/api/webhook'), 'no URL');
    }
  }
  const ok = await runSwitch('zdf');
  assert.ok(!ok.replies.includes(SECRET_ID) && !ok.logged.includes(SECRET_ID));
  assert.ok(!ok.logged.includes('ha.example'));
});

test('/tv usage and help mention the switch', async () => {
  const { calls } = await runCommand({}, ['wat']);
  assert.ok(calls[0][1].includes('/tv ard'));
  const { watcher } = newWatcher();
  const rec = recordTransport();
  try {
    await watcher.executeHelpCommand(event, ['tools']);
  } finally {
    rec.restore();
  }
  assert.ok(rec.calls[0][1].includes('/tv off'));
  for (const word of ['/tv tagesschau', '/tv next', '/tv prev', '/tv mute', '/tv vol up', '/tv vol down']) {
    assert.ok(rec.calls[0][1].includes(word), word);
    assert.ok(TV_USAGE.includes(word), word);
  }
});

test('loadConfig: the tv switch takes secrets from files and falls back to an explicit home_assistant url only', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { loadConfig } = await import('../src/config.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-switch-'));
  const savedHass = process.env.HASS_URL;
  delete process.env.HASS_URL;
  try {
    const idFile = path.join(dir, 'id');
    fs.writeFileSync(idFile, `${SECRET_ID}\n`);
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ tv: { switch: { webhooks: { ard: { _secret: idFile } } } } }));
    let tv = loadConfig(file).tv;
    assert.equal(tv.switch.webhooks.ard, SECRET_ID);
    assert.equal(tv.switch.base_url, '', 'the built-in home_assistant default is not inherited');

    fs.writeFileSync(file, JSON.stringify({ home_assistant: { url: 'https://ha.example/' }, tv: { switch: { webhooks: { ard: 'x' } } } }));
    tv = loadConfig(file).tv;
    assert.equal(tv.switch.base_url, 'https://ha.example');
  } finally {
    if (savedHass === undefined) delete process.env.HASS_URL;
    else process.env.HASS_URL = savedHass;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------- tagesschau, next/prev, mute, volume

const TOKEN = 'secret-ha-token-4567';
const STATE_URL = 'https://ha.example/api/states/select.scene_x';
const readbackConfig = (extra = {}) =>
  config({
    switch: {
      base_url: 'https://ha.example',
      webhooks: {
        ard: SECRET_ID + '-ard',
        zdf: SECRET_ID + '-zdf',
        tagesschau: SECRET_ID + '-tagesschau',
        off: SECRET_ID + '-off',
        mute: SECRET_ID + '-mute',
        volume: SECRET_ID + '-volume',
        volume_up: SECRET_ID + '-volume_up',
        volume_down: SECRET_ID + '-volume_down',
      },
      state: { entity_id: 'select.scene_x', token: TOKEN, map: { ard: ['ard', 'Scene ARD'], zdf: ['zdf', 'scene zdf'] } },
      volume: { entity_id: 'media_player.tv_x' },
      ...extra,
    },
  });

/** A fake Home Assistant: `scene` is what the state read returns, `volume` the volume_level attribute. */
function fakeHa({ scene = 'ard', volume = 0.5, fail = () => false, delayMs = 0 } = {}) {
  const ha = { scene, volume, posts: [] };
  const handler = async (url, init) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (fail(url, init)) return { ok: false, status: 503 };
    if (url.includes('/api/states/media_player.')) {
      return { ok: true, status: 200, json: async () => ({ state: 'on', attributes: { volume_level: ha.volume } }) };
    }
    if (url.includes('/api/states/')) return { ok: true, status: 200, json: async () => ({ state: ha.scene }) };
    const body = JSON.parse(init.body);
    ha.posts.push(body);
    if (['ard', 'zdf', 'tagesschau'].includes(body.action)) ha.scene = body.action === 'tagesschau' ? 'tagesschau' : body.action;
    if (body.action === 'off') ha.scene = 'brb';
    if (body.action === 'volume') ha.volume = body.level;
    return { ok: true, status: 200 };
  };
  return { ha, handler, ...recordingFetch(handler) };
}

test('parseTvArgs: tagesschau aliases and typos, next/prev, mute, vol', () => {
  for (const a of ['tagesschau', 'Tagesschau', 'ts', 'taggeesscahu', 'tagesshau', 'tageschau', 'tagesschua']) {
    assert.equal(parseTvArgs([a]).action, 'tagesschau', a);
  }
  for (const a of ['next', 'n', 'NEXT']) assert.equal(parseTvArgs([a]).action, 'next');
  for (const a of ['prev', 'previous', 'p']) assert.equal(parseTvArgs([a]).action, 'prev');
  assert.equal(parseTvArgs(['mute']).action, 'mute');
  assert.equal(parseTvArgs(['vol', 'up']).action, 'volume_up');
  assert.equal(parseTvArgs(['volume', 'DOWN']).action, 'volume_down');
  assert.equal(parseTvArgs(['vol']).action, 'unknown');
  for (const a of ['tag', 'program2', 'zdfneo', 'abc']) assert.equal(parseTvArgs([a]).action, 'unknown', a);
  assert.deepEqual(TV_SWITCH_TARGETS, ['ard', 'zdf', 'tagesschau']);
});

test('TvSwitch.cycle: forward, reverse and wrap follow the channel Home Assistant reports', async () => {
  const forward = { ard: 'zdf', zdf: 'tagesschau', tagesschau: 'ard' };
  const backward = { ard: 'tagesschau', zdf: 'ard', tagesschau: 'zdf' };
  for (const [direction, table] of [['next', forward], ['prev', backward]]) {
    for (const [scene, expected] of Object.entries(table)) {
      const { ha, impl } = fakeHa({ scene });
      const sw = new TvSwitch(readbackConfig().switch, { fetchImpl: impl });
      const out = await sw.cycle(direction);
      assert.deepEqual(out, { ok: true, target: expected, from: scene }, `${direction} from ${scene}`);
      assert.deepEqual(ha.posts, [{ action: expected }]);
    }
  }
});

test('TvSwitch.cycle: from off (brb or anything unmapped) next is ARD and prev is Tagesschau', async () => {
  for (const scene of ['brb', 'BRB']) {
    const a = fakeHa({ scene });
    assert.equal((await new TvSwitch(readbackConfig().switch, { fetchImpl: a.impl }).cycle('next')).target, 'ard');
    const b = fakeHa({ scene });
    assert.equal((await new TvSwitch(readbackConfig().switch, { fetchImpl: b.impl }).cycle('prev')).target, 'tagesschau');
  }
  // Anything that is neither a channel nor the off scene is unknown: nothing is switched.
  const odd = fakeHa({ scene: 'something else' });
  const unknown = await new TvSwitch(readbackConfig().switch, { fetchImpl: odd.impl }).cycle('next');
  assert.deepEqual(unknown, { ok: false, error: 'could not read the current channel (unrecognized state)' });
  assert.deepEqual(odd.ha.posts, []);
  // The mapped state values are matched case-insensitively.
  const mapped = fakeHa({ scene: 'Scene ZDF' });
  assert.equal((await new TvSwitch(readbackConfig().switch, { fetchImpl: mapped.impl }).cycle('next')).target, 'tagesschau');
});

test('TvSwitch.cycle: the readback is authenticated, and a failing or unusable one stops the command', async () => {
  const ok = fakeHa({ scene: 'ard' });
  await new TvSwitch(readbackConfig().switch, { fetchImpl: ok.impl }).cycle('next');
  assert.equal(ok.requests[0].url, STATE_URL);
  assert.equal(ok.requests[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(ok.requests[1].init.headers.Authorization, undefined, 'the token is not sent to the webhook');

  for (const scene of ['unavailable', 'unknown', '']) {
    const bad = fakeHa({ scene });
    const out = await new TvSwitch(readbackConfig().switch, { fetchImpl: bad.impl }).cycle('next');
    assert.equal(out.ok, false, scene);
    assert.match(out.error, /could not read the current channel/);
    assert.deepEqual(bad.ha.posts, [], 'no switch without a trustworthy current channel');
  }
  const down = fakeHa({ fail: (url) => url.includes('/api/states/') });
  const out = await new TvSwitch(readbackConfig().switch, { fetchImpl: down.impl }).cycle('next');
  assert.deepEqual(out, { ok: false, error: 'could not read the current channel (HTTP 503)' });
  assert.deepEqual(down.ha.posts, []);
});

test('TvSwitch.cycle: a failed switch does not advance', async () => {
  const flaky = fakeHa({ scene: 'ard', fail: (url) => url.includes('/api/webhook/') });
  const sw = new TvSwitch(readbackConfig().switch, { fetchImpl: flaky.impl });
  assert.deepEqual(await sw.cycle('next'), { ok: false, error: 'HTTP 503' });
  assert.equal(flaky.ha.scene, 'ard');
  assert.equal(sw.lastKnown, undefined);
  // Without readback the remembered channel is untouched by the failure too.
  const noRead = readbackConfig({ state: { trust_last_switch: true } }).switch;
  const ha = fakeHa({ fail: (url, init) => init?.body?.includes('zdf') });
  const local = new TvSwitch(noRead, { fetchImpl: ha.impl });
  await local.switchTo('ard');
  assert.equal((await local.cycle('next')).ok, false);
  assert.equal(local.lastKnown, 'ard');
});

test('TvSwitch.cycle: without readback it fails closed, even after a restart', async () => {
  const { ha, impl } = fakeHa();
  const sw = new TvSwitch(readbackConfig({ state: {} }).switch, { fetchImpl: impl });
  assert.equal(sw.hasReadback(), false);
  for (const d of ['next', 'prev']) {
    const out = await sw.cycle(d);
    assert.equal(out.ok, false);
    assert.match(out.error, /unknown \(no readback configured\)/);
  }
  await sw.switchTo('zdf');
  assert.equal((await sw.cycle('next')).ok, false, 'a remembered switch is not trusted unless opted in');
  assert.deepEqual(ha.posts, [{ action: 'zdf' }]);
});

test('TvSwitch.cycle: trust_last_switch cycles from this process\'s last switch, never before the first one', async () => {
  const { impl } = fakeHa();
  const sw = new TvSwitch(readbackConfig({ state: { trust_last_switch: true } }).switch, { fetchImpl: impl });
  assert.equal(sw.hasReadback(), false);
  const fresh = await sw.cycle('next');
  assert.equal(fresh.ok, false);
  assert.match(fresh.error, /unknown since the restart/);
  await sw.switchTo('ard');
  const seen = [];
  for (const d of ['next', 'next', 'next', 'next', 'prev']) seen.push((await sw.cycle(d)).target);
  assert.deepEqual(seen, ['zdf', 'tagesschau', 'ard', 'zdf', 'ard']);
  await sw.switchTo('off');
  assert.equal((await sw.cycle('prev')).target, 'tagesschau');
});

test('TvSwitch.cycle: targets without a webhook are skipped; none at all is not configured', async () => {
  const cfg = readbackConfig().switch;
  delete cfg.webhooks.zdf;
  const { impl } = fakeHa({ scene: 'ard' });
  const sw = new TvSwitch(cfg, { fetchImpl: impl });
  assert.equal((await sw.cycle('next')).target, 'tagesschau');
  const none = new TvSwitch(normalizeTvConfig({ switch: { base_url: 'https://ha.example' } }).switch, { fetchImpl: impl });
  assert.deepEqual(await none.cycle('next'), { ok: false, error: 'not configured' });
  assert.equal(none.canRun('next'), false);
});

test('TvSwitch: concurrent next commands are serialized, two presses advance twice', async () => {
  const { ha, impl } = fakeHa({ scene: 'ard', delayMs: 5 });
  const sw = new TvSwitch(readbackConfig().switch, { fetchImpl: impl });
  const [a, b, c] = await Promise.all([sw.cycle('next'), sw.cycle('next'), sw.cycle('prev')]);
  assert.deepEqual([a.target, b.target, c.target], ['zdf', 'tagesschau', 'zdf']);
  assert.deepEqual(ha.posts.map((p) => p.action), ['zdf', 'tagesschau', 'zdf']);

  // A failure in the middle of the queue does not wedge the commands behind it.
  let calls = 0;
  const flaky = fakeHa({ scene: 'ard', fail: (url) => url.includes('/api/webhook/') && ++calls === 1 });
  const s2 = new TvSwitch(readbackConfig().switch, { fetchImpl: flaky.impl });
  const [x, y] = await Promise.all([s2.cycle('next'), s2.cycle('next')]);
  assert.equal(x.ok, false);
  assert.equal(y.ok, true);
  assert.equal(y.target, 'zdf', 'the failed press did not advance, so the next one starts from ARD again');
});

test('TvSwitch: state read is sent to the explicit base URL only, with the daemon token as the fallback', () => {
  const own = normalizeTvConfig(
    { switch: { base_url: 'https://other.example', state: { entity_id: 'x.y' } } },
    { baseUrl: 'https://ha.example', token: TOKEN }
  ).switch;
  assert.equal(own.state.token, '', 'the daemon token is not sent to a different host');
  const inherited = normalizeTvConfig({ switch: { state: { entity_id: 'x.y' } } }, { baseUrl: 'https://ha.example', token: TOKEN }).switch;
  assert.equal(inherited.state.token, TOKEN);
  assert.equal(new TvSwitch(own).hasReadback(), false);
  assert.equal(new TvSwitch(inherited).hasReadback(), true);
});

test('TvSwitch.mute: always an explicit mute-on request, never a toggle, repeatable', async () => {
  const { ha, impl } = fakeHa();
  const sw = new TvSwitch(readbackConfig().switch, { fetchImpl: impl });
  assert.deepEqual(await sw.mute(), { ok: true, requested: true, channel: 'ard' });
  assert.deepEqual(await sw.mute(), { ok: true, requested: true, channel: 'ard' });
  assert.deepEqual(ha.posts, [{ action: 'mute', muted: true }, { action: 'mute', muted: true }]);
  assert.equal(sw.lastKnown, undefined, 'muting is not a channel change');
  const failing = fakeHa({ fail: (url) => url.includes('/api/webhook/') });
  assert.deepEqual(await new TvSwitch(readbackConfig().switch, { fetchImpl: failing.impl }).mute(), { ok: false, error: 'HTTP 503' });
});

test('TvSwitch.volumeStep: with a volume entity the level is read, stepped by 5 points and clamped to 0..1', async () => {
  const cfg = readbackConfig().switch;
  const { ha, impl } = fakeHa({ volume: 0.5 });
  const sw = new TvSwitch(cfg, { fetchImpl: impl });
  assert.deepEqual(await sw.volumeStep('up'), { ok: true, requested: true, channel: 'ard', level: 0.55 });
  assert.deepEqual(await sw.volumeStep('down'), { ok: true, requested: true, channel: 'ard', level: 0.5 });
  for (const [start, dir, level] of [[0.98, 'up', 1], [1, 'up', 1], [0.03, 'down', 0], [0, 'down', 0]]) {
    const edge = fakeHa({ volume: start });
    const out = await new TvSwitch(cfg, { fetchImpl: edge.impl }).volumeStep(dir);
    assert.deepEqual(out, { ok: true, requested: true, channel: 'ard', level }, `${start} ${dir}`);
    assert.deepEqual(edge.ha.posts, [{ action: 'volume', level }]);
  }
  assert.equal(ha.posts.length, 2);
  // A configurable step.
  const custom = readbackConfig({ volume: { entity_id: 'media_player.tv_x', step: 0.1 } }).switch;
  const c = fakeHa({ volume: 0.2 });
  assert.equal((await new TvSwitch(custom, { fetchImpl: c.impl }).volumeStep('up')).level, 0.3);
  // A nonsensical step falls back to the default.
  assert.equal(normalizeTvConfig({ switch: { volume: { step: 7 } } }).switch.volume.step, 0.05);
});

test('TvSwitch.volumeStep: concurrent steps do not lose updates', async () => {
  const { ha, impl } = fakeHa({ volume: 0.5, delayMs: 5 });
  const sw = new TvSwitch(readbackConfig().switch, { fetchImpl: impl });
  const out = await Promise.all([sw.volumeStep('up'), sw.volumeStep('up'), sw.volumeStep('up')]);
  assert.deepEqual(out.map((o) => o.level), [0.55, 0.6, 0.65]);
  assert.equal(ha.volume, 0.65);
});

test('TvSwitch.volumeStep: a failed read or write changes nothing; without an entity the receiver gets the step', async () => {
  const cfg = readbackConfig().switch;
  const readFail = fakeHa({ fail: (url) => url.includes('media_player') });
  const out = await new TvSwitch(cfg, { fetchImpl: readFail.impl }).volumeStep('up');
  assert.deepEqual(out, { ok: false, error: 'could not read the volume (HTTP 503)' });
  assert.deepEqual(readFail.ha.posts, []);
  const writeFail = fakeHa({ fail: (url) => url.includes('/api/webhook/') });
  assert.deepEqual(await new TvSwitch(cfg, { fetchImpl: writeFail.impl }).volumeStep('down'), { ok: false, error: 'HTTP 503' });
  assert.equal(writeFail.ha.volume, 0.5);

  const relative = readbackConfig({ volume: {} }).switch;
  const rel = fakeHa();
  assert.deepEqual(await new TvSwitch(relative, { fetchImpl: rel.impl }).volumeStep('down'), { ok: true, requested: true, channel: 'ard' });
  assert.deepEqual(rel.ha.posts, [{ action: 'volume_down', step: 0.05 }]);
  assert.equal(rel.ha.posts.some((p) => 'muted' in p), false, 'no automatic unmute');
});

test('/tv tagesschau, taggeesscahu, next, prev: the owner switches and the reply names the channel', async () => {
  const cases = [
    [['tagesschau'], 'ard', 'tagesschau', 'Switched to Tagesschau'],
    [['taggeesscahu'], 'ard', 'tagesschau', 'Switched to Tagesschau'],
    [['next'], 'zdf', 'tagesschau', 'Switched to Tagesschau'],
    [['prev'], 'zdf', 'ard', 'Switched to ARD'],
    [['next'], 'brb', 'ard', 'Switched to ARD'],
    [['prev'], 'brb', 'tagesschau', 'Switched to Tagesschau'],
  ];
  for (const [args, scene, target, reply] of cases) {
    const { ha, handler } = fakeHa({ scene });
    const r = await runSwitch(args, { tv: readbackConfig(), handler });
    assert.deepEqual(ha.posts.map((p) => p.action), [target], args.join(' ') + ' from ' + scene);
    assert.match(r.replies, new RegExp(reply));
    assert.match(r.reactions[0], /whiteheavycheckmark/);
  }
});

test('/tv next|prev|mute|vol: anyone but the owner is refused and nothing is called', async () => {
  for (const args of [['next'], ['prev'], ['tagesschau'], ['mute'], ['vol', 'up'], ['vol', 'down']]) {
    const { handler } = fakeHa();
    const r = await runSwitch(args, { as: OTHER_MRI, tv: readbackConfig(), handler });
    assert.equal(r.requests.length, 0, args.join(' '));
    assert.match(r.replies, /not in the sudoers file/);
    assert.match(r.reactions[0], /crossmark/);
    const anon = await runSwitch(args, { as: '', tv: readbackConfig(), handler });
    assert.equal(anon.requests.length, 0);
  }
});

test('/tv mute and /tv vol up|down: the owner controls the audio, replies and reactions', async () => {
  const mute = fakeHa();
  const m = await runSwitch(['mute'], { tv: readbackConfig(), handler: mute.handler });
  assert.deepEqual(mute.ha.posts, [{ action: 'mute', muted: true }]);
  assert.match(m.replies, /Mute requested\./);
  assert.doesNotMatch(m.replies, /Muted/);
  assert.match(m.replies, /not verified/);
  assert.match(m.reactions[0], /whiteheavycheckmark/);

  const up = fakeHa({ volume: 0.5 });
  const u = await runSwitch(['vol', 'up'], { tv: readbackConfig(), handler: up.handler });
  assert.deepEqual(up.ha.posts, [{ action: 'volume', level: 0.55 }]);
  assert.match(u.replies, /Volume increase requested\./);
  assert.match(u.replies, /not verified/);
  const down = fakeHa({ volume: 0.5 });
  const d = await runSwitch(['vol', 'down'], { tv: readbackConfig(), handler: down.handler });
  assert.deepEqual(down.ha.posts, [{ action: 'volume', level: 0.45 }]);
  assert.match(d.replies, /Volume decrease requested\./);
  assert.doesNotMatch(`${m.replies}${u.replies}${d.replies}`, /Muted\.|Volume up\.|Volume down\./);
});

test('TvSwitch mute and volume: the brb scene is a no-op, nothing is posted', async () => {
  for (const scene of ['brb', 'idle-off']) {
    const cfg = readbackConfig({
      state: { entity_id: 'select.scene_x', token: TOKEN, map: { off: ['brb', 'idle-off'] } },
    }).switch;
    const { ha, impl } = fakeHa({ scene });
    const sw = new TvSwitch(cfg, { fetchImpl: impl });
    for (const out of [await sw.mute(), await sw.volumeStep('up'), await sw.volumeStep('down')]) {
      assert.equal(out.ok, false);
      assert.equal(out.noop, true);
      assert.match(out.error, /TV is off/);
    }
    assert.deepEqual(ha.posts, [], `nothing posted on ${scene}`);
  }
});

test('TvSwitch mute and volume: an unknown, unreadable or unconfigured scene fails closed', async () => {
  const cases = [
    ['an unrecognized scene', fakeHa({ scene: 'something-else' }), /unrecognized state/],
    ['an unavailable state', fakeHa({ scene: 'unavailable' }), /state unavailable/],
    ['a failing readback', fakeHa({ fail: (url) => url.includes('/api/states/') }), /HTTP 503/],
  ];
  for (const [label, fake, pattern] of cases) {
    const sw = new TvSwitch(readbackConfig().switch, { fetchImpl: fake.impl });
    for (const out of [await sw.mute(), await sw.volumeStep('up')]) {
      assert.equal(out.ok, false, label);
      assert.equal(out.noop, undefined, label);
      assert.match(out.error, /could not read the current channel/, label);
      assert.match(out.error, pattern, label);
    }
    assert.deepEqual(fake.ha.posts, [], label);
  }
  // No readback at all: the scene cannot be checked, so nothing is sent.
  const bare = config({ switch: { base_url: 'https://ha.example', webhooks: { mute: SECRET_ID + '-mute', volume_up: SECRET_ID + '-vu' } } }).switch;
  const none = fakeHa();
  const sw = new TvSwitch(bare, { fetchImpl: none.impl });
  for (const out of [await sw.mute(), await sw.volumeStep('up')]) {
    assert.equal(out.ok, false);
    assert.match(out.error, /cannot be checked/);
  }
  assert.deepEqual(none.ha.posts, []);
  assert.equal(none.requests.length, 0, 'not even a state read');
});

test('TvSwitch mute: a switch that just succeeded outranks a readback that still shows the brb scene', async () => {
  const { ha, impl } = fakeHa({ scene: 'brb' });
  let now = 1000;
  const sw = new TvSwitch(readbackConfig().switch, { fetchImpl: impl, now: () => now });
  assert.equal((await sw.mute()).noop, true);
  ha.scene = 'brb';
  const posted = await sw.switchTo('zdf');
  assert.equal(posted.ok, true);
  ha.scene = 'brb'; // Home Assistant lags
  now += 1000;
  assert.deepEqual(await sw.mute(), { ok: true, requested: true, channel: 'zdf' });
  now += 10000;
  ha.scene = 'zdf';
  assert.equal((await sw.mute()).ok, true, 'the readback now says zdf');
  ha.scene = 'brb';
  assert.equal((await sw.mute()).noop, true, 'the lag allowance has expired');
});

test('/tv mute and /tv vol on the brb scene: a no-action reply, a warning reaction and no webhook', async () => {
  for (const args of [['mute'], ['vol', 'up'], ['vol', 'down']]) {
    const { ha, handler } = fakeHa({ scene: 'brb' });
    const r = await runSwitch(args, { tv: readbackConfig(), handler });
    assert.deepEqual(ha.posts, [], args.join(' '));
    assert.match(r.replies, /did nothing/);
    assert.match(r.replies, /TV is off/);
    assert.doesNotMatch(r.replies, /requested|Muted/);
    assert.match(r.reactions[0], /warning/i);
    assert.doesNotMatch(r.reactions.join(), /whiteheavycheckmark/);
  }
});

test('/tv mute and /tv vol with an unknown scene: fails closed with a failure reaction and no webhook', async () => {
  for (const [scene, args] of [['mystery', ['mute']], ['mystery', ['vol', 'up']], ['unavailable', ['vol', 'down']]]) {
    const { ha, handler } = fakeHa({ scene });
    const r = await runSwitch(args, { tv: readbackConfig(), handler });
    assert.deepEqual(ha.posts, [], `${scene} ${args.join(' ')}`);
    assert.match(r.replies, /failed: could not read the current channel/);
    assert.doesNotMatch(r.replies, /requested|Muted/);
    assert.match(r.reactions[0], /crossmark/);
    for (const secret of [SECRET_ID, TOKEN, 'ha.example', 'select.scene_x']) {
      assert.equal(`${r.replies}${r.logged}`.includes(secret), false, `leaked ${secret}`);
    }
  }
});

test('/tv mute: HA accepts the webhook but nothing is verified, so the reply says requested, not done', async () => {
  // The webhook answers 200 while OBS may do nothing: the daemon cannot tell, and must not claim it.
  const accepted = fakeHa({ scene: 'tagesschau' });
  const r = await runSwitch(['mute'], { tv: readbackConfig(), handler: accepted.handler });
  assert.deepEqual(accepted.ha.posts, [{ action: 'mute', muted: true }]);
  assert.match(r.replies, /Mute requested\. Home Assistant accepted the request; the result is not verified\./);
  assert.doesNotMatch(r.replies, /\bMuted\b|\bmuted\b|done|completed/i);
  const reads = r.requests.filter((req) => req.url.includes('/api/states/'));
  assert.equal(reads.length, 1, 'the scene is read once before the webhook');
  assert.ok(r.requests.findIndex((req) => req.url.includes('/api/states/')) < r.requests.findIndex((req) => req.url.includes('/api/webhook/')));
});

test('/tv next|mute|vol: not configured is explained and not attempted', async () => {
  for (const args of [['mute'], ['vol', 'up'], ['vol', 'down']]) {
    const r = await runSwitch(args, { tv: config({ switch: { base_url: 'https://ha.example', webhooks: { ard: 'x' } } }) });
    assert.equal(r.requests.length, 0, args.join(' '));
    assert.match(r.replies, /not configured/);
    assert.match(r.reactions[0], /warning/i);
  }
  const bare = await runSwitch(['next'], { tv: config({}) });
  assert.equal(bare.requests.length, 0);
  assert.match(bare.replies, /not configured/);
});

test('/tv next|mute|vol failures: a failure reaction, never the URL, id, token or host', async () => {
  for (const args of [['next'], ['prev'], ['mute'], ['vol', 'up'], ['tagesschau']]) {
    for (const failure of [
      () => new Error(`getaddrinfo ENOTFOUND ${SECRET_URL} ${TOKEN}`),
      () => ({ ok: false, status: 502 }),
    ]) {
      const r = await runSwitch(args, { tv: readbackConfig(), handler: failure });
      assert.match(r.reactions[0], /crossmark/, args.join(' '));
      for (const text of [r.replies, r.logged]) {
        for (const secret of [SECRET_ID, SECRET_URL, TOKEN, 'ha.example', 'select.scene_x']) {
          assert.equal(text.includes(secret), false, `${args.join(' ')} leaked ${secret}`);
        }
      }
      assert.match(r.replies, /failed/);
    }
  }
});

test('TvSwitch.cycle: the readback can use an entity attribute and a configured off value', async () => {
  const cfg = readbackConfig({
    state: { entity_id: 'select.scene_x', attribute: 'input', token: TOKEN, map: { off: ['idle'] } },
  }).switch;
  const posts = [];
  const impl = async (url, init) => {
    if (url.includes('/api/states/')) {
      return { ok: true, status: 200, json: async () => ({ state: 'tv', attributes: { input: 'ZDF' } }) };
    }
    posts.push(JSON.parse(init.body));
    return { ok: true, status: 200 };
  };
  assert.equal((await new TvSwitch(cfg, { fetchImpl: impl }).cycle('next')).target, 'tagesschau');
  const idle = async () => ({ ok: true, status: 200, json: async () => ({ state: 'tv', attributes: { input: 'idle' } }) });
  assert.equal((await new TvSwitch(cfg, { fetchImpl: idle }).readChannel()).channel, null);
  const missing = async () => ({ ok: true, status: 200, json: async () => ({ state: 'tv', attributes: {} }) });
  assert.deepEqual(await new TvSwitch(cfg, { fetchImpl: missing }).readChannel(), { ok: false, error: 'state unavailable' });
  assert.deepEqual(posts, [{ action: 'tagesschau' }]);
});

test('TvSwitch.canRun: the absolute volume webhook alone cannot run a step, it needs the entity and the readback', () => {
  const full = readbackConfig().switch;
  assert.equal(new TvSwitch(full).canRun('volume_up'), true);
  const onlyVolume = (extra) =>
    config({ switch: { base_url: 'https://ha.example', webhooks: { volume: SECRET_ID + '-volume' }, ...extra } }).switch;
  assert.equal(new TvSwitch(onlyVolume({})).canRun('volume_up'), false, 'no entity, no readback');
  assert.equal(new TvSwitch(onlyVolume({ volume: { entity_id: 'media_player.tv_x' } })).canRun('volume_down'), false, 'no state readback');
  const withStep = config({ switch: { base_url: 'https://ha.example', webhooks: { volume_up: SECRET_ID + '-vu' } } }).switch;
  assert.equal(new TvSwitch(withStep).canRun('volume_up'), true, 'a step webhook needs no readback');
});

test('TvSwitch.cycle: a readback that still shows the previous channel right after a switch does not repeat it', async () => {
  const { ha, impl } = fakeHa({ scene: 'ard' });
  let now = 1000;
  const sw = new TvSwitch(readbackConfig().switch, { fetchImpl: impl, now: () => now });
  assert.equal((await sw.cycle('next')).target, 'zdf');
  ha.scene = 'ard'; // Home Assistant has not caught up yet
  now += 1000;
  const second = await sw.cycle('next');
  assert.deepEqual(second, { ok: true, target: 'tagesschau', from: 'zdf' });
  now += 10000; // long after: the readback is the truth again
  ha.scene = 'ard';
  assert.equal((await sw.cycle('next')).from, 'ard');
});
