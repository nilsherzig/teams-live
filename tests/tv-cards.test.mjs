import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeRichMessage, richMessageWireBytes, setRichMessages, transport } from '../src/teams.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { MAX_CARD_BYTES } from '../src/cards.mjs';
import { TV_LOGOS } from '../src/tv-logos.mjs';
import { TvProgrammeService, TvSwitch, normalizeTvConfig, parseArdProgram, parseXmltv } from '../src/tv.mjs';
import { buildTvProgrammeCard, safeArtworkUrl, tvControlReply } from '../src/tv-cards.mjs';

beforeEach(() => setRichMessages(false));

const CONV = '19:test@thread.v2';
const NOW = new Date('2026-01-15T12:30:00Z'); // 13:30 in Europe/Berlin
const TZ = 'Europe/Berlin';
const OWNER_MRI = '8:orgid:00000000-0000-0000-0000-000000000001';
// Generic fixtures: nothing here is a real id, URL or token.
const SECRET_ID = 'whsec-0123456789abcdef';
const TOKEN = 'tok-secret-value-0123456789';

const ART_ARD = 'https://programm-api.ard.de/images/MjAyNi0wMS0xNQ==/64ff2f19fca76d00089981f2_1694445337959.jpg?w={width}';
const ART_MEDIATHEK = 'https://api.ardmediathek.de/image-service/images/urn:ard:image:47bcd77c9be3c359?w={width}&ch=8f5273a51a44969d';
const ART_ZDF = 'http://img.tvspielfilm.de/f5/d4/c6/6ada2fde6b6f3b46dcc6d4f5.jpeg';

const at = (hhmm) => new Date(`2026-01-15T${hhmm}:00+01:00`);
const programme = (title, from, to, extra = {}) => ({ title, start: at(from), end: at(to), subtitle: '', description: '', image: '', ...extra });

const find = (node, pred, out = []) => {
  if (Array.isArray(node)) node.forEach((n) => find(n, pred, out));
  else if (node && typeof node === 'object') {
    if (pred(node)) out.push(node);
    Object.values(node).forEach((n) => find(n, pred, out));
  }
  return out;
};
const texts = (card) => find(card.body, (n) => n.type === 'TextBlock').map((n) => n.text);
// The words of a card: the icon-only blocks (a status emoji) are decoration, not copy.
const words = (card) => texts(card).filter((t) => /[\p{L}\p{N}]/u.test(t));
const images = (card) => find(card.body, (n) => n.type === 'Image');
const wire = (markdown, card) => richMessageWireBytes(makeRichMessage(markdown, card));

// ------------------------------------------------------------------ artwork allowlist

test('safeArtworkUrl: only https URLs of the EPG picture hosts, rebuilt without the source query', () => {
  assert.equal(
    safeArtworkUrl(ART_ARD),
    'https://programm-api.ard.de/images/MjAyNi0wMS0xNQ==/64ff2f19fca76d00089981f2_1694445337959.jpg?w=960'
  );
  assert.equal(safeArtworkUrl(ART_MEDIATHEK), 'https://api.ardmediathek.de/image-service/images/urn:ard:image:47bcd77c9be3c359?w=960');
  assert.equal(
    safeArtworkUrl('https://api.ardmediathek.de/image-service/image-collections/urn:ard:image-collection:3c60299b82eebe9f/16x9?w={width}'),
    'https://api.ardmediathek.de/image-service/image-collections/urn:ard:image-collection:3c60299b82eebe9f/16x9?w=960'
  );
  // XMLTV icons come as http: upgraded, and a tracking query or fragment is dropped.
  assert.equal(safeArtworkUrl(ART_ZDF), 'https://img.tvspielfilm.de/f5/d4/c6/6ada2fde6b6f3b46dcc6d4f5.jpeg');
  assert.equal(safeArtworkUrl(`${ART_ZDF}?utm_source=x&track=1#frag`), 'https://img.tvspielfilm.de/f5/d4/c6/6ada2fde6b6f3b46dcc6d4f5.jpeg');

  for (const bad of [
    '',
    undefined,
    null,
    'not a url',
    '/relative/pic.jpg',
    '//img.tvspielfilm.de/f5/d4/c6/6ada2fde6b6f3b46dcc6d4f5.jpeg',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    'ftp://img.tvspielfilm.de/f5/d4/c6/6ada2fde6b6f3b46dcc6d4f5.jpeg',
    'https://evil.example/f5/d4/c6/6ada2fde6b6f3b46dcc6d4f5.jpeg',
    'https://img.tvspielfilm.de.evil.example/f5/d4/c6/6ada2fde6b6f3b46dcc6d4f5.jpeg',
    'https://evil.example/img.tvspielfilm.de/f5/d4/c6/6ada2fde6b6f3b46dcc6d4f5.jpeg',
    'https://user:pw@img.tvspielfilm.de/f5/d4/c6/6ada2fde6b6f3b46dcc6d4f5.jpeg',
    'https://img.tvspielfilm.de:8443/f5/d4/c6/6ada2fde6b6f3b46dcc6d4f5.jpeg',
    'https://img.tvspielfilm.de/other/path.jpeg',
    'https://programm-api.ard.de/images/x/../../admin?w=1',
    'https://programm-api.ard.de/api/program',
    `https://img.tvspielfilm.de/f5/d4/c6/${'a'.repeat(400)}.jpeg`,
  ]) {
    assert.equal(safeArtworkUrl(bad), null, String(bad).slice(0, 60));
  }
});

