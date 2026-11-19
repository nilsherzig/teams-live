import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setRichMessages } from '../src/teams.mjs';
import { AvatarService } from '../src/avatars.mjs';
import { PLACEHOLDER_AVATAR } from '../src/placeholder-avatar.mjs';
import { AVATAR_PX, userRow } from '../src/card-user-row.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';

// The neutral placeholder of people without a profile picture. All people and images are generic fakes.

beforeEach(() => setRichMessages(false));

const ALICE = '8:orgid:00000000-0000-4000-8000-00000000000a';
const directory = { users: new Map([[ALICE, { displayName: 'Alice Example', mri: ALICE }]]) };
const PHOTO = `data:image/jpeg;base64,${'A'.repeat(900)}`;

const pngSize = (uri) => {
  const bytes = Buffer.from(uri.split(',')[1], 'base64');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length };
};

function newWatcher(teams = { rich_messages: true }, { photo = false, fetched = [] } = {}) {
  const watcher = new MergeRequestWatcher({
    config: { conversations: [], gitlab: { group: 'group', notify: {} }, teams },
    gitlab: { findMrLinks: () => [], mrLink: () => '', pipelineLink: () => '', getMr: async () => null },
    jira: null,
    opsgenie: null,
  });
  watcher.saveState = () => {};
  if (watcher.avatarService) {
    watcher.avatarService = new AvatarService({
      directory,
      fetchPhoto: async (mri) => {
        fetched.push(mri);
        return photo ? { kind: 'photo', bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 0x11, 8, 0, 32, 0, 32, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9, 7, 7, 7, 7, 7, 7, 7, 7]) } : { kind: 'none' };
      },
    });
  }
  return watcher;
}

const imagesOf = (node, found = []) => {
  if (Array.isArray(node)) node.forEach((n) => imagesOf(n, found));
  else if (node && typeof node === 'object') {
    if (node.type === 'Image' && node.style === 'Person') found.push(node);
    Object.values(node).forEach((n) => imagesOf(n, found));
  }
  return found;
};

test('the placeholder is a tiny static palette PNG, square, built for 18px', () => {
  assert.match(PLACEHOLDER_AVATAR, /^data:image\/png;base64,/);
  const { width, height, bytes } = pngSize(PLACEHOLDER_AVATAR);
  assert.equal(width, height);
  assert.ok(width >= 2 * AVATAR_PX, 'sharp on dense screens');
  assert.ok(PLACEHOLDER_AVATAR.length < 900, `compact (${PLACEHOLDER_AVATAR.length} chars)`);
  assert.ok(bytes < 700);
});

test('peekOrPlaceholder: the cached photo, else the placeholder, and it never starts a request', async () => {
  const fetched = [];
  const service = new AvatarService({ directory, fetchPhoto: async (mri) => (fetched.push(mri), { kind: 'none' }) });
  assert.equal(service.peekOrPlaceholder('Alice Example'), PLACEHOLDER_AVATAR, 'nothing cached yet');
  assert.equal(service.peekOrPlaceholder('Nobody Known'), PLACEHOLDER_AVATAR, 'unresolved identity');
  assert.deepEqual(fetched, []);
  await service.avatarsFor([{ name: 'Alice Example' }]);
  assert.equal(service.peekOrPlaceholder('Alice Example'), PLACEHOLDER_AVATAR, 'resolved, but no photo');
  assert.equal(service.peek('Alice Example'), null, 'strict resolution is unchanged: no photo means no photo');
});

test('an MR card shows the placeholder for author and approver without a photo', async () => {
  const watcher = newWatcher();
  const mr = { project: 'group/app', iid: 7, title: 'Example' };
  const details = { title: 'Example', author: 'Alice Example', approved: true, approvedBy: ['Zed Nobody'], autoMerge: true, autoMergeUser: 'Quinn Example' };
  await watcher.prefetchAvatars(watcher.mrCardPeopleData(mr, details));
  const images = imagesOf(watcher.buildMrCard(mr, details));
  assert.deepEqual(images.map((i) => i.altText).sort(), ['Alice Example', 'Zed Nobody']);
  for (const image of images) {
    assert.equal(image.url, PLACEHOLDER_AVATAR);
    assert.deepEqual([image.width, image.height], ['18px', '18px']);
  }
});

test('a real photo wins over the placeholder; people without one sit beside it', async () => {
  const watcher = newWatcher(undefined, { photo: true });
  const mr = { project: 'group/app', iid: 7, title: 'Example' };
  const details = { title: 'Example', author: 'Alice Example', approved: true, approvedBy: ['Zed Nobody'] };
  await watcher.prefetchAvatars(watcher.mrCardPeopleData(mr, details));
  const urls = Object.fromEntries(imagesOf(watcher.buildMrCard(mr, details)).map((i) => [i.altText, i.url]));
  assert.match(urls['Alice Example'], /^data:image\/jpeg;base64,/);
  assert.equal(urls['Zed Nobody'], PLACEHOLDER_AVATAR);
});

test('no placeholder in regular mode, with the avatars suppressed, or without a service', async () => {
  const mr = { project: 'group/app', iid: 7, title: 'Example' };
  const details = { title: 'Example', author: 'Alice Example', approved: true, approvedBy: ['Zed Nobody'] };
  const fetched = [];
  const regular = newWatcher({}, { fetched });
  assert.equal(regular.avatarService, null);
  assert.deepEqual(regular.cardAvatars(regular.mrCardPeopleData(mr, details)), {});
  const rich = newWatcher();
  rich.suppressAvatars = true;
  assert.deepEqual(rich.cardAvatars(rich.mrCardPeopleData(mr, details)), {});
  assert.deepEqual(imagesOf(rich.buildMrCard(mr, details)), []);
  assert.deepEqual(fetched, []);
});

test('userRow: placeholders only take what real photos leave, and count against the caps', () => {
  const people = [
    { name: 'Nobody One', avatar: PLACEHOLDER_AVATAR },
    { name: 'Nobody Two', avatar: PLACEHOLDER_AVATAR },
    { name: 'Alice Example', avatar: PHOTO },
    { name: 'Bob Example', avatar: PHOTO },
    { name: 'Carol Example', avatar: PHOTO },
  ];
  const row = userRow('Approvers', people);
  const urls = imagesOf(row).map((i) => [i.altText, i.url === PLACEHOLDER_AVATAR ? 'placeholder' : 'photo']);
  assert.deepEqual(urls.map(([, kind]) => kind), ['placeholder', 'placeholder', 'photo', 'photo', 'photo']);

  const tight = userRow('Approvers', people, { charBudget: PHOTO.length + PLACEHOLDER_AVATAR.length });
  const kinds = (row2) => imagesOf(row2).map((i) => (i.url === PLACEHOLDER_AVATAR ? 'placeholder' : 'photo'));
  assert.equal(kinds(tight).length, 5, 'everybody keeps a picture');
  assert.equal(kinds(tight).filter((k) => k === 'photo').length, 1, 'photos only take the budget');
  const none = userRow('Approvers', people, { charBudget: 10 });
  assert.deepEqual(kinds(none), Array(5).fill('placeholder'), 'over budget: placeholders, never a bare name');
});

test('userRow: every name stays in order whether it has an image or not', () => {
  const row = userRow('Approvers', [
    { name: 'Nobody One', avatar: PLACEHOLDER_AVATAR },
    { name: 'Alice Example', avatar: PHOTO },
  ]);
  const names = JSON.stringify(row).match(/"text":"(Nobody One|Alice Example)"/g);
  assert.deepEqual(names, ['"text":"Nobody One"', '"text":"Alice Example"']);
});
