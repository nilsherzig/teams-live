import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitLabClient } from '../src/gitlab.mjs';

const response = (status, body = {}) => new Response(JSON.stringify(body), { status });
const HOST = 'git.example.com';
const USERS = { first: { id: 1, username: 'primary' }, second: { id: 2, username: 'fallback' }, third: { id: 3, username: 'third' } };

/**
 * Stands in for GitLab. `route(token, method, path)` answers, `/user` is
 * answered per credential unless the route handles it. Records every call.
 */
async function withGitLab(route, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname.replace('/api/v4/', '');
    const token = options.headers?.['PRIVATE-TOKEN'];
    const method = options.method || 'GET';
    calls.push({ token, method, path });
    const answer = route(token, method, path, options);
    if (answer instanceof Error) throw answer;
    if (answer) return answer;
    if (path === 'user') return response(200, USERS[token]);
    return response(404);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const tokensOf = (calls, method) => calls.filter((c) => !method || c.method === method).map((c) => c.token);
const client = (extra = {}) => new GitLabClient({ host: HOST, token: 'first', fallback_tokens: ['second', 'third'], ...extra });

test('GitLab reads fall back in order, only after a 404', async () => {
  await withGitLab((token) => (token === 'third' ? response(200, { id: 42 }) : response(404)), async (calls) => {
    assert.deepEqual(await client().request('projects/example'), { id: 42 });
    assert.deepEqual(tokensOf(calls), ['first', 'second', 'third']);
  });
  for (const status of [401, 403, 500]) {
    await withGitLab(() => response(status), async (calls) => {
      await assert.rejects(client({ onAuthError: () => {} }).request('projects/example'), { status });
      assert.deepEqual(tokensOf(calls, 'GET').filter((t, i) => i === 0 || calls[i].path !== 'user'), ['first']);
      assert.ok(!calls.some((c) => c.token === 'second' && c.path !== 'user'), `no fallback after ${status}`);
    });
  }
});

test('an unpinned write falls back sequentially after a definite 404 and stops at the first success', async () => {
  await withGitLab((token, method) => (method === 'POST' && token === 'second' ? response(201, { ok: true }) : response(404)), async (calls) => {
    assert.deepEqual(await client().request('projects/example/retry', { method: 'POST' }), { ok: true });
    assert.deepEqual(tokensOf(calls), ['first', 'second']);
  });
});

test('an ambiguous write is never repeated and never moves to another credential', async () => {
  // Lost answer (network failure): sent exactly once, whatever the retry flag says.
  for (const options of [{}, { retry: true }, { retry: false }]) {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      await withGitLab(() => new Error('network failure'), async (calls) => {
        await assert.rejects(client().request('projects/example/x', { method, ...options }), /network failure/);
        assert.equal(calls.length, 1, `${method} ${JSON.stringify(options)}`);
      });
    }
  }
  // 5xx and 401/403 are not a definite "not found": no other identity is tried.
  for (const status of [500, 502, 401, 403]) {
    await withGitLab(() => response(status), async (calls) => {
      await assert.rejects(client({ onAuthError: () => {} }).request('projects/example/approve', { method: 'POST' }), { status });
      assert.ok(!calls.some((c) => c.token !== 'first' && c.path !== 'user'), `status ${status}`);
      assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
    });
  }
  // A read is still retried once after a lost answer.
  let attempts = 0;
  await withGitLab(() => (++attempts === 1 ? new Error('blip') : response(200, { id: 1 })), async () => {
    assert.deepEqual(await client().request('projects/example'), { id: 1 });
  });
});

test('locateMr picks the first credential that can see the merge request and reports its own account', async () => {
  await withGitLab((token, _m, path) => (path.includes('merge_requests') ? (token === 'second' ? response(200, { iid: 7, state: 'opened' }) : response(404)) : null), async (calls) => {
    const found = await client().locateMr('group/app', 7);
    assert.equal(found.tokenIndex, 1);
    assert.deepEqual(found.user, USERS.second);
    assert.deepEqual(tokensOf(calls), ['first', 'second', 'second']);
    assert.equal(calls.at(-1).path, 'user');
    assert.equal(calls.at(-1).token, 'second');
  });
  // The primary credential sees it: nothing else is asked.
  await withGitLab((_t, _m, path) => (path.includes('merge_requests') ? response(200, { iid: 7 }) : null), async (calls) => {
    const found = await client().locateMr('group/app', 7);
    assert.equal(found.tokenIndex, 0);
    assert.deepEqual(found.user, USERS.first);
    assert.ok(!calls.some((c) => c.token !== 'first'));
  });
  // Anything but a 404 is not a reason to try another identity.
  await withGitLab((_t, _m, path) => (path.includes('merge_requests') ? response(500) : null), async (calls) => {
    await assert.rejects(client().locateMr('group/app', 7), { status: 500 });
    assert.deepEqual(tokensOf(calls), ['first']);
  });
  // Seen by nobody: the last 404 surfaces.
  await withGitLab(() => response(404), async () => {
    await assert.rejects(client().locateMr('group/app', 7), { status: 404 });
  });
});

