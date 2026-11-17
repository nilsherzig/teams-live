import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AvatarService,
  createTeamsPhotoFetcher,
  inspectImage,
  isOrgIdMri,
} from '../src/avatars.mjs';
import {
  MAX_AVATAR_CHARS_PER_CARD,
  collectCardPeople,
  isImageDataUri,
  userRow,
} from '../src/card-user-row.mjs';
import { buildJiraIssueCard, buildMergeRequestCard, buildOpsGenieAlertCard, MAX_CARD_BYTES } from '../src/cards.mjs';
import { makeRichMessage, richMessageWireBytes } from '../src/teams.mjs';

// All people, ids and pictures below are generic fixtures.
const ALICE = '8:orgid:00000000-0000-4000-8000-00000000000a';
const BOB = '8:orgid:00000000-0000-4000-8000-00000000000b';
const CAROL = '8:orgid:00000000-0000-4000-8000-00000000000c';
const DAVE = '8:orgid:00000000-0000-4000-8000-00000000000d';

function fakeJpeg(width = 32, height = 32, extra = 0) {
  const head = [
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255,
    0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9,
  ];
  return Uint8Array.from([...head, ...new Array(8 + extra).fill(7)]);
}

function fakePng(width = 32, height = 32) {
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    ...u32(width), ...u32(height), 8, 2, 0, 0, 0, 0, 0, 0, 0,
  ]);
}

const person = (displayName, mri, email = '') => ({ displayName, mri, email });
const directoryOf = (...users) => ({ users: new Map(users.map((u) => [u.mri, u])) });
const defaultDirectory = () =>
  directoryOf(
    person('Alice Example', ALICE, 'alice.example@example.com'),
    person('Bob Example', BOB, 'bob.example@example.com'),
    person('Carol Example', CAROL),
  );

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t, advance: (ms) => (c.t += ms) };
  return c;
}

const photo = (bytes = fakeJpeg()) => ({ kind: 'photo', bytes });

// ── image validation ────────────────────────────────────────────────────────

test('inspectImage accepts small JPEG and PNG and reports their size', () => {
  assert.deepEqual(inspectImage(fakeJpeg(32, 24)), { mime: 'image/jpeg', width: 32, height: 24 });
  assert.deepEqual(inspectImage(fakePng(48, 48)), { mime: 'image/png', width: 48, height: 48 });
});

test('inspectImage rejects oversized, malformed and foreign content', () => {
  assert.equal(inspectImage(fakeJpeg(512, 512)), null, 'too many pixels');
  assert.equal(inspectImage(fakePng(129, 32)), null, 'too wide');
  assert.equal(inspectImage(fakeJpeg(32, 32, 20_000)), null, 'too many bytes');
  assert.equal(inspectImage(fakeJpeg(0, 0)), null, 'zero size');
  assert.equal(inspectImage(new TextEncoder().encode('<html><body>login</body></html> padding padding')), null);
  assert.equal(inspectImage(new TextEncoder().encode('GIF89a' + 'x'.repeat(40))), null);
  assert.equal(inspectImage(fakeJpeg().subarray(0, 12)), null, 'truncated');
  assert.equal(inspectImage(null), null);
});

// ── identity matching ───────────────────────────────────────────────────────

test('resolveKnown maps only exact known identities', () => {
  const svc = new AvatarService({ directory: defaultDirectory(), fetchPhoto: async () => photo() });
  assert.equal(svc.resolveKnown('Alice Example'), ALICE);
  assert.equal(svc.resolveKnown('  alice   EXAMPLE '), ALICE, 'case and spacing only');
  assert.equal(svc.resolveKnown({ mri: BOB }), BOB);
  assert.equal(svc.resolveKnown('alice.example@example.com'), ALICE);
  assert.equal(svc.resolveKnown({ email: 'BOB.EXAMPLE@example.com' }), BOB);
});

