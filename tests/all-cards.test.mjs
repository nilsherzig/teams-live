import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  editOriginalMessage,
  isRichMessage,
  makeRichMessage,
  prepareRichMessages,
  richMessageWireBytes,
  sendDirectMessage,
  sendReply,
  setRichMessages,
  transport,
  updateReply,
} from '../src/teams.mjs';
import fs from 'node:fs';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { MAX_CARD_BYTES, buildMarkdownCard, buildReplyCard, splitMarkdownForCards } from '../src/cards.mjs';

const CARD_TAG = 'itemtype="http://schema.skype.com/InputExtension"';
const CONV = '19:example@thread.v2';
const CHANNEL = '19:example@thread.tacv2';
const ORIGINAL = { messageId: '1700000000000', from: 'Alice Example', fromMri: '8:orgid:alice', previewText: 'status' };

let original;
let calls;
beforeEach(() => {
  setRichMessages(true);
  original = { ...transport };
  calls = [];
  const record = (kind) => (...args) => {
    calls.push({ kind, args });
    return Promise.resolve({ ok: true, value: { messageId: `17000000001${calls.length}`, timestamp: `17000000001${calls.length}` } });
  };
  transport.sendMessage = record('send');
  transport.editMessage = record('edit');
});
afterEach(() => {
  Object.assign(transport, original);
  setRichMessages(false);
});

const optionsOf = (call) => call.args.at(-1);
const htmlOf = (call) => (call.kind === 'edit' ? call.args[2] : call.args[1]);
const cardsOf = (call) => JSON.parse(optionsOf(call).properties.cards);
const cardText = (call) => JSON.stringify(cardsOf(call)[0].content);

const STATUS = [
  '**teams-live** status',
  '',
  '- 🟢 Teams connection: connected',
  '- Uptime: 3h 2m',
  '- Watched MRs: 4',
].join('\n');

test('rich off: every message stays the regular markdown, untouched', async () => {
  setRichMessages(false);
  assert.deepEqual(prepareRichMessages(STATUS), [STATUS]);
  await sendDirectMessage(CONV, STATUS);
  await sendReply(CONV, ORIGINAL, 'ok');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(!htmlOf(call).includes(CARD_TAG));
    assert.equal(optionsOf(call).properties.cards, '[]');
  }
});

test('rich on: status, help, error, acknowledgement and plain replies all become cards', async () => {
  const texts = [
    STATUS,
    '**Commands**\n\n- `/mrs` - list merge requests\n- `/whois <name>` - look someone up',
    '❌ Could not reach GitLab.',
    '⚠️ Rate limited, retrying later.',
    '✅ Done.',
    'Just a plain sentence without any structure.',
  ];
  for (const text of texts) {
    await sendDirectMessage(CONV, text);
    await sendReply(CONV, ORIGINAL, text);
  }
  assert.equal(calls.length, texts.length * 2);
  for (const call of calls) {
    assert.ok(htmlOf(call).includes(CARD_TAG), htmlOf(call));
    const cards = cardsOf(call);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].content.type, 'AdaptiveCard');
    assert.equal(optionsOf(call).properties.mentions, '[]');
  }
  // Tone and content survive: the error is an attention card that still says what happened.
  const error = calls[4];
  assert.match(cardText(error), /Could not reach GitLab/);
  assert.match(cardText(error), /attention/);
  // Status keeps its bullets as text.
  assert.match(cardText(calls[0]), /Uptime/);
  assert.match(cardText(calls[0]), /Watched MRs/);
});

test('rich on: mentions become names in the card, without a notification', async () => {
  const text = '👥 **Reviewers**\n\n- @[Alice Example](8:orgid:alice) approved\n- @[Bob Example](8:orgid:bob#contact) pending';
  await sendReply(CONV, ORIGINAL, text);
  const [call] = calls;
  assert.equal(optionsOf(call).properties.mentions, '[]');
  const body = cardText(call);
  assert.match(body, /Alice Example/);
  assert.match(body, /Bob Example/);
  assert.ok(!body.includes('8:orgid'));
  assert.ok(!body.includes('@['));
});

test('rich on: an entity card that fits is passed through, never wrapped twice', async () => {
  const card = { type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text: 'Entity card' }] };
  const rich = makeRichMessage('**Entity**', card);
  const prepared = prepareRichMessages(rich);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0], rich);
  await sendDirectMessage(CONV, rich);
  assert.deepEqual(cardsOf(calls[0])[0].content.body, card.body);
});

test('rich on: an entity card that is too large becomes generic cards of its markdown', () => {
  const lines = Array.from({ length: 800 }, (_, i) => `- row ${i}: ${'x'.repeat(40)}`);
  const big = makeRichMessage(`**Big**\n\n${lines.join('\n')}`, {
    type: 'AdaptiveCard',
    version: '1.4',
    body: [{ type: 'TextBlock', text: 'y'.repeat(MAX_CARD_BYTES) }],
  });
  const parts = prepareRichMessages(big);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(isRichMessage(part));
    assert.ok(richMessageWireBytes(part) <= MAX_CARD_BYTES);
  }
});

