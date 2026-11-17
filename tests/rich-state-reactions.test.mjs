import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { STATUS_REACTIONS } from '../src/teams.mjs';
import { useStubbedTransport } from './stub-transport.mjs';

// Nothing in this file may reach a real Teams account.
const calls = useStubbedTransport(beforeEach, afterEach);

const CONV = '19:team@thread.v2';
const MSG = '1690000000010';

function newWatcher(teams = {}) {
  return new MergeRequestWatcher({ config: { conversations: [{ id: CONV, name: 'team' }], gitlab: {}, teams }, gitlab: {} });
}
const entryWith = (status = null, extra = {}) => ({ conversationId: CONV, messageId: MSG, status, ...extra });
const reactions = () => calls.reactions;

test('plain mode: a status change still adds the new and removes the old state reaction', async () => {
  const watcher = newWatcher();
  const entry = entryWith('pending');
  await watcher.setReactionStatus(entry, 'merged');
  assert.deepEqual(reactions().map((r) => [r.op, r.key]), [['add', STATUS_REACTIONS.merged], ['remove', STATUS_REACTIONS.pending]]);
  assert.equal(entry.status, 'merged');
  assert.equal(watcher.isBotReaction(MSG, STATUS_REACTIONS.merged), true);
});

test('rich mode: no state reaction is added or removed, the status is still tracked', async () => {
  const watcher = newWatcher({ rich_messages: true });
  const entry = entryWith(null);
  for (const status of ['pending', 'approved', 'failed', 'merged', 'closed', null]) {
    await watcher.setReactionStatus(entry, status);
    assert.equal(entry.status, status);
  }
  assert.deepEqual(reactions(), []);
  assert.equal(watcher.botPlacedReactions.size, 0);
});

test('rich mode: a thumbs up on an approved entry is the user\'s, not the bot\'s', async () => {
  const rich = newWatcher({ rich_messages: true });
  rich.watched.set(`${CONV}/${MSG}`, entryWith('approved'));
  assert.equal(rich.isBotReaction(MSG, 'like'), false);
  const plain = newWatcher();
  plain.watched.set(`${CONV}/${MSG}`, entryWith('approved'));
  assert.equal(plain.isBotReaction(MSG, 'like'), true);
});

test('rich mode: a pending reaction restored from an earlier plain run is retired once', async () => {
  const watcher = newWatcher({ rich_messages: true });
  watcher.recordBotReaction(MSG, STATUS_REACTIONS.pending);
  const entry = entryWith('pending');
  await watcher.setReactionStatus(entry, 'merged');
  assert.deepEqual(reactions().map((r) => [r.op, r.key]), [['remove', STATUS_REACTIONS.pending]]);
  assert.equal(watcher.botPlacedReactions.size, 0);
  await watcher.setReactionStatus(entry, null);
  assert.equal(reactions().length, 1, 'nothing more to retire');
});

test('rich mode: a tracked thumbs up is forgotten, never removed (it may be the user\'s own)', async () => {
  const watcher = newWatcher({ rich_messages: true });
  watcher.recordBotReaction(MSG, STATUS_REACTIONS.approved);
  await watcher.setReactionStatus(entryWith('approved'), 'merged');
  assert.deepEqual(reactions(), []);
  assert.equal(watcher.botPlacedReactions.size, 0);
});

test('rich mode: an untracked reaction is never touched', async () => {
  const watcher = newWatcher({ rich_messages: true });
  await watcher.setReactionStatus(entryWith('merged'), 'closed');
  assert.deepEqual(reactions(), []);
});

test('dropPendingReaction: plain removes it, rich only a tracked leftover', async () => {
  const plain = newWatcher();
  await plain.dropPendingReaction(entryWith('pending'));
  assert.deepEqual(reactions().map((r) => [r.op, r.key]), [['remove', STATUS_REACTIONS.pending]]);

  reactions().length = 0;
  const rich = newWatcher({ rich_messages: true });
  await rich.dropPendingReaction(entryWith('pending'));
  assert.deepEqual(reactions(), []);
  rich.recordBotReaction(MSG, STATUS_REACTIONS.pending);
  await rich.dropPendingReaction(entryWith('pending'));
  assert.deepEqual(reactions().map((r) => [r.op, r.key]), [['remove', STATUS_REACTIONS.pending]]);
});

test('restoring saved state: rich mode never records a thumbs up as the bot\'s, but keeps leftovers of the other states', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-rx-'));
  try {
    const file = path.join(dir, 'watcher-state.json');
    const now = Date.now();
    const saved = (status, id) => [`${CONV}/${id}`, { conversationId: CONV, messageId: id, status, createdAt: now }];
    fs.writeFileSync(file, JSON.stringify({ entries: Object.fromEntries([saved('approved', 'm1'), saved('pending', 'm2')]) }));
    for (const [rich, likeIsBot] of [[true, false], [false, true]]) {
      const watcher = newWatcher(rich ? { rich_messages: true } : {});
      watcher.botPlacedReactions.clear();
      watcher.watched.clear();
      watcher.stateFile = file;
      watcher.loadState();
      assert.equal(watcher.isBotReaction('m1', 'like'), likeIsBot, `rich=${rich}: like on an approved entry`);
      assert.equal(watcher.botPlacedReactions.has(`m2:${STATUS_REACTIONS.pending}`) || [...watcher.botPlacedReactions.keys()].some((k) => String(k).includes('m2')), true, `rich=${rich}: pending leftover tracked`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
