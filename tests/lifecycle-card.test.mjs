import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setRichMessages, transport } from '../src/teams.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { LIFECYCLE_KINDS, buildLifecycleCard, lifecycleMarkdown } from '../src/lifecycle-card.mjs';
import { ADAPTIVE_CARD_VERSION } from '../src/cards.mjs';

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

test('startup card is green: good container, green heading and icon, ONLINE pill', () => {
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

test('last-will card is red: attention container, red heading and icon, STOPPED pill', () => {
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
  const [set] = find(card, (n) => n.type === 'FactSet');
  assert.deepEqual(
    set.facts.map((f) => f.title),
    STARTUP_FACTS.map(([label]) => label)
  );
  const byTitle = Object.fromEntries(set.facts.map((f) => [f.title, f.value]));
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
  // No "service · kind" header of the entity cards and no buttons.
  assert.equal(find(card, (n) => n.type === 'Image').length, 0);
  assert.equal(card.actions, undefined);
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
  const [set] = find(card, (n) => n.type === 'FactSet');
  assert.deepEqual(
    set.facts.map((f) => f.title),
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
  const [set] = find(card, (n) => n.type === 'FactSet');
  const facts = Object.fromEntries(set.facts.map((f) => [f.title, f.value]));
  assert.equal(facts.Signal, 'SIGTERM');
  assert.ok(facts.Uptime);
  assert.deepEqual(Object.keys(facts), ['Host', 'PID', 'Signal', 'Uptime', 'Time']);
});