test('oversized text is split into ordered cards, each within the wire limit, keeping every row', async () => {
  const rows = Array.from({ length: 400 }, (_, i) => `- row ${String(i).padStart(3, '0')} ${'z'.repeat(60)}`);
  const text = `**Long list**\n\n${rows.join('\n')}`;
  const parts = prepareRichMessages(text);
  assert.ok(parts.length >= 2 && parts.length <= 10, `parts: ${parts.length}`);
  for (const part of parts) assert.ok(richMessageWireBytes(part) <= MAX_CARD_BYTES);

  await sendReply(CONV, ORIGINAL, text);
  assert.equal(calls.length, parts.length);
  const joined = calls.map(cardText).join('\n');
  for (let i = 0; i < 400; i += 37) assert.ok(joined.includes(`row ${String(i).padStart(3, '0')}`), `row ${i}`);
  // Order: first card's rows precede the last card's rows.
  assert.ok(joined.indexOf('row 000') < joined.indexOf('row 399'));
  // Every part is a quote-reply to the same original (chat), numbered "i/n" in its header.
  calls.forEach((call, i) => {
    assert.equal(JSON.parse(optionsOf(call).properties.qtdMsgs)[0].messageId, Number(ORIGINAL.messageId));
    assert.match(cardText(call), new RegExp(`${i + 1}/${parts.length}`));
  });
});

test('split parts of a channel reply stay in the same thread', async () => {
  const text = Array.from({ length: 500 }, (_, i) => `- item ${i} ${'q'.repeat(60)}`).join('\n');
  await sendReply(CHANNEL, ORIGINAL, text);
  assert.ok(calls.length >= 2);
  for (const call of calls) assert.ok(JSON.stringify(call.args).includes(ORIGINAL.messageId));
});

test('updateReply edits the first card in place and sends the rest as new replies', async () => {
  const text = Array.from({ length: 500 }, (_, i) => `- item ${i} ${'q'.repeat(60)}`).join('\n');
  await updateReply(CONV, '1700000000005', ORIGINAL, text);
  assert.equal(calls[0].kind, 'edit');
  assert.ok(calls.length >= 2);
  assert.ok(calls.slice(1).every((call) => call.kind === 'send'));
});

test('editOriginalMessage: a card when it fits, regular text when it would need several cards', async () => {
  await editOriginalMessage(CONV, '1700000000000', 'https://example.com/x', STATUS);
  assert.ok(htmlOf(calls[0]).includes(CARD_TAG));
  assert.ok(htmlOf(calls[0]).includes('https://example.com/x'));

  const huge = Array.from({ length: 500 }, (_, i) => `- item ${i} ${'q'.repeat(60)}`).join('\n');
  await editOriginalMessage(CONV, '1700000000000', 'https://example.com/x', huge);
  assert.equal(calls.length, 2);
  assert.ok(!htmlOf(calls[1]).includes(CARD_TAG));
  assert.equal(optionsOf(calls[1]).properties.cards, '[]');
});

