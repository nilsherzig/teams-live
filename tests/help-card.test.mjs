import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isRichMessage, makeRichMessage, richMessageWireBytes, setRichMessages, transport } from '../src/teams.mjs';
import { MAX_CARD_BYTES } from '../src/cards.mjs';
import { MergeRequestWatcher, buildHelpText } from '../src/watcher.mjs';
import { buildHelpCard, helpEntries, parseHelpEntry, splitHelpCategories } from '../src/card-help.mjs';

// The /help card: commands grouped by domain. Everything here is generic.

beforeEach(() => setRichMessages(false));

const CONV = '19:example@thread.v2';
const event = { conversationId: CONV, messageId: '1700000000000', from: 'Person A Example' };

const walk = (node, fn) => {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, fn));
  if (!node || typeof node !== 'object') return;
  fn(node);
  Object.values(node).forEach((v) => walk(v, fn));
};
/** All visible text of a card, one string per text block / run, in order. */
const visible = (card) => {
  const out = [];
  walk(card, (n) => {
    if (n.type === 'TextBlock') out.push(n.text);
    if (n.type === 'TextRun') out.push(n.text);
  });
  return out;
};
const flat = (card) => visible(card).join(' ');

function helpWatcher({ rich = true, features = [] } = {}) {
  const watcher = new MergeRequestWatcher({
    config: { conversations: [], gitlab: {}, teams: rich ? { rich_messages: true } : {} },
    gitlab: { findMrLinks: () => [], mrLink: () => 'https://gitlab.example.com/x' },
    jira: null,
    opsgenie: null,
  });
  watcher.saveState = () => {};
  watcher.setCommandReaction = async () => {};
  watcher.helpFeatures = new Set(features);
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
const sentBody = (call) => String(call[1]);

test('parseHelpEntry reads the command, its arguments, aliases, description, examples and the admin flag', () => {
  const plain = parseHelpEntry('- `/close [link]`: Closes the target MR.');
  assert.deepEqual(plain.commands, [{ name: '/close', args: '[link]' }]);
  assert.equal(plain.description, 'Closes the target MR.');
  assert.deepEqual(plain.aliases, []);

  const aliased = parseHelpEntry('- `/doc` (or `/wiki`, `/confluence`) [link|id]: Displays Confluence document details.');
  assert.deepEqual(aliased.commands, [{ name: '/doc', args: '' }]);
  assert.deepEqual(aliased.aliases, ['/wiki', '/confluence']);
  assert.equal(aliased.args, '[link|id]');

  const example = parseHelpEntry('- `/roll` (or `/dice`) [expr]: Rolls dice (e.g. `/roll`, `/roll d20`, `/roll 2d6`).');
  assert.deepEqual(example.examples, ['/roll', '/roll d20', '/roll 2d6']);
  assert.equal(example.description, 'Rolls dice.');

  const admin = parseHelpEntry('- `/exec <cmd>`: Executes a command [admin only].');
  assert.equal(admin.adminOnly, true);
  assert.equal(admin.description, 'Executes a command.');
  assert.deepEqual(admin.commands, [{ name: '/exec', args: '<cmd>' }]);

  const quoted = parseHelpEntry('- `/poll "Question" "Opt1" "Opt2"`: Creates an interactive reaction poll.');
  assert.deepEqual(quoted.commands, [{ name: '/poll', args: '"Question" "Opt1" "Opt2"' }]);

  assert.equal(parseHelpEntry('just some text'), null);
});

test('a catalogue line the parser cannot read is still shown, as plain text', () => {
  const card = buildHelpCard([{ id: 'x', title: '**X**', aliases: [], commands: ['- Something **unusual** without a command'] }], {});
  assert.match(flat(card), /Something unusual without a command/);
});

test('helpEntries drops an entry whose feature is not available and keeps plain entries', () => {
  const category = { commands: ['- `/a`: A.', { text: '- `/tv ard`: Switches the TV.', requires: 'tv' }] };
  assert.deepEqual(helpEntries(category, () => false), ['- `/a`: A.']);
  assert.deepEqual(helpEntries(category, (f) => f === 'tv'), ['- `/a`: A.', '- `/tv ard`: Switches the TV.']);
  assert.deepEqual(helpEntries(category), ['- `/a`: A.', '- `/tv ard`: Switches the TV.'], 'no filter given: all shown');
});

test('the card shows every command, alias, argument and description of the catalogue (rich full help)', () => {
  setRichMessages(true);
  const watcher = helpWatcher();
  const text = buildHelpText();
  const [message] = watcher.helpMessages(null, text);
  assert.ok(isRichMessage(message));
  const shown = flat(message.card);
  // Every command line of the plain help appears in the card, with its alias and description words.
  for (const line of text.split('\n').filter((l) => l.startsWith('- `'))) {
    const entry = parseHelpEntry(line);
    assert.ok(entry, `parsed: ${line}`);
    for (const c of entry.commands) assert.ok(shown.includes(c.name), `command ${c.name}`);
    for (const a of entry.aliases) assert.ok(shown.includes(a), `alias ${a}`);
    for (const e of entry.examples) assert.ok(shown.includes(e), `example ${e}`);
    assert.ok(shown.includes(entry.description), `description of ${entry.commands[0].name}`);
  }
  assert.match(shown, /GitLab/);
  assert.match(shown, /Fun & Games/);
  assert.match(shown, /admin only/);
  assert.match(shown, /e\.g\. \/roll/);
  assert.match(shown, /\/help <category>/);
  assert.ok(!shown.includes('**'), 'no raw markdown bold in the card');
  assert.ok(!/`/.test(shown), 'no raw code ticks in the card');
});

test('one domain: heading as title, its footer, no other domains', () => {
  setRichMessages(true);
  const watcher = helpWatcher();
  const [message] = watcher.helpMessages('gitlab', 'plain');
  const shown = flat(message.card);
  assert.match(shown, /GitLab/);
  assert.match(shown, /\/approve/);
  assert.match(shown, /Target an MR by replying/);
  assert.ok(!/\/weather/.test(shown));
  assert.ok(!/\/help <category>/.test(shown), 'the filter tip belongs to the full help');
  assert.equal(message.markdown, 'plain', 'the plain text is kept as the markdown part');
});

test('an alias of a domain selects it, an unknown one is not a card', () => {
  const watcher = helpWatcher();
  assert.match(flat(watcher.helpMessages('MRs', 'x')[0].card), /\/rebase/);
  assert.equal(watcher.helpMessages('nonsense', 'x'), null);
});

test('rich mode: /help sends one card, regular mode sends the unchanged markdown', async () => {
  setRichMessages(true);
  let watcher = helpWatcher();
  let rec = recordTransport();
  try {
    await watcher.executeHelpCommand(event, []);
  } finally {
    rec.restore();
  }
  assert.equal(rec.calls.length, 1);
  const card = sentCard(rec.calls[0]);
  assert.equal(card.type, 'AdaptiveCard');
  assert.match(flat(card), /\/mrs/);

  setRichMessages(false);
  watcher = helpWatcher({ rich: false });
  rec = recordTransport();
  try {
    await watcher.executeHelpCommand(event, []);
    await watcher.executeHelpCommand(event, ['fun']);
  } finally {
    rec.restore();
  }
  assert.equal(rec.calls.length, 2);
  assert.ok(!sentBody(rec.calls[0]).includes('AdaptiveCard'));
  assert.match(sentBody(rec.calls[0]), /teams-live slash commands/);
  assert.match(sentBody(rec.calls[0]), /Target an MR by replying/);
  assert.match(sentBody(rec.calls[1]), /Fun &amp; Games|Fun & Games/);
});

test('an unknown category keeps the text answer in both modes', async () => {
  setRichMessages(true);
  const watcher = helpWatcher();
  const rec = recordTransport();
  try {
    await watcher.executeHelpCommand(event, ['nonsense']);
  } finally {
    rec.restore();
  }
  assert.equal(rec.calls.length, 1);
  assert.match(flat(sentCard(rec.calls[0])), /Unknown category/);
});

test('a command that requires a feature is only listed when the feature is there', () => {
  const category = { id: 'x', title: 'X', aliases: [], commands: ['- `/a`: A.', { text: '- `/tv ard`: Switches the TV.', requires: 'tv' }] };
  const without = buildHelpCard([category], { has: () => false });
  assert.ok(!flat(without).includes('/tv'), 'not advertised without the feature');
  // The plain text path ignores the filter only for entries without `requires`.
  assert.match(buildHelpText(null, () => true), /\/approve/);
  assert.equal(helpWatcher().hasHelpFeature('tv'), false);
  assert.equal(helpWatcher({ features: ['tv'] }).hasHelpFeature('tv'), true);
});

test('splitHelpCategories keeps the order, never cuts a domain and gives null when one cannot fit', () => {
  const cats = ['a', 'b', 'c', 'd'].map((id) => ({ id, size: 10 }));
  const fits = (list) => list.reduce((n, c) => n + c.size, 0) <= 25;
  assert.deepEqual(splitHelpCategories(cats, fits).map((g) => g.map((c) => c.id)), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(splitHelpCategories(cats, () => true).map((g) => g.length), [4]);
  assert.equal(splitHelpCategories([{ id: 'big', size: 99 }], fits), null);
  assert.deepEqual(splitHelpCategories([], fits), []);
});

test('a help too large for one card is split into cards that each fit, in order', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `c${i}`,
    title: `Domain ${i}`,
    aliases: [],
    commands: Array.from({ length: 12 }, (_, j) => `- \`/cmd${i}x${j} [arg]\`: Does thing ${j} of domain ${i} with a fairly long description that wraps over lines.`),
  }));
  const message = (list, part = null) => makeRichMessage('x', buildHelpCard(list, { part, notes: ['Tip.'] }));
  const fits = (list) => richMessageWireBytes(message(list)) <= MAX_CARD_BYTES;
  const groups = splitHelpCategories(many, fits);
  assert.ok(groups.length > 1, 'needs several cards');
  assert.deepEqual(groups.flat().map((c) => c.id), many.map((c) => c.id), 'order and completeness');
  for (const [i, g] of groups.entries()) assert.ok(richMessageWireBytes(message(g, [i + 1, groups.length])) <= MAX_CARD_BYTES, `card ${i + 1} within the limit`);
  assert.match(flat(message(groups[0], [1, groups.length]).card), /Help 1\//);
});

test('every size-budget measurement is on the wire: cards of the real catalogue are within the limit', () => {
  setRichMessages(true);
  const watcher = helpWatcher({ features: ['tv'] });
  for (const category of [null, 'gitlab', 'jira', 'ops', 'tools', 'fun', 'admin']) {
    for (const m of watcher.helpMessages(category, 'x')) assert.ok(richMessageWireBytes(m) <= MAX_CARD_BYTES, String(category));
  }
});
