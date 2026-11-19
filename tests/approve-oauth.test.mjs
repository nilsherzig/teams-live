import test from 'node:test';
import assert from 'node:assert/strict';

import { ApproveServer } from '../src/approve.mjs';

// "Sign in with GitLab" on the approval page: OAuth authorization code with PKCE, the verified user is bound
// into the session, restricted by an allow-list, never the author, and named in the merge request comment.

const ORIGIN = 'https://approve.example.com';
const GL = 'git.example.com';
const SHA = 'a'.repeat(40);
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

async function withFlow({ oauth = { clientId: 'cid', clientSecret: 'sec', allowedUsers: [] }, signInAs = 'alice' } = {}, fn) {
  const notes = [];
  const approvals = [];
  const gitlab = {
    host: GL,
    mr: { state: 'opened', draft: false, sha: SHA, title: 'Example change', author: { username: 'author' } },
    async getCurrentUser() {
      return { id: 1, username: 'owner' };
    },
    async getMr() {
      return gitlab.mr;
    },
    async getUserApprovalState() {
      return { known: true, user: { id: 1, username: 'owner' }, hasApproved: false, canApprove: true };
    },
    async approveMr(project, iid, opts) {
      approvals.push({ project, iid, opts });
      return {};
    },
    async addMrNote(project, iid, note) {
      notes.push(note);
    },
  };
  const server = new ApproveServer({ gitlab, baseUrl: `${ORIGIN}/approve`, port: 0, oauth });
  await server.start();
  const base = `http://127.0.0.1:${server.port}`;
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options = {}) => {
    if (!String(url).startsWith(`https://${GL}/`)) return original(url, options);
    seen.push({ url: String(url), options });
    if (String(url).endsWith('/oauth/token')) return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    if (String(url).endsWith('/api/v4/user')) return new Response(JSON.stringify({ id: 9, username: signInAs, name: 'Alice Example' }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  try {
    const { token } = server.store.linkFor({ project: 'group/app', iid: 7, sha: SHA, action: 'approve' });
    const boot = await fetch(`${base}/approve/session`, { method: 'POST', headers: { ...FORM, Origin: ORIGIN }, body: new URLSearchParams({ token }).toString() });
    const cookie = /tl_approve=[^;]+/.exec(boot.headers.get('set-cookie') || '')[0];
    await fn({ base, cookie, notes, approvals, seen, server });
  } finally {
    globalThis.fetch = original;
    await server.stop();
  }
}

const signIn = async ({ base, cookie }) => {
  const start = await fetch(`${base}/approve/oauth/start`, { headers: { Cookie: cookie }, redirect: 'manual' });
  const location = new URL(start.headers.get('location'));
  const back = await fetch(`${base}/approve/oauth/callback?code=thecode&state=${location.searchParams.get('state')}`);
  return { start, location, back };
};

test('without a sign-in the page asks for one and offers no approval', async () => {
  await withFlow({}, async (ctx) => {
    const html = await (await fetch(`${ctx.base}/approve/confirm`, { headers: { Cookie: ctx.cookie } })).text();
    assert.match(html, /Sign in with GitLab/);
    assert.doesNotMatch(html, /name="csrf"/);
  });
});

test('sign-in runs the authorization code flow with PKCE and then offers the approval', async () => {
  await withFlow({}, async (ctx) => {
    const { start, location, back } = await signIn(ctx);
    assert.equal(start.status, 302);
    assert.equal(location.origin + location.pathname, `https://${GL}/oauth/authorize`);
    assert.equal(location.searchParams.get('client_id'), 'cid');
    assert.equal(location.searchParams.get('scope'), 'read_user');
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(location.searchParams.get('redirect_uri'), `${ORIGIN}/approve/oauth/callback`);
    assert.equal(back.status, 200);
    assert.match(await back.text(), /Signed in as <code>alice<\/code>/);
    const tokenCall = ctx.seen.find((c) => c.url.endsWith('/oauth/token'));
    const body = new URLSearchParams(tokenCall.options.body);
    assert.equal(body.get('code'), 'thecode');
    assert.equal(body.get('client_secret'), 'sec');
    assert.ok(body.get('code_verifier'));
    const challenge = (await import('node:crypto')).createHash('sha256').update(body.get('code_verifier')).digest('base64url');
    assert.equal(challenge, location.searchParams.get('code_challenge'));

    const page = await (await fetch(`${ctx.base}/approve/confirm`, { headers: { Cookie: ctx.cookie } })).text();
    assert.match(page, /Signed in with GitLab as <code>alice<\/code>/);
    assert.doesNotMatch(page, /Anyone with this link/);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1];
    const res = await fetch(`${ctx.base}/approve/confirm`, { method: 'POST', headers: { ...FORM, Origin: ORIGIN, Cookie: ctx.cookie }, body: new URLSearchParams({ csrf, user: '1', cred: '' }).toString() });
    assert.equal(res.status, 200);
    assert.equal(ctx.approvals.length, 1);
    assert.match(ctx.notes[0], /@alice \(signed in with GitLab\)/);
  });
});

test('the state is single use and unknown states are refused', async () => {
  await withFlow({}, async (ctx) => {
    const { location } = await signIn(ctx);
    const again = await fetch(`${ctx.base}/approve/oauth/callback?code=x&state=${location.searchParams.get('state')}`);
    assert.equal(again.status, 400);
    assert.equal((await fetch(`${ctx.base}/approve/oauth/callback?code=x&state=nope`)).status, 400);
    assert.equal(ctx.seen.filter((c) => c.url.endsWith('/oauth/token')).length, 1);
  });
});

test('the author of the merge request and users outside the allow-list cannot confirm', async () => {
  await withFlow({ signInAs: 'author' }, async (ctx) => {
    await signIn(ctx);
    const res = await fetch(`${ctx.base}/approve/confirm`, { headers: { Cookie: ctx.cookie } });
    assert.equal(res.status, 403);
    const html = await res.text();
    assert.match(html, /author of this merge request/);
    assert.doesNotMatch(html, /name="csrf"/);
  });
  await withFlow({ oauth: { clientId: 'cid', clientSecret: 'sec', allowedUsers: ['bob'] } }, async (ctx) => {
    await signIn(ctx);
    const res = await fetch(`${ctx.base}/approve/confirm`, { headers: { Cookie: ctx.cookie } });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /not allowed/);
  });
});

test('without oauth configured the sign-in routes do not exist', async () => {
  await withFlow({ oauth: null }, async (ctx) => {
    assert.equal((await fetch(`${ctx.base}/approve/oauth/start`, { headers: { Cookie: ctx.cookie } })).status, 404);
  });
});
