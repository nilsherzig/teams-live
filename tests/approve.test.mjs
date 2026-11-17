import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ApproveServer, ApprovalStore, CsrfTokens, normalizeOwnerUsers } from '../src/approve.mjs';
import { buildMergeRequestCard } from '../src/cards.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';

const SECRET = 'proxy-secret-for-tests';
const ORIGIN = 'https://approve.example.com';
const SHA = 'a'.repeat(40);
const PROJECT = 'group/app';
const IID = 7;

function makeGitlab(overrides = {}) {
  const calls = { approve: [], getMr: 0, state: 0 };
  const gitlab = {
    calls,
    mr: { state: 'opened', draft: false, sha: SHA, title: 'Example change' },
    userState: { known: true, user: { id: 1, username: 'owner' }, hasApproved: false, canApprove: true },
    approveError: null,
    async getMr() {
      calls.getMr++;
      return gitlab.mr;
    },
    async getUserApprovalState() {
      calls.state++;
      return typeof gitlab.userState === 'function' ? gitlab.userState() : gitlab.userState;
    },
    async approveMr(project, iid, opts) {
      calls.approve.push({ project, iid, opts });
      if (gitlab.approveError) throw gitlab.approveError;
      return {};
    },
    ...overrides,
  };
  return gitlab;
}

async function setup({ gitlab = makeGitlab(), refreshCards, stateFile = null, now, ownerUsers = ['Owner'] } = {}) {
  const server = new ApproveServer({
    gitlab,
    baseUrl: `${ORIGIN}/approve`,
    ownerUsers,
    proxySecret: SECRET,
    port: 0,
    stateFile,
    refreshCards,
    now,
  });
  await server.start();
  const base = `http://127.0.0.1:${server.port}`;
  const link = server.store.linkFor({ project: PROJECT, iid: IID, sha: SHA });
  const headers = (extra = {}) => ({ 'X-Teams-Live-Proxy-Secret': SECRET, 'Remote-User': 'owner', ...extra });
  const get = (id = link.id, h = headers()) => fetch(`${base}/approve/${id}`, { headers: h });
  const csrfFrom = async (res) => /name="csrf" value="([^"]+)"/.exec(await res.text())?.[1];
  const post = (id, form, h = {}) =>
    fetch(`${base}/approve/${id}`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, ...h }),
      body: new URLSearchParams(form).toString(),
    });
  const confirm = async (h = {}) => post(link.id, { csrf: await csrfFrom(await get()) }, h);
  return { server, gitlab, link, base, headers, get, post, csrfFrom, confirm };
}

test('constructor fails closed without owners, secret, base url or on a non-loopback host', () => {
  const ok = { gitlab: makeGitlab(), baseUrl: `${ORIGIN}/approve`, ownerUsers: ['owner'], proxySecret: SECRET };
  assert.doesNotThrow(() => new ApproveServer(ok));
  assert.throws(() => new ApproveServer({ ...ok, ownerUsers: [] }), /owner_users/);
  assert.throws(() => new ApproveServer({ ...ok, proxySecret: '  ' }), /secret/);
  assert.throws(() => new ApproveServer({ ...ok, baseUrl: '' }), /base_url/);
  assert.throws(() => new ApproveServer({ ...ok, host: '0.0.0.0' }), /loopback/);
});

test('normalizeOwnerUsers accepts arrays and comma or newline separated text', () => {
  assert.deepEqual(normalizeOwnerUsers(['Alice', ' bob ', '']), ['alice', 'bob']);
  assert.deepEqual(normalizeOwnerUsers('Alice,bob\ncarol'), ['alice', 'bob', 'carol']);
  assert.deepEqual(normalizeOwnerUsers(undefined), []);
});