test('a pinned write is sent under that credential only, and a 404 does not move it', async () => {
  await withGitLab((token, method, path) => (path === 'user' ? null : method === 'POST' && token === 'second' ? response(201, {}) : response(404)), async (calls) => {
    await client().approveMr('group/app', 7, { sha: 'abc', tokenIndex: 1, expectUserId: 2 });
    assert.deepEqual(tokensOf(calls, 'POST'), ['second']);
  });
  await withGitLab((_t, _m, path) => (path === 'user' ? null : response(404)), async (calls) => {
    await assert.rejects(client().approveMr('group/app', 7, { sha: 'abc', tokenIndex: 1 }), { status: 404 });
    assert.deepEqual(tokensOf(calls), ['second']);
    calls.length = 0;
    await assert.rejects(client().mergeMrOnce('group/app', 7, { sha: 'abc', tokenIndex: 2 }), { status: 404 });
    await assert.rejects(client().reopenMr('group/app', 7, { tokenIndex: 0 }), { status: 404 });
    assert.deepEqual(tokensOf(calls), ['third', 'first']);
  });
});

test('a write is not sent when the credential is no longer the account that was shown', async () => {
  await withGitLab(() => response(201, {}), async (calls) => {
    const gitlab = client();
    for (const call of [
      () => gitlab.approveMr('group/app', 7, { sha: 'abc', tokenIndex: 1, expectUserId: 1 }),
      () => gitlab.mergeMrOnce('group/app', 7, { sha: 'abc', tokenIndex: 1, expectUserId: 1 }),
      () => gitlab.reopenMr('group/app', 7, { tokenIndex: 1, expectUserId: 1 }),
    ]) {
      await assert.rejects(call(), { identityMismatch: true });
    }
    assert.deepEqual(calls.filter((c) => c.method !== 'GET'), [], 'nothing was written');
  });
  // An identity that cannot be read is not "the same account" either.
  await withGitLab((_t, _m, path) => (path === 'user' ? response(500) : response(201, {})), async (calls) => {
    await assert.rejects(client().approveMr('group/app', 7, { sha: 'abc', tokenIndex: 0, expectUserId: 1 }), { identityMismatch: true });
    assert.deepEqual(calls.filter((c) => c.method !== 'GET'), []);
  });
});

test('the approval state is read as one credential: identity and approvals never mix', async () => {
  const approvals = (token) => (token === 'second' ? response(200, { approved_by: [{ user: { id: 2 } }], user_can_approve: false }) : response(404));
  await withGitLab((token, _m, path) => (path.endsWith('/approvals') ? approvals(token) : null), async () => {
    const state = await client().getUserApprovalState('group/app', 7);
    assert.equal(state.tokenIndex, 1);
    assert.deepEqual(state.user, USERS.second);
    assert.equal(state.hasApproved, true, 'matched against the fallback account, not the primary one');
    assert.equal(state.canApprove, false);
    // Pinned to the primary credential: no fallback, the answer is unknown.
    const pinned = await client().getUserApprovalState('group/app', 7, { tokenIndex: 0 });
    assert.equal(pinned.known, false);
    assert.equal(pinned.tokenIndex, 0);
    assert.deepEqual(pinned.user, USERS.first);
  });
  // The second credential approved as itself; the primary account (id 1) is not on the list.
  await withGitLab((token, _m, path) => (path.endsWith('/approvals') ? response(200, { approved_by: [{ user: { id: 2 } }] }) : null), async () => {
    assert.equal((await client().getUserApprovalState('group/app', 7, { tokenIndex: 0 })).hasApproved, false);
    assert.equal((await client().getUserApprovalState('group/app', 7, { tokenIndex: 1 })).hasApproved, true);
  });
});

