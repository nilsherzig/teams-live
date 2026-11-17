import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setRichMessages, transport } from '../src/teams.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { LIFECYCLE_KINDS, buildLifecycleCard, chatList, chatUrl, lifecycleMarkdown } from '../src/lifecycle-card.mjs';
import { ADAPTIVE_CARD_VERSION, MAX_CARD_BYTES } from '../src/cards.mjs';
import { SERVICE_ICONS } from '../src/card-icons.mjs';
import { LIFECYCLE_ICONS, LIFECYCLE_ICONS_PX } from '../src/lifecycle-icons.mjs';
import { richMessageWireBytes, makeRichMessage } from '../src/teams.mjs';

beforeEach(() => setRichMessages(false));
afterEach(() => setRichMessages(false));

// ---------------------------------------------------------------------------
// Helper module: markdown (regular message) and card
// ---------------------------------------------------------------------------

// Generic fixture names and ids: no real chat appears in the tests. The names are labels of the fixture only.
const FIXTURE_GROUP_ID = '19:fixture-group@thread.v2';
const FIXTURE_GROUP_URL = 'https://teams.microsoft.com/l/chat/19%3Afixture-group%40thread.v2/0';
const FIXTURE_CHATS = chatList([
  { name: 'Example Group', id: FIXTURE_GROUP_ID },
  { name: 'Notes', id: '48:notes' },
]);
const FIXTURE_CHATS_MD = `[Example Group](${FIXTURE_GROUP_URL}), Notes`;

const STARTUP_FACTS = [
  ['Host', '`bot-host`'],
  ['PID', '`4242`'],
  ['Runtime', 'Node.js `v22.1.0` (linux x64)'],
  ['Memory', '80 MB'],
  ['Started', '2026-11-17 10:00:00 UTC'],
  ['Watched Conversations', FIXTURE_CHATS, FIXTURE_CHATS],
  ['GitLab', 'Polling every 60s', 'Polling · 60s'],
  ['Jira', 'Not configured'],
  ['Home Assistant (HR works)', 'Active'],
  ['Precompute Cache', 'Active (every 5m)'],
];
// The card shows three labels shorter than the regular message; the plain text keeps the full ones.
const SHORT_LABELS = { 'Watched Conversations': 'Chats', 'Home Assistant (HR works)': 'HA', 'Precompute Cache': 'Cache' };
const SHUTDOWN_FACTS = [
  ['Host', '`bot-host`'],
  ['PID', '`4242`'],
  ['Signal', '`SIGTERM`'],
  ['Uptime', '1h 2m 3s'],
  ['Time', '2026-11-17 11:02:03 UTC'],
];
const NOTICE = {
  title: 'WARNING: GitLab Token Override is Active!',
  facts: [['Override File', '`/run/override-token`']],
  body: 'The configured secret file was read-only; please update the rotated token (`nixos-config-private`) so it persists:',
  command: 'cat /run/override-token',
};

const textsIn = (node) => {
  if (!node || typeof node !== 'object') return [];
  if (node.type === 'TextBlock') return [node.text];
  if (node.type === 'FactSet') return node.facts.flatMap((f) => [f.title, f.value]);
  return [...(node.body || []), ...(node.items || []), ...(node.columns || [])].flatMap(textsIn);
};
// The fact grid of a card: one row (ColumnSet) per fact, `{ icon, label, value }`. The warning block keeps its own FactSet.
const gridRows = (card) =>
  find(card, (n) => n.type === 'Container' && !n.style)
    .flatMap((c) => c.items || [])
    .filter((n) => n.type === 'ColumnSet')
    .map((row) => {
      const [icon, label, value] = row.columns;
      return { icon: icon.items[0] || null, label: label.items[0].text, value: value.items[0].text, row };
    });
const gridFacts = (card) => Object.fromEntries(gridRows(card).map((r) => [r.label, r.value]));
const find = (node, pred) => {
  if (!node || typeof node !== 'object') return [];
  const here = pred(node) ? [node] : [];
  return [...here, ...[...(node.body || []), ...(node.items || []), ...(node.columns || [])].flatMap((n) => find(n, pred))];
};

