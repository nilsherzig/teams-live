import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isRichMessage, messageMarkdown, richMessageWireBytes, setRichMessages } from '../src/teams.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { MAX_CARD_BYTES } from '../src/cards.mjs';
import { AvatarService } from '../src/avatars.mjs';

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

function newWatcher({ teams = { rich_messages: true }, extra = 0, fetched = [], photo = true } = {}) {
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
      fetchPhoto: async (mri) => {
        fetched.push(mri);
        return photo ? { kind: 'photo', bytes: fakeJpeg(extra) } : { kind: 'none' };
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

test('/mrs list: a row whose author has an exact picture shows it at 20px, next to the author', async () => {
  const fetched = [];
  const w = newWatcher({ fetched });
  const mrs = [mr(1, ALICE_GL), mr(2, BOB_GL), mr(3, { name: 'Carol Example', username: 'carol' })];
  w.getOrFetchMrsData = async () => mrs;
  const message = await w.getOrFetchMrsText({});
  assert.ok(isRichMessage(message));
  const images = personsIn(message);
  assert.deepEqual(images.map((i) => i.altText).sort(), ['Alice Example', 'Bob Example']);
  for (const image of images) {
    assert.equal(image.width, '20px');
    assert.equal(image.height, '20px');
    assert.match(image.url, /^data:image\/jpeg;base64,/);
  }
  // The author names stay on the meta lines; Carol has no Teams identity and is name only.
  const text = JSON.stringify(cardOf(message));
  for (const name of ['Alice Example', 'Bob Example', 'Carol Example']) assert.ok(text.includes(name));
  assert.deepEqual(fetched.sort(), [ALICE, BOB].sort());
});

test('/mrs list: every fact of the plain list card is kept, pictures only add a column', async () => {
  const w = newWatcher();
  const mrs = [mr(1, ALICE_GL), mr(2, BOB_GL), mr(3, ALICE_GL)];
  w.getOrFetchMrsData = async () => mrs;
  const withPictures = await w.getOrFetchMrsText({});
  const plain = newWatcher({ photo: false });
  plain.getOrFetchMrsData = async () => mrs;
  const without = await plain.getOrFetchMrsText({});
  assert.equal(personsIn(without).length, 0);
  assert.equal(messageMarkdown(withPictures), messageMarkdown(without));
  const strip = (card) => JSON.stringify(card).replace(/\{"type":"Column","width":"auto","verticalContentAlignment":"Center","items":\[\{"type":"Image","url":"data:[^"]+","altText":"[^"]+","style":"Person","width":"20px","height":"20px"\}\]\},?/g, '');
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

test('/mrs list: no picture for an ambiguous name, a single word, a bot or an unknown author', async () => {
  const fetched = [];
  const w = newWatcher({ fetched });
  w.getOrFetchMrsData = async () => [
    mr(1, { name: 'Alice Example', username: 'alice' }),
    mr(2, { name: 'Alice Example', username: 'alice2' }), // same name, other account
    mr(3, { name: 'Bob', username: 'bob' }), // one word: never enough
    mr(4, { name: 'Renovate Bot', username: 'renovate-bot' }),
    mr(5, { name: 'Dave Nobody', username: 'dave' }), // not in the directory
    mr(6, null),
  ];
  const message = await w.getOrFetchMrsText({ mode: 'all' });
  assert.ok(isRichMessage(message));
  assert.equal(personsIn(message).length, 0);
  assert.deepEqual(fetched, []);
});

test('/mrs list: without any picture the card is the plain list card', async () => {
  const w = newWatcher({ photo: false });
  const mrs = [mr(1, ALICE_GL), mr(2, BOB_GL)];
  w.getOrFetchMrsData = async () => mrs;
  const message = await w.getOrFetchMrsText({});
  assert.ok(isRichMessage(message));
  assert.equal(personsIn(message).length, 0);
});

test('/mrs list: a list near the size limit gets as many pictures as fit and never loses a row or the state icons', async () => {
  const w = newWatcher({ extra: 2300 });
  // Titles that fill most of a card with the image form of the list.
  const mrs = Array.from({ length: 10 }, (_, i) =>
    mr(100 + i, i % 2 ? BOB_GL : ALICE_GL, `Example change number ${i} with a reasonably descriptive title`)
  );
  w.getOrFetchMrsData = async () => mrs;
  const message = await w.getOrFetchMrsText({});
  assert.ok(isRichMessage(message));
  assert.ok(richMessageWireBytes(message) <= MAX_CARD_BYTES);
  const shown = personsIn(message).length;
  assert.ok(shown > 0 && shown < mrs.length, `some but not every row has a picture (${shown} of ${mrs.length})`);
  const text = JSON.stringify(cardOf(message));
  for (const m of mrs) assert.ok(text.includes(`!${m.iid}`), `row !${m.iid} kept`);
  assert.ok(text.includes('data:image/png'), 'GitLab state icons are not downgraded to emojis for photos');
  // Rows are filled in order: the first rows have the pictures.
  const rowsWithPicture = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ColumnSet' && node.columns?.length === 3 && JSON.stringify(node.columns[2]).includes('"Person"')) {
      rowsWithPicture.push(/!(\d+)/.exec(JSON.stringify(node.columns[1]))[1]);
    }
    Object.values(node).forEach(walk);
  };
  walk(cardOf(message));
  assert.deepEqual(rowsWithPicture, mrs.slice(0, rowsWithPicture.length).map((m) => String(m.iid)));
});

test('/mrs list: a list that only fits without pictures stays as it was', async () => {
  const w = newWatcher({ extra: 2300 });
  const mrs = Array.from({ length: 14 }, (_, i) =>
    mr(300 + i, ALICE_GL, `Example change number ${i} with a reasonably descriptive title`)
  );
  w.getOrFetchMrsData = async () => mrs;
  const withService = await w.getOrFetchMrsText({});
  const plain = newWatcher({ photo: false });
  plain.getOrFetchMrsData = async () => mrs;
  const without = await plain.getOrFetchMrsText({});
  assert.ok(isRichMessage(withService));
  assert.ok(richMessageWireBytes(withService) <= MAX_CARD_BYTES);
  assert.equal(personsIn(withService).length, 0, 'no room: names only');
  assert.deepEqual(cardOf(withService), cardOf(without));
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