test('fenced code blocks render as monospace lines and are closed and reopened across a split', () => {
  const code = Array.from({ length: 700 }, (_, i) => `line ${i} ${'c'.repeat(40)}`);
  const text = `Output:\n\n\`\`\`\n${code.join('\n')}\n\`\`\``;
  const texts = splitMarkdownForCards(text, (t) => richMessageWireBytes(makeRichMessage(t, buildReplyCard(t, { part: [2, 2] }))) <= MAX_CARD_BYTES);
  assert.ok(texts.length >= 2);
  for (const part of texts) assert.equal((part.match(/```/g) || []).length % 2, 0, 'fences balanced');
  const single = buildReplyCard('```\nfoo  bar\n```');
  assert.match(JSON.stringify(single), /Monospace/);
});

test('output beyond the card limit is truncated with an explicit note', () => {
  const huge = Array.from({ length: 20000 }, (_, i) => `- row ${i} ${'w'.repeat(60)}`).join('\n');
  const parts = prepareRichMessages(huge);
  assert.ok(parts.length <= 11);
  assert.match(JSON.stringify(parts.at(-1)), /truncated/);
});

test('buildReplyCard is never null for text and keeps text-only replies', () => {
  assert.ok(buildReplyCard('plain'));
  assert.equal(buildMarkdownCard('plain no bullets'), null);
  assert.match(JSON.stringify(buildReplyCard('plain no bullets')), /plain no bullets/);
});

test('when Teams rejects a card the plain markdown is sent as a last resort', async () => {
  let attempts = 0;
  transport.sendMessage = (...args) => {
    attempts += 1;
    calls.push({ kind: 'send', args });
    return Promise.resolve(attempts === 1 ? { ok: false, error: { message: 'card rejected' } } : { ok: true, value: { messageId: '1', timestamp: '1' } });
  };
  const warn = console.warn;
  const error = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    const result = await sendDirectMessage(CONV, 'Hello **world**');
    assert.equal(result.ok, true);
  } finally {
    console.warn = warn;
    console.error = error;
  }
  assert.equal(calls.length, 2);
  assert.ok(htmlOf(calls[0]).includes(CARD_TAG));
  assert.ok(!htmlOf(calls[1]).includes(CARD_TAG));
});

// Regression matrix: every message the watcher itself originates (admin and
// auth notices, token lifecycle, startup) reaches the wire as a card.
function matrixWatcher(gitlab = {}) {
  const watcher = new MergeRequestWatcher({
    config: { conversations: [{ id: '48:notes', name: 'Notes' }], gitlab: {}, teams: { rich_messages: true } },
    gitlab,
  });
  watcher.saveState = () => {};
  watcher.setCommandReaction = async () => {};
  return watcher;
}

function assertEveryCallIsACard(label) {
  assert.ok(calls.length > 0, `${label}: something was sent`);
  for (const call of calls) {
    assert.ok(htmlOf(call).includes(CARD_TAG), `${label}: ${call.kind} carries the card reference`);
    const cards = cardsOf(call);
    assert.equal(cards.length, 1, `${label}: exactly one card per message`);
    assert.equal(cards[0].contentType, 'application/vnd.microsoft.card.adaptive');
    assert.ok([undefined, '[]'].includes(optionsOf(call).properties.mentions), `${label}: no mention metadata`);
  }
}

test('matrix: admin auth expired and restored notices are cards', async () => {
  const watcher = matrixWatcher();
  await watcher.notifyAdminAuthExpired('Jira', 'HTTP 401');
  assertEveryCallIsACard('auth expired');
  assert.match(cardText(calls[0]), /Authentication Expired/);
  calls.length = 0;
  await watcher.notifyAdminAuthRecovered('Jira');
  assertEveryCallIsACard('auth restored');
});

test('matrix: GitLab token lifecycle notices are cards (auto-renew, warning, reaction result)', async () => {
  const inDays = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const renewal = { rotated: { token: 'x', expires_at: '2027-01-01' }, savedPath: '/example/gitlab-token', isReadOnlySecret: true };

  let watcher = matrixWatcher({ token: 't', getTokenInfo: async () => ({ expires_at: inDays(2) }) });
  watcher.renewGitLabToken = async () => renewal;
  await watcher.checkGitLabTokenExpiryAndAutoRenew();
  assertEveryCallIsACard('auto-renew notice');

  calls.length = 0;
  watcher = matrixWatcher({ token: 't', getTokenInfo: async () => ({ expires_at: inDays(7) }) });
  await watcher.checkGitLabTokenExpiryAndAutoRenew();
  assertEveryCallIsACard('expiry warning');
  assert.match(cardText(calls[0]), /Expiry Warning/);

  calls.length = 0;
  watcher.pendingTokenRenewalMessageIds.add('1987654321');
  watcher.selfOid = 'f94ccd0d-d140-4d1d-9fee-b00e642b9c11';
  watcher.renewGitLabToken = async () => renewal;
  watcher.getMessage = async () => ({
    ok: true,
    value: { id: '1987654321', reactions: [{ key: 'like', user: { mri: '8:orgid:f94ccd0d-d140-4d1d-9fee-b00e642b9c11' } }] },
  });
  await watcher.handleTokenRenewalReaction({ conversationId: '48:notes', messageId: '1987654321' });
  assertEveryCallIsACard('reaction result');
});

test('matrix: a token renewal reaction only acts on a message the watcher itself recorded', async () => {
  const watcher = matrixWatcher({ token: 't' });
  let renewed = 0;
  watcher.renewGitLabToken = async () => {
    renewed += 1;
    return { rotated: {}, savedPath: '/example', isReadOnlySecret: true };
  };
  watcher.selfOid = 'f94ccd0d-d140-4d1d-9fee-b00e642b9c11';
  watcher.getMessage = async () => ({
    ok: true,
    value: { reactions: [{ key: 'like', user: { mri: '8:orgid:f94ccd0d-d140-4d1d-9fee-b00e642b9c11' } }] },
  });
  await watcher.handleTokenRenewalReaction({ conversationId: '48:notes', messageId: '1700000000999' });
  await watcher.handleMessageUpdate({ kind: 'MessageUpdate', conversationId: '48:notes', messageId: '1700000000999' });
  assert.equal(renewed, 0, 'a thumbs up on any other message never rotates the token');
  assert.equal(calls.length, 0);
});

test('matrix: nothing outside teams.mjs imports the raw Teams send or edit functions', () => {
  const offenders = [];
  for (const name of fs.readdirSync(new URL('../src/', import.meta.url))) {
    if (!name.endsWith('.mjs') || name === 'teams.mjs') continue;
    const text = fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
    if (/chatsvc-messaging/.test(text) && /\b(sendMessage|editMessage)\b/.test(text)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});