test('parsers keep the source picture URL; a programme without one has an empty image', () => {
  const ard = parseArdProgram(
    {
      channels: [
        {
          id: 'c',
          timeSlots: [
            [
              { title: 'A', broadcastedOn: '2026-01-15T13:00:00+01:00', broadcastEnd: '2026-01-15T14:00:00+01:00', images: { aspect16x9: { src: ART_ARD } } },
              { title: 'B', broadcastedOn: '2026-01-15T14:00:00+01:00', broadcastEnd: '2026-01-15T15:00:00+01:00' },
            ],
          ],
        },
      ],
    },
    'c'
  );
  assert.deepEqual(ard.map((p) => p.image), [ART_ARD, '']);
  const xml = `<tv><programme start="20260115120000 +0000" stop="20260115130000 +0000" channel="z"><title>T</title><icon src="${ART_ZDF.replace('&', '&amp;')}" /></programme>
    <programme start="20260115130000 +0000" stop="20260115140000 +0000" channel="z"><title>U</title></programme></tv>`;
  assert.deepEqual(parseXmltv(xml, 'z').map((p) => p.image), [ART_ZDF, '']);
});

// ------------------------------------------------------------------ /tv program card

// The per-channel Containers inside the card's emphasis wrapper.
const channelBlocks = (card) => card.body[0].items.filter((n) => n.type === 'Container');

const CHANNELS = [
  { key: 'ard', name: 'Das Erste', error: null, current: programme('Tagesschau', '13:00', '14:00', { subtitle: 'Folge 1', image: ART_ARD }), next: programme('Sportschau', '14:00', '15:00', { image: ART_ARD }) },
  { key: 'zdf', name: 'ZDF', error: null, current: programme('heute', '13:00', '14:00', { image: ART_ZDF }), next: programme('Drehscheibe', '14:00', '15:00') },
];
const DATA = { now: NOW, timezone: TZ, channels: CHANNELS };

test('programme card: no heading row, no visible channel label, the logo sits right of the running programme', () => {
  const card = buildTvProgrammeCard(DATA);
  const all = texts(card);
  assert.ok(!all.includes('Das Erste') && !all.includes('ZDF'), 'the channel name is not shown as text');
  // Each channel block is one programme Container (+ the NEXT line); the logo is the last column of its info row.
  const blocks = channelBlocks(card);
  assert.equal(blocks.length, 2);
  for (const [i, alt] of [[0, 'ARD'], [1, 'ZDF']]) {
    const [row, next, ...rest] = blocks[i].items;
    assert.equal(row.type, 'Container', 'the programme row leads the block');
    assert.equal(rest.length, 0);
    assert.equal(next.type, 'TextBlock');
    assert.ok(next.text.startsWith('NEXT'));
    // Picture, then the info row (text + logo), then the progress line.
    assert.deepEqual(row.items.map((n) => n.type), ['Image', 'ColumnSet', 'TextBlock']);
    const cols = row.items[1].columns;
    assert.deepEqual(cols.map((c) => c.width), ['stretch', 'auto']);
    const logo = find(cols[1], (n) => n.type === 'Image')[0];
    assert.equal(logo.altText, alt);
    assert.equal(logo.horizontalAlignment, 'Right');
    assert.ok(logo.url.startsWith('data:image/png;base64,'));
  }
  // The time is on a line of its own (no percentage on it); the progress has its own line.
  assert.ok(all.some((t) => t === 'NOW · 13:00–14:00'));
  assert.ok(all.filter((t) => /▰/.test(t)).every((t) => /^[▰▱]+ 50%$/.test(t)));
  assert.ok(all.includes('Tagesschau') && all.includes('Folge 1'));
  assert.ok(all.some((t) => t === 'NEXT · **14:00**  Sportschau'));
  // No generic "TV programme" title wrapper, no duplicated title.
  assert.ok(!all.some((t) => /TV programme|Update/.test(t)));
  const titles = all.filter((t) => !/^(NOW|NEXT) ·/.test(t) && !/^[▰▱]+ \d+%$/.test(t));
  assert.equal(new Set(titles).size, titles.length, 'no title is shown twice');
  const alts = images(card).map((i) => i.altText);
  assert.ok(alts.includes('ARD') && alts.includes('ZDF'), 'the logos carry alt text');
  // Both logos are the embedded data URIs (nothing fetched for a logo).
  assert.ok(images(card).some((i) => i.url === TV_LOGOS.ard.url) && images(card).some((i) => i.url === TV_LOGOS.zdf.url));
  assert.equal(buildTvProgrammeCard({ ...DATA, channels: [] }), null);
});