test('resolveKnown refuses fuzzy, partial, single-word and guessed matches', () => {
  const svc = new AvatarService({ directory: defaultDirectory(), fetchPhoto: async () => photo() });
  assert.equal(svc.resolveKnown('Alice Exampl'), null, 'near miss');
  assert.equal(svc.resolveKnown('Alice'), null, 'first name only');
  assert.equal(svc.resolveKnown('Example'), null, 'surname only');
  assert.equal(svc.resolveKnown('alice.example'), null, 'email prefix or username');
  assert.equal(svc.resolveKnown('aexample'), null, 'guessed username');
  assert.equal(svc.resolveKnown('Alice Q Example'), null, 'extra token');
  assert.equal(svc.resolveKnown('Zed Unknown'), null);
  assert.equal(svc.resolveKnown({ mri: 'user:alice-example' }), null, 'synthetic MRI');
  assert.equal(svc.resolveKnown({ mri: '8:orgid:not-a-uuid' }), null);
  assert.equal(svc.resolveKnown(''), null);
  assert.equal(svc.resolveKnown(null), null);
});

test('resolveKnown ignores directory users that only have a synthetic MRI', () => {
  const svc = new AvatarService({
    directory: directoryOf(person('Erin Example', 'user:erin-example')),
    fetchPhoto: async () => photo(),
  });
  assert.equal(svc.resolveKnown('Erin Example'), null);
});

test('resolveKnown returns nothing when two known people share a name', () => {
  const svc = new AvatarService({
    directory: directoryOf(person('Alice Example', ALICE), person('Alice Example', DAVE)),
    fetchPhoto: async () => photo(),
  });
  assert.equal(svc.resolveKnown('Alice Example'), null);
});

test('search fallback accepts exactly one equal-name hit with an orgid MRI', async () => {
  const calls = [];
  const searchFn = async (name) => {
    calls.push(name);
    return [{ displayName: 'Frank Example', mri: DAVE }, { displayName: 'Frank Examples', mri: CAROL }];
  };
  const fetched = [];
  const svc = new AvatarService({
    directory: defaultDirectory(),
    searchFn,
    fetchPhoto: async (mri) => (fetched.push(mri), photo()),
  });
  const out = await svc.avatarsFor(['Frank Example']);
  assert.deepEqual(fetched, [DAVE]);
  assert.ok(isImageDataUri(out['Frank Example']));
  await svc.avatarsFor(['Frank Example']);
  assert.equal(calls.length, 1, 'search result is cached');
  assert.equal(svc.peek('Frank Example'), out['Frank Example'], 'peek sees search-resolved people');

  const ambiguous = new AvatarService({
    directory: defaultDirectory(),
    searchFn: async () => [
      { displayName: 'Frank Example', mri: DAVE },
      { displayName: 'Frank Example', mri: CAROL },
    ],
    fetchPhoto: async () => assert.fail('must not fetch for an ambiguous name'),
  });
  assert.deepEqual(await ambiguous.avatarsFor(['Frank Example']), {});
});

test('isOrgIdMri', () => {
  assert.equal(isOrgIdMri(ALICE), true);
  assert.equal(isOrgIdMri('8:live:someone'), false);
  assert.equal(isOrgIdMri(undefined), false);
});

// ── service: cache, dedupe, limits, failure ─────────────────────────────────

test('avatarsFor embeds a data URI and caches it', async () => {
  let fetches = 0;
  const svc = new AvatarService({
    directory: defaultDirectory(),
    fetchPhoto: async () => (fetches++, photo()),
  });
  const first = await svc.avatarsFor(['Alice Example', 'Alice Example']);
  assert.match(first['Alice Example'], /^data:image\/jpeg;base64,/);
  await svc.avatarsFor(['Alice Example']);
  assert.equal(fetches, 1);
  assert.equal(svc.peek('Alice Example'), first['Alice Example'], 'peek reads the cache without a request');
  assert.equal(svc.peek('Bob Example'), null);
  assert.equal(fetches, 1);
});

test('concurrent lookups of one identity share a single request', async () => {
  let fetches = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const svc = new AvatarService({
    directory: defaultDirectory(),
    fetchPhoto: async () => {
      fetches++;
      await gate;
      return photo();
    },
  });
  const a = svc.avatarsFor(['Alice Example'], { deadlineMs: 1000 });
  const b = svc.avatarsFor(['Alice Example'], { deadlineMs: 1000 });
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(fetches, 1);
  assert.deepEqual(ra, rb);
});

test('parallel requests are capped', async () => {
  let active = 0;
  let peak = 0;
  const svc = new AvatarService({
    directory: defaultDirectory(),
    concurrency: 2,
    fetchPhoto: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return photo();
    },
  });
  const out = await svc.avatarsFor(['Alice Example', 'Bob Example', 'Carol Example']);
  assert.equal(Object.keys(out).length, 3);
  assert.equal(peak, 2);
});

