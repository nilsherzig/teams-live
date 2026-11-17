import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isRichMessage, messageMarkdown, richMessageWireBytes, setRichMessages } from '../src/teams.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { MAX_CARD_BYTES } from '../src/cards.mjs';
import { AvatarService } from '../src/avatars.mjs';
import { PLACEHOLDER_AVATAR } from '../src/placeholder-avatar.mjs';

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
const photosIn = (message) => personsIn(message).filter((i) => i.url !== PLACEHOLDER_AVATAR);
const placeholdersIn = (message) => personsIn(message).filter((i) => i.url === PLACEHOLDER_AVATAR);
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

test('/mrs list: every fact of the plain list card is kept, pictures only add a column', async () => {
  const w = newWatcher();
  const mrs = [mr(1, ALICE_GL), mr(2, BOB_GL), mr(3, ALICE_GL)];
  w.getOrFetchMrsData = async () => mrs;
  const withPictures = await w.getOrFetchMrsText({});
  const without = await noPictures(mrs);
  assert.equal(personsIn(without).length, 0);
  assert.equal(messageMarkdown(withPictures), messageMarkdown(without));
  const strip = (card) => JSON.stringify(card).replace(/\{"type":"Column","width":"auto","verticalContentAlignment":"Center","items":\[\{"type":"Image","url":"data:[^"]+","altText":"[^"]+","style":"Person","width":"18px","height":"18px"\}\]\},?/g, '');
  const normalize = (s) => s.replace(/,\]/g, ']');
  assert.equal(normalize(strip(cardOf(withPictures))), normalize(JSON.stringify(cardOf(without))));
  // The GitLab state glyphs are still images, not emojis.
  assert.ok(JSON.stringify(cardOf(withPictures)).includes('data:image/png'));
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

test('/mrs list: a single word, an unknown or an ambiguous human author get the neutral placeholder, never a photo; a bot or no author nothing', async () => {
  const fetched = [];
  const w = newWatcher({ fetched });
  w.getOrFetchMrsData = async () => [
    mr(1, { name: 'Alice Example', username: 'alice' }),
    mr(2, { name: 'Alice Example', username: 'alice2' }), // same name, other account: ambiguous
    mr(3, { name: 'Bob', username: 'bob' }), // one word: never enough
    mr(4, { name: 'Renovate Bot', username: 'renovate-bot' }),
    mr(5, { name: 'Dave Nobody', username: 'dave' }), // not in the directory
    mr(6, null),
  ];
  const message = await w.getOrFetchMrsText({ mode: 'all' });
  assert.ok(isRichMessage(message));
  assert.equal(photosIn(message).length, 0, 'an ambiguous name never gets a (possibly wrong) photo');
  assert.deepEqual(
    placeholdersIn(message).map((i) => i.altText),
    ['Alice Example', 'Alice Example', 'Bob', 'Dave Nobody'],
    'every human row has the placeholder, bots and the row without an author none'
  );
  assert.deepEqual(fetched, [], 'no request for them');
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

test('/mrs list: real photos and placeholders share the card: every human row has one, photos where they fit', async () => {
  const w = newWatcher({ extra: 1500 });
  const mrs = [
    ...Array.from({ length: 2 }, (_, i) => mr(10 + i, { name: 'Dave Nobody', username: 'dave' })),
    ...Array.from({ length: 4 }, (_, i) => mr(20 + i, i % 2 ? BOB_GL : ALICE_GL)),
  ];
  w.getOrFetchMrsData = async () => mrs;
  const message = await w.getOrFetchMrsText({});
  assert.ok(richMessageWireBytes(message) <= MAX_CARD_BYTES);
  assert.equal(personsIn(message).length, mrs.length);
  assert.equal(photosIn(message).length, 4);
  assert.equal(placeholdersIn(message).length, 2);
});

test('/mrs list: bot rows get no picture while every human row has one, also with a cold cache (fetch not in time)', async () => {
  const w = newWatcher({ photo: false });
  // The lookup never answers in time: nothing is cached when the list is built.
  w.avatarService.avatarsFor = async () => ({});
  const mrs = [
    mr(1, ALICE_GL),
    mr(2, BOB_GL),
    mr(3, { name: 'Carol Example', username: 'carol' }),
    ...Array.from({ length: 10 }, (_, i) => mr(40 + i, { name: 'Renovate Bot', username: 'renovate-bot' }, `chore(deps): update dependency number ${i}`)),
  ];
  w.getOrFetchMrsData = async () => mrs;
  const message = await w.getOrFetchMrsText({ mode: 'all' });
  assert.ok(isRichMessage(message));
  assert.ok(richMessageWireBytes(message) <= MAX_CARD_BYTES);
  assert.deepEqual(placeholdersIn(message).map((i) => i.altText), ['Alice Example', 'Bob Example', 'Carol Example']);
  assert.equal(photosIn(message).length, 0);
  const text = JSON.stringify(cardOf(message));
  for (const m of mrs) assert.ok(text.includes(`!${m.iid}`), `row !${m.iid} kept`);
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

test('/mrs list: a list near the size limit gets as many pictures as fit and never loses a row or the state icons', async () => {
  const w = newWatcher({ extra: 2300 });
  // Titles that fill most of a card with the image form of the list (state glyphs and CI icons).
  const mrs = Array.from({ length: 7 }, (_, i) =>
    mr(100 + i, i % 2 ? BOB_GL : ALICE_GL, `Example change number ${i} with a reasonably descriptive title`)
  );
  w.getOrFetchMrsData = async () => mrs;
  const message = await w.getOrFetchMrsText({});
  assert.ok(isRichMessage(message));
  assert.ok(richMessageWireBytes(message) <= MAX_CARD_BYTES);
  assert.equal(personsIn(message).length, mrs.length, 'every human row has a picture slot');
  const shown = photosIn(message).length;
  assert.ok(shown > 0 && shown < mrs.length, `some but not every row has a real photo (${shown} of ${mrs.length})`);
  const text = JSON.stringify(cardOf(message));
  for (const m of mrs) assert.ok(text.includes(`!${m.iid}`), `row !${m.iid} kept`);
  assert.ok(text.includes('data:image/png'), 'GitLab state icons are not downgraded to emojis for photos');
  // Rows are filled in order: the first rows have the pictures.
  const rowsWithPicture = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ColumnSet' && node.columns?.length === 3 && JSON.stringify(node.columns[2]).includes('"Person"') && !JSON.stringify(node.columns[2]).includes(PLACEHOLDER_AVATAR)) {
      rowsWithPicture.push(/!(\d+)/.exec(JSON.stringify(node.columns[1]))[1]);
    }
    Object.values(node).forEach(walk);
  };
  walk(cardOf(message));
  assert.deepEqual(rowsWithPicture, mrs.slice(0, rowsWithPicture.length).map((m) => String(m.iid)));
});

test('/mrs list: photos replace placeholders by their measured cost, so no further photo would still fit', async () => {
  let mixed = 0;
  for (const count of [6, 7, 8, 9, 10, 11, 12]) {
    const w = newWatcher({ extra: 700 });
    const mrs = Array.from({ length: count }, (_, i) =>
      mr(500 + i, i % 2 ? BOB_GL : ALICE_GL, `Example change number ${i} with a reasonably descriptive title`)
    );
    w.getOrFetchMrsData = async () => mrs;
    const message = await w.getOrFetchMrsText({});
    assert.ok(isRichMessage(message));
    const bytes = richMessageWireBytes(message);
    assert.ok(bytes <= MAX_CARD_BYTES);
    assert.equal(personsIn(message).length, count, `${count} rows: every one has a picture`);
    const photos = photosIn(message);
    if (photos.length === 0 || photos.length === count) continue;
    mixed += 1;
    // Upgrading one more row only swaps the placeholder for the photo: that is what is left at most.
    const upgrade = photos[0].url.length - PLACEHOLDER_AVATAR.length;
    assert.ok(MAX_CARD_BYTES - bytes < upgrade, `${count} rows: ${MAX_CARD_BYTES - bytes} bytes left would still fit another photo (${upgrade})`);
  }
  assert.ok(mixed >= 2, `the placement was measured on mixed lists (${mixed})`);
});

test('/mrs list: a picture that does not fit is skipped and a smaller one after it still gets the room', async () => {
  // Alice's photo is too big for what the card leaves, Bob's is small.
  const w = newWatcher({ extraFor: (mri) => (mri === ALICE ? 7000 : 200) });
  const mrs = Array.from({ length: 8 }, (_, i) =>
    mr(600 + i, i % 2 ? BOB_GL : ALICE_GL, `Example change number ${i} with a reasonably descriptive title`)
  );
  w.getOrFetchMrsData = async () => mrs;
  const message = await w.getOrFetchMrsText({});
  assert.ok(isRichMessage(message));
  assert.ok(richMessageWireBytes(message) <= MAX_CARD_BYTES);
  const pictures = photosIn(message);
  assert.ok(pictures.length > 0, 'the small pictures are shown');
  assert.ok(pictures.every((p) => p.url.length < 1000), 'the big picture is not');
  const text = JSON.stringify(cardOf(message));
  for (const m of mrs) assert.ok(text.includes(`!${m.iid}`), `row !${m.iid} kept`);
});

test('/mrs list: photos that cannot fit leave the placeholders, never a name-only human row', async () => {
  const w = newWatcher({ extra: 5000 });
  const mrs = Array.from({ length: 14 }, (_, i) =>
    mr(300 + i, ALICE_GL, `Example change number ${i} with a reasonably descriptive title`)
  );
  w.getOrFetchMrsData = async () => mrs;
  const message = await w.getOrFetchMrsText({});
  assert.ok(isRichMessage(message));
  assert.ok(richMessageWireBytes(message) <= MAX_CARD_BYTES);
  assert.equal(photosIn(message).length, 0, 'no room for a 5 KB photo');
  assert.equal(placeholdersIn(message).length, mrs.length, 'every human row has the placeholder');
  const text = JSON.stringify(cardOf(message));
  for (const m of mrs) assert.ok(text.includes(`!${m.iid}`), `row !${m.iid} kept`);
});

test('/mrs list: a list too large for the heavy form takes a lighter form before a row loses its avatar', async () => {
  for (const count of [13, 14]) {
    const w = newWatcher({ photo: false });
    const mrs = Array.from({ length: count }, (_, i) =>
      mr(700 + i, i % 2 ? BOB_GL : ALICE_GL, `Example change number ${i} with a reasonably descriptive title`)
    );
    w.getOrFetchMrsData = async () => mrs;
    const message = await w.getOrFetchMrsText({});
    assert.ok(isRichMessage(message));
    assert.ok(richMessageWireBytes(message) <= MAX_CARD_BYTES);
    assert.equal(placeholdersIn(message).length, count, `${count} rows: all have the placeholder`);
    const text = JSON.stringify(cardOf(message));
    for (const m of mrs) assert.ok(text.includes(`!${m.iid}`), `row !${m.iid} kept`);
    assert.equal(messageMarkdown(message), messageMarkdown(await noPictures(mrs)));
  }
});

test('/mrs list: a list that cannot carry the placeholders in any form stays the plain card, all or none', async () => {
  const w = newWatcher({ photo: false });
  const mrs = Array.from({ length: 22 }, (_, i) =>
    mr(800 + i, i % 2 ? BOB_GL : ALICE_GL, `Example change number ${i} with a reasonably descriptive title`)
  );
  w.getOrFetchMrsData = async () => mrs;
  const message = await w.getOrFetchMrsText({});
  assert.ok(isRichMessage(message));
  assert.ok(richMessageWireBytes(message) <= MAX_CARD_BYTES);
  assert.equal(personsIn(message).length, 0, 'not a few rows with and the rest without');
  assert.deepEqual(cardOf(message), cardOf(await noPictures(mrs)));
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