test('lifecycleMarkdown: startup message is the regular message, byte for byte', () => {
  assert.equal(
    lifecycleMarkdown({ kind: 'startup', facts: STARTUP_FACTS }),
    '🟢 **teams-live started**\n\n' +
      '- **Host**: `bot-host`\n' +
      '- **PID**: `4242`\n' +
      '- **Runtime**: Node.js `v22.1.0` (linux x64)\n' +
      '- **Memory**: 80 MB\n' +
      '- **Started**: 2026-11-17 10:00:00 UTC\n' +
      `- **Watched Conversations**: ${FIXTURE_CHATS_MD}\n` +
      '- **GitLab**: Polling every 60s\n' +
      '- **Jira**: Not configured\n' +
      '- **Home Assistant (HR works)**: Active\n' +
      '- **Precompute Cache**: Active (every 5m)'
  );
});

test('lifecycleMarkdown: token override warning block and the shutdown message are unchanged', () => {
  const withNotice = lifecycleMarkdown({ kind: 'startup', facts: [['Host', '`h`']], notice: NOTICE });
  assert.equal(
    withNotice,
    '🟢 **teams-live started**\n\n- **Host**: `h`' +
      '\n\n⚠️ **WARNING: GitLab Token Override is Active!**\n' +
      '- **Override File**: `/run/override-token`\n' +
      '- The configured secret file was read-only; please update the rotated token (`nixos-config-private`) so it persists:\n' +
      '  `cat /run/override-token`'
  );
  assert.equal(
    lifecycleMarkdown({ kind: 'shutdown', facts: SHUTDOWN_FACTS }),
    '🛑 **teams-live shutting down**\n\n' +
      '- **Host**: `bot-host`\n- **PID**: `4242`\n- **Signal**: `SIGTERM`\n- **Uptime**: 1h 2m 3s\n- **Time**: 2026-11-17 11:02:03 UTC'
  );
});

test('lifecycleMarkdown and buildLifecycleCard reject an unknown kind', () => {
  assert.throws(() => lifecycleMarkdown({ kind: 'sleep' }), /unknown lifecycle kind/);
  assert.throws(() => buildLifecycleCard({ kind: 'sleep' }), /unknown lifecycle kind/);
});

test('startup card is green: good container, green heading and icon, ONLINE status line', () => {
  const card = buildLifecycleCard({ kind: 'startup', facts: STARTUP_FACTS });
  assert.equal(card.type, 'AdaptiveCard');
  assert.equal(card.version, ADAPTIVE_CARD_VERSION);
  assert.equal(card.body.length, 1);
  assert.equal(card.body[0].type, 'Container');
  assert.equal(card.body[0].style, 'good');

  const heading = find(card, (n) => n.type === 'TextBlock' && n.text === 'teams-live started')[0];
  assert.equal(heading.color, 'Good');
  assert.equal(heading.weight, 'Bolder');
  assert.ok(find(card, (n) => n.type === 'TextBlock' && n.text === LIFECYCLE_KINDS.startup.icon).length === 1);
  const pill = find(card, (n) => n.type === 'TextBlock' && n.text === 'ONLINE')[0];
  assert.equal(pill.color, 'Good');
  // Legible without container styles: nothing relies on the style alone.
  assert.equal(find(card, (n) => n.color === 'Attention').length, 0);
});

test('last-will card is red: attention container, red heading and icon, STOPPED status line', () => {
  const card = buildLifecycleCard({ kind: 'shutdown', facts: SHUTDOWN_FACTS });
  assert.equal(card.body[0].style, 'attention');
  const heading = find(card, (n) => n.type === 'TextBlock' && n.text === 'teams-live shutting down')[0];
  assert.equal(heading.color, 'Attention');
  assert.ok(find(card, (n) => n.type === 'TextBlock' && n.text === '\u{1F6D1}').length === 1);
  assert.equal(find(card, (n) => n.type === 'TextBlock' && n.text === 'STOPPED')[0].color, 'Attention');
  assert.equal(find(card, (n) => n.color === 'Good').length, 0);
});