test('entries expire: pictures after the TTL, misses after the negative TTL', async () => {
  const c = clock();
  const calls = { [ALICE]: 0, [BOB]: 0 };
  const svc = new AvatarService({
    directory: defaultDirectory(),
    now: c.now,
    ttlMs: 1000,
    negativeTtlMs: 5000,
    fetchPhoto: async (mri) => {
      calls[mri]++;
      return mri === ALICE ? photo() : { kind: 'none' };
    },
  });
  await svc.avatarsFor(['Alice Example', 'Bob Example']);
  c.advance(999);
  await svc.avatarsFor(['Alice Example', 'Bob Example']);
  assert.deepEqual(calls, { [ALICE]: 1, [BOB]: 1 });
  c.advance(2);
  await svc.avatarsFor(['Alice Example', 'Bob Example']);
  assert.deepEqual(calls, { [ALICE]: 2, [BOB]: 1 }, 'picture refreshed, miss still cached');
  c.advance(5000);
  await svc.avatarsFor(['Bob Example']);
  assert.equal(calls[BOB], 2);
});

test('failures give name only, never throw, and are retried only after the error TTL', async () => {
  const c = clock();
  let fetches = 0;
  const svc = new AvatarService({
    directory: defaultDirectory(),
    now: c.now,
    errorTtlMs: 1000,
    fetchPhoto: async () => {
      fetches++;
      throw new Error('status 403');
    },
  });
  assert.deepEqual(await svc.avatarsFor(['Alice Example']), {});
  assert.deepEqual(await svc.avatarsFor(['Alice Example']), {});
  assert.equal(fetches, 1, 'no request storm per render');
  c.advance(1001);
  await svc.avatarsFor(['Alice Example']);
  assert.equal(fetches, 2);
});

test('a failing endpoint opens the circuit breaker and closes it again later', async () => {
  const c = clock();
  let fetches = 0;
  let healthy = false;
  const logs = [];
  const origError = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const svc = new AvatarService({
      directory: directoryOf(
        person('Alice Example', ALICE), person('Bob Example', BOB), person('Carol Example', CAROL), person('Dave Example', DAVE),
      ),
      now: c.now,
      breakerThreshold: 2,
      breakerMs: 60_000,
      errorTtlMs: 10,
      concurrency: 1,
      fetchPhoto: async () => {
        fetches++;
        if (!healthy) throw new Error('status 503');
        return photo();
      },
    });
    await svc.avatarsFor(['Alice Example']);
    await svc.avatarsFor(['Bob Example']);
    assert.equal(svc.breakerOpen, true);
    const before = fetches;
    assert.deepEqual(await svc.avatarsFor(['Carol Example', 'Dave Example']), {});
    assert.equal(fetches, before, 'no requests while the breaker is open');
    healthy = true;
    c.advance(60_001);
    assert.equal(svc.breakerOpen, false);
    assert.ok((await svc.avatarsFor(['Carol Example']))['Carol Example']);
    assert.equal(logs.filter((l) => l.includes('paused')).length, 1);
  } finally {
    console.error = origError;
  }
});

test('a slow picture does not hold the card back and lands in the cache for the next one', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const svc = new AvatarService({
    directory: defaultDirectory(),
    fetchPhoto: async () => {
      await gate;
      return photo();
    },
  });
  const out = await svc.avatarsFor(['Alice Example'], { deadlineMs: 10 });
  assert.deepEqual(out, {});
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(out, {}, 'the returned object is not mutated later');
  assert.ok(svc.peek('Alice Example'));
});

test('unknown people cost no request, and bad or oversized photos give name only', async () => {
  let fetches = 0;
  const svc = new AvatarService({
    directory: defaultDirectory(),
    fetchPhoto: async (mri) => {
      fetches++;
      if (mri === ALICE) return photo(fakeJpeg(512, 512));
      if (mri === BOB) return photo(new TextEncoder().encode('not an image at all, just some text'));
      return { kind: 'none' };
    },
  });
  const out = await svc.avatarsFor(['Zed Unknown', 'Alice', 'Alice Example', 'Bob Example', 'Carol Example']);
  assert.deepEqual(out, {});
  assert.equal(fetches, 3, 'only the three exactly known people were looked up');
});

