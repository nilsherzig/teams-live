import test from 'node:test';
import assert from 'node:assert/strict';
import { AvatarService, loadAvatarOverrides } from '../src/avatars.mjs';
import {
  createAvatarFallbacks,
  createConfluenceAvatarSource,
  createJiraAvatarSource,
} from '../src/avatar-sources.mjs';
import { normalizeAvatarsConfig } from '../src/config.mjs';
import { PLACEHOLDER_AVATAR } from '../src/placeholder-avatar.mjs';
import { buildMergeRequestCard } from '../src/cards.mjs';

// All people, hosts, ids and pictures below are generic fixtures.
const ALICE = '8:orgid:00000000-0000-4000-8000-00000000000a';
const JIRA = 'https://jira.example.com';
const WIKI = 'https://wiki.example.com';
const TOKEN = 'secret-token-value';

function fakePng(width = 32, height = 32, extra = 0) {
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    ...u32(width), ...u32(height), 8, 2, 0, 0, 0, 0, 0, 0, 0, ...new Array(extra).fill(1),
  ]);
}

const dataUriOf = (bytes) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
const photo = (bytes = fakePng()) => ({ kind: 'photo', bytes });
const noDirectory = { users: new Map() };

function response(status, { json = null, bytes = null, type = null } = {}) {
  const headers = new Map();
  if (type) headers.set('content-type', type);
  return {
    status,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    json: async () => json,
    arrayBuffer: async () => (bytes || new Uint8Array()).buffer.slice(0),
  };
}

/** A fetch fake: `routes` maps a URL substring to a response (or a function of the request). */
function router(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [needle, handler] of routes) {
      if (String(url).includes(needle)) return typeof handler === 'function' ? handler(url, init) : handler;
    }
    return response(404);
  };
  fn.calls = calls;
  return fn;
}

const jiraClient = { baseUrl: JIRA, token: TOKEN, isConfigured: () => true };
const wikiClient = { baseUrl: WIKI, token: TOKEN, isConfigured: () => true };
const avatarUrl = (id, owner = true) => `${JIRA}/secure/useravatar?${owner ? 'ownerId=alice&' : ''}avatarId=${id}`;
const jiraUser = (over = {}) => ({
  name: 'alice',
  displayName: 'Alice Example',
  emailAddress: 'alice@example.com',
  active: true,
  avatarUrls: { '32x32': avatarUrl(10500), '48x48': avatarUrl(10501) },
  ...over,
});

// ── AvatarService chain ─────────────────────────────────────────────────────

function service(opts = {}) {
  return new AvatarService({ directory: noDirectory, fetchPhoto: async () => ({ kind: 'none' }), ...opts });
}

test('a Teams picture wins; the fallback sources are not asked', async () => {
  let asked = 0;
  const svc = new AvatarService({
    directory: { users: new Map([[ALICE, { displayName: 'Alice Example', mri: ALICE }]]) },
    fetchPhoto: async () => photo(fakePng(16, 16)),
    fallbacks: [async () => ((asked += 1), photo())],
  });
  await svc.avatarsFor([{ name: 'Alice Example' }]);
  assert.equal(svc.peek({ name: 'Alice Example' }), dataUriOf(fakePng(16, 16)));
  assert.equal(asked, 0);
});

test('without a Teams picture the sources run in order and the first picture wins', async () => {
  const order = [];
  const second = fakePng(24, 24);
  const svc = service({
    fallbacks: [
      async () => (order.push('jira'), { kind: 'none' }),
      async () => (order.push('wiki'), photo(second)),
      async () => (order.push('never'), photo()),
    ],
  });
  const result = await svc.avatarsFor([{ name: 'Alice Example' }]);
  assert.deepEqual(order, ['jira', 'wiki']);
  assert.equal(result['Alice Example'], dataUriOf(second));
  assert.equal(svc.peek({ name: 'Alice Example' }), dataUriOf(second));
  assert.equal(svc.peekOrPlaceholder({ name: 'Alice Example' }), dataUriOf(second));
});