test('programme card: now-pictures only from the allowlist, never for the next programme, and a clean fallback without one', () => {
  const card = buildTvProgrammeCard(DATA);
  const pics = images(card).filter((i) => !i.url.startsWith('data:'));
  assert.deepEqual(pics.map((i) => i.url), [
    'https://programm-api.ard.de/images/MjAyNi0wMS0xNQ==/64ff2f19fca76d00089981f2_1694445337959.jpg?w=960',
    'https://img.tvspielfilm.de/f5/d4/c6/6ada2fde6b6f3b46dcc6d4f5.jpeg',
  ]);
  // Full card width: stretched, never a fixed pixel size, always with alt text.
  assert.ok(pics.every((i) => i.size === 'Stretch' && i.width === undefined && i.height === undefined && i.altText));

  // A disallowed URL, a missing one and the opt-out all give the same card without a picture: no empty frame.
  const bad = { ...DATA, channels: CHANNELS.map((c) => ({ ...c, current: { ...c.current, image: 'https://evil.example/x.jpg' } })) };
  for (const card2 of [buildTvProgrammeCard(bad), buildTvProgrammeCard({ ...DATA, channels: CHANNELS.map((c) => ({ ...c, current: { ...c.current, image: '' } })) }), buildTvProgrammeCard(DATA, { artwork: false })]) {
    assert.equal(images(card2).filter((i) => !i.url.startsWith('data:')).length, 0);
    assert.ok(!JSON.stringify(card2).includes('evil.example'));
    assert.ok(texts(card2).includes('Tagesschau'));
  }
});

test('programme card: a failed channel says so in its own block, with its logo at the right, and keeps the other', () => {
  const card = buildTvProgrammeCard({ now: NOW, timezone: TZ, channels: [{ ...CHANNELS[0], current: null, next: null, error: 'HTTP 500' }, CHANNELS[1]] });
  const all = texts(card);
  assert.ok(all.some((t) => t.includes('HTTP 500')));
  assert.ok(all.includes('heute'));
  const [set] = channelBlocks(card)[0].items;
  assert.equal(set.type, 'ColumnSet');
  assert.deepEqual(set.columns.map((c) => c.width), ['stretch', 'auto']);
  assert.equal(find(set.columns[1], (n) => n.type === 'Image')[0].altText, 'ARD');
  assert.ok(find(set.columns[0], (n) => n.type === 'TextBlock')[0].text.includes('Das Erste'));
});

test('programme card: nothing on now keeps the logo at the right and the next line below', () => {
  const card = buildTvProgrammeCard({ now: NOW, timezone: TZ, channels: [{ ...CHANNELS[0], current: null }, CHANNELS[1]] });
  const items = channelBlocks(card)[0].items;
  assert.equal(items.length, 2);
  assert.equal(items[0].type, 'ColumnSet');
  assert.ok(find(items[0], (n) => n.type === 'TextBlock').some((n) => n.text.includes('nothing on now')));
  assert.equal(find(items[0], (n) => n.type === 'Image')[0].altText, 'ARD');
  assert.ok(items[1].text.startsWith('NEXT · '));
});

test('programme card: source text is escaped, the card stays well under the byte budget, even with long titles', () => {
  const long = 'Titel '.repeat(200);
  const big = {
    now: NOW,
    timezone: TZ,
    channels: CHANNELS.map((c) => ({ ...c, current: { ...c.current, title: long, subtitle: long }, next: { ...c.next, title: long } })),
  };
  const card = buildTvProgrammeCard(big);
  const size = wire('markdown', card);
  assert.ok(size <= MAX_CARD_BYTES, `${size} bytes`);
  assert.ok(find(buildTvProgrammeCard({ ...DATA, channels: [{ ...CHANNELS[0], current: { ...CHANNELS[0].current, title: '*bold* _x_ [l](u)' } }] }), (n) => n.text === '\\*bold\\* \\_x\\_ \\[l\\](u)').length === 1);
  // The usual card is small.
  assert.ok(wire('m', buildTvProgrammeCard(DATA)) < 12_000, 'regular card size');
});