test('accounts are cached per credential', async () => {
  await withGitLab(() => null, async (calls) => {
    const gitlab = client();
    assert.deepEqual(await gitlab.getCurrentUser(), USERS.first);
    assert.deepEqual(await gitlab.getCurrentUser({ tokenIndex: 1 }), USERS.second);
    assert.deepEqual(await gitlab.getCurrentUser({ tokenIndex: 2 }), USERS.third);
    assert.deepEqual(await gitlab.getCurrentUser({ tokenIndex: 1 }), USERS.second);
    assert.equal(await gitlab.getCurrentUser({ tokenIndex: 3 }), null);
    assert.deepEqual(tokensOf(calls), ['first', 'second', 'third']);
  });
});

test('token info and rotation address one credential and never fall back', async () => {
  await withGitLab((token, method, path) => {
    if (path === 'personal_access_tokens/self' && token === 'second') return response(200, { id: 22, expires_at: '2027-01-01' });
    if (path === 'personal_access_tokens/self/rotate' && token === 'second') return response(200, { id: 22, token: 'second-new', expires_at: '2027-02-02' });
    if (path === 'user' && token === 'second-new') return response(200, USERS.second);
    return method === 'GET' || path.endsWith('/rotate') ? response(404) : null;
  }, async (calls) => {
    const gitlab = client();
    assert.equal((await gitlab.getTokenInfo({ tokenIndex: 1 })).id, 22);
    assert.equal(await gitlab.getTokenInfo(), null, 'the primary credential has no info here and nothing else answers for it');
    assert.equal(await gitlab.getTokenInfo({ tokenIndex: 5 }), null);
    assert.deepEqual(tokensOf(calls), ['second', 'first']);

    calls.length = 0;
    await assert.rejects(gitlab.rotateToken(), { status: 404 });
    assert.deepEqual(tokensOf(calls), ['first']);
    assert.equal(gitlab.token, 'first');

    calls.length = 0;
    await gitlab.getCurrentUser({ tokenIndex: 1 });
    const rotated = await gitlab.rotateToken({ tokenIndex: 1, expiresAt: '2027-02-02' });
    assert.equal(rotated.token, 'second-new');
    assert.deepEqual(tokensOf(calls, 'POST'), ['second']);
    assert.equal(gitlab.token, 'first', 'the primary token is untouched');
    assert.deepEqual(gitlab.fallbackTokens, ['second-new', 'third']);
    assert.equal(gitlab.tokenAt(1), 'second-new');
    // The identity of the rotated credential is read again, under the new token.
    calls.length = 0;
    assert.deepEqual(await gitlab.getCurrentUser({ tokenIndex: 1 }), USERS.second);
    assert.deepEqual(tokensOf(calls), ['second-new']);
    await assert.rejects(gitlab.rotateToken({ tokenIndex: 9 }), /no token configured/);
  });
});

test('the primary token is rotated in memory by default', async () => {
  await withGitLab((token, _m, path) => (path.endsWith('/rotate') && token === 'first' ? response(200, { token: 'first-new' }) : null), async () => {
    const gitlab = client();
    await gitlab.rotateToken();
    assert.equal(gitlab.token, 'first-new');
    assert.deepEqual(gitlab.fallbackTokens, ['second', 'third']);
  });
});

test('identity-bound calls stay on the primary credential: reactions and webhooks', async () => {
  await withGitLab(() => response(404), async (calls) => {
    const gitlab = client();
    await assert.rejects(gitlab.getAwardEmojis('group/app', 7), { status: 404 });
    await assert.rejects(gitlab.awardEmoji('group/app', 7, 'thumbsup'), { status: 404 });
    await assert.rejects(gitlab.deleteAwardEmoji('group/app', 7, 3), { status: 404 });
    await assert.rejects(gitlab.addGroupHook('group', {}), { status: 404 });
    await assert.rejects(gitlab.editGroupHook('group', 1, {}), { status: 404 });
    await assert.rejects(gitlab.deleteGroupHook('group', 1), { status: 404 });
    await assert.rejects(gitlab.listGroupHooks('group'), { status: 404 });
    assert.ok(calls.length > 0 && tokensOf(calls).every((t) => t === 'first'));
  });
});
