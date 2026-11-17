import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeRichMessage, richMessageWireBytes, setRichMessages, transport } from '../src/teams.mjs';
import { MAX_CARD_BYTES } from '../src/cards.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { AvatarService } from '../src/avatars.mjs';

// Watcher wiring of profile pictures. All people, images and URLs are generic fakes.

beforeEach(() => setRichMessages(false));

const ALICE = '8:orgid:00000000-0000-4000-8000-00000000000a';
const BOB = '8:orgid:00000000-0000-4000-8000-00000000000b';
const CONV = '19:example@thread.v2';

function fakeJpeg(extra = 0) {
  const head = [
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 32, 0, 32, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9,
  ];
  return Uint8Array.from([...head, ...new Array(8 + extra).fill(7)]);
}

const directory = {
  users: new Map([
    [ALICE, { displayName: 'Alice Example', mri: ALICE }],
    [BOB, { displayName: 'Bob Example', mri: BOB }],
  ]),
};

function richWatcher(teams = { rich_messages: true }, { extra = 0, fetched = [] } = {}) {
  const watcher = new MergeRequestWatcher({
    config: { conversations: [], gitlab: {}, teams },
    gitlab: {
      findMrLinks: () => [],
      mrLink: (project, iid) => `https://gitlab.example.com/${project}/-/merge_requests/${iid}`,
    },
    jira: null,
    opsgenie: null,
  });
  watcher.saveState = () => {};
  if (watcher.avatarService) {
    watcher.avatarService = new AvatarService({
      directory,
      fetchPhoto: async (mri) => (fetched.push(mri), { kind: 'photo', bytes: fakeJpeg(extra) }),
    });
  }
  return watcher;
}

const personImages = (card) => {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Image' && node.style === 'Person') found.push(node);
    Object.values(node).forEach(walk);
  };
  walk(card);
  return found;
};

const jiraIssue = {
  key: 'EX-1',
  summary: 'Something is broken',
  url: 'https://jira.example.com/browse/EX-1',
  issueType: 'Bug',
  status: 'Open',
  statusCategory: 'new',
  priority: 'High',
  assignee: 'Alice Example',
};

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

test('regular mode creates no avatar service and makes no photo request', async () => {
  const fetched = [];
  const watcher = richWatcher({}, { fetched });
  assert.equal(watcher.avatarService, null);
  await watcher.prefetchAvatars(jiraIssue);
  assert.deepEqual(watcher.cardAvatars(jiraIssue), {});
  assert.deepEqual(fetched, []);
});

test('Jira handler embeds the assignee picture in rich mode, fetching it once', async () => {
  const fetched = [];
  const watcher = richWatcher(undefined, { fetched });
  const entry = { conversationId: CONV, messageId: '1700000000000', from: 'Bob Example', previewText: 'x' };
  const rec = recordTransport();
  try {
    await watcher.handleJiraIssueComment(entry, { key: 'EX-1' }, jiraIssue);
    await watcher.handleJiraIssueComment(entry, { key: 'EX-1' }, jiraIssue);
  } finally {
    rec.restore();
  }
  assert.deepEqual(fetched, [ALICE], 'second card is served from the cache');
  for (const call of rec.calls) {
    const images = personImages(sentCard(call));
    assert.equal(images.length, 1);
    assert.equal(images[0].altText, 'Alice Example');
    assert.match(images[0].url, /^data:image\/jpeg;base64,/);
  }
});

test('an unknown or failing lookup leaves the card with names only', async () => {
  const watcher = richWatcher();
  watcher.avatarService = new AvatarService({
    directory,
    fetchPhoto: async () => {
      throw new Error('status 403');
    },
  });
  const entry = { conversationId: CONV, messageId: '1700000000000', from: 'Bob Example', previewText: 'x' };
  const rec = recordTransport();
  try {
    await watcher.handleJiraIssueComment(entry, { key: 'EX-1' }, jiraIssue);
    await watcher.handleJiraIssueComment(entry, { key: 'EX-2' }, { ...jiraIssue, assignee: 'Zed Unknown' });
  } finally {
    rec.restore();
  }
  assert.equal(rec.calls.length, 2);
  for (const call of rec.calls) assert.equal(personImages(sentCard(call)).length, 0);
});

test('MR cards show the pictures of the approvers once they are prefetched', async () => {
  const fetched = [];
  const watcher = richWatcher(undefined, { fetched });
  const mr = { project: 'group/app', iid: 7, title: 'Example' };
  const details = { title: 'Example', approved: true, approvedBy: ['Alice Example', 'Bob Example'] };
  assert.equal(personImages(watcher.buildMrCard(mr, details)).length, 0, 'building never fetches');
  assert.deepEqual(fetched, []);
  await watcher.prefetchAvatars(watcher.mrCardPeopleData(mr, details));
  assert.deepEqual(fetched.sort(), [ALICE, BOB]);
  const names = personImages(watcher.buildMrCard(mr, details)).map((i) => i.altText);
  assert.deepEqual(names, ['Alice Example', 'Bob Example']);
});

test('MR merged and closed cards fall back to the last reported approvers', async () => {
  const watcher = richWatcher();
  const mr = { project: 'group/app', iid: 7, title: 'Example', lastReportedApprovalStatus: true, lastReportedApprovedBy: 'Alice Example' };
  await watcher.prefetchAvatars(watcher.mrCardPeopleData(mr, {}));
  const card = watcher.buildMrCard(mr, { title: 'Example' }, { state: 'merged' });
  assert.deepEqual(personImages(card).map((i) => i.altText), ['Alice Example']);
});

test('a card that would outgrow the wire budget with pictures is rebuilt without them', async () => {
  const watcher = richWatcher(undefined, { extra: 5000 });
  await watcher.prefetchAvatars(jiraIssue);
  const markdown = 'Example';
  const build = (pad) => () => {
    const avatars = watcher.cardAvatars(jiraIssue);
    const body = [{ type: 'TextBlock', text: 'x'.repeat(pad) }];
    for (const [name, url] of Object.entries(avatars)) body.push({ type: 'Image', url, altText: name, style: 'Person' });
    return { type: 'AdaptiveCard', version: '1.4', body };
  };
  const plainCard = (pad) => ({ type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text: 'x'.repeat(pad) }] });
  const base = richMessageWireBytes(makeRichMessage(markdown, plainCard(0)));
  // Without the picture it fits with a little room to spare; with it it does not.
  const pad = MAX_CARD_BYTES - base - 200;
  const withoutPicture = richMessageWireBytes(makeRichMessage(markdown, plainCard(pad)));
  assert.ok(withoutPicture <= MAX_CARD_BYTES);
  assert.ok(richMessageWireBytes(makeRichMessage(markdown, build(pad)())) > MAX_CARD_BYTES, 'precondition: picture overflows');

  const message = watcher.richMessage(markdown, build(pad));
  assert.notEqual(message, markdown, 'still a card, not the plain markdown');
  assert.ok(richMessageWireBytes(message) <= MAX_CARD_BYTES);
  assert.ok(!JSON.stringify(message).includes('data:image'), 'no picture in the fallback card');
  assert.equal(watcher.suppressAvatars, false, 'the switch is reset');
  assert.equal(Object.keys(watcher.cardAvatars(jiraIssue)).length, 1, 'later cards get their pictures again');
});