test('programme card: nothing in a programme row can wrap at phone width (308px)', () => {
  const card = buildTvProgrammeCard(DATA);
  for (const block of channelBlocks(card)) {
    const [row] = block.items;
    const progress = row.items.filter((n) => n.type === 'TextBlock');
    // The progress line sits outside every column (the whole card width), is short and never wraps.
    assert.equal(progress.length, 1);
    assert.equal(progress[0].wrap, false);
    assert.ok(progress[0].text.length <= 14, `progress is ${progress[0].text.length} characters`);
    assert.match(progress[0].text, /^[▰▱]{8} \d{1,3}%$/);
    // The NOW/time line never wraps either; the rest of the text may.
    const [set] = row.items.filter((n) => n.type === 'ColumnSet');
    const lines = set.columns[0].items;
    assert.ok(lines[0].text.startsWith('NOW · ') && lines[0].wrap === false);
    // Only the logo is fixed-width (auto), so the text column keeps the rest of the row.
    assert.deepEqual(set.columns.map((c) => c.width), ['stretch', 'auto']);
    assert.ok(find(set.columns[0], (n) => n.type === 'Image').length === 0);
    assert.ok(find(set.columns[1], (n) => n.type === 'Image').every((i) => parseInt(i.width, 10) <= 40));
    // The picture is the full width, not a column.
    assert.equal(row.items[0].size, 'Stretch');
  }
  // No fixed pixel widths anywhere except the small logos.
  const fixed = images(card).filter((i) => !i.url.startsWith('data:') && i.width);
  assert.equal(fixed.length, 0);
});

test('programme card: a programme without a picture starts at the info row and keeps the progress line', () => {
  const card = buildTvProgrammeCard({ ...DATA, channels: CHANNELS.map((c) => ({ ...c, current: { ...c.current, image: '' } })) });
  for (const block of channelBlocks(card)) {
    assert.deepEqual(block.items[0].items.map((n) => n.type), ['ColumnSet', 'TextBlock']);
    assert.equal(block.items[0].items[1].wrap, false);
  }
});

// ------------------------------------------------------------------ control replies

const NOWPROG = { current: programme('Tagesschau', '13:00', '14:00', { image: ART_ARD }), next: programme('Sportschau', '14:00', '15:00') };

test('switch reply: "requested" until a readback confirmed it; the channel and the state are plain words', () => {
  const requested = tvControlReply({ type: 'switch', target: 'ard', state: 'requested', programme: NOWPROG }, { now: NOW, timezone: TZ });
  assert.match(requested.markdown, /Switch to ARD requested\./);
  assert.doesNotMatch(requested.markdown, /Switched/);
  assert.ok(texts(requested.card).includes('ARD') && texts(requested.card).includes('Switch requested'));
  assert.doesNotMatch(JSON.stringify(requested.card), /Confirmed|Switched/);

  const confirmed = tvControlReply({ type: 'switch', target: 'zdf', state: 'confirmed', programme: null }, { now: NOW, timezone: TZ });
  assert.match(confirmed.markdown, /Switched to ZDF \(confirmed on air\)\./);
  assert.ok(texts(confirmed.card).includes('Confirmed on air'));
  assert.equal(confirmed.card.body[0].style, 'good');
  assert.equal(requested.card.body[0].style, 'emphasis');

  const off = tvControlReply({ type: 'switch', target: 'off', state: 'confirmed' }, { now: NOW, timezone: TZ });
  assert.match(off.markdown, /The TV is off \(brb scene, confirmed\)/);
  assert.ok(texts(off.card).includes('TV off'));
  assert.match(tvControlReply({ type: 'switch', target: 'off', state: 'requested' }).markdown, /Switch to off \(brb\) requested\./);
});

test('switch reply: the current programme with a time hierarchy, a picture only when it is safe', () => {
  const { card, markdown } = tvControlReply({ type: 'switch', target: 'ard', state: 'confirmed', programme: NOWPROG }, { now: NOW, timezone: TZ });
  const all = texts(card);
  assert.ok(all.includes('NOW · 13:00–14:00') && all.some((t) => /^[▰▱]{8} 50%$/.test(t)));
  assert.ok(all.includes('Tagesschau'));
  assert.ok(all.includes('NEXT · **14:00**  Sportschau'));
  assert.match(markdown, /- Now: \*\*Tagesschau\*\* \(13:00–14:00\)/);
  assert.match(markdown, /- Next: 14:00 \*\*Sportschau\*\*/);
  assert.equal(images(card).filter((i) => i.url.startsWith('https://programm-api.ard.de/')).length, 1);
  // No programme (Tagesschau has no source, or the EPG is unavailable): the confirmation stands alone.
  for (const programmeValue of [null, undefined]) {
    const bare = tvControlReply({ type: 'switch', target: 'tagesschau', state: 'confirmed', programme: programmeValue }, { now: NOW, timezone: TZ });
    assert.ok(!texts(bare.card).some((t) => /NOW|NEXT/.test(t)));
    assert.doesNotMatch(bare.markdown, /Now:|Next:/);
    assert.ok(images(bare.card).every((i) => i.url === TV_LOGOS.tagesschau.url));
  }
  // Without the artwork option there is no picture.
  const noArt = tvControlReply({ type: 'switch', target: 'ard', state: 'confirmed', programme: NOWPROG }, { now: NOW, timezone: TZ, artwork: false });
  assert.equal(images(noArt.card).filter((i) => !i.url.startsWith('data:')).length, 0);
});