test('a Teams identity with no photo also falls back', async () => {
  const svc = new AvatarService({
    directory: { users: new Map([[ALICE, { displayName: 'Alice Example', mri: ALICE }]]) },
    fetchPhoto: async () => ({ kind: 'none' }),
    fallbacks: [async () => photo()],
  });
  await svc.avatarsFor([{ name: 'Alice Example' }]);
  assert.equal(svc.peek({ name: 'Alice Example' }), dataUriOf(fakePng()));
});

test('a failing source is skipped, the next one is used, and the failure is retried soon', async () => {
  let calls = 0;
  const t = { now: 1_000_000 };
  const svc = service({
    now: () => t.now,
    fallbacks: [
      async () => {
        calls += 1;
        throw new Error('status 503');
      },
      async () => ({ kind: 'none' }),
    ],
  });
  await svc.avatarsFor([{ name: 'Alice Example' }]);
  assert.equal(svc.peek({ name: 'Alice Example' }), null);
  await svc.avatarsFor([{ name: 'Alice Example' }]);
  assert.equal(calls, 1, 'cached for the error window');
  t.now += 3 * 60 * 1000;
  await svc.avatarsFor([{ name: 'Alice Example' }]);
  assert.equal(calls, 2, 'retried after the short error TTL');
});

test('a source that has nothing is remembered longer than a failure', async () => {
  let calls = 0;
  const t = { now: 1_000_000 };
  const svc = service({ now: () => t.now, fallbacks: [async () => (calls += 1, { kind: 'none' })] });
  await svc.avatarsFor([{ name: 'Alice Example' }]);
  t.now += 10 * 60 * 1000;
  await svc.avatarsFor([{ name: 'Alice Example' }]);
  assert.equal(calls, 1);
});

test('fallback pictures are validated like Teams pictures', async () => {
  const svc = service({
    fallbacks: [async () => photo(fakePng(512, 512))],
  });
  await svc.avatarsFor([{ name: 'Alice Example' }]);
  assert.equal(svc.peek({ name: 'Alice Example' }), null, 'too many pixels is not embedded');
  const svc2 = service({ fallbacks: [async () => photo(new Uint8Array([1, 2, 3]))] });
  await svc2.avatarsFor([{ name: 'Alice Example' }]);
  assert.equal(svc2.peek({ name: 'Alice Example' }), null, 'not an image');
});

test('concurrent lookups of one person share one request per size, sizes do not mix', async () => {
  let calls = 0;
  const svc = service({ fallbacks: [async () => (calls += 1, photo())] });
  await Promise.all([
    svc.avatarsFor([{ name: 'Alice Example' }]),
    svc.avatarsFor([{ name: 'Alice Example' }]),
  ]);
  assert.equal(calls, 1);
  assert.equal(svc.peek({ name: 'Alice Example' }, { size: 'HR24x24' }), null, 'another size is another entry');
});

test('a configured override is used last, needs no request and ignores case and spacing', async () => {
  const logo = dataUriOf(fakePng(64, 64));
  let calls = 0;
  const svc = service({
    fallbacks: [async () => (calls += 1, { kind: 'none' })],
    overrides: [{ name: 'MS Teams bot', dataUri: logo }],
  });
  assert.equal(svc.peek('  ms  teams BOT '), logo, 'available before any lookup');
  assert.equal(svc.peekOrPlaceholder({ name: 'MS Teams bot' }), logo);
  assert.equal(svc.peekOrPlaceholder({ name: 'Somebody Else' }), PLACEHOLDER_AVATAR);
  await svc.avatarsFor([{ name: 'MS Teams bot' }]);
  assert.equal(svc.peek({ name: 'MS Teams bot' }), logo);
  assert.ok(calls <= 1);
});

test('a fallback picture beats an override, an override beats the placeholder', async () => {
  const logo = dataUriOf(fakePng(64, 64));
  const found = fakePng(20, 20);
  const svc = service({
    fallbacks: [async () => photo(found)],
    overrides: [{ name: 'Alice Example', dataUri: logo }],
  });
  assert.equal(svc.peek({ name: 'Alice Example' }), logo, 'nothing looked up yet');
  await svc.avatarsFor([{ name: 'Alice Example' }]);
  assert.equal(svc.peek({ name: 'Alice Example' }), dataUriOf(found));
});

