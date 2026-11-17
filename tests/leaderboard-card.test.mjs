import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeRichMessage, richMessageWireBytes, setRichMessages, transport, isRichMessage } from '../src/teams.mjs';
import { MAX_CARD_BYTES } from '../src/cards.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { AvatarService } from '../src/avatars.mjs';
import {
  LEADERBOARD_MAX_ENTRIES,
  PODIUM_AVATAR_PX,
  PODIUM_SIZE,
  ROW_AVATAR_PX,
  buildLeaderboardCard,
  rankLeaderboard,
  topCommandsText,
} from '../src/card-leaderboard.mjs';

// The /leaderboard card. All people, figures and images are generic fakes.

beforeEach(() => setRichMessages(false));

const PIC = 'data:image/jpeg;base64,/9j/AAAA';
const CONV = '19:example@thread.v2';
const mri = (n) => `8:orgid:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function assertValidCard(card) {
  assert.equal(card.type, 'AdaptiveCard');
  assert.equal(card.version, '1.4');
  assert.ok(Array.isArray(card.body) && card.body.length > 0);
  assert.deepEqual(JSON.parse(JSON.stringify(card)), card);
}

const walkAll = (node, fn) => {
  if (Array.isArray(node)) return node.forEach((n) => walkAll(n, fn));
  if (!node || typeof node !== 'object') return;
  fn(node);
  Object.values(node).forEach((v) => walkAll(v, fn));
};
const texts = (card) => {
  const out = [];
  walkAll(card, (n) => n.type === 'TextBlock' && out.push(n.text));
  return out;
};
const images = (card) => {
  const out = [];
  walkAll(card, (n) => n.type === 'Image' && out.push(n));
  return out;
};

const people = (n) =>
  Array.from({ length: n }, (_, i) => ({
    name: `Person ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? i : ''} Example`,
    mri: mri(i + 1),
    count: 100 - i * 3,
    commands: { '/mrs': 10 + i, '/status': 4, '/help': 1, '/whois': 2 },
  }));

test('topCommandsText lists the three most used commands, most used first', () => {
  assert.equal(topCommandsText({ '/help': 1, '/mrs': 12, '/status': 4, '/whois': 2 }), '/mrs ×12 · /status ×4 · /whois ×2');
  assert.equal(topCommandsText({ '/b': 2, '/a': 2 }), '/a ×2 · /b ×2', 'ties by name');
  assert.equal(topCommandsText(undefined), '');
  assert.equal(topCommandsText({ '/x': 0, '/y': 'many' }), '', 'invalid counts are dropped');
});

test('rankLeaderboard orders by count then name, drops invalid entries and sums the totals', () => {
  const { ranked, total, topCommand } = rankLeaderboard([
    { name: 'Zed Example', count: 5, commands: { '/mrs': 5 } },
    { name: 'Amy Example', count: 5, commands: { '/mrs': 2, '/status': 3 } },
    { name: 'Max Example', count: 9, commands: { '/status': 9 } },
    { name: '', count: 50 },
    { name: 'Nobody Example', count: 0 },
    null,
  ]);
  assert.deepEqual(ranked.map((e) => e.name), ['Max Example', 'Amy Example', 'Zed Example']);
  assert.equal(total, 19);
  assert.deepEqual(topCommand, { command: '/status', count: 12 });
  assert.deepEqual(rankLeaderboard(undefined), { ranked: [], total: 0, topCommand: null });
});

test('the card is valid and shows stats, ranked rows with medals, counts and shares', () => {
  const card = buildLeaderboardCard({ entries: people(5), fallbackText: 'x' });
  assertValidCard(card);
  const t = texts(card);
  assert.ok(t.includes('Bot interaction leaderboard'));
  assert.ok(t.includes('interactions') && t.includes('users') && t.includes('most used'));
  for (const medal of ['\u{1F947}', '\u{1F948}', '\u{1F949}']) assert.ok(t.includes(medal), medal);
  assert.ok(t.includes('#4') && t.includes('#5'));
  assert.ok(t.includes('Ranked by interactions with the bot'));
  const names = t.filter((x) => /^Person .* Example$/.test(x));
  assert.deepEqual(names, people(5).map((p) => p.name), 'in rank order');
  assert.ok(t.some((x) => x.startsWith('/mrs ×')), 'per person top commands');
  assert.ok(t.some((x) => /^\d+%$/.test(x)), 'share of all interactions');
});

test('bars are runs of block characters relative to the leader, gold for the leader', () => {
  const card = buildLeaderboardCard({ entries: [{ name: 'Amy Example', count: 10 }, { name: 'Bob Example', count: 5 }, { name: 'Cy Example', count: 1 }] });
  const bars = [];
  walkAll(card, (n) => n.type === 'TextBlock' && /^\u2588+$/.test(n.text) && bars.push(n));
  assert.deepEqual(bars.map((b) => b.text.length), [10, 5, 1]);
  assert.deepEqual(bars.map((b) => b.color), ['Warning', 'Accent', 'Accent']);
  assert.ok(bars.every((b) => b.wrap === false));
});

test('no highlighted container: rows stay aligned (nothing insets the leader)', () => {
  const card = buildLeaderboardCard({ entries: people(4) });
  let containers = 0;
  walkAll(card, (n) => n.type === 'Container' && n.style === 'good' && (containers += 1));
  assert.equal(containers, 0);
});

test('pictures: bigger on the podium, smaller below, a spacer keeps names aligned', () => {
  const entries = people(6).map((p, i) => ({ ...p, avatar: i === 1 || i === 4 ? undefined : PIC }));
  const card = buildLeaderboardCard({ entries });
  assertValidCard(card);
  const imgs = images(card);
  assert.equal(imgs.length, 4);
  assert.deepEqual(imgs.map((i) => i.altText), [entries[0].name, entries[2].name, entries[3].name, entries[5].name]);
  assert.deepEqual(imgs.map((i) => i.width), [PODIUM_AVATAR_PX, PODIUM_AVATAR_PX, ROW_AVATAR_PX, ROW_AVATAR_PX].map((px) => `${px}px`));
  assert.ok(imgs.every((i) => i.style === 'Person'));
  const columnCounts = [];
  walkAll(card, (n) => n.type === 'ColumnSet' && n.columns.length >= 3 && columnCounts.push(n.columns.length));
  assert.ok(columnCounts.every((c) => c === columnCounts[0] || c === columnCounts[0] + 1 || c === columnCounts[0] - 1));
});

test('no pictures at all: no picture column, still a valid card', () => {
  const card = buildLeaderboardCard({ entries: people(5) });
  assert.equal(images(card).length, 0);
  assertValidCard(card);
});

test('anything that is not an image data URI is not embedded', () => {
  const card = buildLeaderboardCard({ entries: [{ name: 'Amy Example', count: 3, avatar: 'https://example.com/x.png' }] });
  assert.equal(images(card).length, 0);
});

test('only the top entries are shown; the stats still count everybody', () => {
  const all = people(LEADERBOARD_MAX_ENTRIES + 4);
  const card = buildLeaderboardCard({ entries: all });
  const t = texts(card);
  assert.equal(t.filter((x) => /^Person .* Example$/.test(x)).length, LEADERBOARD_MAX_ENTRIES);
  assert.ok(t.includes(`Top ${LEADERBOARD_MAX_ENTRIES} of ${all.length} users, ranked by interactions`));
  assert.ok(t.includes(String(all.reduce((s, p) => s + p.count, 0))), 'total over all users');
  assert.ok(t.includes(String(all.length)));
});

test('a single user is singular and has no rows beyond the podium', () => {
  const card = buildLeaderboardCard({ entries: [{ name: 'Amy Example', count: 1 }] });
  assert.ok(texts(card).includes('user'));
  assertValidCard(card);
});

test('empty state is a card with a hint, not a blank leaderboard', () => {
  for (const entries of [[], undefined, [{ name: 'Nobody Example', count: 0 }]]) {
    const card = buildLeaderboardCard({ entries, fallbackText: 'plain' });
    assertValidCard(card);
    assert.ok(texts(card).some((x) => x.startsWith('No interactions recorded yet')));
    assert.equal(images(card).length, 0);
  }
});

test('the podium size and the entry limit are what the layout assumes', () => {
  assert.equal(PODIUM_SIZE, 3);
  assert.ok(LEADERBOARD_MAX_ENTRIES > PODIUM_SIZE);
});

// --- watcher wiring -------------------------------------------------------

function fakeJpeg(extra = 0) {
  const head = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 32, 0, 32, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9];
  return Uint8Array.from([...head, ...new Array(8 + extra).fill(7)]);
}

function leaderboardWatcher({ rich = true, users = people(5), extra = 0, fetched = [] } = {}) {
  const watcher = new MergeRequestWatcher({
    config: { conversations: [], gitlab: {}, teams: rich ? { rich_messages: true } : {} },
    gitlab: { findMrLinks: () => [], mrLink: () => 'https://gitlab.example.com/x' },
    jira: null,
    opsgenie: null,
  });
  watcher.saveState = () => {};
  watcher.setCommandReaction = async () => {};
  watcher.userInteractions = new Map(users.map((u) => [u.mri, { ...u, lastSeen: 1 }]));
  if (watcher.avatarService) {
    watcher.avatarService = new AvatarService({
      directory: { users: new Map(users.map((u) => [u.mri, { displayName: u.name, mri: u.mri }])) },
      fetchPhoto: async (id) => (fetched.push(id), { kind: 'photo', bytes: fakeJpeg(extra) }),
    });
  }
  return watcher;
}

function recordTransport() {
  const calls = [];
  const original = { ...transport };
  transport.sendMessage = (...args) => {
    calls.push(args);
    return Promise.resolve({ ok: true, value: { messageId: '1700000000001', timestamp: '1700000000001' } });
  };
  return { calls, restore: () => Object.assign(transport, original) };
}

const sentCard = (call) => JSON.parse(call[2].properties.cards)[0].content;
const event = { conversationId: CONV, messageId: '1700000000000', from: 'Person A Example' };

test('rich mode: /leaderboard sends one card with pictures for the ranked users, fetched once each', async () => {
  const fetched = [];
  setRichMessages(true);
  const watcher = leaderboardWatcher({ fetched });
  const rec = recordTransport();
  try {
    await watcher.executeLeaderboardCommand(event);
    await watcher.executeLeaderboardCommand(event);
  } finally {
    rec.restore();
  }
  assert.equal(new Set(fetched).size, 5);
  assert.equal(rec.calls.length, 2);
  const card = sentCard(rec.calls[0]);
  assertValidCard(card);
  assert.equal(images(card).length, 5);
  assert.deepEqual(images(card).slice(0, 3).map((i) => i.width), ['28px', '28px', '28px']);
  assert.ok(texts(card).includes('Bot interaction leaderboard'));
});

test('rich mode keeps the text a plain-text reader needs in the markdown part', () => {
  setRichMessages(true);
  const watcher = leaderboardWatcher();
  const message = watcher.leaderboardMessage(rankLeaderboard([...watcher.userInteractions.values()]).ranked);
  assert.ok(isRichMessage(message));
  assert.match(message.markdown, /Bot Interaction Leaderboard/);
  assert.ok(richMessageWireBytes(message) <= MAX_CARD_BYTES);
});

test('regular mode is unchanged: markdown, no card, no avatar service', async () => {
  const watcher = leaderboardWatcher({ rich: false });
  assert.equal(watcher.avatarService, null);
  const rec = recordTransport();
  try {
    await watcher.executeLeaderboardCommand(event);
  } finally {
    rec.restore();
  }
  assert.equal(rec.calls.length, 1);
  const body = JSON.stringify(rec.calls[0]);
  assert.ok(!body.includes('AdaptiveCard'));
  assert.match(body, /Bot Interaction Leaderboard/);
  assert.match(body, /Person A Example/);
});

test('regular mode with nobody recorded keeps the old text', async () => {
  const watcher = leaderboardWatcher({ rich: false, users: [] });
  assert.match(watcher.formatLeaderboardMarkdown([]), /No interactions recorded yet/);
});

test('with huge photos the card drops pictures from the lowest rank until it fits', async () => {
  setRichMessages(true);
  const watcher = leaderboardWatcher({ users: people(10), extra: 4000 });
  const ranked = rankLeaderboard([...watcher.userInteractions.values()]).ranked;
  await watcher.prefetchLeaderboardAvatars(ranked);
  const message = watcher.leaderboardMessage(ranked);
  assert.ok(isRichMessage(message));
  assert.ok(richMessageWireBytes(message) <= MAX_CARD_BYTES);
  const shown = images(message.card).length;
  assert.ok(shown >= 1 && shown < 10, `some pictures kept, not all (${shown})`);
  assert.deepEqual(images(message.card).map((i) => i.altText), ranked.slice(0, shown).map((e) => e.name), 'the best ranked keep theirs');
});

test('a failing photo lookup leaves names only', async () => {
  setRichMessages(true);
  const watcher = leaderboardWatcher();
  watcher.avatarService = new AvatarService({
    directory: { users: new Map() },
    fetchPhoto: async () => {
      throw new Error('status 403');
    },
  });
  const rec = recordTransport();
  try {
    await watcher.executeLeaderboardCommand(event);
  } finally {
    rec.restore();
  }
  assert.equal(rec.calls.length, 1);
  assert.equal(images(sentCard(rec.calls[0])).length, 0);
});