test('audio reply: "requested", never "done", and the detail is in the status line', () => {
  const mute = tvControlReply({ type: 'audio', action: 'mute', channel: 'ard' });
  assert.match(mute.markdown, /Mute requested\. Home Assistant accepted the request; the result is not verified\./);
  assert.doesNotMatch(mute.markdown, /Muted/);
  assert.deepEqual(texts(mute.card), ['Mute requested', 'ARD · accepted, not verified']);
  const up = tvControlReply({ type: 'audio', action: 'volume_up', channel: 'zdf', level: 0.55 });
  assert.deepEqual(texts(up.card), ['Volume increase and unmute requested', 'ZDF · target 55% · accepted, not verified']);
  assert.match(tvControlReply({ type: 'audio', action: 'volume_down', channel: 'ard' }).markdown, /Volume decrease requested\./);
  const unmute = tvControlReply({ type: 'audio', action: 'unmute', channel: 'ard' });
  assert.match(unmute.markdown, /Unmute requested\. Home Assistant accepted the request; the result is not verified\./);
  assert.deepEqual(texts(unmute.card), ['Unmute requested', 'ARD · accepted, not verified']);
});

test('refusal, failure and "not configured" replies: a warning or error card with the reason, no channel logo', () => {
  const noop = tvControlReply({ type: 'noop', command: '/tv mute', reason: 'the TV is off (brb scene), so there is nothing to change' });
  assert.match(noop.markdown, /`\/tv mute` did nothing: the TV is off \(brb scene\), so there is nothing to change\./);
  assert.equal(noop.card.body[0].style, 'warning');
  const failed = tvControlReply({ type: 'failed', doing: 'Switching to ARD', error: 'timeout' });
  assert.equal(failed.markdown, '❌ Switching to ARD failed: timeout');
  assert.equal(failed.card.body[0].style, 'attention');
  assert.deepEqual(words(failed.card), ['Switching to ARD failed', 'Timeout']);
  const none = tvControlReply({ type: 'unconfigured', command: '/tv ard' });
  assert.match(none.markdown, /`\/tv ard` is not configured on this daemon \(`tv\.switch`\)\./);
  assert.throws(() => tvControlReply({ type: 'nope' }));
});

test('control cards are compact: small, no title wrapper, no actions, no Image beyond the logo and one picture', () => {
  for (const outcome of [
    { type: 'switch', target: 'ard', state: 'confirmed', programme: NOWPROG },
    { type: 'switch', target: 'tagesschau', state: 'requested', programme: null },
    { type: 'audio', action: 'mute', channel: 'ard' },
    { type: 'failed', doing: 'Muting', error: 'HTTP 503' },
  ]) {
    const { card, markdown } = tvControlReply(outcome, { now: NOW, timezone: TZ });
    assert.equal(card.type, 'AdaptiveCard');
    assert.equal(card.actions, undefined, 'no fake buttons');
    assert.ok(find(card, (n) => n.type === 'Action.Submit' || n.type === 'ActionSet').length === 0);
    assert.ok(wire(markdown, card) < 9_000, `${outcome.type}: ${wire(markdown, card)} bytes`);
    assert.ok(images(card).length <= 2);
    assert.ok(card.fallbackText.length > 0);
    assert.ok(!texts(card).some((t) => /^Update\b/.test(t)));
    const [header] = card.body[0].items;
    assert.deepEqual(header.columns.map((c) => c.width), ['auto', 'stretch'], 'phone width: logo plus text only');
  }
});

// ------------------------------------------------------------------ the watcher: truth, delay, secrets

const ardJson = (extra = {}) => ({
  channels: [
    {
      id: 'chan-x',
      timeSlots: [
        [{ title: 'Quiz', broadcastedOn: '2026-01-15T13:00:00+01:00', broadcastEnd: '2026-01-15T14:00:00+01:00', images: { aspect16x9: { src: ART_ARD } }, ...extra }],
        [{ title: 'Krimi', broadcastedOn: '2026-01-15T14:00:00+01:00', broadcastEnd: '2026-01-15T15:00:00+01:00' }],
      ],
    },
  ],
});

const tvConfig = (extra = {}) =>
  normalizeTvConfig({
    channels: {
      ard: { type: 'ard-api', url: 'https://epg.example/api/program', channel_id: 'chan-x', name: 'Channel X' },
      zdf: { type: 'xmltv', url: 'https://epg.example/guide.xml', channel_id: 'chan-a.example', name: 'Channel A' },
    },
    switch: {
      base_url: 'https://ha.example',
      webhooks: { ard: `${SECRET_ID}-ard`, zdf: `${SECRET_ID}-zdf`, tagesschau: `${SECRET_ID}-tagesschau`, off: `${SECRET_ID}-off`, mute: `${SECRET_ID}-mute`, unmute: `${SECRET_ID}-unmute` },
      state: { entity_id: 'select.scene_x', token: TOKEN },
      ...extra.switch,
    },
    ...extra.tv,
  });