test('the cache is bounded', async () => {
  const svc = new AvatarService({
    directory: defaultDirectory(),
    maxEntries: 2,
    fetchPhoto: async () => photo(),
  });
  await svc.avatarsFor(['Alice Example']);
  await svc.avatarsFor(['Bob Example']);
  await svc.avatarsFor(['Carol Example']);
  assert.equal(svc.cache.size, 2);
  assert.equal(svc.peek('Alice Example'), null, 'oldest entry evicted');
});

// ── default Teams fetcher ───────────────────────────────────────────────────

const AUTH = {
  ok: true,
  value: {
    skypeToken: 'FAKE_FIXTURE_A',
    spacesToken: 'FAKE_FIXTURE_B',
    regionConfig: { teamsBaseUrl: 'https://teams.example.com', regionPartition: 'emea', hasPartition: true },
  },
};

function fakeResponse(status, { headers = {}, body = fakeJpeg() } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
}
const REAL = { 'content-type': 'image/jpeg', etag: '"abc"', 'x-profile-picture-user-hashed-id': 'h' };

test('fetcher asks the Teams API for a small picture with the bot credentials', async () => {
  const seen = [];
  const fetchPhoto = createTeamsPhotoFetcher({
    loadAuth: () => AUTH,
    fetchFn: async (url, init) => (seen.push({ url, init }), fakeResponse(200, { headers: REAL })),
  });
  const result = await fetchPhoto(ALICE);
  assert.equal(result.kind, 'photo');
  assert.equal(seen.length, 1);
  assert.equal(
    seen[0].url,
    `https://teams.example.com/api/mt/part/emea/beta/users/${encodeURIComponent(ALICE)}/profilepicturev2?size=HR32x32`,
  );
  assert.equal(seen[0].init.redirect, 'error', 'credentials never follow a redirect');
  assert.equal(seen[0].init.headers.Accept, 'image/*');
  assert.match(seen[0].init.headers.Authentication, /^skypetoken=/);
});

test('fetcher treats missing photo headers, 404 and non-images as no picture', async () => {
  const run = (response) =>
    createTeamsPhotoFetcher({ loadAuth: () => AUTH, fetchFn: async () => response })(ALICE);
  assert.deepEqual(await run(fakeResponse(200, { headers: { 'content-type': 'image/jpeg' } })), { kind: 'none' }, 'placeholder');
  assert.deepEqual(await run(fakeResponse(404)), { kind: 'none' });
  assert.deepEqual(await run(fakeResponse(200, { headers: { ...REAL, 'content-type': 'text/html' } })), { kind: 'none' });
  assert.deepEqual(await run(fakeResponse(200, { headers: { ...REAL, 'content-length': '999999' } })), { kind: 'none' });
});

test('fetcher errors carry neither URL nor token', async () => {
  const failing = (fetchFn, loadAuth = () => AUTH) => createTeamsPhotoFetcher({ loadAuth, fetchFn })(ALICE);
  await assert.rejects(failing(async () => fakeResponse(503)), (e) => e.message === 'status 503');
  await assert.rejects(failing(async () => fakeResponse(403)), (e) => e.message === 'status 403');
  await assert.rejects(
    failing(async () => {
      throw new Error('connect failed to teams.example.com using FAKE_FIXTURE_VALUE');
    }),
    (e) => e.message === 'network' && !/FAKE_FIXTURE_VALUE|teams\.example/.test(e.message),
  );
  await assert.rejects(failing(async () => assert.fail('no request without auth'), () => ({ ok: false })), (e) => e.message === 'status 401');
});

test('fetcher never requests anything for a non-orgid identity or an odd size', async () => {
  let calls = 0;
  const fetchPhoto = createTeamsPhotoFetcher({ loadAuth: () => AUTH, fetchFn: async () => (calls++, fakeResponse(200)) });
  assert.deepEqual(await fetchPhoto('user:alice-example'), { kind: 'none' });
  assert.deepEqual(await fetchPhoto('8:orgid:../../x'), { kind: 'none' });
  assert.equal(calls, 0);
  assert.throws(() => createTeamsPhotoFetcher({ size: 'HR32x32&x=1' }), /Unsupported/);
});

// ── card rows ───────────────────────────────────────────────────────────────

