import test from 'node:test';
import assert from 'node:assert/strict';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { stubDirectoryLookups } from './stub-transport.mjs';

// Which merge request a slash command is about when it is sent right after a merge request message:
// the card (the posted link edited by the bot) must count, not be skipped as the bot's own message.

const CONV = '19:test@thread.v2';

function watcherWith(messages) {
  const watcher = new MergeRequestWatcher({
    config: { conversations: [], gitlab: { group: 'group' }, teams: {} },
    gitlab: {
      findMrLinks: (text) => [...String(text).matchAll(/group\/(app)\/-\/merge_requests\/(\d+)/g)].map((m) => ({ project: `group/${m[1]}`, iid: Number(m[2]) })),
      mrLink: (project, iid) => `https://gitlab.example.com/${project}/-/merge_requests/${iid}`,
    },
    jira: null,
    opsgenie: null,
  });
  watcher.saveState = () => {};
  watcher.threadMessages = async () => ({ ok: true, value: { messages } });
  watcher.watched.set('card', { conversationId: CONV, messageId: '300', status: 'pending', mrs: [{ project: 'group/app', iid: 2062, title: 'Newer' }] });
  return stubDirectoryLookups(watcher);
}

const THREAD = [
  { id: '100', content: 'https://gitlab.example.com/group/app/-/merge_requests/8', sender: { mri: '8:orgid:other' } },
  // The posted link, edited into its card by the bot: carries the watermark, has no link in its text.
  { id: '300', content: 'status card', sender: { mri: '8:orgid:me' } },
  { id: '301', content: '/rebase', sender: { mri: '8:orgid:me' } },
];

test('a command right after a watched merge request card targets that merge request, not an older one', async () => {
  const watcher = watcherWith(THREAD);
  watcher.isOwnMessage = (mri, text, id) => String(id) === '300';
  const found = await watcher.findTargetMrsForCommand({ conversationId: CONV, messageId: '301', rawHtml: '', links: [] }, []);
  assert.deepEqual(found.map((m) => `${m.project}!${m.iid}`), ['group/app!2062']);
  assert.equal(found.source, 'preceding');
  assert.equal(found.isDirectReply, true);
});

test('quoting a watched card targets its merge request', async () => {
  const watcher = watcherWith([]);
  const found = await watcher.findTargetMrsForCommand({ conversationId: CONV, messageId: '301', rawHtml: '<blockquote itemid="300">card</blockquote>', links: [] }, []);
  assert.deepEqual(found.map((m) => `${m.project}!${m.iid}`), ['group/app!2062']);
  assert.equal(found.source, 'quote');
});

test('without a watched card, the older merge request message is still found', async () => {
  const watcher = watcherWith(THREAD);
  watcher.watched.clear();
  watcher.isOwnMessage = (mri, text, id) => String(id) === '300';
  const found = await watcher.findTargetMrsForCommand({ conversationId: CONV, messageId: '301', rawHtml: '', links: [] }, []);
  assert.deepEqual(found.map((m) => `${m.project}!${m.iid}`), ['group/app!8']);
});
