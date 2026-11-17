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

test('search fallback fails closed when the result page is full (truncated)', async () => {
  const asked = [];
  const svc = new AvatarService({
    directory: defaultDirectory(),
    searchLimit: 3,
    searchFn: async (name, limit) => {
      asked.push(limit);
      return [
        { displayName: 'Frank Example', mri: DAVE },
        { displayName: 'Other Person', mri: CAROL },
        { displayName: 'Another Person', mri: BOB },
      ];
    },
    fetchPhoto: async () => assert.fail('must not fetch when uniqueness cannot be established'),
  });
  assert.deepEqual(await svc.avatarsFor(['Frank Example']), {});
  assert.deepEqual(asked, [3], 'the search is asked for the configured limit');
  await svc.avatarsFor(['Frank Example']);
  assert.equal(asked.length, 1, 'the negative answer is cached');
});

test('searches share the concurrency cap and are deduplicated', async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const svc = new AvatarService({
    directory: defaultDirectory(),
    concurrency: 2,
    searchFn: async () => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return [];
    },
    fetchPhoto: async () => photo(),
  });
  await Promise.all([
    svc.avatarsFor(['Frank Example', 'Grace Example', 'Heidi Example', 'Ivan Example']),
    svc.avatarsFor(['Frank Example']),
  ]);
  assert.equal(peak, 2);
  assert.equal(calls, 4, 'one search per distinct name');
});

