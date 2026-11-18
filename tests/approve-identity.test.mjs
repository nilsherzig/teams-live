import test from 'node:test';
import assert from 'node:assert/strict';

import { ApproveServer } from '../src/approve.mjs';
import { GitLabClient } from '../src/gitlab.mjs';

// The approval flow on the real GitLab client with several credentials: the
// account shown on the confirmation page must be the account that writes, a
// write is sent once, and another credential is only tried after a definite 404.

const ORIGIN = 'https://approve.example.com';
const HOST = 'git.example.com';
const SHA = 'a'.repeat(40);
const PROJECT = 'group/app';
const IID = 7;
const USERS = { first: { id: 1, username: 'primary' }, second: { id: 2, username: 'fallback' } };
const json = (status, body = {}) => new Response(JSON.stringify(body), { status });

/**
 * A GitLab with one merge request. `visibleTo` lists the credentials that can
 * see it; `behaviour.approve(token)` may override the approval answer.
 */
async function withFlow({ visibleTo: visible = ['first', 'second'], approve = () => json(201, {}), mr = {}, action = 'approve', approvals = {}, users = {} } = {}, fn) {
  const savedUsers = { ...USERS };
  Object.assign(USERS, users);
  const original = globalThis.fetch;
  const visibleTo = [...visible];
  const log = [];
  const state = { approvedBy: [] };
  globalThis.fetch = async (url, options = {}) => {
    if (!String(url).startsWith(`https://${HOST}/`)) return original(url, options);
    const path = new URL(url).pathname.replace('/api/v4/', '');
    const token = options.headers?.['PRIVATE-TOKEN'];
    const method = options.method || 'GET';
    log.push({ token, method, path });
    if (path === 'user') return json(200, USERS[token]);
    if (!visibleTo.includes(token)) return json(404, { message: '404 Not found' });
    if (path.endsWith('/approvals')) {
      return json(200, { approved_by: state.approvedBy.map((id) => ({ user: { id } })), user_can_approve: true, ...approvals });
    }
    if (method === 'POST' && path.endsWith('/approve')) {
      const answer = await approve(token, state);
      if (answer.ok) state.approvedBy.push(USERS[token].id);
      return answer;
    }
    if (path.includes('/merge_requests/')) {
      return json(200, { state: action === 'reopen' ? 'closed' : 'opened', draft: false, sha: SHA, title: 'Example change', ...mr });
    }
    return json(404);
  };
  const gitlab = new GitLabClient({ host: HOST, token: 'first', fallback_tokens: ['second'] });
  const server = new ApproveServer({ gitlab, baseUrl: `${ORIGIN}/approve`, port: 0, mergeEnabled: true, mergePollMs: 0, mergePollAttempts: 1, sleep: async () => {} });
  await server.start();
  const base = `http://127.0.0.1:${server.port}`;
  const { token } = server.store.linkFor({ project: PROJECT, iid: IID, sha: action === 'reopen' ? undefined : SHA, action });
  const FORM = { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN };
  const session = await fetch(`${base}/approve/session`, { method: 'POST', headers: FORM, body: new URLSearchParams({ token }).toString() });
  const cookie = /tl_approve=[^;]+/.exec(session.headers.get('set-cookie') || '')[0];
  const confirmation = await fetch(`${base}/approve/confirm`, { headers: { Cookie: cookie } });
  const confirmationHtml = await confirmation.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(confirmationHtml)?.[1];
  const shown = { user: /name="user" value="([^"]*)"/.exec(confirmationHtml)?.[1], cred: /name="cred" value="([^"]*)"/.exec(confirmationHtml)?.[1] };
  const confirm = async (fields = { csrf, ...shown }) => {
    const body = new URLSearchParams(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))).toString();
    const res = await fetch(`${base}/approve/confirm`, { method: 'POST', headers: { ...FORM, Cookie: cookie }, body });
    return { status: res.status, html: await res.text() };
  };
  try {
    return await fn({ log, state, confirm, csrf, shown, visibleTo, users: USERS, confirmationHtml, confirmationStatus: confirmation.status, gitlab, server });
  } finally {
    await server.stop?.();
    globalThis.fetch = original;
    Object.assign(USERS, savedUsers);
  }
}

const writes = (log) => log.filter((c) => c.method !== 'GET');

test('the account shown is the account that approves when only the fallback credential sees the merge request', async () => {
  await withFlow({ visibleTo: ['second'] }, async ({ log, state, confirm, confirmationHtml }) => {
    assert.match(confirmationHtml, /<code>fallback<\/code>/);
    assert.doesNotMatch(confirmationHtml, /<code>primary<\/code>/);
    const res = await confirm();
    assert.equal(res.status, 200);
    assert.match(res.html, /Approved in GitLab/);
    assert.match(res.html, /<code>fallback<\/code>/);
    assert.deepEqual(writes(log), [{ token: 'second', method: 'POST', path: `projects/${encodeURIComponent(PROJECT)}/merge_requests/${IID}/approve` }]);
    assert.deepEqual(state.approvedBy, [2]);
  });
});

test('the primary credential approves, and nothing else is asked, when it can see the merge request', async () => {
  await withFlow({}, async ({ log, confirm, confirmationHtml }) => {
    assert.match(confirmationHtml, /<code>primary<\/code>/);
    assert.equal((await confirm()).status, 200);
    assert.ok(!log.some((c) => c.token === 'second'), 'the fallback credential was never used');
    assert.deepEqual(writes(log).map((c) => c.token), ['first']);
  });
});

