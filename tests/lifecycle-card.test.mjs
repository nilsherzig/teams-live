import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setRichMessages, transport } from '../src/teams.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { LIFECYCLE_KINDS, buildLifecycleCard, lifecycleMarkdown } from '../src/lifecycle-card.mjs';
import { ADAPTIVE_CARD_VERSION, MAX_CARD_BYTES } from '../src/cards.mjs';
import { SERVICE_ICONS } from '../src/card-icons.mjs';
import { LIFECYCLE_ICONS, LIFECYCLE_ICONS_PX } from '../src/lifecycle-icons.mjs';
import { richMessageWireBytes, makeRichMessage } from '../src/teams.mjs';

beforeEach(() => setRichMessages(false));
afterEach(() => setRichMessages(false));

// ---------------------------------------------------------------------------
// Helper module: markdown (regular message) and card
// ---------------------------------------------------------------------------

const STARTUP_FACTS = [
  ['Host', '`bot-host`'],
  ['PID', '`4242`'],
  ['Runtime', 'Node.js `v22.1.0` (linux x64)'],
  ['Memory', '80 MB'],
  ['Started', '2026-11-17 10:00:00 UTC'],
  ['Watched Conversations', '2 (Notes, Team_Chat)'],
  ['GitLab', 'Polling every 60s'],
  ['Jira', 'Not configured'],
  ['Home Assistant (HR works)', 'Active'],
  ['Precompute Cache', 'Active (every 5m)'],
];
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
      '- **Watched Conversations**: 2 (Notes, Team_Chat)\n' +
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
    STARTUP_FACTS.map(([label]) => label)
  );
  const byTitle = gridFacts(card);
  assert.equal(byTitle.Host, 'bot-host');
  assert.equal(byTitle.Runtime, 'Node.js v22.1.0 (linux x64)');
  // An underscore in a value is not read as emphasis.
  assert.equal(byTitle['Watched Conversations'], '2 (Notes, Team\\_Chat)');
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
  const command = find(warning, (n) => n.type === 'TextBlock' && n.fontType === 'Monospace')[0];
  assert.equal(command.text, 'cat /run/override-token');
  assert.equal(find(card, (n) => n.type === 'Container' && n.style === 'warning').length, 1);
  assert.equal(
    find(buildLifecycleCard({ kind: 'startup', facts: STARTUP_FACTS }), (n) => n.style === 'warning').length,
    0
  );
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
      [px, 5, 7],
      label
    );
    assert.equal(row.columns[1].items[0].weight, 'Bolder', label);
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
  assert.equal(iconOf['Home Assistant (HR works)'], LIFECYCLE_ICONS.homeassistant.url);
  // The glyphs are all different, so the rows are told apart at a glance.
  const glyphs = ['Host', 'PID', 'Memory', 'Started', 'Watched Conversations', 'Precompute Cache'].map((l) => iconOf[l]);
  assert.equal(new Set(glyphs).size, glyphs.length);
  assert.equal(new Set(Object.values(iconOf)).size, Object.keys(iconOf).length, 'every row has its own icon');
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
    ['16px', 5, 7]
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
    ['Host', 'PID', 'Runtime', 'Memory', 'Started', 'Watched Conversations', 'GitLab', 'Jira', 'Home Assistant (HR works)', 'Precompute Cache']
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
