import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isRichMessage, messageMarkdown, prepareRichMessages, richMessageWireBytes, setRichMessages } from '../src/teams.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { MAX_CARD_BYTES } from '../src/cards.mjs';
import { AvatarService } from '../src/avatars.mjs';
import { PLACEHOLDER_AVATAR } from '../src/placeholder-avatar.mjs';
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
  // The picture sits directly before the author name (`<picture> <name>`); the words on the card are unchanged.
  const words = (card) => {
    const out = [];
    const walk = (n) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      if (n.type === 'TextBlock' && n.text) out.push(n.text);
      Object.values(n).forEach(walk);
    };
    walk(card);
    // The author now leads the meta line, so compare the words, not their order.
    return out.join(' ').split(/[\s·]+/).filter(Boolean).sort().join(' ');
  };
  assert.equal(words(cardOf(withPictures)), words(cardOf(without)));
  const flowNames = [];
  const visit = (n) => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n.items)) n.items.forEach((item, i) => item.type === 'Image' && item.style === 'Person' && flowNames.push([item.altText, n.items[i + 1]?.text]));
    Object.values(n).forEach(visit);
  };
  visit(cardOf(withPictures));
  assert.equal(flowNames.length, 3);
  for (const [alt, next] of flowNames) assert.ok(next.startsWith(alt), `${alt} is followed directly by their name`);
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
  const parts = partsOf(message);
  parts.forEach((part) => assert.ok(richMessageWireBytes(part) <= MAX_CARD_BYTES));
  assert.deepEqual(parts.flatMap((p) => placeholdersIn(p)).map((i) => i.altText), ['Alice Example', 'Bob Example', 'Carol Example']);
  assert.equal(parts.flatMap((p) => photosIn(p)).length, 0);
  assert.deepEqual(parts.flatMap(refsOf), mrs.map((m) => m.iid), 'every row kept');
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

test('/mrs list: a list too large for one card becomes several list cards that keep glyphs, CI icons and a picture on every human row', async () => {
  for (const count of [16, 30]) {
    const w = newWatcher({ photo: false });
    const mrs = alternating(count);
    w.getOrFetchMrsData = async () => mrs;
    const message = await w.getOrFetchMrsText({});
    assert.ok(isRichMessage(message));
    const parts = partsOf(message);
    assert.ok(parts.length >= 2 && parts.length <= 10, `${count} rows: ${parts.length} cards`);
    for (const [i, part] of parts.entries()) {
      assert.ok(isRichMessage(part), `card ${i + 1} is a rich message`);
      assert.ok(richMessageWireBytes(part) <= MAX_CARD_BYTES, `card ${i + 1} within the budget`);
      assert.ok(stateGlyphs(part).length > 0, `card ${i + 1} keeps the state glyph images`);
      assert.equal(ciIconsOf(part).length, stateGlyphs(part).length, `card ${i + 1} keeps the CI icons`);
      assert.equal(placeholdersIn(part).length, refsOf(part).length, `card ${i + 1}: a picture on every row`);
      assert.ok(JSON.stringify(cardOf(part)).includes(`Merge requests ${i + 1}/${parts.length}`), `card ${i + 1} is numbered`);
    }
    const all = parts.flatMap(refsOf);
    assert.deepEqual(all, mrs.map((m) => m.iid), 'every row once, in order');
    assert.equal(parts.flatMap((p) => personsIn(p)).length, count);
    assert.ok(!parts.some((part) => textsOf(part).some((t) => t.includes('\u2705 CI passed'))), 'no emoji downgrade');
  }
});

test('/mrs list: several cards carry cached photos and placeholders on every human row, and never a picture on a bot', async () => {
  const w = newWatcher({ extra: 1500 });
  const mrs = [
    ...alternating(22),
    mr(900, { name: 'Dave Nobody', username: 'dave' }),
    ...Array.from({ length: 3 }, (_, i) => mr(950 + i, { name: 'Renovate Bot', username: 'renovate-bot' }, `chore(deps): update dependency number ${i}`)),
  ];
  w.getOrFetchMrsData = async () => mrs;
  const message = await w.getOrFetchMrsText({});
  const parts = partsOf(message);
  assert.ok(parts.length >= 2);
  parts.forEach((part) => assert.ok(richMessageWireBytes(part) <= MAX_CARD_BYTES));
  const human = mrs.filter((m) => m.iid < 950);
  assert.equal(parts.flatMap((p) => personsIn(p)).length, human.length, 'a picture on every human row, none on the bots');
  assert.equal(parts.flatMap((p) => photosIn(p)).length, 22, 'the cached photos are all shown: room is made by another card');
  assert.equal(parts.flatMap((p) => placeholdersIn(p)).length, 1, 'only the author without a photo has the placeholder');
  assert.deepEqual(parts.flatMap(refsOf).sort((a, b) => a - b), mrs.map((m) => m.iid).sort((a, b) => a - b));
});