const URI = `data:image/jpeg;base64,${Buffer.from(fakeJpeg()).toString('base64')}`;
const bigUri = (n) => `data:image/jpeg;base64,${'A'.repeat(n)}`;
const items = (card) => card.body[0].items;
const rows = (card) => items(card).filter((i) => i.type === 'ColumnSet' && i.columns.some((c) => c.items[0].type === 'Image' && c.items[0].style === 'Person'));
// Profile pictures only: the service icon in the header is an Image too.
const images = (card) => JSON.stringify(card).match(/"type":"Image"[^}]*"style":"Person"/g)?.length ?? 0;

const JIRA = { key: 'EX-1', summary: 'Example issue', status: 'In Progress', statusCategory: 'indeterminate', priority: 'High', assignee: 'Alice Example', url: 'https://jira.example.com/browse/EX-1' };
const MR = {
  iid: 7, title: 'Example MR', project: 'group/project', url: 'https://gitlab.example.com/group/project/-/merge_requests/7',
  state: 'open', approved: true, approvedBy: ['Alice Example', 'Bob Example'], autoMerge: true, autoMergeUser: 'Carol Example', targetBranch: 'main',
};
const ALERT = { id: 'abcdef123456', tinyId: '12', message: 'Disk full', priority: 'P2', status: 'open', acknowledged: false, owner: 'Alice Example', url: 'https://opsgenie.example.com/a/12' };

test('regular output is byte-identical without pictures', () => {
  for (const [build, data] of [[buildJiraIssueCard, JIRA], [buildMergeRequestCard, MR], [buildOpsGenieAlertCard, ALERT]]) {
    const plain = JSON.stringify(build(data));
    assert.equal(JSON.stringify(build({ ...data, avatars: undefined })), plain);
    assert.equal(JSON.stringify(build({ ...data, avatars: {} })), plain);
    assert.equal(JSON.stringify(build({ ...data, avatars: { 'Somebody Else': URI } })), plain, 'pictures of other people are ignored');
    assert.equal(images(build(data)), 0);
  }
});

test('jira assignee gets a round 24px picture next to the name', () => {
  const card = buildJiraIssueCard({ ...JIRA, avatars: { 'Alice Example': URI } });
  const [row] = rows(card);
  assert.ok(row);
  const [label, avatar, name] = row.columns;
  assert.equal(label.items[0].text, 'Assignee');
  assert.deepEqual(
    { type: avatar.items[0].type, style: avatar.items[0].style, width: avatar.items[0].width, height: avatar.items[0].height, altText: avatar.items[0].altText, url: avatar.items[0].url },
    { type: 'Image', style: 'Person', width: '24px', height: '24px', altText: 'Alice Example', url: URI },
  );
  assert.equal(name.items[0].text, 'Alice Example');
  const factSets = items(card).filter((i) => i.type === 'FactSet');
  assert.ok(factSets.every((f) => !f.facts.some((x) => x.title === 'Assignee')), 'assignee only once');
  assert.ok(factSets.flatMap((f) => f.facts).some((x) => x.title === 'Priority'), 'other facts kept');
});

test('unassigned or picture-less people stay plain facts', () => {
  const unassigned = buildJiraIssueCard({ ...JIRA, assignee: '', avatars: { 'Alice Example': URI } });
  assert.equal(images(unassigned), 0);
  const placeholder = buildJiraIssueCard({ ...JIRA, assignee: 'Unassigned', avatars: { Unassigned: URI } });
  assert.equal(placeholder.body[0].items.some((i) => i.type === 'ColumnSet' && i.columns.length > 3), false);
});

test('merge request approvers and the auto-merge user get pictures, in fact order', () => {
  const card = buildMergeRequestCard({ ...MR, avatars: { 'Alice Example': URI, 'Bob Example': URI, 'Carol Example': URI } });
  const [approval, autoMerge] = rows(card);
  assert.deepEqual(approval.columns.map((c) => c.items[0].text ?? c.items[0].altText), ['Approval', '👍 Approved by', 'Alice Example', 'Alice Example', 'Bob Example', 'Bob Example']);
  assert.deepEqual(autoMerge.columns.map((c) => c.items[0].text ?? c.items[0].altText), ['Auto-merge', '🔀 Enabled by', 'Carol Example', 'Carol Example']);
  const order = items(card).map((i) => (i.type === 'FactSet' ? `F:${i.facts.map((f) => f.title).join(',')}` : i.type === 'ColumnSet' ? `R:${i.columns[0].items[0].text ?? ''}` : i.type));
  assert.ok(order.indexOf('R:Approval') < order.indexOf('R:Auto-merge'));
  assert.ok(order.some((o) => o.startsWith('F:') && o.includes('Status')));
});