test('an email address is never used as a fallback name', async () => {
  let calls = 0;
  const svc = service({ fallbacks: [async () => (calls += 1, photo())] });
  await svc.avatarsFor(['alice@example.com']);
  assert.equal(calls, 0);
  assert.equal(svc.peek('alice@example.com'), null);
});

test('invalid overrides are ignored', () => {
  const svc = service({
    overrides: [
      { name: 'A B', dataUri: 'https://example.com/x.png' },
      { name: '', dataUri: dataUriOf(fakePng()) },
      null,
    ],
  });
  assert.equal(svc.overrides.size, 0);
});

// ── override files ──────────────────────────────────────────────────────────

test('loadAvatarOverrides reads valid pictures and skips the rest without throwing', () => {
  const files = {
    '/etc/ok.png': fakePng(64, 64),
    '/etc/big.png': fakePng(900, 900),
    '/etc/text.txt': new TextEncoder().encode('hello hello hello hello hello'),
  };
  const readFile = (file) => {
    if (!(file in files)) throw new Error('ENOENT');
    return Buffer.from(files[file]);
  };
  const out = loadAvatarOverrides(
    [
      { name: 'MS Teams bot', file: '/etc/ok.png' },
      { name: 'Big', file: '/etc/big.png' },
      { name: 'Text', file: '/etc/text.txt' },
      { name: 'Missing', file: '/etc/none.png' },
      { name: '', file: '/etc/ok.png' },
      { name: 'No file' },
    ],
    { readFile },
  );
  assert.deepEqual(out, [{ name: 'MS Teams bot', dataUri: dataUriOf(files['/etc/ok.png']) }]);
  assert.deepEqual(loadAvatarOverrides(undefined), []);
});

test('normalizeAvatarsConfig defaults to Jira then Confluence and keeps valid overrides only', () => {
  assert.deepEqual(normalizeAvatarsConfig(undefined), { fallback_sources: ['jira', 'confluence'], overrides: [] });
  assert.deepEqual(normalizeAvatarsConfig({ fallback_sources: [] }).fallback_sources, []);
  assert.deepEqual(
    normalizeAvatarsConfig({
      fallback_sources: ['Confluence', 'bogus', 'confluence'],
      overrides: [{ name: ' Bot ', file: '/p.png' }, { name: '', file: 'x' }, { name: 'y' }, null],
    }),
    { fallback_sources: ['confluence'], overrides: [{ name: 'Bot', file: '/p.png' }] },
  );
});

// ── Jira source ─────────────────────────────────────────────────────────────

function jiraFetch(users, image = response(200, { bytes: fakePng(32, 32), type: 'image/png' })) {
  return router([
    ['/rest/api/2/user/search', response(200, { json: users })],
    ['/secure/useravatar', image],
  ]);
}