test('a 404 on the approval itself is definite: nothing is approved and no other account is tried', async () => {
  await withFlow({ approve: () => json(404, { message: '404 Not found' }) }, async ({ log, state, confirm }) => {
    const res = await confirm();
    assert.equal(res.status, 404);
    assert.match(res.html, /Nothing was approved/);
    assert.deepEqual(writes(log).map((c) => c.token), ['first']);
    assert.deepEqual(state.approvedBy, []);
  });
});

test('an ambiguous approval is sent once, checked as the same account, and never retried under another', async () => {
  // The first attempt landed but the answer was lost.
  await withFlow({
    approve: (_token, state) => {
      state.approvedBy.push(1);
      return json(502, {});
    },
  }, async ({ log, confirm }) => {
    const res = await confirm();
    assert.equal(res.status, 200, 'confirmed by reading the approvals back');
    assert.match(res.html, /Approved in GitLab/);
    assert.equal(writes(log).length, 1);
    assert.ok(!log.some((c) => c.token === 'second'));
  });
  // A lost answer with no approval recorded: still one write, the page says so.
  await withFlow({ approve: () => json(500, {}) }, async ({ log, state, confirm }) => {
    const res = await confirm();
    assert.equal(res.status, 502);
    assert.match(res.html, /Nothing was approved/);
    assert.equal(writes(log).length, 1);
    assert.deepEqual(state.approvedBy, []);
  });
  // A refusal is not a "not found": the other account is not tried either.
  await withFlow({ approve: () => json(403, { message: '403 Forbidden' }) }, async ({ log, confirm }) => {
    const res = await confirm();
    assert.equal(res.status, 403);
    assert.deepEqual(writes(log).map((c) => c.token), ['first']);
  });
});

test('a fallback-only merge request is reopened and merged as the fallback account', async () => {
  await withFlow({ visibleTo: ['second'], action: 'reopen', approve: () => json(200, {}) }, async ({ log, confirm, confirmationHtml }) => {
    assert.match(confirmationHtml, /<code>fallback<\/code>/);
    const original = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'PUT' && String(url).includes('/merge_requests/')) {
        log.push({ token: options.headers['PRIVATE-TOKEN'], method: 'PUT', path: new URL(url).pathname });
        return json(200, { state: 'opened' });
      }
      return original(url, options);
    };
    try {
      const res = await confirm();
      assert.equal(res.status, 200);
      assert.match(res.html, /Reopened in GitLab/);
      assert.deepEqual(writes(log).map((c) => c.token), ['second']);
    } finally {
      globalThis.fetch = original;
    }
  });
});

test('the page is not shown, and nothing is written, when no credential can see the merge request', async () => {
  await withFlow({ visibleTo: [] }, async ({ log, confirmationStatus, confirmationHtml }) => {
    assert.equal(confirmationStatus, 409);
    assert.match(confirmationHtml, /Nothing was approved/);
    assert.deepEqual(writes(log), []);
  });
});

// Identity binding between the page (GET) and the confirmation (POST).

test('the confirmation form carries the shown account and credential, bound into the CSRF token', async () => {
  await withFlow({ visibleTo: ['second'] }, async ({ shown, confirm, csrf, log }) => {
    assert.deepEqual(shown, { user: '2', cred: '1' });
    // Hidden fields cannot be edited: another account, another credential, or none at all.
    for (const forged of [{ user: '1', cred: '1' }, { user: '2', cred: '0' }, { user: undefined, cred: undefined }, { user: '', cred: '' }]) {
      const res = await confirm({ csrf, ...forged });
      assert.equal(res.status, 403, JSON.stringify(forged));
      assert.match(res.html, /Nothing was approved/);
    }
    assert.deepEqual(writes(log), []);
    assert.equal((await confirm()).status, 200, 'the genuine form still works');
  });
});

test('a credential change between the page and the click is rejected and nothing is sent', async () => {
  // The page was shown for the primary credential; it then stops seeing the merge request, so the fallback would act.
  await withFlow({}, async ({ confirmationHtml, visibleTo, confirm, log, state }) => {
    assert.match(confirmationHtml, /<code>primary<\/code>/);
    visibleTo.splice(0, visibleTo.length, 'second');
    const res = await confirm();
    assert.equal(res.status, 409);
    assert.match(res.html, /Account changed/);
    assert.match(res.html, /Nothing was approved/);
    assert.deepEqual(writes(log), []);
    assert.deepEqual(state.approvedBy, []);
  });
});

test('a different account behind the same credential is rejected and nothing is sent', async () => {
  await withFlow({}, async ({ gitlab, users, confirm, log, state }) => {
    users.first = { id: 9, username: 'someone-else' };
    gitlab.userCache.clear();
    const res = await confirm();
    assert.equal(res.status, 409);
    assert.match(res.html, /Account changed/);
    assert.deepEqual(writes(log), []);
    assert.deepEqual(state.approvedBy, []);
  });
});

test('no confirmation form is offered when the account cannot be told', async () => {
  await withFlow({ users: { first: { username: 'nobody' } } }, async ({ log, confirmationStatus, confirmationHtml }) => {
    assert.notEqual(confirmationStatus, 200);
    assert.doesNotMatch(confirmationHtml, /<form|name="csrf"/);
    assert.match(confirmationHtml, /Nothing was approved/);
    assert.deepEqual(writes(log), []);
  });
});

test('a click is refused when the account becomes unavailable after the page was shown', async () => {
  await withFlow({}, async ({ gitlab, users, confirm, log, state }) => {
    users.first = {};
    gitlab.userCache.clear();
    const res = await confirm();
    assert.notEqual(res.status, 200);
    assert.match(res.html, /Nothing was approved/);
    assert.deepEqual(writes(log), []);
    assert.deepEqual(state.approvedBy, []);
  });
});
