import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isRichMessage, messageMarkdown, prepareRichMessages, richMessageWireBytes, setRichMessages } from '../src/teams.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { MAX_CARD_BYTES } from '../src/cards.mjs';
import { AvatarService } from '../src/avatars.mjs';
import { PLACEHOLDER_AVATAR } from '../src/placeholder-avatar.mjs';
import { fallbackAvatar } from '../src/card-user-row.mjs';

// A picture a person without a photo gets: their initials (or the silhouette for a name that cannot be drawn).
const isFallback = (image) => image.url === PLACEHOLDER_AVATAR || image.url === fallbackAvatar(image.altText);
import { CI_STATUS_ICONS } from '../src/ci-icons.mjs';

// Author pictures on the /mrs list card. All people, images and URLs are generic fakes.

beforeEach(() => setRichMessages(false));

const GL = 'https://gitlab.example.com/example-group';
const ALICE = '8:orgid:00000000-0000-4000-8000-00000000000a';
const BOB = '8:orgid:00000000-0000-4000-8000-00000000000b';

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

function newWatcher({ teams = { rich_messages: true }, extra = 0, extraFor = null, fetched = [], photo = true, sizes = [] } = {}) {
  const watcher = new MergeRequestWatcher({
    config: { conversations: [], gitlab: { group: 'example-group', notify: {} }, teams },
    gitlab: { findMrLinks: () => [], mrLink: () => '', pipelineLink: () => '', getMr: async () => null },
    jira: null,
    opsgenie: null,
  });
  watcher.saveState = () => {};
  watcher.userDirectory.formatMention = (a) => `@[${a?.name || 'unknown'}](8:orgid:0000)`;
  watcher.userDirectory.resolveUser = async () => null;
  if (watcher.avatarService) {
    watcher.avatarService = new AvatarService({
      directory,
      fetchPhoto: async (mri, size) => {
        fetched.push(mri);
        sizes.push(size);
        return photo ? { kind: 'photo', bytes: fakeJpeg(extraFor ? extraFor(mri) : extra) } : { kind: 'none' };
      },
    });
  }
  return watcher;
}

const mr = (iid, author, title = `Example change ${iid}`, extra = {}) => ({
  iid,
  title,
  web_url: `${GL}/app/-/merge_requests/${iid}`,
  references: { full: `example-group/app!${iid}` },
  author,
  draft: false,
  state: 'opened',
  head_pipeline: { status: 'success' },
  approval_summary: { known: true, approved: false, approvedBy: [] },
  ...extra,
});

const ALICE_GL = { name: 'Alice Example', username: 'alice' };
const BOB_GL = { name: 'Bob Example', username: 'bob' };

const cardOf = (message) => message.card;
const personsIn = (message) => {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Image' && node.style === 'Person') found.push(node);
    Object.values(node).forEach(walk);
  };
  walk(cardOf(message));
  return found;
};
// Real photos only; the neutral placeholder of authors without a photo is counted apart.
const photosIn = (message) => personsIn(message).filter((i) => !isFallback(i));
const placeholdersIn = (message) => personsIn(message).filter((i) => isFallback(i));
// The same list as the service-less (no picture at all) card.
const noPictures = (mrs) => {
  const w = newWatcher({ photo: false });
  w.avatarService = null;
  w.getOrFetchMrsData = async () => mrs;
  return w.getOrFetchMrsText({});
};

test('/mrs list: a row whose author has an exact picture shows it at 18px, next to the author', async () => {
  const fetched = [];
  const w = newWatcher({ fetched });
  const mrs = [mr(1, ALICE_GL), mr(2, BOB_GL), mr(3, { name: 'Carol Example', username: 'carol' })];
  w.getOrFetchMrsData = async () => mrs;
  const message = await w.getOrFetchMrsText({});
  assert.ok(isRichMessage(message));
  const images = photosIn(message);
  assert.deepEqual(images.map((i) => i.altText).sort(), ['Alice Example', 'Bob Example']);
  for (const image of images) {
    assert.equal(image.width, '18px');
    assert.equal(image.height, '18px');
    assert.match(image.url, /^data:image\/jpeg;base64,/);
  }
  // The author names stay on the meta lines; Carol has no Teams identity: the neutral placeholder, never a photo.
  assert.deepEqual(placeholdersIn(message).map((i) => i.altText), ['Carol Example']);
  const text = JSON.stringify(cardOf(message));
  for (const name of ['Alice Example', 'Bob Example', 'Carol Example']) assert.ok(text.includes(name));
  assert.deepEqual(fetched.sort(), [ALICE, BOB].sort());
});