test('cards keep every fact of the regular message, code spans shown plainly, markdown escaped', () => {
  const card = buildLifecycleCard({ kind: 'startup', facts: STARTUP_FACTS });
  assert.deepEqual(
    gridRows(card).map((r) => r.label),
    STARTUP_FACTS.map(([label]) => SHORT_LABELS[label] ?? label)
  );
  const byTitle = gridFacts(card);
  assert.equal(byTitle.Host, 'bot-host');
  assert.equal(byTitle.Runtime, 'Node.js v22.1.0 (linux x64)');
  // The chat list is the card's own markdown: links stay links.
  assert.equal(byTitle.Chats, FIXTURE_CHATS_MD);
  assert.equal(byTitle.GitLab, 'Polling · 60s');
  assert.ok(!JSON.stringify(card).includes('`'));
});

test('token override warning becomes a warning container with the same information', () => {
  const card = buildLifecycleCard({ kind: 'startup', facts: STARTUP_FACTS, notice: NOTICE });
  const [warning] = find(card, (n) => n.type === 'Container' && n.style === 'warning');
  assert.ok(warning);
  const texts = textsIn(warning);
  assert.ok(texts.some((t) => t.includes('WARNING: GitLab Token Override is Active!')));
  assert.ok(texts.includes('/run/override-token'));
  assert.ok(texts.some((t) => t.includes('nixos-config-private')));
  assert.equal(find(card, (n) => n.type === 'Container' && n.style === 'warning').length, 1);
  assert.equal(
    find(buildLifecycleCard({ kind: 'startup', facts: STARTUP_FACTS }), (n) => n.style === 'warning').length,
    0
  );
});

test('chatUrl: a Teams deep link for thread chats only, the id encoded for the path', () => {
  assert.equal(chatUrl(FIXTURE_GROUP_ID), FIXTURE_GROUP_URL);
  // A configured id that is already URL-encoded gives the same link, not a double encoding.
  assert.equal(chatUrl('19%3Afixture-group%40thread.v2'), FIXTURE_GROUP_URL);
  assert.equal(chatUrl('19:a_b@unq.gbl.spaces'), 'https://teams.microsoft.com/l/chat/19%3Aa_b%40unq.gbl.spaces/0');
  // Characters encodeURIComponent keeps are encoded too, so the markdown link cannot end early.
  assert.equal(chatUrl('19:x(1)@thread.v2'), 'https://teams.microsoft.com/l/chat/19%3Ax%281%29%40thread.v2/0');
  // No link rather than a broken one: self chat, channels, malformed ids.
  for (const id of ['48:notes', '19:chan@thread.tacv2', '', undefined, 'not an id', '19:a/b@thread.v2', '19:a b@thread.v2']) {
    assert.equal(chatUrl(id), null, String(id));
  }
});