function epgFetch(routes) {
  return async (url) => {
    const hit = Object.entries(routes).find(([prefix]) => String(url).startsWith(prefix));
    if (!hit) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const body = typeof hit[1] === 'function' ? await hit[1](String(url)) : hit[1];
    if (body instanceof Error) throw body;
    const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
}

function fakeHa({ scene = 'zdf', applies = true } = {}) {
  const ha = { scene, posts: [] };
  const handler = async (url, init) => {
    if (url.includes('/api/states/')) return { ok: true, status: 200, json: async () => ({ state: ha.scene }) };
    const body = JSON.parse(init.body);
    ha.posts.push(body);
    if (applies && ['ard', 'zdf', 'tagesschau'].includes(body.action)) ha.scene = body.action;
    if (applies && body.action === 'off') ha.scene = 'brb';
    return { ok: true, status: 200 };
  };
  return { ha, handler };
}

async function run(args, { rich = false, ha = fakeHa(), epg = epgFetch({ 'https://epg.example/api/program': ardJson() }), tv = tvConfig(), settleMs = 0, attempts = 2, programmeTimeoutMs } = {}) {
  const sent = [];
  const original = { ...transport };
  transport.sendMessage = (...a) => {
    sent.push(a);
    return Promise.resolve({ ok: true, value: { messageId: '1700000000001', timestamp: '1700000000001' } });
  };
  setRichMessages(rich);
  const watcher = new MergeRequestWatcher({
    config: { conversations: [], gitlab: { group: 'group' }, teams: { rich_messages: rich }, tv },
    gitlab: { findMrLinks: () => [], getMr: async () => null },
    jira: null,
    opsgenie: null,
  });
  watcher.saveState = () => {};
  watcher.selfMri = OWNER_MRI;
  watcher.selfOid = '00000000-0000-0000-0000-000000000001';
  watcher.richMessages = rich;
  watcher.tv = new TvProgrammeService(tv, { fetchImpl: epg, now: () => NOW });
  if (programmeTimeoutMs !== undefined) {
    const channelNow = watcher.tv.channelNow.bind(watcher.tv);
    watcher.tv.channelNow = (key) => channelNow(key, { timeoutMs: programmeTimeoutMs });
  }
  watcher.tvSwitch = new TvSwitch(tv.switch, { fetchImpl: async (u, i) => ha.handler(String(u), i), settleMs, attempts });
  const reactions = [];
  watcher.setCommandReaction = async (conv, msg, key) => reactions.push(key);
  const logged = [];
  const origError = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  const started = Date.now();
  try {
    await watcher.executeTvCommand({ conversationId: CONV, messageId: '1700000000000', from: 'Alice Example', fromMri: OWNER_MRI }, args);
  } finally {
    console.error = origError;
    Object.assign(transport, original);
    setRichMessages(false);
  }
  const cards = sent.flatMap((c) => JSON.parse(c[2].properties.cards || '[]').map((x) => x.content));
  return { sent, html: sent.map((c) => c[1]).join('\n'), cards, reactions, logged: logged.join('\n'), took: Date.now() - started, ha: ha.ha };
}

test('/tv ard: "Switched" only after the scene readback shows it; otherwise "requested" with the same success reaction', async () => {
  const confirmed = await run(['ard'], { ha: fakeHa({ scene: 'zdf', applies: true }) });
  assert.match(confirmed.html, /Switched to ARD \(confirmed on air\)/);
  assert.match(confirmed.html, /Now: <(strong|b)>Quiz<\/(strong|b)>|Now: \*\*Quiz\*\*/);

  // Home Assistant accepted the webhook but the scene never changes: that is "requested", not a false "Switched".
  const lagging = await run(['ard'], { ha: fakeHa({ scene: 'zdf', applies: false }) });
  assert.match(lagging.html, /Switch to ARD requested\./);
  assert.doesNotMatch(lagging.html, /Switched|confirmed/);
  assert.match(lagging.reactions[0], /whiteheavycheckmark/);

  // No readback configured at all: the same honest wording.
  const bare = await run(['zdf'], { tv: tvConfig({ switch: { state: { entity_id: '', token: '' } } }) });
  assert.match(bare.html, /Switch to ZDF requested\./);
});

test('/tv off: confirmed only by the off scene; the programme lookup is not even attempted', async () => {
  let epgCalls = 0;
  const epg = epgFetch({ 'https://epg.example/': () => { epgCalls++; return ardJson(); } });
  const off = await run(['off'], { ha: fakeHa({ scene: 'ard' }), epg });
  assert.match(off.html, /The TV is off \(brb scene, confirmed\)/);
  assert.equal(epgCalls, 0);
  const stuck = await run(['off'], { ha: fakeHa({ scene: 'ard', applies: false }) });
  assert.match(stuck.html, /Switch to off \(brb\) requested\./);
});

test('/tv tagesschau: no programme is shown, because the provider has none for it', async () => {
  let epgCalls = 0;
  const epg = epgFetch({ 'https://epg.example/': () => { epgCalls++; return ardJson(); } });
  const r = await run(['tagesschau'], { epg, rich: true });
  assert.equal(epgCalls, 0);
  const all = texts(r.cards[0]);
  assert.ok(all.includes('Tagesschau') && all.includes('Confirmed on air'));
  assert.ok(!all.some((t) => /NOW|NEXT/.test(t)));
});

test('/tv zdf (rich): a compact card with the logo, the state and the current programme from the existing provider', async () => {
  const xml = `<tv><programme start="20260115120000 +0000" stop="20260115130000 +0000" channel="chan-a.example"><title>heute</title></programme>
    <programme start="20260115130000 +0000" stop="20260115140000 +0000" channel="chan-a.example"><title>Magazin</title><icon src="${ART_ZDF}" /></programme>
    <programme start="20260115140000 +0000" stop="20260115150000 +0000" channel="chan-a.example"><title>Serie</title></programme></tv>`;
  // 13:30 Berlin = 12:30Z: "heute" (12:00Z-13:00Z) is running.
  const r = await run(['zdf'], { rich: true, ha: fakeHa({ scene: 'ard' }), epg: epgFetch({ 'https://epg.example/guide.xml': xml }) });
  assert.equal(r.cards.length, 1);
  const all = texts(r.cards[0]);
  assert.ok(all.includes('ZDF') && all.includes('Confirmed on air'));
  assert.ok(all.includes('heute'));
  assert.ok(all.some((t) => t.startsWith('NOW · 13:00–14:00')), 'the time zone of the provider is used');
  assert.ok(all.some((t) => t === 'NEXT · **14:00**  Magazin'));
  assert.ok(!all.some((t) => /^Update|TV programme/.test(t)));
  assert.ok(r.html.includes('InputExtension'));
});

test('/tv ard: an unavailable, failing or missing EPG never turns the control into an error, and nothing waits for it', async () => {
  for (const [name, epg, extra] of [
    ['source down', epgFetch({ 'https://epg.example/': new Error('boom') }), {}],
    ['404', epgFetch({}), {}],
    ['no data for this time', epgFetch({ 'https://epg.example/api/program': { channels: [] } }), {}],
    ['stale list', epgFetch({ 'https://epg.example/api/program': { channels: [{ id: 'chan-x', timeSlots: [[{ title: 'Old', broadcastedOn: '2026-01-14T13:00:00+01:00', broadcastEnd: '2026-01-14T14:00:00+01:00' }]] }] } }), {}],
    ['hangs', epgFetch({ 'https://epg.example/': () => new Promise(() => {}) }), { programmeTimeoutMs: 40 }],
  ]) {
    const r = await run(['ard'], { epg, rich: true, ...extra });
    assert.equal(r.cards.length, 1, name);
    const all = texts(r.cards[0]);
    assert.ok(all.includes('Confirmed on air'), `${name}: the control result stands`);
    assert.ok(!all.some((t) => /NOW|NEXT/.test(t)), `${name}: no programme`);
    assert.doesNotMatch(JSON.stringify(r.cards[0]), /boom|HTTP 404|no programme data|failed/i, name);
    assert.match(r.reactions[0], /whiteheavycheckmark/, name);
    assert.ok(r.took < 1500, `${name}: answered in ${r.took}ms`);
  }
});

test('/tv ard: a failed switch is an error card with no programme and no "Switched"', async () => {
  const ha = { ha: { posts: [] }, handler: async () => ({ ok: false, status: 503 }) };
  const r = await run(['ard'], { rich: true, ha });
  assert.deepEqual(words(r.cards[0]), ['Switching to ARD failed', 'HTTP 503']);
  assert.match(r.reactions[0], /crossmark/);
});

test('/tv mute (rich): "Mute requested" with the detail in the card, and a refused mute stays a warning', async () => {
  const r = await run(['mute'], { rich: true, ha: fakeHa({ scene: 'ard' }) });
  assert.deepEqual(texts(r.cards[0]), ['Mute requested', 'ARD · accepted, not verified']);
  assert.deepEqual(r.ha.posts, [{ action: 'mute', muted: true }]);
  const brb = await run(['mute'], { rich: true, ha: fakeHa({ scene: 'brb' }) });
  assert.match(words(brb.cards[0])[0], /did nothing/);
  assert.deepEqual(brb.ha.posts, []);
  assert.match(brb.reactions[0], /warning|exclamation|crossmark|⚠/i);
});

test('/tv unmute (rich): "Unmute requested" with the detail in the card, and a refused one stays a warning', async () => {
  const r = await run(['unmute'], { rich: true, ha: fakeHa({ scene: 'ard' }) });
  assert.deepEqual(texts(r.cards[0]), ['Unmute requested', 'ARD · accepted, not verified']);
  assert.deepEqual(r.ha.posts, [{ action: 'unmute', muted: false }]);
  const brb = await run(['unmute'], { rich: true, ha: fakeHa({ scene: 'brb' }) });
  assert.match(words(brb.cards[0])[0], /did nothing/);
  assert.deepEqual(brb.ha.posts, []);
});

test('no reply, card, log or reaction contains a webhook id, URL or token', async () => {
  const cases = [
    ['ard', {}],
    ['zdf', { ha: fakeHa({ applies: false }) }],
    ['mute', {}],
    ['unmute', {}],
    ['off', {}],
    ['ard', { ha: { ha: { posts: [] }, handler: async () => { throw new Error(`getaddrinfo ENOTFOUND ha.example ${SECRET_ID}`); } } }],
    ['ard', { epg: epgFetch({ 'https://epg.example/': new Error(`secret ${TOKEN}`) }) }],
  ];
  for (const rich of [false, true]) {
    for (const [arg, extra] of cases) {
      const r = await run([arg], { rich, ...extra });
      const everything = `${r.html}\n${JSON.stringify(r.cards)}\n${r.logged}`;
      for (const secret of [SECRET_ID, TOKEN, 'ha.example', '/api/webhook/', 'Bearer']) {
        assert.ok(!everything.includes(secret), `${arg} rich=${rich}: leaked ${secret}`);
      }
    }
  }
});

test('/tv program (rich): the card carries the programme pictures from the provider, the wire size stays small', async () => {
  const r = await run(['program'], { rich: true });
  assert.equal(r.cards.length, 1);
  const card = r.cards[0];
  assert.ok(images(card).some((i) => i.url.startsWith('https://programm-api.ard.de/')));
  assert.ok(wire('x', card) < 12_000);
  // tv.artwork = false: no remote picture.
  const off = await run(['program'], { rich: true, tv: tvConfig({ tv: { artwork: false } }) });
  assert.ok(images(off.cards[0]).every((i) => i.url.startsWith('data:')));
});

test('TvProgrammeService.channelNow: bounded, deduplicated, and null for channels without a source', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const epg = epgFetch({ 'https://epg.example/api/program': async () => { calls++; await gate; return ardJson(); } });
  const svc = new TvProgrammeService(tvConfig(), { fetchImpl: epg, now: () => NOW });
  // Two callers while the first request is still running share it; both time out without waiting for it.
  const [a, b] = await Promise.all([svc.channelNow('ard', { timeoutMs: 30 }), svc.channelNow('ard', { timeoutMs: 30 })]);
  assert.deepEqual([a, b], [null, null]);
  assert.equal(calls, 1, 'one request');
  release();
  await new Promise((r) => setTimeout(r, 20));
  const later = await svc.channelNow('ard', { timeoutMs: 30 });
  assert.equal(later.current.title, 'Quiz');
  assert.equal(later.next.title, 'Krimi');
  assert.equal(calls, 1, 'the late answer filled the cache');
  assert.equal(await svc.channelNow('tagesschau'), null);
  assert.equal(await svc.channelNow('nope'), null);
});