test('Jira: an exact, unique, active user with an uploaded picture gets it, with the token and no redirects', async () => {
  const fetchFn = jiraFetch([jiraUser()]);
  const { fetch } = createJiraAvatarSource({ jira: jiraClient, fetchFn });
  const result = await fetch({ name: 'Alice  Example' });
  assert.equal(result.kind, 'photo');
  assert.deepEqual([...result.bytes], [...fakePng(32, 32)]);
  const [search, image] = fetchFn.calls;
  assert.ok(search.url.startsWith(`${JIRA}/rest/api/2/user/search?username=alice%20example&`));
  assert.equal(search.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(image.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(image.init.redirect, 'error');
  assert.equal(image.url, avatarUrl(10500), 'the 32 px variant');
});

test('Jira: the instance default avatar (no ownerId) is not a picture', async () => {
  const fetchFn = jiraFetch([jiraUser({ avatarUrls: { '32x32': avatarUrl(10122, false), '48x48': avatarUrl(10122, false) } })]);
  const { fetch } = createJiraAvatarSource({ jira: jiraClient, fetchFn });
  assert.deepEqual(await fetch({ name: 'Alice Example' }), { kind: 'none' });
  assert.equal(fetchFn.calls.length, 1, 'no image request');
});

test('Jira: only exact, unique, active matches count', async () => {
  const cases = [
    ['a first name or username alone', [jiraUser()], { name: 'alice' }, 0],
    ['a partial name', [jiraUser({ displayName: 'Alice Examples' })], { name: 'Alice Example' }, 1],
    ['two people with this name', [jiraUser(), jiraUser({ name: 'alice2' })], { name: 'Alice Example' }, 1],
    ['an inactive user', [jiraUser({ active: false })], { name: 'Alice Example' }, 1],
    ['no result', [], { name: 'Alice Example' }, 1],
    ['a full page of results', Array.from({ length: 10 }, (_, i) => jiraUser({ name: `u${i}`, displayName: i ? `X ${i}` : 'Alice Example' })), { name: 'Alice Example' }, 1],
  ];
  for (const [label, users, person, searches] of cases) {
    const fetchFn = jiraFetch(users);
    const { fetch } = createJiraAvatarSource({ jira: jiraClient, fetchFn });
    assert.deepEqual(await fetch(person), { kind: 'none' }, label);
    assert.equal(fetchFn.calls.length, searches, label);
  }
});

test('Jira: an exact e-mail address is matched too', async () => {
  const fetchFn = jiraFetch([jiraUser(), jiraUser({ name: 'bob', displayName: 'Bob Example', emailAddress: 'bob@example.com' })]);
  const { fetch } = createJiraAvatarSource({ jira: jiraClient, fetchFn });
  assert.equal((await fetch({ email: 'Alice@Example.com' })).kind, 'photo');
});

test('Jira: a picture is only fetched from the Jira origin', async () => {
  const fetchFn = jiraFetch([jiraUser({ avatarUrls: { '32x32': 'https://evil.example.net/a?ownerId=x&avatarId=1' } })]);
  const { fetch } = createJiraAvatarSource({ jira: jiraClient, fetchFn });
  assert.deepEqual(await fetch({ name: 'Alice Example' }), { kind: 'none' });
  assert.equal(fetchFn.calls.length, 1);
  assert.ok(!fetchFn.calls.some((c) => c.url.includes('evil.example.net')));
});

test('Jira: wrong content types and oversized pictures are not embedded', async () => {
  for (const image of [
    response(200, { bytes: fakePng(), type: 'text/html' }),
    response(200, { bytes: fakePng(32, 32, 20_000), type: 'image/png' }),
    response(404),
  ]) {
    const { fetch } = createJiraAvatarSource({ jira: jiraClient, fetchFn: jiraFetch([jiraUser()], image) });
    assert.deepEqual(await fetch({ name: 'Alice Example' }), { kind: 'none' });
  }
});

test('Jira: failures throw an error without URL, token or name', async () => {
  for (const [fetchFn, expected] of [
    [router([['/user/search', response(401)]]), 'status 401'],
    [router([['/user/search', response(503)]]), 'status 503'],
    [async () => { throw new Error(`boom ${JIRA} ${TOKEN}`); }, 'network'],
  ]) {
    const { fetch } = createJiraAvatarSource({ jira: jiraClient, fetchFn });
    await assert.rejects(fetch({ name: 'Alice Example' }), (err) => {
      assert.equal(err.message, expected);
      assert.ok(!err.message.includes(TOKEN) && !err.message.includes('example'));
      return true;
    });
  }
});

test('Jira: nothing is requested without a configured client', async () => {
  const fetchFn = jiraFetch([jiraUser()]);
  for (const jira of [null, { baseUrl: '', token: TOKEN }, { baseUrl: JIRA, token: '' }]) {
    const { fetch } = createJiraAvatarSource({ jira, fetchFn });
    assert.deepEqual(await fetch({ name: 'Alice Example' }), { kind: 'none' });
  }
  assert.equal(fetchFn.calls.length, 0);
});

// ── Confluence source ───────────────────────────────────────────────────────

function wikiFetch({ isDefault = false, path = '/download/attachments/1/user-avatar', image } = {}) {
  return router([
    ['/rest/api/user?username=alice', response(200, { json: { type: 'known', profilePicture: { path, isDefault } } })],
    ['/download/attachments/', image || response(200, { bytes: fakePng(32, 32), type: 'image/png' })],
  ]);
}

test('Confluence: looked up by the Jira username, only an uploaded picture, same origin, no redirects', async () => {
  const wikiFn = wikiFetch();
  const resolveUser = async () => jiraUser();
  const fetch = createConfluenceAvatarSource({ confluence: wikiClient, resolveUser, fetchFn: wikiFn });
  const result = await fetch({ name: 'Alice Example' });
  assert.equal(result.kind, 'photo');
  const [lookup, image] = wikiFn.calls;
  assert.equal(lookup.url, `${WIKI}/rest/api/user?username=alice`);
  assert.equal(image.url, `${WIKI}/download/attachments/1/user-avatar`);
  assert.equal(image.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(image.init.redirect, 'error');
});

test('Confluence: the default picture, a missing flag, no Jira match or a foreign URL give nothing', async () => {
  const resolve = async () => jiraUser();
  const none = { kind: 'none' };
  let fn = wikiFetch({ isDefault: true });
  assert.deepEqual(await createConfluenceAvatarSource({ confluence: wikiClient, resolveUser: resolve, fetchFn: fn })({ name: 'Alice Example' }), none);
  assert.equal(fn.calls.length, 1, 'no image request for the default picture');

  fn = router([['/rest/api/user', response(200, { json: { profilePicture: { path: '/x' } } })]]);
  assert.deepEqual(await createConfluenceAvatarSource({ confluence: wikiClient, resolveUser: resolve, fetchFn: fn })({ name: 'Alice Example' }), none);

  fn = wikiFetch();
  assert.deepEqual(await createConfluenceAvatarSource({ confluence: wikiClient, resolveUser: async () => null, fetchFn: fn })({ name: 'Alice Example' }), none);
  assert.equal(fn.calls.length, 0, 'nothing is looked up without a matched Jira user');

  fn = wikiFetch({ path: 'https://evil.example.net/a.png' });
  assert.deepEqual(await createConfluenceAvatarSource({ confluence: wikiClient, resolveUser: resolve, fetchFn: fn })({ name: 'Alice Example' }), none);
  assert.ok(!fn.calls.some((c) => c.url.includes('evil.example.net')));
});

test('Confluence: a picture over the byte cap is skipped, not resized', async () => {
  const fn = wikiFetch({ image: response(200, { bytes: fakePng(32, 32, 20_000), type: 'image/png' }) });
  const fetch = createConfluenceAvatarSource({ confluence: wikiClient, resolveUser: async () => jiraUser(), fetchFn: fn });
  assert.deepEqual(await fetch({ name: 'Alice Example' }), { kind: 'none' });
});

// ── wiring ──────────────────────────────────────────────────────────────────

test('createAvatarFallbacks builds Jira then Confluence and shares one Jira lookup', async () => {
  const jiraFn = router([
    ['/rest/api/2/user/search', response(200, { json: [jiraUser({ avatarUrls: { '32x32': avatarUrl(10122, false), '48x48': avatarUrl(10122, false) } })] })],
  ]);
  const wikiFn = wikiFetch();
  // One fetch function per service would be cleaner; here one router serves both origins.
  const both = async (url, init) => (String(url).startsWith(WIKI) ? wikiFn(url, init) : jiraFn(url, init));
  const list = createAvatarFallbacks({ jira: jiraClient, confluence: wikiClient, fetchFn: both });
  assert.equal(list.length, 2);
  const svc = service({ fallbacks: list });
  await svc.avatarsFor([{ name: 'Alice Example' }]);
  // Jira has only the default avatar, Confluence has the uploaded one.
  assert.equal(svc.peek({ name: 'Alice Example' }), dataUriOf(fakePng(32, 32)));
  assert.equal(jiraFn.calls.length, 1, 'one Jira search for both sources');
});

test('createAvatarFallbacks leaves out what is off or not configured', () => {
  const off = { isConfigured: () => false };
  assert.equal(createAvatarFallbacks({}).length, 0);
  assert.equal(createAvatarFallbacks({ jira: off, confluence: wikiClient }).length, 0, 'Confluence needs Jira users to match on');
  assert.equal(createAvatarFallbacks({ jira: jiraClient, confluence: off }).length, 1);
  assert.equal(createAvatarFallbacks({ jira: jiraClient, confluence: wikiClient, sources: [] }).length, 0);
  assert.equal(createAvatarFallbacks({ jira: jiraClient, confluence: wikiClient, sources: ['confluence'] }).length, 1);
  assert.equal(createAvatarFallbacks({ jira: jiraClient, confluence: wikiClient, sources: ['jira'] }).length, 1);
});

test('fallback and configured pictures are held to the small byte cap that keeps a card row intact', async () => {
  // Over the cap (2400 bytes) but within the Teams cap: not embedded, so it cannot push the pill out of a row.
  const svc = service({ fallbacks: [async () => photo(fakePng(32, 32, 3000))] });
  await svc.avatarsFor([{ name: 'Alice Example' }]);
  assert.equal(svc.peek({ name: 'Alice Example' }), null);
  const small = service({ fallbacks: [async () => photo(fakePng(32, 32, 1500))] });
  await small.avatarsFor([{ name: 'Alice Example' }]);
  assert.ok(small.peek({ name: 'Alice Example' }));
  const out = loadAvatarOverrides([{ name: 'Big', file: '/big.png' }, { name: 'Ok', file: '/ok.png' }], {
    readFile: (f) => Buffer.from(f === '/big.png' ? fakePng(32, 32, 3000) : fakePng(32, 32, 1500)),
  });
  assert.deepEqual(out.map((o) => o.name), ['Ok']);
});

test('Jira: falls back to the 24 px picture when the 32 px one is too big, and takes neither if both are', async () => {
  const sized = (big32, big24) =>
    router([
      ['/rest/api/2/user/search', response(200, { json: [jiraUser({ avatarUrls: { '32x32': avatarUrl(1), '24x24': avatarUrl(2) } })] })],
      ['avatarId=1', response(200, { bytes: fakePng(32, 32, big32 ? 5000 : 0), type: 'image/png' })],
      ['avatarId=2', response(200, { bytes: fakePng(24, 24, big24 ? 5000 : 0), type: 'image/png' })],
    ]);
  let r = await createJiraAvatarSource({ jira: jiraClient, fetchFn: sized(true, false) }).fetch({ name: 'Alice Example' });
  assert.deepEqual([...r.bytes], [...fakePng(24, 24)]);
  r = await createJiraAvatarSource({ jira: jiraClient, fetchFn: sized(true, true) }).fetch({ name: 'Alice Example' });
  assert.deepEqual(r, { kind: 'none' });
});

test('a merge request card keeps the approval pill and shows the bot picture next to the author photo', () => {
  const photoOf = (extra) => dataUriOf(fakePng(32, 32, extra));
  const mr = {
    iid: 1,
    title: 'Example',
    project: 'group/app',
    url: 'https://gitlab.example.com/group/app/-/merge_requests/1',
    state: 'open',
    approved: true,
    author: 'Alice Example',
    approvedBy: ['Example Bot'],
  };
  // The sizes of a Teams photo and of the shipped bot logo (a 32 px PNG of about 2 KB).
  const card = buildMergeRequestCard({ ...mr, avatars: { 'Alice Example': photoOf(1500), 'Example Bot': photoOf(2000) } });
  const text = JSON.stringify(card);
  assert.ok(!text.includes('👍 By'), 'the pill is kept, so the plain-text lead is not needed');
  assert.ok(text.includes(photoOf(2000)), 'the bot picture is shown');
  assert.ok(text.includes(photoOf(1500)), 'the author photo is shown');
  // A picture too big for the card budget must not be what decides: keep the cap documented here.
  const oversized = buildMergeRequestCard({ ...mr, avatars: { 'Alice Example': photoOf(1500), 'Example Bot': photoOf(6000) } });
  assert.ok(!JSON.stringify(oversized).includes(photoOf(6000)), 'over the budget it is not embedded');
});