test('chatList: comma-separated linked names, escaped, no count and no parentheses', () => {
  assert.equal(chatList([{ name: 'Example Group', id: FIXTURE_GROUP_ID }, { name: 'Notes', id: '48:notes' }]), FIXTURE_CHATS_MD);
  assert.equal(chatList([{ name: 'A_b [x] *y*', id: '48:notes' }]), 'A\\_b \\[x\\] \\*y\\*');
  assert.equal(chatList([{ name: '', id: FIXTURE_GROUP_ID }]), 'none');
  assert.equal(chatList([]), 'none');
  assert.doesNotMatch(FIXTURE_CHATS, /^\d|\(\d|\(Notes/);
});

test('the override path is a code inset and the command is not shown on the card', () => {
  const card = buildLifecycleCard({
    kind: 'startup',
    facts: STARTUP_FACTS,
    notice: { ...NOTICE, facts: [['Override File', '`/run/a_b*/token`']] },
  });
  const [warning] = find(card, (n) => n.type === 'Container' && n.style === 'warning');
  const insets = (warning.items || []).filter((n) => n.type === 'Container' && n.style === 'emphasis');
  assert.equal(insets.length, 1);
  for (const inset of insets) {
    const [block, ...rest] = inset.items;
    assert.equal(rest.length, 0);
    assert.equal(block.type, 'TextBlock');
    assert.equal(block.fontType, 'Monospace');
    assert.equal(block.wrap, true);
  }
  // Markdown characters of a path are escaped so the monospace text shows verbatim.
  assert.equal(insets[0].items[0].text, '/run/a\\_b\\*/token');
  // The card drops the command; plain mode keeps it (see the lifecycleMarkdown tests).
  assert.ok(!JSON.stringify(warning).includes('cat '));
  assert.ok(textsIn(warning).some((t) => t.endsWith('so it persists.')));
  // The label sits right before its inset; no backticks and no FactSet in the warning.
  const labelIdx = warning.items.findIndex((n) => n.text === 'Override File');
  assert.equal(warning.items[labelIdx + 1], insets[0]);
  assert.ok(!JSON.stringify(warning).includes('`'));
  assert.equal(find(warning, (n) => n.type === 'FactSet').length, 0);
  // A non-code value stays plain text.
  const plain = buildLifecycleCard({ kind: 'startup', facts: [], notice: { ...NOTICE, facts: [['Mode', 'read-only']] } });
  assert.ok(textsIn(plain).includes('read-only'));
});

test('the card is a dedicated layout, not the generic markdown wrapper', () => {
  const card = buildLifecycleCard({ kind: 'shutdown', facts: SHUTDOWN_FACTS });
  assert.ok(find(card, (n) => n.type === 'ColumnSet').length >= 1);
  // No "service · kind" header of the entity cards and no buttons; the only images are the fact icons.
  assert.equal(find(card, (n) => n.type === 'Image').length, SHUTDOWN_FACTS.length);
  assert.equal(card.actions, undefined);
});

test('the header has two columns only; the status word sits under the title (phone width)', () => {
  for (const [kind, title, word] of [
    ['startup', 'teams-live started', 'ONLINE'],
    ['shutdown', 'teams-live shutting down', 'STOPPED'],
  ]) {
    const card = buildLifecycleCard({ kind, facts: kind === 'startup' ? STARTUP_FACTS : SHUTDOWN_FACTS });
    const [set] = find(card, (n) => n.type === 'ColumnSet');
    // A third column squeezed the title to ~95px at 308px: icon (auto) + text (stretch) only.
    assert.deepEqual(
      set.columns.map((c) => c.width),
      ['auto', 'stretch']
    );
    const [icon, text] = set.columns;
    assert.equal(icon.items.length, 1);
    assert.deepEqual(
      text.items.map((i) => i.text),
      [title, word]
    );
    // The status line is compact and carries the colour next to the word.
    assert.equal(text.items[1].size, 'Small');
    assert.equal(text.items[1].color, LIFECYCLE_KINDS[kind].color);
    // The good/attention background stays on the outer container; the header has no styled column.
    assert.equal(card.body[0].style, LIFECYCLE_KINDS[kind].style);
    assert.equal(set.columns.filter((c) => c.style).length, 0);
  }
});

test('fact rows: a 16px icon slot, the bold label, the value; real logos for services, neutral glyphs otherwise', () => {
  const card = buildLifecycleCard({ kind: 'startup', facts: STARTUP_FACTS });
  const rows = gridRows(card);
  assert.equal(rows.length, STARTUP_FACTS.length);
  const px = `${LIFECYCLE_ICONS_PX}px`;
  assert.equal(px, '16px');
  for (const { row, icon, label } of rows) {
    // Same three columns in every row, so labels and values line up.
    assert.deepEqual(
      row.columns.map((c) => c.width),
      [px, '76px', 'stretch'],
      label
    );
    assert.equal(row.columns[1].items[0].weight, 'Bolder', label);
    // Top-aligned icon: it stays beside the first line of a label that wraps.
    assert.equal(row.columns[0].verticalContentAlignment, undefined, label);
    assert.ok(icon, `${label} has an icon`);
    assert.equal(icon.type, 'Image');
    assert.equal(icon.width, px);
    assert.equal(icon.height, px);
    assert.match(icon.url, /^data:image\/png;base64,/);
    assert.ok(icon.altText, `${label} icon has alt text`);
  }
  const iconOf = Object.fromEntries(rows.map((r) => [r.label, r.icon.url]));
  // Real logos of the services, reused from the entity cards where they exist.
  assert.equal(iconOf.GitLab, SERVICE_ICONS.gitlab);
  assert.equal(iconOf.Jira, SERVICE_ICONS.jira);
  assert.equal(iconOf.Runtime, LIFECYCLE_ICONS.node.url);
  assert.equal(iconOf.HA, LIFECYCLE_ICONS.homeassistant.url);
  // The glyphs are all different, so the rows are told apart at a glance.
  const glyphs = ['Host', 'PID', 'Memory', 'Started', 'Chats', 'Cache'].map((l) => iconOf[l]);
  assert.equal(new Set(glyphs).size, glyphs.length);
  assert.equal(new Set(Object.values(iconOf)).size, Object.keys(iconOf).length, 'every row has its own icon');
});

test('fact rows: the short labels are for the card only, the plain message keeps the full labels', () => {
  const md = lifecycleMarkdown({ kind: 'startup', facts: STARTUP_FACTS });
  for (const full of Object.keys(SHORT_LABELS)) assert.ok(md.includes(`**${full}**`), full);
  for (const short of Object.values(SHORT_LABELS)) assert.ok(!md.includes(`**${short}**`), short);
  const card = buildLifecycleCard({ kind: 'startup', facts: STARTUP_FACTS });
  const labels = gridRows(card).map((r) => r.label);
  for (const full of Object.keys(SHORT_LABELS)) assert.ok(!labels.includes(full), full);
  assert.ok(!JSON.stringify(card).includes('HR works'));
});

test('fact rows: the shutdown facts have icons too, and no emoji sneaks into the grid', () => {
  const card = buildLifecycleCard({ kind: 'shutdown', facts: SHUTDOWN_FACTS });
  for (const { icon, label, value } of gridRows(card)) {
    assert.ok(icon, `${label} has an icon`);
    assert.doesNotMatch(`${label} ${value}`, /\p{Extended_Pictographic}/u);
  }
});

test('fact rows: an unknown label keeps an empty icon slot, so the labels stay aligned', () => {
  const card = buildLifecycleCard({ kind: 'startup', facts: [['Host', '`h`'], ['Something New', 'x']] });
  const rows = gridRows(card);
  assert.ok(rows[0].icon);
  assert.equal(rows[1].icon, null);
  assert.deepEqual(
    rows[1].row.columns.map((c) => c.width),
    ['16px', '76px', 'stretch']
  );
  assert.equal(rows[1].label, 'Something New');
});

test('fact rows: an empty value or label is left out, as in the FactSet before', () => {
  const card = buildLifecycleCard({ kind: 'startup', facts: [['Host', ''], ['', 'x'], ['PID', '`1`']] });
  assert.deepEqual(gridFacts(card), { PID: '1' });
  assert.equal(find(buildLifecycleCard({ kind: 'startup', facts: [] }), (n) => n.type === 'Image').length, 0);
});

test('the lifecycle cards with icons keep headroom below the card size budget', () => {
  for (const [kind, facts, notice] of [
    ['startup', STARTUP_FACTS, NOTICE],
    ['shutdown', SHUTDOWN_FACTS, null],
  ]) {
    const card = buildLifecycleCard({ kind, facts, notice });
    const bytes = richMessageWireBytes(makeRichMessage(lifecycleMarkdown({ kind, facts, notice }), card));
    // The GitLab and Jira logos reused from card-icons.mjs dominate the size; keep room for a longer notice or more facts.
    assert.ok(bytes <= MAX_CARD_BYTES - 3000, `${kind}: ${bytes} bytes`);
  }
});

test('the plain messages are unchanged by the icons: no image, no card data', () => {
  assert.doesNotMatch(lifecycleMarkdown({ kind: 'startup', facts: STARTUP_FACTS, notice: NOTICE }), /data:image|!\[/);
});

// ---------------------------------------------------------------------------
// Watcher: plain mode untouched, rich mode sends the cards
// ---------------------------------------------------------------------------

function recordTransport() {
  const calls = [];
  const original = { ...transport };
  transport.sendMessage = (...args) => {
    calls.push(args);
    return Promise.resolve({ ok: true, value: { messageId: '1700000000001', timestamp: '1700000000001' } });
  };
  return {
    calls,
    restore() {
      Object.assign(transport, original);
    },
  };
}

function newWatcher(teams = {}, gitlab = {}) {
  const watcher = new MergeRequestWatcher({
    config: { conversations: [], gitlab: { group: 'group', ...gitlab }, teams },
    gitlab: { findMrLinks: () => [], getMr: async () => null },
    jira: null,
    opsgenie: null,
  });
  watcher.saveState = () => {};
  return watcher;
}

async function announce(watcher, method, ...args) {
  const rec = recordTransport();
  try {
    await watcher[method](...args);
  } finally {
    rec.restore();
  }
  return rec.calls;
}

const cardOf = (options) => JSON.parse(options.properties.cards)[0]?.content;

test('plain mode: startup and shutdown announcements are regular messages without cards', async () => {
  const watcher = newWatcher();
  const [start] = await announce(watcher, 'sendStartupAnnouncement');
  assert.equal(start[0], '48:notes');
  assert.equal(start[2].properties.cards, '[]');
  assert.match(start[1], /teams-live started/);
  assert.match(start[1], /Precompute Cache/);

  const [stop] = await announce(watcher, 'sendShutdownAnnouncement', 'SIGINT');
  assert.equal(stop[2].properties.cards, '[]');
  assert.match(stop[1], /teams-live shutting down/);
  assert.match(stop[1], /SIGINT/);
});

test('rich mode: startup is the green lifecycle card with the regular text as fallback', async () => {
  const watcher = newWatcher({ rich_messages: true });
  const [call] = await announce(watcher, 'sendStartupAnnouncement');
  const card = cardOf(call[2]);
  assert.equal(card.body[0].style, 'good');
  assert.deepEqual(
    gridRows(card).map((r) => r.label),
    ['Host', 'PID', 'Runtime', 'Memory', 'Started', 'Chats', 'GitLab', 'Jira', 'HA', 'Cache']
  );
  assert.equal(find(card, (n) => n.style === 'warning').length, 0);
});

test('rich mode: a token override adds the warning block to the card', async () => {
  const watcher = newWatcher({ rich_messages: true }, { is_token_override: true, override_token_path: '/run/override-token' });
  const [call] = await announce(watcher, 'sendStartupAnnouncement');
  const [warning] = find(cardOf(call[2]), (n) => n.type === 'Container' && n.style === 'warning');
  assert.ok(textsIn(warning).includes('/run/override-token'));
});

test('rich mode: shutdown is the red last-will card with signal and uptime', async () => {
  const watcher = newWatcher({ rich_messages: true });
  const [call] = await announce(watcher, 'sendShutdownAnnouncement', 'SIGTERM');
  const card = cardOf(call[2]);
  assert.equal(card.body[0].style, 'attention');
  const facts = gridFacts(card);
  assert.equal(facts.Signal, 'SIGTERM');
  assert.ok(facts.Uptime);
  assert.deepEqual(Object.keys(facts), ['Host', 'PID', 'Signal', 'Uptime', 'Time']);
});

// ---------------------------------------------------------------------------
// Watcher: the Chats fact lists the real titles, linked; the GitLab fact is short in the card
// ---------------------------------------------------------------------------

const GROUP_B_ID = '19:fixture-other@thread.v2';

function chatsWatcher(conversations, teams = { rich_messages: true }, gitlab = {}) {
  const watcher = newWatcher(teams, gitlab);
  watcher.config.conversations = conversations;
  return watcher;
}

async function withTitles(titles, fn) {
  const original = transport.getConversationTitle;
  const looked = [];
  transport.getConversationTitle = async (id) => {
    looked.push(id);
    const title = titles[id];
    if (title instanceof Error) throw title;
    return title ?? '';
  };
  try {
    return await fn(looked);
  } finally {
    transport.getConversationTitle = original;
  }
}

test('rich mode: Chats lists the titles Teams shows as links, not the configured handles or a count', async () => {
  const watcher = chatsWatcher([
    { id: FIXTURE_GROUP_ID, name: 'config_handle' },
    { id: '48:notes', name: 'Notes' },
  ]);
  await withTitles({ [FIXTURE_GROUP_ID]: 'Example Group' }, async (looked) => {
    const [call] = await announce(watcher, 'sendStartupAnnouncement');
    assert.equal(gridFacts(cardOf(call[2])).Chats, FIXTURE_CHATS_MD);
    // The Notes self-chat is not looked up: its configured label is the name and it has no link.
    assert.deepEqual(looked, [FIXTURE_GROUP_ID]);
    assert.ok(!call[1].includes('config_handle'));
    // The regular message (plain mode) lists the same linked names.
    const plain = chatsWatcher(watcher.config.conversations, {});
    const [plainCall] = await announce(plain, 'sendStartupAnnouncement');
    // (the regular message goes out as HTML)
    assert.ok(plainCall[1].includes(`<b>Watched Conversations</b>: <a href="${FIXTURE_GROUP_URL}">Example Group</a>, Notes</li>`));
  });
});

test('Chats falls back to the configured label when the lookup fails, is empty or hangs; ids and handles never leak as links', async () => {
  const watcher = chatsWatcher([
    { id: FIXTURE_GROUP_ID, name: 'Fixture Label' },
    { id: GROUP_B_ID, name: 'Other Label' },
    { id: '19:fixture-third@thread.v2' },
  ]);
  await withTitles({ [FIXTURE_GROUP_ID]: new Error('boom'), [GROUP_B_ID]: '  ' }, async () => {
    const chats = await watcher.lifecycleChats();
    assert.deepEqual(
      chats.map((c) => c.name),
      ['Fixture Label', 'Other Label', 'Chat']
    );
    const [call] = await announce(watcher, 'sendStartupAnnouncement');
    const chatsValue = gridFacts(cardOf(call[2])).Chats;
    assert.match(chatsValue, /^\[Fixture Label\]\(https:\/\/teams\.microsoft\.com\/l\/chat\/19%3Afixture-group%40thread\.v2\/0\), /);
    // A conversation without a title or label is a generic "Chat", never its raw id.
    assert.ok(chatsValue.endsWith(', [Chat](https://teams.microsoft.com/l/chat/19%3Afixture-third%40thread.v2/0)'));
    assert.ok(!chatsValue.includes('fixture-third@'));
  });
});

test('a found title is remembered; a later failed lookup keeps it', async () => {
  const watcher = chatsWatcher([{ id: FIXTURE_GROUP_ID, name: 'Fixture Label' }]);
  await withTitles({ [FIXTURE_GROUP_ID]: 'Example Group' }, () => watcher.lifecycleChats());
  await withTitles({ [FIXTURE_GROUP_ID]: new Error('offline') }, async (looked) => {
    const chats = await watcher.lifecycleChats();
    assert.equal(chats[0].name, 'Example Group');
    assert.deepEqual(looked, []);
  });
});

test('duplicate configured conversations (encoded and decoded id) are listed once', async () => {
  const watcher = chatsWatcher([
    { id: FIXTURE_GROUP_ID, name: 'A' },
    { id: encodeURIComponent(FIXTURE_GROUP_ID), name: 'A' },
  ]);
  await withTitles({}, async () => {
    assert.equal((await watcher.lifecycleChats()).length, 1);
  });
});

test('rich mode: the GitLab fact is short in the card and keeps the real interval; the plain message stays full', async () => {
  const polling = chatsWatcher([]);
  polling.pollIntervalMs = 90000;
  let [call] = await announce(polling, 'sendStartupAnnouncement');
  assert.equal(gridFacts(cardOf(call[2])).GitLab, 'Polling · 90s');
  const plainPolling = chatsWatcher([], {});
  plainPolling.pollIntervalMs = 90000;
  assert.match((await announce(plainPolling, 'sendStartupAnnouncement'))[0][1], /<b>GitLab<\/b>: Polling every 90s/);

  for (const [setup, expected] of [
    [{ ok: true, group: 'fixture-group', hookId: 32 }, 'Webhooks · fallback 60s'],
    [null, 'Webhook listener · fallback 60s'],
  ]) {
    const hooks = chatsWatcher([]);
    hooks.webhookServer = { listening: true, port: 8123 };
    hooks.webhookSetupStatus = setup;
    [call] = await announce(hooks, 'sendStartupAnnouncement');
    const value = gridFacts(cardOf(call[2])).GitLab;
    assert.equal(value, expected);
    assert.doesNotMatch(value, /fixture-group|32|\(/);
    // Plain mode keeps the full detail.
    const plainHooks = chatsWatcher([], {});
    plainHooks.webhookServer = hooks.webhookServer;
    plainHooks.webhookSetupStatus = setup;
    const [plainCall] = await announce(plainHooks, 'sendStartupAnnouncement');
    assert.match(plainCall[1], /<b>GitLab<\/b>: Webhooks active \(/);
    if (setup) assert.match(plainCall[1], /configured on <code>fixture-group<\/code> id: 32, fallback poll every 60s\)/);
  }
});