test('TvSwitch.confirm: true only when the scene shows the target; a failing readback is false, not an error', async () => {
  const cfg = tvConfig().switch;
  const shown = fakeHa({ scene: 'zdf' });
  const sw = (ha, attempts = 3) => new TvSwitch(cfg, { fetchImpl: async (u, i) => ha.handler(String(u), i), settleMs: 0, attempts });
  assert.equal(await sw(shown).confirm('zdf'), true);
  assert.equal(await sw(shown).confirm('ard'), false);
  assert.equal(await sw(fakeHa({ scene: 'brb' })).confirm('off'), true);
  assert.equal(await sw(fakeHa({ scene: 'ard' })).confirm('off'), false);
  // It retries while Home Assistant lags: the scene changes on the second read.
  let reads = 0;
  const lag = { handler: async () => ({ ok: true, status: 200, json: async () => ({ state: ++reads >= 2 ? 'ard' : 'zdf' }) }) };
  assert.equal(await sw(lag).confirm('ard'), true);
  assert.equal(reads, 2);
  const broken = { handler: async () => ({ ok: false, status: 503 }) };
  assert.equal(await sw(broken).confirm('ard'), false);
  // No readback configured.
  const none = new TvSwitch(tvConfig({ switch: { state: { entity_id: '', token: '' } } }).switch, { settleMs: 0 });
  assert.equal(await none.confirm('ard'), false);
  // The "recent switch" memory is not a confirmation.
  const recent = sw(fakeHa({ scene: 'zdf', applies: false }));
  await recent.switchTo('ard');
  assert.equal(await recent.confirm('ard'), false);
});
