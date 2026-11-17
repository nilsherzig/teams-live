import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRichMessage,
  makeRichMessage,
  makeRichMessageSequence,
  messageMarkdown,
  prepareRichMessages,
  richMessageWireBytes,
  sendReply,
  setRichMessages,
  transport,
} from '../src/teams.mjs';
import { MAX_CARD_BYTES, buildReplyCard } from '../src/cards.mjs';
import { useStubbedTransport } from './stub-transport.mjs';

// Several rich messages that belong together (a /mrs list that needs more than one card).

const CONV = '19:example@thread.v2';
const ORIGINAL = { messageId: '1700000000000', from: 'Alice Example', fromMri: '8:orgid:alice', previewText: 'status' };

const calls = useStubbedTransport(beforeEach, afterEach);
beforeEach(() => {
  setRichMessages(true);
  transport.sendMessage = async (conversationId, html, options) => {
    calls.sent.push({ conversationId, html, options });
    const n = calls.sent.length;
    return { ok: true, value: { id: `client-${n}`, messageId: `client-${n}`, timestamp: `17000000${String(n).padStart(5, '0')}` } };
  };
});
afterEach(() => setRichMessages(false));

const card = (text) => makeRichMessage(text, buildReplyCard(text, {}));
const sentCards = () => calls.sent.map((c) => JSON.stringify(c));

test('a sequence is the first message carrying the others, and still a rich message', () => {
  const [a, b, c] = ['first part', 'second part', 'third part'].map(card);
  const sequence = makeRichMessageSequence([a, b, c]);
  assert.ok(isRichMessage(sequence), 'the marker survives the spread');
  assert.equal(sequence.markdown, 'first part');
  assert.deepEqual(sequence.followUps.map((m) => m.markdown), ['second part', 'third part']);
  assert.equal(messageMarkdown(sequence), 'first part\n\nsecond part\n\nthird part', 'the regular text has every part');
});

test('a sequence of one is that message, of none is nothing, plain text is not a part', () => {
  const only = card('only');
  assert.equal(makeRichMessageSequence([only]), only);
  assert.equal(makeRichMessageSequence([]), null);
  assert.equal(makeRichMessageSequence(null), null);
  assert.equal(makeRichMessageSequence(['plain', only]), only);
});

test('prepareRichMessages turns a sequence into its cards, in order, without nesting', () => {
  const parts = ['one', 'two', 'three'].map(card);
  const prepared = prepareRichMessages(makeRichMessageSequence(parts));
  assert.equal(prepared.length, 3);
  assert.deepEqual(prepared.map((m) => m.markdown), ['one', 'two', 'three']);
  for (const message of prepared) {
    assert.ok(isRichMessage(message));
    assert.equal(message.followUps, undefined);
    assert.ok(richMessageWireBytes(message) <= MAX_CARD_BYTES);
  }
  assert.equal(prepared[1], parts[1], 'the cards are passed through unchanged');
});

test('a sequence with a card over the budget falls back to the generic cards of the whole text, nothing lost', () => {
  const sequence = makeRichMessageSequence([card('first part'), makeRichMessage('second part', { ...buildReplyCard('second part', {}), padding: 'x'.repeat(MAX_CARD_BYTES) })]);
  assert.ok(richMessageWireBytes(sequence.followUps[0]) > MAX_CARD_BYTES, 'precondition');
  const prepared = prepareRichMessages(sequence);
  assert.ok(prepared.length >= 1);
  for (const message of prepared) assert.ok(!isRichMessage(message) || richMessageWireBytes(message) <= MAX_CARD_BYTES);
  const text = prepared.map((m) => JSON.stringify(m.card ?? m)).join('\n');
  assert.ok(text.includes('first part') && text.includes('second part'));
});

test('regular mode leaves a sequence alone', () => {
  setRichMessages(false);
  const sequence = makeRichMessageSequence(['one', 'two'].map(card));
  assert.deepEqual(prepareRichMessages(sequence), [sequence]);
});

test('sendReply posts every card of a sequence, in order', async () => {
  const parts = ['first list card', 'second list card', 'third list card'].map(card);
  await sendReply(CONV, ORIGINAL, makeRichMessageSequence(parts));
  assert.equal(calls.sent.length, 3);
  const sent = sentCards();
  assert.ok(sent[0].includes('first list card'));
  assert.ok(sent[1].includes('second list card'));
  assert.ok(sent[2].includes('third list card'));
});
