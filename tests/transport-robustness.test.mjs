import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prepareRichMessages, richMessageWireBytes, sendReply, setRichMessages, transport, updateReply } from '../src/teams.mjs';
import { MAX_CARD_BYTES, splitMarkdownForCards } from '../src/cards.mjs';
import { useStubbedTransport } from './stub-transport.mjs';

const CONV = '19:example@thread.v2';
const ORIGINAL = { messageId: '1700000000000', from: 'Alice Example', fromMri: '8:orgid:alice', previewText: 'status' };
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const calls = useStubbedTransport(beforeEach, afterEach);
// Teams answers a send with a client message id and a different server id (the timestamp): edits must use the latter.
const clientId = (n) => `client-${n}`;
const serverId = (n) => `17000000${String(n).padStart(5, '0')}`;
beforeEach(() => {
  setRichMessages(true);
  transport.sendMessage = async (conversationId, html, options) => {
    calls.sent.push({ conversationId, html, options });
    const n = calls.sent.length;
    return { ok: true, value: { id: clientId(n), messageId: clientId(n), timestamp: serverId(n) } };
  };
});
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
  const sentIds = new Set(calls.sent.map((_, i) => serverId(i + 1)));
  const editedIds = calls.edited.slice(2).map((c) => c.messageId);
  assert.ok(editedIds.includes('1700000000005'));
  const overflowEdits = editedIds.filter((id) => id !== '1700000000005');
  assert.ok(overflowEdits.length > 0, 'an overflow card was edited in place');
  for (const id of overflowEdits) assert.ok(sentIds.has(id), `edit uses the server id (${id}), not the client message id`);
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

test('a message with no cardable content is never swallowed: it falls back to the regular message', () => {
  // Nothing but code fences over the budget: no card carries content, the splitter returns no part.
  const fences = '```\n'.repeat(8000);
  assert.ok(Buffer.byteLength(fences) > MAX_CARD_BYTES);
  assert.deepEqual(splitMarkdownForCards(fences, (t) => Buffer.byteLength(t) <= 1000), []);
  const prepared = prepareRichMessages(fences);
  assert.equal(prepared.length, 1);
  assert.equal(typeof prepared[0], 'string', 'a regular message, not a card');
  assert.equal(prepared[0], fences.trim());
});

test('a pathological budget yields no parts instead of looping, and the note never overflows a card', () => {
  assert.deepEqual(splitMarkdownForCards('hello\nworld', () => false), []);
  // Not one more character fits once the first card is full: the note is left out rather than overflowing it.
  const fits = (t) => Buffer.byteLength(t) <= 60;
  const parts = splitMarkdownForCards(`${'a'.repeat(59)}\nb\nc\nd`, fits, { maxParts: 1 });
  assert.ok(parts.length <= 1);
  for (const part of parts) assert.ok(fits(part), 'every part is within the budget');
});

test('when no card can be built, sendReply still posts and updateReply keeps the existing content', async () => {
  const fences = '```\n'.repeat(8000);
  const sent = await sendReply(CONV, ORIGINAL, fences);
  assert.ok(sent && sent.ok, 'sendReply returns a result, not null');
  assert.equal(calls.sent.length, 1);

  const updated = await updateReply(CONV, '1700000000007', ORIGINAL, fences);
  assert.ok(updated.ok);
  assert.equal(calls.edited.length, 1);
  // Edited to the regular message, not wiped to an empty body (the reply quote only).
  assert.match(calls.edited[0].html, /<pre>/);
  assert.ok(calls.edited[0].html.length > 500);
});