test('/mrs list: pictures are the small 24px variant and do not touch the 32px card cache', async () => {
  const sizes = [];
  const w = newWatcher({ sizes });
  w.getOrFetchMrsData = async () => [mr(1, ALICE_GL), mr(2, BOB_GL)];
  await w.getOrFetchMrsText({});
  assert.deepEqual([...new Set(sizes)], ['HR24x24']);
  assert.equal(w.avatarService.peek('Alice Example'), null, 'the MR card size is not pre-filled by the list');
  assert.ok(w.avatarService.peek('Alice Example', { size: 'HR24x24' }));
});


test('/mrs list: each author is fetched once, under one deadline for the whole list', async () => {
  const w = newWatcher();
  const calls = [];
  const original = w.avatarService.avatarsFor.bind(w.avatarService);
  w.avatarService.avatarsFor = (people, options) => {
    calls.push({ people, options });
    return original(people, options);
  };
  w.getOrFetchMrsData = async () => [mr(1, ALICE_GL), mr(2, ALICE_GL), mr(3, BOB_GL), mr(4, BOB_GL)];
  await w.getOrFetchMrsText({});
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].people, [{ name: 'Alice Example' }, { name: 'Bob Example' }]);
  assert.ok(calls[0].options.deadlineMs >= 2500 && calls[0].options.deadlineMs <= 3000, 'one list deadline, not per row');
});


test('/mrs list: authors without a photo get the neutral 18px placeholder, in the same layout', async () => {
  const w = newWatcher({ photo: false });
  const mrs = [mr(1, ALICE_GL), mr(2, BOB_GL)];
  w.getOrFetchMrsData = async () => mrs;
  const message = await w.getOrFetchMrsText({});
  assert.ok(isRichMessage(message));
  assert.equal(photosIn(message).length, 0);
  const images = placeholdersIn(message);
  assert.deepEqual(images.map((i) => i.altText), ['Alice Example', 'Bob Example']);
  for (const image of images) assert.deepEqual([image.width, image.height], ['18px', '18px']);
  assert.equal(messageMarkdown(message), messageMarkdown(await noPictures(mrs)));
});



test('/mrs list: a failed fetch shows the placeholder, and a photo that arrives later replaces it', async () => {
  const w = newWatcher();
  const mrs = [mr(1, ALICE_GL), mr(2, BOB_GL)];
  w.getOrFetchMrsData = async () => mrs;
  let failing = true;
  const original = w.avatarService.avatarsFor.bind(w.avatarService);
  w.avatarService.avatarsFor = async (people, options) => (failing ? {} : original(people, options));
  const first = await w.getOrFetchMrsText({});
  assert.equal(photosIn(first).length, 0);
  assert.equal(placeholdersIn(first).length, 2);
  failing = false;
  const second = await w.getOrFetchMrsText({ force: true });
  assert.equal(photosIn(second).length, 2);
  assert.equal(placeholdersIn(second).length, 0);
});

// ---- Lists too large for one card are split into several list cards ----

const CI_URLS = new Set(Object.values(CI_STATUS_ICONS).map((i) => i.url));
// Each card of a (possibly several-card) message.
const partsOf = (message) => {
  const { followUps = [], ...head } = message;
  return [head, ...followUps];
};
const nodesOf = (message) => {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    found.push(node);
    Object.values(node).forEach(walk);
  };
  walk(cardOf(message).body);
  return found;
};
const textsOf = (message) => nodesOf(message).filter((n) => n.type === 'TextBlock').map((n) => n.text);
const imagesOf = (message) => nodesOf(message).filter((n) => n.type === 'Image');
const stateGlyphs = (message) => imagesOf(message).filter((i) => i.altText === 'Open' || i.altText === 'Draft');
const ciIconsOf = (message) => imagesOf(message).filter((i) => CI_URLS.has(i.url));
// The merge request numbers a card lists, in display order.
const refsOf = (message) => textsOf(message).flatMap((t) => [...t.matchAll(/!(\d+)/g)].map((m) => Number(m[1])));
const mrIn = (project, iid, author, title = `Example change number ${iid} with a reasonably descriptive title`) =>
  mr(iid, author, title, {
    web_url: `${GL}/${project}/-/merge_requests/${iid}`,
    references: { full: `example-group/${project}!${iid}` },
  });
const alternating = (count, first = 700, title) =>
  Array.from({ length: count }, (_, i) => (title ? mr(first + i, i % 2 ? BOB_GL : ALICE_GL, title(i)) : mr(first + i, i % 2 ? BOB_GL : ALICE_GL, `Example change number ${first + i} with a reasonably descriptive title`)));