test('ids are opaque 192-bit base64url and records are reused per project, merge request and head', () => {
  const store = new ApprovalStore();
  const a = store.linkFor({ project: PROJECT, iid: IID, sha: SHA });
  assert.match(a.id, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(store.linkFor({ project: PROJECT.toUpperCase(), iid: IID, sha: SHA }).id, a.id);
  const b = store.linkFor({ project: PROJECT, iid: IID, sha: 'b'.repeat(40) });
  assert.notEqual(b.id, a.id);
  assert.equal(store.records.get(a.id).status, 'stale');
  assert.equal(store.linkFor({ project: PROJECT, iid: IID, sha: null }), null);
});

test('unauthenticated, spoofed and wrong-owner requests are rejected before anything happens', async () => {
  const ctx = await setup();
  try {
    const noSecret = await ctx.get(ctx.link.id, { 'Remote-User': 'owner' });
    assert.equal(noSecret.status, 401);
    const wrongSecret = await ctx.get(ctx.link.id, ctx.headers({ 'X-Teams-Live-Proxy-Secret': 'nope' }));
    assert.equal(wrongSecret.status, 401);
    const noUser = await ctx.get(ctx.link.id, { 'X-Teams-Live-Proxy-Secret': SECRET });
    assert.equal(noUser.status, 401);
    const listUser = await ctx.get(ctx.link.id, ctx.headers({ 'Remote-User': 'owner, mallory' }));
    assert.equal(listUser.status, 401);
    const other = await ctx.get(ctx.link.id, ctx.headers({ 'Remote-User': 'mallory' }));
    assert.equal(other.status, 403);
    const post = await ctx.post(ctx.link.id, { csrf: 'x' }, { 'Remote-User': 'mallory' });
    assert.equal(post.status, 403);
    assert.equal(ctx.gitlab.calls.getMr, 0);
    assert.equal(ctx.gitlab.calls.approve.length, 0);
  } finally {
    await ctx.server.stop();
  }
});

test('GET and HEAD never mutate and carry the hardening headers', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.get();
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Approve merge request/);
    assert.match(html, /<form method="post"/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'same-origin');
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, new RegExp(`form-action ${ORIGIN}`));

    const before = ctx.gitlab.calls.getMr;
    const head = await fetch(`${ctx.base}/approve/${ctx.link.id}`, { method: 'HEAD', headers: ctx.headers() });
    assert.equal(head.status, 200);
    assert.equal(ctx.gitlab.calls.getMr, before, 'HEAD does not contact GitLab');
    assert.equal(ctx.gitlab.calls.approve.length, 0);
  } finally {
    await ctx.server.stop();
  }
});

test('unknown, malformed and cross-prefix ids are not found', async () => {
  const ctx = await setup();
  try {
    assert.equal((await ctx.get('short')).status, 404);
    assert.equal((await ctx.get('A'.repeat(32))).status, 404);
    const bare = await fetch(`${ctx.base}/${ctx.link.id}`, { headers: ctx.headers() });
    assert.equal(bare.status, 200, 'the proxy may strip the prefix');
  } finally {
    await ctx.server.stop();
  }
});

test('a confirmed POST approves once with the displayed head SHA and refreshes the card', async () => {
  const refreshes = [];
  const ctx = await setup({
    refreshCards: async (project, iid) => {
      refreshes.push([project, iid]);
      return { matched: 1, completed: 1, failed: 0 };
    },
  });
  try {
    const res = await ctx.confirm();
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Approved in GitLab/);
    assert.match(html, /refresh was run/);
    assert.deepEqual(ctx.gitlab.calls.approve, [{ project: PROJECT, iid: String(IID), opts: { sha: SHA } }]);
    assert.deepEqual(refreshes, [[PROJECT, String(IID)]]);
    assert.equal(ctx.server.store.get(ctx.link.id).status, 'approved');

    // A replay never approves a second time.
    const again = await ctx.confirm();
    assert.equal(again.status, 200);
    assert.match(await again.text(), /already approved/i);
    assert.equal(ctx.gitlab.calls.approve.length, 1);
  } finally {
    await ctx.server.stop();
  }
});

test('concurrent POSTs approve exactly once', async () => {
  const gitlab = makeGitlab();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const approve = gitlab.approveMr;
  gitlab.approveMr = async (...args) => {
    await gate;
    return approve(...args);
  };
  const ctx = await setup({ gitlab });
  try {
    const token = await ctx.csrfFrom(await ctx.get());
    const first = ctx.post(ctx.link.id, { csrf: token });
    const second = ctx.post(ctx.link.id, { csrf: token });
    await new Promise((r) => setTimeout(r, 100));
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(ctx.gitlab.calls.approve.length, 1);
  } finally {
    release();
    await ctx.server.stop();
  }
});