test('/mrs list: the cards keep the project grouping, repeat the heading and the headline, and put the note on the last card', async () => {
  const w = newWatcher({ photo: false });
  const projects = ['alpha', 'beta', 'gamma'];
  const humans = Array.from({ length: 21 }, (_, i) => mrIn(projects[i % 3], 100 + i, i % 2 ? BOB_GL : ALICE_GL));
  const bots = Array.from({ length: 8 }, (_, i) =>
    mrIn('alpha', 300 + i, { name: 'Renovate Bot', username: 'renovate-bot' }, `chore(deps): update dependency number ${i}`)
  );
  w.getOrFetchMrsData = async () => [...humans, ...bots];
  const message = await w.getOrFetchMrsText({});
  const parts = partsOf(message);
  assert.ok(parts.length >= 2);
  // Display order of a card: by project (first appearance), then as listed.
  const expected = [...projects.flatMap((p) => humans.filter((m) => m.references.full.includes(`/${p}!`))), ...bots.slice(0, 5)].map((m) => m.iid);
  const listed = parts.flatMap(refsOf);
  assert.equal(new Set(listed).size, listed.length, 'no row twice');
  assert.deepEqual([...listed].sort((a, b) => a - b), [...expected].sort((a, b) => a - b), 'no row lost: the humans and the top 5 bots');
  const projectOf = (iid) => [...humans, ...bots].find((m) => m.iid === iid).references.full.split('/')[1].split('!')[0];
  const humanProjects = listed.filter((iid) => iid < 300).map(projectOf);
  assert.deepEqual(humanProjects, [...humanProjects].sort((a, b) => projects.indexOf(a) - projects.indexOf(b)), 'a project is never interleaved with another');
  for (const [i, part] of parts.entries()) {
    const text = textsOf(part).join('\n');
    assert.ok(text.includes('Open Merge Requests'), `card ${i + 1} repeats the headline`);
    if (i === 0) assert.ok(!/continued/.test(text), 'the first card has the plain headings');
    assert.equal(text.includes('and 3 more bot MRs'), i === parts.length - 1, `the note is on the last card only (card ${i + 1})`);
  }
  assert.ok(parts.slice(1).some((part) => /continued/.test(textsOf(part).join('\n'))), 'a section that goes on says so');
  // The markdown of the cards, joined, is every row of the regular list.
  for (const m of [...humans, ...bots.slice(0, 5)]) assert.ok(messageMarkdown(message).includes(`!${m.iid}]`), `!${m.iid} in the fallback markdown`);
});

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

test('/mrs list: more cards than the transport sends are never made: a lighter form comes first, then the plain markdown', async () => {
  // Humans with placeholders: the heavy form needs more than 10 cards, a lighter one fewer.
  const heavy = alternating(130);
  const w = newWatcher({ photo: false });
  w.getOrFetchMrsData = async () => heavy;
  const message = await w.getOrFetchMrsText({ mode: 'all' });
  const parts = isRichMessage(message) ? partsOf(message) : [];
  assert.ok(parts.length > 0 && parts.length <= 10, `${parts.length} cards`);
  parts.forEach((part) => assert.ok(richMessageWireBytes(part) <= MAX_CARD_BYTES));
  assert.equal(parts.flatMap(refsOf).length, 130, 'every row is still there');
  assert.equal(parts.flatMap((p) => ciIconsOf(p)).length, 0, 'the CI icons were given up before any row');
  assert.equal(parts.flatMap((p) => personsIn(p)).length, 130, 'but not the pictures');

  const huge = alternating(900);
  w.getOrFetchMrsData = async () => huge;
  const fallback = await w.getOrFetchMrsText({ mode: 'all', force: true });
  assert.equal(typeof fallback, 'string', 'beyond that, the markdown');
  assert.ok(fallback.includes('!1599') || fallback.includes('!700'));
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

test('/mrs list: what fits one card stays one card, with no sequence and no label', async () => {
  const w = newWatcher({ photo: false });
  w.getOrFetchMrsData = async () => alternating(5);
  const message = await w.getOrFetchMrsText({});
  assert.equal(message.followUps, undefined);
  assert.equal(partsOf(message).length, 1);
  assert.ok(!JSON.stringify(cardOf(message)).includes('Merge requests 1/'));
  assert.equal(placeholdersIn(message).length, 5);
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