test('/mrs list: a long list is a sequence the transport sends card by card, and a later change shows in the cache comparison', async () => {
  setRichMessages(true);
  const w = newWatcher({ photo: false });
  const mrs = alternating(18);
  w.getOrFetchMrsData = async () => mrs;
  const message = await w.getOrFetchMrsText({});
  const prepared = prepareRichMessages(message);
  assert.equal(prepared.length, partsOf(message).length);
  assert.ok(prepared.length >= 2);
  prepared.forEach((part) => assert.ok(isRichMessage(part)));
  assert.deepEqual(prepared.flatMap(refsOf), mrs.map((m) => m.iid));
  // executeCachedCommand compares the serialised messages: a change on a later card must differ.
  const changed = [...mrs.slice(0, -1), { ...mrs.at(-1), title: 'A renamed last change' }];
  w.getOrFetchMrsData = async () => changed;
  const later = await w.getOrFetchMrsText({ force: true });
  assert.notEqual(JSON.stringify(later), JSON.stringify(message));
  const same = await w.getOrFetchMrsText({ force: true });
  assert.equal(JSON.stringify(same), JSON.stringify(later));
});


test('/mrs list: a single row that cannot carry its photo takes the placeholder, and the cards still fit', async () => {
  const w = newWatcher({ extraFor: (mri) => (mri === ALICE ? 30000 : 200) });
  const mrs = alternating(6);
  w.getOrFetchMrsData = async () => mrs;
  const message = await w.getOrFetchMrsText({});
  const parts = partsOf(message);
  parts.forEach((part) => assert.ok(richMessageWireBytes(part) <= MAX_CARD_BYTES));
  assert.equal(parts.flatMap((p) => personsIn(p)).length, 6);
  assert.equal(parts.flatMap((p) => placeholdersIn(p)).length, 3, "Alice's huge photo is not shown, her rows have the placeholder");
  assert.equal(parts.flatMap((p) => photosIn(p)).length, 3);
});


test('/mrs list: regular messages make no picture request and stay markdown', async () => {
  const fetched = [];
  const w = newWatcher({ teams: {}, fetched });
  assert.equal(w.avatarService, null);
  w.getOrFetchMrsData = async () => [mr(1, ALICE_GL), mr(2, BOB_GL)];
  const message = await w.getOrFetchMrsText({});
  assert.equal(typeof message, 'string');
  assert.ok(message.includes('Open Merge Requests'));
  assert.deepEqual(fetched, []);
});

test('/mrs list: pictures are cached, so a later list is built without new requests', async () => {
  const fetched = [];
  const w = newWatcher({ fetched });
  const mrs = [mr(1, ALICE_GL), mr(2, BOB_GL)];
  w.getOrFetchMrsData = async () => mrs;
  await w.getOrFetchMrsText({});
  const before = fetched.length;
  // The cached reply path (formatMrsMessage) never starts a request.
  const cached = w.formatMrsMessage(mrs, {});
  assert.equal(personsIn(cached).length, 2);
  await w.getOrFetchMrsText({ force: true });
  assert.equal(fetched.length, before);
});

test('/mrs list: a list that needs several cards is split by section, humans first, bots after', async () => {
  const w = newWatcher({ photo: false });
  const humans = Array.from({ length: 14 }, (_, i) => mr(100 + i, i % 2 ? BOB_GL : ALICE_GL));
  const bots = Array.from({ length: 14 }, (_, i) => mr(200 + i, { name: 'Renovate Bot', username: 'renovate-bot' }, `chore(deps): update dependency number ${i}`));
  w.getOrFetchMrsData = async () => [...humans, ...bots];
  const message = await w.getOrFetchMrsText({ mode: 'all' });
  const parts = partsOf(message);
  assert.ok(parts.length >= 2);
  const kinds = parts.map((part) => {
    const refs = refsOf(part);
    return new Set(refs.map((ref) => (ref >= 200 ? 'bot' : 'human')));
  });
  for (const k of kinds) assert.equal(k.size, 1, 'a card never mixes humans and bots');
  assert.equal(kinds[0].has('human'), true);
  assert.equal(kinds.at(-1).has('bot'), true);
});

test('/mrs multi-MR cards show exact human photos and omit bot avatars', async () => {
  const w = newWatcher();
  const rows = [mr(1, ALICE_GL), mr(2, BOB_GL), mr(3, { name: 'Renovate Bot', username: 'renovate-bot' })];
  w.getOrFetchMrsData = async () => rows;
  const message = await w.getOrFetchMrsText({ mode: 'all' });
  const persons = [message, ...(message.followUps || [])].flatMap(personsIn);
  assert.ok(persons.some((image) => image.altText === 'Alice Example' && !isFallback(image)));
  assert.ok(persons.some((image) => image.altText === 'Bob Example' && !isFallback(image)));
  assert.ok(!persons.some((image) => image.altText === 'Renovate Bot'));
});

test('/mrs multi-MR cards keep ambiguous authors anonymous with placeholders', async () => {
  const w = newWatcher();
  const rows = [mr(1, ALICE_GL), mr(2, { name: 'Alice Example', username: 'another-alice' })];
  w.getOrFetchMrsData = async () => rows;
  const message = await w.getOrFetchMrsText({});
  const persons = [message, ...(message.followUps || [])].flatMap(personsIn);
  assert.equal(persons.length, 2);
  assert.ok(persons.every(isFallback));
});