test('CSRF and origin checks reject a POST without approving', async () => {
  const ctx = await setup();
  try {
    const token = await ctx.csrfFrom(await ctx.get());
    assert.equal((await ctx.post(ctx.link.id, {})).status, 403, 'missing token');
    assert.equal((await ctx.post(ctx.link.id, { csrf: 'garbage' })).status, 403, 'bad token');
    assert.equal((await ctx.post(ctx.link.id, { csrf: `${token}x` })).status, 403, 'tampered token');
    assert.equal((await ctx.post(ctx.link.id, { csrf: token }, { Origin: 'https://evil.example.org' })).status, 403, 'foreign origin');
    const noOrigin = await fetch(`${ctx.base}/approve/${ctx.link.id}`, {
      method: 'POST',
      headers: ctx.headers({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: new URLSearchParams({ csrf: token }).toString(),
    });
    assert.equal(noOrigin.status, 403, 'neither Origin nor Referer');
    const referer = await ctx.post(ctx.link.id, { csrf: token }, { Origin: '', Referer: `${ORIGIN}/approve/${ctx.link.id}` });
    assert.equal(referer.status, 200, 'a matching Referer is an accepted fallback');
    assert.equal(ctx.gitlab.calls.approve.length, 1);
  } finally {
    await ctx.server.stop();
  }
});

test('a CSRF token is bound to the owner, the record and its expiry', () => {
  let now = 1_000_000;
  const csrf = new CsrfTokens({ now: () => now, ttlMs: 1000 });
  const token = csrf.issue('owner', 'id-1');
  assert.equal(csrf.verify(token, 'owner', 'id-1'), true);
  assert.equal(csrf.verify(token, 'someone', 'id-1'), false);
  assert.equal(csrf.verify(token, 'owner', 'id-2'), false);
  assert.equal(new CsrfTokens().verify(token, 'owner', 'id-1'), false, 'another process key');
  now += 1001;
  assert.equal(csrf.verify(token, 'owner', 'id-1'), false, 'expired');
});

test('wrong content type and oversized bodies are rejected', async () => {
  const ctx = await setup();
  try {
    const json = await fetch(`${ctx.base}/approve/${ctx.link.id}`, {
      method: 'POST',
      headers: ctx.headers({ 'Content-Type': 'application/json', Origin: ORIGIN }),
      body: '{}',
    });
    assert.equal(json.status, 415);
    const big = await fetch(`${ctx.base}/approve/${ctx.link.id}`, {
      method: 'POST',
      headers: ctx.headers({ 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN }),
      body: `csrf=${'a'.repeat(10_000)}`,
    }).catch(() => null);
    if (big) assert.equal(big.status, 413);
    assert.equal(ctx.gitlab.calls.approve.length, 0);
  } finally {
    await ctx.server.stop();
  }
});

test('a changed head commit is rejected as stale and marks the link stale', async () => {
  const ctx = await setup();
  try {
    const token = await ctx.csrfFrom(await ctx.get());
    ctx.gitlab.mr = { ...ctx.gitlab.mr, sha: 'c'.repeat(40) };
    const res = await ctx.post(ctx.link.id, { csrf: token });
    assert.equal(res.status, 409);
    assert.match(await res.text(), /changed after this card was posted/);
    assert.equal(ctx.gitlab.calls.approve.length, 0);
    assert.equal(ctx.server.store.get(ctx.link.id).status, 'stale');
  } finally {
    await ctx.server.stop();
  }
});

test('closed, merged and draft merge requests are not offered or approved', async () => {
  for (const [patch, pattern] of [
    [{ state: 'closed' }, /no longer open/],
    [{ state: 'merged' }, /merged/],
    [{ draft: true }, /draft/],
  ]) {
    const ctx = await setup();
    try {
      ctx.gitlab.mr = { ...ctx.gitlab.mr, ...patch };
      const page = await ctx.get();
      assert.equal(page.status, 409);
      assert.match(await page.text(), pattern);
      assert.equal(ctx.gitlab.calls.approve.length, 0);
    } finally {
      await ctx.server.stop();
    }
  }
});

test('identity decides: already approved, unknown and not-allowed are refused without a request', async () => {
  const cases = [
    [{ known: true, user: { id: 1 }, hasApproved: true, canApprove: true }, 200, /already approved/i],
    [{ known: false, user: null, hasApproved: false, canApprove: null }, 409, /could not be verified/],
    [{ known: true, user: { id: 1 }, hasApproved: false, canApprove: false }, 409, /does not allow/],
  ];
  for (const [userState, status, pattern] of cases) {
    const gitlab = makeGitlab();
    gitlab.userState = userState;
    const ctx = await setup({ gitlab });
    try {
      const res = await ctx.get();
      assert.equal(res.status, status);
      assert.match(await res.text(), pattern);
      assert.equal(gitlab.calls.approve.length, 0);
    } finally {
      await ctx.server.stop();
    }
  }
});

test('a pending merge status such as ci_must_pass does not block the approval', async () => {
  const ctx = await setup();
  try {
    ctx.gitlab.mr = { ...ctx.gitlab.mr, detailed_merge_status: 'ci_must_pass', merge_status: 'cannot_be_merged' };
    const res = await ctx.confirm();
    assert.equal(res.status, 200);
    assert.equal(ctx.gitlab.calls.approve.length, 1);
  } finally {
    await ctx.server.stop();
  }
});

test('GitLab errors are reported honestly without rendering GitLab text', async () => {
  const gitlab = makeGitlab();
  gitlab.approveError = new Error('GitLab error (403): <script>secret-detail</script>');
  const ctx = await setup({ gitlab });
  try {
    const res = await ctx.confirm();
    assert.equal(res.status, 403);
    const html = await res.text();
    assert.match(html, /Nothing was approved/);
    assert.doesNotMatch(html, /secret-detail/);
  } finally {
    await ctx.server.stop();
  }
});

test('an uncertain outcome checks the own approval before reporting', async () => {
  // The request fails after GitLab applied it: the recheck finds the approval.
  const gitlab = makeGitlab();
  gitlab.approveError = new Error('GitLab request failed (network)');
  gitlab.userState = () => ({ known: true, user: { id: 1 }, hasApproved: gitlab.calls.approve.length > 0, canApprove: true });
  let ctx = await setup({ gitlab });
  try {
    const res = await ctx.confirm();
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Approved in GitLab/);
  } finally {
    await ctx.server.stop();
  }

  // The recheck finds nothing: say so.
  const g2 = makeGitlab();
  g2.approveError = new Error('GitLab error (502): bad gateway');
  ctx = await setup({ gitlab: g2 });
  try {
    const res = await ctx.confirm();
    assert.equal(res.status, 502);
    assert.match(await res.text(), /no approval is recorded/);
  } finally {
    await ctx.server.stop();
  }

  // The recheck itself is unavailable: the outcome is unknown.
  const g3 = makeGitlab();
  g3.approveError = new Error('GitLab request failed (network)');
  g3.userState = () =>
    g3.calls.approve.length === 0 ? { known: true, user: { id: 1 }, hasApproved: false, canApprove: true } : { known: false };
  ctx = await setup({ gitlab: g3 });
  try {
    const res = await ctx.confirm();
    assert.equal(res.status, 502);
    assert.match(await res.text(), /may or may not be approved/);
  } finally {
    await ctx.server.stop();
  }
});

test('a failing card refresh is reported without over-claiming', async () => {
  for (const [refreshCards, pattern] of [
    [async () => ({ matched: 1, completed: 0, failed: 1 }), /could not be refreshed yet/],
    [async () => ({ matched: 0, completed: 0, failed: 0 }), /No watched Teams card/],
    [async () => { throw new Error('boom'); }, /could not be refreshed yet/],
  ]) {
    const ctx = await setup({ refreshCards });
    try {
      const res = await ctx.confirm();
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /Approved in GitLab/);
      assert.match(html, pattern);
      assert.doesNotMatch(html, /card (was )?updated/i);
    } finally {
      await ctx.server.stop();
    }
  }
});