test('failing searches open the circuit breaker for searches and photos alike', async () => {
  const clk = clock();
  let searches = 0;
  const svc = new AvatarService({
    directory: defaultDirectory(),
    now: clk.now,
    breakerThreshold: 2,
    breakerMs: 60_000,
    searchFn: async () => {
      searches++;
      throw new Error('directory down');
    },
    fetchPhoto: async () => photo(),
  });
  await svc.avatarsFor(['Frank Example']);
  await svc.avatarsFor(['Grace Example']);
  assert.equal(svc.breakerOpen, true);
  await svc.avatarsFor(['Heidi Example']);
  assert.equal(searches, 2, 'no search while the breaker is open');
  assert.deepEqual(await svc.avatarsFor(['Alice Example']), {}, 'photos pause too');
  clk.advance(61_000);
  assert.equal(svc.breakerOpen, false);
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

test('pictures are cached per requested size and never mix', async () => {
  const sizes = [];
  const svc = new AvatarService({
    directory: defaultDirectory(),
    fetchPhoto: async (mri, size) => (sizes.push(size), photo()),
  });
  assert.equal(svc.peek('Alice Example', { size: 'HR24x24' }), null);
  await svc.avatarsFor(['Alice Example'], { size: 'HR24x24' });
  assert.deepEqual(sizes, ['HR24x24']);
  assert.ok(svc.peek('Alice Example', { size: 'HR24x24' }));
  assert.equal(svc.peek('Alice Example'), null, 'a list picture is not served as the default size');
  await svc.avatarsFor(['Alice Example']);
  assert.deepEqual(sizes, ['HR24x24', 'HR32x32'], 'the default size is fetched on its own');
  await svc.avatarsFor(['Alice Example'], { size: 'HR24x24' });
  await svc.avatarsFor(['Alice Example']);
  assert.equal(sizes.length, 2, 'both variants are cached');
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

test('fetcher can ask for another supported size, and refuses unsupported ones', async () => {
  const seen = [];
  const fetchPhoto = createTeamsPhotoFetcher({
    loadAuth: () => AUTH,
    fetchFn: async (url) => (seen.push(url), fakeResponse(200, { headers: REAL })),
  });
  assert.equal((await fetchPhoto(ALICE, 'HR24x24')).kind, 'photo');
  assert.ok(seen[0].endsWith('/profilepicturev2?size=HR24x24'));
  await assert.rejects(() => fetchPhoto(ALICE, 'HR24x24&x=1'), /Unsupported avatar size/);
  assert.equal(seen.length, 1);
});

test('fetcher treats missing photo headers, 404 and non-images as no picture', async () => {
  const run = (response) =>
    createTeamsPhotoFetcher({ loadAuth: () => AUTH, fetchFn: async () => response })(ALICE);
  assert.deepEqual(await run(fakeResponse(200, { headers: { 'content-type': 'image/jpeg' } })), { kind: 'none' }, 'placeholder');
  assert.deepEqual(await run(fakeResponse(404)), { kind: 'none' });
  assert.deepEqual(await run(fakeResponse(200, { headers: { ...REAL, 'content-type': 'text/html' } })), { kind: 'none' });
  assert.deepEqual(await run(fakeResponse(200, { headers: { ...REAL, 'content-length': '999999' } })), { kind: 'none' });
});

test('fetcher stops reading a body that exceeds the cap even without a content-length', async () => {
  let cancelled = false;
  let reads = 0;
  const chunk = new Uint8Array(4096);
  const res = fakeResponse(200, { headers: REAL });
  res.body = {
    getReader: () => ({
      read: async () => (++reads > 100 ? { done: true } : { done: false, value: chunk }),
      cancel: async () => {
        cancelled = true;
      },
    }),
  };
  res.arrayBuffer = async () => assert.fail('the whole body must not be buffered');
  const out = await createTeamsPhotoFetcher({ loadAuth: () => AUTH, fetchFn: async () => res, maxBytes: 12 * 1024 })(ALICE);
  assert.deepEqual(out, { kind: 'none' });
  assert.equal(cancelled, true);
  assert.ok(reads <= 4, 'reading stopped right after the cap');
});

test('fetcher reads a small streamed body completely', async () => {
  const bytes = fakeJpeg();
  const res = fakeResponse(200, { headers: REAL });
  let sent = false;
  res.body = {
    getReader: () => ({
      read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })),
      cancel: async () => {},
    }),
  };
  const out = await createTeamsPhotoFetcher({ loadAuth: () => AUTH, fetchFn: async () => res })(ALICE);
  assert.equal(out.kind, 'photo');
  assert.equal(out.bytes.length, bytes.length);
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
const factOf = (card, label) => items(card).find((i) => i.type === 'ColumnSet' && i.columns[0].items[0].text === label);
// A person row is [label, one stretch value column of person lines]; a person line is [lead?, picture|spacer, name].
const isPersonLine = (line) => line.type === 'ColumnSet' && line.columns.some((c) => c.items[0].type === 'Image' && c.items[0].style === 'Person');
const rows = (card) => items(card).filter((i) => i.type === 'ColumnSet' && i.columns[1]?.items?.some(isPersonLine));
const linesOf = (row) => row.columns[1].items;
const lineTexts = (line) => line.columns.map((c) => c.items[0].text ?? c.items[0].altText);
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

test('jira assignee gets a round 20px picture next to the name', () => {
  const card = buildJiraIssueCard({ ...JIRA, avatars: { 'Alice Example': URI } });
  const [row] = rows(card);
  assert.ok(row);
  const [label, value] = row.columns;
  const [avatar, name] = linesOf(row)[0].columns.filter((c) => c.items[0].text !== '\u00A0');
  assert.equal(label.items[0].text, 'Assignee');
  assert.equal(value.width, 'stretch');
  assert.deepEqual(
    { type: avatar.items[0].type, style: avatar.items[0].style, width: avatar.items[0].width, height: avatar.items[0].height, altText: avatar.items[0].altText, url: avatar.items[0].url },
    { type: 'Image', style: 'Person', width: '20px', height: '20px', altText: 'Alice Example', url: URI },
  );
  assert.equal(name.items[0].text, 'Alice Example');
  assert.equal(items(card).filter((i) => i.type === 'FactSet').length, 0, 'a picture turns the facts into aligned rows');
  assert.equal(items(card).filter((i) => i.type === 'ColumnSet' && i.columns[0].items[0].text === 'Assignee').length, 1, 'assignee only once');
  assert.ok(factOf(card, 'Priority'), 'other facts kept');
  assert.equal(label.width, factOf(card, 'Priority').columns[0].width, 'label widths match');
});

test('merge request card: pending to approved keeps one fixed label column and one value origin on every row', () => {
  const base = {
    ...MR,
    author: 'Alice Example',
    approved: false,
    approvedBy: [],
    autoMerge: false,
    autoMergeUser: undefined,
    pipeline: { id: 7, status: 'success' },
    pipelineKnown: true,
    jira: { key: 'EX-1', url: 'https://jira.example.com/browse/EX-1' },
    avatars: { 'Alice Example': URI, 'Bob Example': URI },
  };
  const approved = { ...base, approved: true, approvedBy: ['Bob Example'], autoMerge: true, autoMergeUser: 'Bob Example' };
  const labels = ['Status', 'Author', 'Pipeline', 'Target', 'Ticket'];
  for (const [state, data, expected] of [
    ['pending', base, labels],
    ['approved', approved, ['Status', 'Author', 'Approval', 'Pipeline', 'Auto-merge', 'Target', 'Ticket']],
  ]) {
    const card = buildMergeRequestCard(data);
    assert.equal(items(card).filter((i) => i.type === 'FactSet').length, 0, `${state}: no auto-sized FactSet left`);
    const rowsOf = items(card).filter((i) => i.type === 'ColumnSet' && expected.includes(i.columns[0].items?.[0]?.text));
    assert.deepEqual(rowsOf.map((r) => r.columns[0].items[0].text), expected, `${state}: every fact keeps its row, in order`);
    const firstWidths = new Set(rowsOf.map((r) => r.columns[0].width));
    assert.equal(firstWidths.size, 1, `${state}: one label width`);
    assert.match([...firstWidths][0], /^\d+px$/, `${state}: a fixed pixel label column`);
    for (const r of rowsOf) assert.equal(r.columns[0].items[0].weight, 'Bolder', `${state}: bold labels`);
  }
  const pendingWidth = factOf(buildMergeRequestCard(base), 'Status').columns[0].width;
  assert.notEqual(pendingWidth, 'auto');
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
  assert.equal(approval.columns[0].items[0].text, 'Approval');
  assert.deepEqual(linesOf(approval).map(lineTexts), [['👍 By', 'Alice Example', 'Alice Example'], ['\u00A0', 'Bob Example', 'Bob Example']]);
  assert.equal(autoMerge.columns[0].items[0].text, 'Auto-merge');
  assert.deepEqual(linesOf(autoMerge).map(lineTexts), [['🔀 By', 'Carol Example', 'Carol Example']]);
  const order = items(card).filter((i) => i.type === 'ColumnSet').map((i) => i.columns[0].items[0].text ?? '');
  assert.ok(order.indexOf('Approval') < order.indexOf('Auto-merge'));
  assert.ok(order.includes('Status') && order.includes('Target'), 'plain facts stay, as rows');
});

test('a person without a picture next to one with a picture keeps their name', () => {
  const card = buildMergeRequestCard({ ...MR, avatars: { 'Bob Example': URI } });
  const [approval] = rows(card);
  assert.equal(approval.columns[0].items[0].text, 'Approval');
  assert.deepEqual(linesOf(approval).map(lineTexts), [['👍 By', '\u00A0', 'Alice Example'], ['\u00A0', 'Bob Example', 'Bob Example']]);
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

test('person rows wrap only their name: one stretch value column, fixed lead and picture cells', () => {
  const card = buildMergeRequestCard({ ...MR, avatars: { 'Alice Example': URI, 'Bob Example': URI, 'Carol Example': URI } });
  const labelWidth = factOf(card, 'Status').columns[0].width;
  const personRows = rows(card);
  assert.ok(personRows.length >= 2, 'approval and auto-merge rows');
  for (const row of personRows) {
    // Same shape as the plain fact rows: a fixed label cell, then a single stretch value cell.
    assert.equal(row.columns.length, 2);
    assert.equal(row.columns[0].width, labelWidth, 'the 112px label column and the same value origin');
    assert.equal(row.columns[1].width, 'stretch');
    for (const line of linesOf(row)) {
      assert.equal(line.type, 'ColumnSet');
      const widths = line.columns.map((c) => c.width);
      assert.equal(widths.filter((w) => w === 'stretch').length, 1, 'exactly one flexible column per line');
      assert.equal(widths.at(-1), 'stretch', 'and it is the name');
      assert.equal(widths.includes('auto'), false, 'no auto-sized column that could be squeezed character by character');
      for (const c of line.columns.slice(0, -1)) assert.match(c.width, /^\d+px$/);
      for (const c of line.columns) {
        const block = c.items[0];
        if (block.type === 'TextBlock' && c.width !== 'stretch') assert.equal(block.wrap, false, 'lead and spacers never wrap');
      }
      assert.equal(line.columns.at(-1).items[0].wrap, true, 'the name wraps');
    }
  }
  // The lead is the short "By", not "Approved by": nothing to break on a phone.
  const json = JSON.stringify(card);
  assert.equal(json.includes('Approved by'), false);
  assert.equal(json.includes('Enabled by'), false);
  assert.ok(json.includes('\u{1F44D} By'));
});

test('userRow stacks several people into one value column and aligns names without a picture', () => {
  const { row } = userRow('Approval', [{ name: 'Alice Example', avatar: URI }, { name: 'Bob Example' }, { name: 'Carol Example', avatar: URI }], { lead: '👍 By', labelWidth: '112px' });
  assert.deepEqual(row.columns.map((c) => c.width), ['112px', 'stretch']);
  const lines = row.columns[1].items;
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => l.columns.length), [3, 3, 3], 'every line has lead, picture-or-spacer, name');
  assert.deepEqual(lines.map((l) => l.columns[0].width), ['42px', '42px', '42px'], 'one lead width keeps the names aligned');
  assert.equal(lines[0].columns[0].items[0].text, '👍 By');
  assert.equal(lines[1].columns[0].items[0].text, '\u00A0');
  assert.equal(lines[1].columns[1].width, `${20}px`, 'spacer stands in for the missing picture');
  assert.equal(row.columns[0].verticalContentAlignment, 'Top', 'the label stays with the first line');
  const single = userRow('Author', [{ name: 'Alice Example', avatar: URI }], { labelWidth: '112px' });
  assert.deepEqual(single.row.columns[1].items[0].columns.map((c) => c.width), ['20px', 'stretch'], 'no lead column without a lead');
  assert.equal(single.row.columns[0].verticalContentAlignment, 'Center');
});

test('pictures per row and per card are capped and the rest falls back to names', () => {
  const approvers = ['Alice Example', 'Bob Example', 'Carol Example', 'Dave Example'];
  const avatars = Object.fromEntries(approvers.map((n) => [n, URI]));
  const card = buildMergeRequestCard({ ...MR, approvedBy: approvers, avatars });
  assert.equal(images(card), 3 + 1, 'three approvers (row cap) and the auto-merge user');
  const [approval] = rows(card);
  assert.ok(linesOf(approval).some((l) => l.columns.some((c) => c.items[0].text === 'Dave Example')), 'fourth approver by name');

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

test('merge request author gets a labeled picture row, aligned with the other fact labels', () => {
  const card = buildMergeRequestCard({ ...MR, author: 'Dave Example', avatars: { 'Dave Example': URI } });
  const row = factOf(card, 'Author');
  assert.equal(row.columns[0].items[0].text, 'Author');
  assert.deepEqual(linesOf(row).map(lineTexts), [['Dave Example', 'Dave Example']]);
  const picture = linesOf(row)[0].columns[0].items[0];
  assert.equal(picture.style, 'Person');
  assert.equal(picture.url, URI);
  assert.equal(row.columns[0].items[0].weight, 'Bolder');
  assert.equal(row.columns[0].width, factOf(card, 'Status').columns[0].width);
  const order = items(card).map((i) => i.columns?.[0].items[0].text);
  assert.ok(order.indexOf('Status') < order.indexOf('Author') && order.indexOf('Author') < order.indexOf('Approval'));
});

test('merge request author without a picture is a plain Author fact; no author, no row', () => {
  const plain = buildMergeRequestCard({ ...MR, author: 'Dave Example' });
  const set = items(plain).find((i) => i.type === 'FactSet');
  assert.deepEqual(set.facts.find((f) => f.title === 'Author'), { title: 'Author', value: 'Dave Example' });
  assert.equal(images(plain), 0);
  for (const author of [undefined, null, '', '  ']) {
    const card = buildMergeRequestCard({ ...MR, author, avatars: { 'Dave Example': URI } });
    assert.ok(!JSON.stringify(card).includes('"Author"'));
  }
});

test('merge request author, first in fact order, takes the shared picture budget; later names stay', () => {
  const big = `data:image/jpeg;base64,${'A'.repeat(4800)}`;
  const card = buildMergeRequestCard({
    ...MR,
    author: 'Dave Example',
    avatars: { 'Dave Example': big, 'Alice Example': big, 'Bob Example': big },
  });
  const text = JSON.stringify(card);
  assert.ok(text.includes('Dave Example'), 'the name is never dropped');
  // Only one picture of this size fits the shared budget; the author, first in fact order, gets it.
  assert.equal(images(card), 1);
  assert.ok(linesOf(factOf(card, 'Author'))[0].columns.some((c) => c.items[0].type === 'Image'));
});
