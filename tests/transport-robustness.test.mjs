import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prepareRichMessages, richMessageWireBytes, setRichMessages, updateReply } from '../src/teams.mjs';
import { MAX_CARD_BYTES, splitMarkdownForCards } from '../src/cards.mjs';
import { useStubbedTransport } from './stub-transport.mjs';

const CONV = '19:example@thread.v2';
const ORIGINAL = { messageId: '1700000000000', from: 'Alice Example', fromMri: '8:orgid:alice', previewText: 'status' };
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const calls = useStubbedTransport(beforeEach, afterEach);
beforeEach(() => setRichMessages(true));
afterEach(() => setRichMessages(false));

const rows = (count, width, prefix = 'row') => Array.from({ length: count }, (_, i) => `- ${prefix} ${i} ${'w'.repeat(width)}`).join('\n');

test('every card of a truncated output stays within the byte budget, note included', () => {
  // Several line widths so that the truncation note lands at different distances from the limit.
  for (const width of [40, 57, 58, 59, 63, 90]) {
    const parts = prepareRichMessages(rows(7000, width));
    assert.ok(parts.length <= 10, `width ${width}: at most 10 cards`);
    assert.match(JSON.stringify(parts.at(-1)), /Output truncated/);
    for (const [i, part] of parts.entries()) {
      assert.ok(richMessageWireBytes(part) <= MAX_CARD_BYTES, `width ${width}: card ${i + 1} is ${richMessageWireBytes(part)}B`);
    }
  }
});

test('splitting measures a number of cards proportional to the output kept, not to the input', () => {
  let measured = 0;
  const fits = (text) => {
    measured += 1;
    return text.length <= 2000;
  };
  const parts = splitMarkdownForCards(rows(50000, 30), fits);
  assert.equal(parts.length, 10);
  assert.ok(measured < 1000, `${measured} measurements`);
  for (const part of parts) assert.ok(part.length <= 2000);
  assert.match(parts.at(-1), /Output truncated: \d+ more lines not shown/);
});

test('a line too long for a card is cut without splitting a surrogate pair, and nothing is lost', () => {
  const line = '😀'.repeat(900) + 'é'.repeat(300) + '👩‍👩‍👧'.repeat(100);
  for (const limit of [101, 200, 333, 500]) {
    const parts = splitMarkdownForCards(line, (t) => t.length <= limit, { maxParts: 1000 });
    assert.ok(parts.length > 1);
    for (const part of parts) {
      assert.ok(part.length <= limit);
      assert.ok(!LONE_SURROGATE.test(part), `limit ${limit}: no lone surrogate`);
    }
    assert.equal(parts.join(''), line);
  }
});

test('the last card is cut to leave room for the truncation note', () => {
  const limit = 400;
  const parts = splitMarkdownForCards(rows(500, 20), (t) => t.length <= limit, { maxParts: 3 });
  assert.equal(parts.length, 3);
  for (const part of parts) assert.ok(part.length <= limit, `${part.length} chars`);
  assert.match(parts.at(-1), /Output truncated/);
});

test('text that fits is returned whole, in order', () => {
  const text = rows(30, 10);
  const parts = splitMarkdownForCards(text, (t) => t.length <= 300, { maxParts: 100 });
  assert.ok(parts.length > 1);
  assert.equal(parts.join('\n').replace(/\n\n/g, '\n'), text.replace(/\n\n/g, '\n'));
});

test('repeated edits update the overflow cards in place instead of reposting them', async () => {
  const text = rows(500, 60);
  await updateReply(CONV, '1700000000005', ORIGINAL, text);
  const overflow = calls.sent.length;
  assert.ok(overflow >= 1);
  assert.equal(calls.edited.length, 1);

  // Same text: the first card is edited again, the unchanged overflow cards are left alone.
  await updateReply(CONV, '1700000000005', ORIGINAL, text);
  assert.equal(calls.sent.length, overflow);
  assert.equal(calls.edited.length, 2);

  // Changed text: the changed overflow cards are edited in place, nothing is posted again.
  await updateReply(CONV, '1700000000005', ORIGINAL, `${text}\n- extra row`);
  assert.equal(calls.sent.length, overflow);
  const sentIds = new Set(calls.sent.map((_, i) => `18000000000${i + 1}`));
  const editedIds = calls.edited.slice(2).map((c) => c.messageId);
  assert.ok(editedIds.includes('1700000000005'));
  assert.ok(editedIds.some((id) => sentIds.has(id)), 'an overflow card was edited in place');
});

test('a longer text only posts the additional overflow cards', async () => {
  await updateReply(CONV, '1700000000006', ORIGINAL, rows(400, 60));
  const before = calls.sent.length;
  await updateReply(CONV, '1700000000006', ORIGINAL, rows(900, 60));
  assert.ok(calls.sent.length > before);
  assert.ok(calls.sent.length - before < before + 5);
  const total = prepareRichMessages(rows(900, 60)).length - 1;
  assert.equal(calls.sent.length, total);
});