test('links survive a restart, expire and are bounded; nothing secret is stored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-test-'));
  const file = path.join(dir, 'links.json');
  try {
    let now = 1_000_000;
    const first = new ApprovalStore({ file, ttlMs: 10_000, now: () => now });
    const rec = first.linkFor({ project: PROJECT, iid: IID, sha: SHA });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const raw = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(raw, /secret|token|csrf/i);

    const second = new ApprovalStore({ file, ttlMs: 10_000, now: () => now });
    second.load();
    assert.equal(second.get(rec.id)?.sha, SHA, 'survives a restart');
    now += 10_001;
    assert.equal(second.get(rec.id), null, 'expired');

    const capped = new ApprovalStore({ max: 3, now: () => ++now });
    for (let i = 0; i < 6; i++) capped.linkFor({ project: PROJECT, iid: i, sha: SHA });
    assert.equal(capped.records.size, 3);

    fs.writeFileSync(file, '{not json');
    const broken = new ApprovalStore({ file });
    assert.doesNotThrow(() => broken.load());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the merge request card has the Approve button only when a link is present', () => {
  const base = { state: 'open', iid: 7, project: PROJECT, title: 'Example', url: 'https://gitlab.example.com/x', approved: false };
  const card = (extra) => buildMergeRequestCard({ ...base, ...extra }).card ?? buildMergeRequestCard({ ...base, ...extra });
  const withLink = card({ approveUrl: `${ORIGIN}/approve/${'A'.repeat(32)}` });
  const text = JSON.stringify(withLink);
  assert.match(text, /"type":"Action.OpenUrl"/);
  assert.match(text, /Approve…/);
  assert.doesNotMatch(JSON.stringify(card({})), /Action\.OpenUrl/);
  assert.doesNotMatch(JSON.stringify(card({ approveUrl: 'javascript:alert(1)' })), /Action\.OpenUrl/);
});