test('a person without a picture next to one with a picture keeps their name', () => {
  const card = buildMergeRequestCard({ ...MR, avatars: { 'Bob Example': URI } });
  const [approval] = rows(card);
  const texts = approval.columns.map((c) => c.items[0]).filter((i) => i.type === 'TextBlock').map((i) => i.text);
  assert.deepEqual(texts, ['Approval', '👍 Approved by', 'Alice Example', 'Bob Example']);
  assert.equal(images(card), 1);
});

test('opsgenie owner gets a picture', () => {
  assert.equal(images(buildOpsGenieAlertCard({ ...ALERT, avatars: { 'Alice Example': URI } })), 1);
});

test('only plain image data URIs are embedded', () => {
  for (const bad of ['https://example.com/a.jpg', 'data:text/html;base64,AAAA', 'data:image/svg+xml;base64,AAAA', 'javascript:alert(1)', 'data:image/jpeg;base64,AA"AA', 42, '']) {
    assert.equal(images(buildJiraIssueCard({ ...JIRA, avatars: { 'Alice Example': bad } })), 0, String(bad));
  }
  assert.equal(isImageDataUri(URI), true);
});

test('pictures per row and per card are capped and the rest falls back to names', () => {
  const approvers = ['Alice Example', 'Bob Example', 'Carol Example', 'Dave Example'];
  const avatars = Object.fromEntries(approvers.map((n) => [n, URI]));
  const card = buildMergeRequestCard({ ...MR, approvedBy: approvers, avatars });
  assert.equal(images(card), 3 + 1, 'three approvers (row cap) and the auto-merge user');
  const [approval] = rows(card);
  assert.ok(approval.columns.some((c) => c.items[0].text === 'Dave Example'), 'fourth approver by name');

  const huge = bigUri(5000);
  const capped = buildMergeRequestCard({ ...MR, avatars: { 'Alice Example': huge, 'Bob Example': huge, 'Carol Example': huge } });
  const used = (JSON.stringify(capped).match(/data:image\/jpeg;base64,A+/g) || []).reduce((n, s) => n + s.length, 0);
  assert.ok(used <= MAX_AVATAR_CHARS_PER_CARD, `pictures use ${used} chars`);
  assert.equal(images(capped), 1, 'the second 5000-char picture would exceed the card budget');
});

test('a card with the largest pictures stays within the wire budget', () => {
  const approvers = ['Alice Example', 'Bob Example', 'Carol Example'];
  const each = Math.floor(MAX_AVATAR_CHARS_PER_CARD / 4);
  const avatars = Object.fromEntries([...approvers, 'Dave Example'].map((n) => [n, bigUri(each)]));
  const card = buildMergeRequestCard({ ...MR, approvedBy: approvers, autoMergeUser: 'Dave Example', avatars });
  const message = makeRichMessage('fallback markdown', card);
  assert.ok(richMessageWireBytes(message) <= MAX_CARD_BYTES, `wire bytes ${richMessageWireBytes(message)}`);
});

test('userRow returns null when nobody has a usable picture', () => {
  assert.equal(userRow('Assignee', [{ name: 'Alice Example' }]), null);
  assert.equal(userRow('Assignee', [{ name: 'Alice Example', avatar: 'https://example.com/a.png' }]), null);
  assert.equal(userRow('Assignee', []), null);
});

test('collectCardPeople lists people once, without placeholders', () => {
  assert.deepEqual(collectCardPeople(MR), ['Alice Example', 'Bob Example', 'Carol Example']);
  assert.deepEqual(collectCardPeople({ assignee: 'Unassigned' }), []);
  assert.deepEqual(collectCardPeople({ assignee: ' Alice Example ', owner: 'Alice Example' }), ['Alice Example']);
  assert.deepEqual(collectCardPeople({}), []);
  assert.deepEqual(collectCardPeople(null), []);
});