function watcherWith(teams, flow) {
  const watcher = new MergeRequestWatcher({
    config: { conversations: [], gitlab: { group: 'group', notify: { ci: { enable: true } } }, teams },
    gitlab: { mrLink: (p, i) => `https://gitlab.example.com/${p}/-/merge_requests/${i}`, findMrLinks: () => [] },
    jira: null,
    opsgenie: null,
  });
  watcher.saveState = () => {};
  watcher.setApproveFlow(flow);
  return watcher;
}

test('the watcher offers the button only for live, undrafted, unapproved merge requests with a known head', () => {
  const flow = new ApproveServer({ gitlab: makeGitlab(), baseUrl: `${ORIGIN}/approve`, ownerUsers: ['owner'], proxySecret: SECRET });
  const mr = { project: PROJECT, iid: IID, title: 'Example' };
  const details = { sha: SHA, draft: false, approved: false, title: 'Example' };
  const hasButton = (w, d, opts) => /Action\.OpenUrl/.test(JSON.stringify(w.buildMrCard(mr, d, opts)));

  const rich = watcherWith({ rich_messages: true }, flow);
  assert.equal(hasButton(rich, details, { state: 'open' }), true);
  assert.equal(hasButton(rich, { ...details, sha: undefined }, { state: 'open' }), false, 'unknown head');
  assert.equal(hasButton(rich, { ...details, draft: true }, { state: 'open' }), false, 'draft');
  assert.equal(hasButton(rich, { ...details, approved: true }, { state: 'open' }), false, 'already approved');
  assert.equal(hasButton(rich, details, { state: 'merged' }), false, 'merged');
  assert.equal(hasButton(rich, details, { state: 'closed' }), false, 'closed');

  assert.equal(hasButton(watcherWith({ rich_messages: false }, flow), details, { state: 'open' }), false, 'rich mode off');
  assert.equal(hasButton(watcherWith({ rich_messages: true }, null), details, { state: 'open' }), false, 'flow disabled');
});

test('refreshMrCards re-checks every watched card of the merge request', async () => {
  const watcher = watcherWith({ rich_messages: true }, null);
  watcher.watched = new Map([
    ['a', { mrs: [{ project: PROJECT, iid: IID }] }],
    ['b', { mrs: [{ project: 'other/proj', iid: IID }] }],
    ['c', { mrs: [{ project: PROJECT, iid: IID }] }],
  ]);
  const checked = [];
  watcher.checkWatchedKey = async (key) => {
    checked.push(key);
    if (key === 'c') throw new Error('boom');
  };
  const result = await watcher.refreshMrCards(PROJECT, IID);
  assert.deepEqual(checked.sort(), ['a', 'c']);
  assert.deepEqual(result, { matched: 2, completed: 1, failed: 1 });
});
