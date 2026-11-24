import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { ApproveServer } from '../src/approve.mjs';
import { alertsSection, defaultFilter, isBotMr, meetingsSection, mrFilters, mrsSection, normalizeMr, webLink } from '../src/dashboard.mjs';

// The signed-in dashboard: GitLab sign-in without a card link, only for members of the configured group,
// merge requests read with the visitor's token, the bot's sources shown next to them, inline approvals sent once.

const ORIGIN = 'https://approve.example.com';
const GL = 'git.example.com';
const SHA = 'b'.repeat(40);
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

const node = (over = {}) => ({
  iid: '7',
  title: 'Example change',
  webUrl: `https://${GL}/group/app/-/merge_requests/7`,
  draft: false,
  updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
  sourceBranch: 'feature',
  targetBranch: 'main',
  diffHeadSha: SHA,
  detailedMergeStatus: 'NOT_APPROVED',
  approved: false,
  approvalsRequired: 2,
  approvalsLeft: 1,
  project: { fullPath: 'group/app' },
  author: { username: 'bob', name: 'Bob Example', bot: false },
  reviewers: { nodes: [{ username: 'alice' }] },
  approvedBy: { nodes: [{ username: 'carol', name: 'Carol Example' }] },
  headPipeline: { status: 'SUCCESS' },
  userPermissions: { canApprove: true },
  ...over,
});

async function withDashboard({ member = true, nodes = [node()], sources = {}, enable = true } = {}, fn) {
  const gitlab = { host: GL, mrLink: (p, i) => `https://${GL}/${p}/-/merge_requests/${i}`, async getMr() { return {}; } };
  const server = new ApproveServer({
    gitlab,
    baseUrl: `${ORIGIN}/approve`,
    port: 0,
    oauth: { clientId: 'cid', clientSecret: 'sec', allowedUsers: [] },
    dashboard: { enable, group: 'group', sources, timeZone: 'UTC' },
  });
  await server.start();
  const base = `http://127.0.0.1:${server.port}`;
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.startsWith(`https://${GL}/`)) return original(url, options);
    seen.push({ url: u, options });
    if (u.endsWith('/oauth/token')) return Response.json({ access_token: 'tok', expires_in: 7200 });
    if (u.endsWith('/api/v4/user')) return Response.json({ id: 9, username: 'alice', name: 'Alice Example' });
    if (u.includes('/groups/group/members/all/9')) return member ? Response.json({ state: 'active', access_level: 30 }) : new Response('{}', { status: 404 });
    if (u.endsWith('/api/graphql')) return Response.json({ data: { group: { mergeRequests: { pageInfo: { hasNextPage: false }, nodes } } } });
    if (u.endsWith('/merge_requests/7')) return Response.json({ state: 'opened', draft: false, sha: SHA, author: { username: 'bob' } });
    if (u.endsWith('/merge_requests/7/approvals')) return Response.json({ approved_by: [], user_can_approve: true });
    if (u.endsWith('/merge_requests/7/approve') && options.method === 'POST') return Response.json({});
    return new Response('{}', { status: 404 });
  };
  try {
    await fn({ base, server, seen });
  } finally {
    globalThis.fetch = original;
    await server.stop();
  }
}

async function signIn(base) {
  const start = await fetch(`${base}/approve/dashboard/signin`, { redirect: 'manual' });
  const location = new URL(start.headers.get('location'));
  const back = await fetch(`${base}/approve/oauth/callback?code=thecode&state=${location.searchParams.get('state')}`);
  const cookie = /tl_dash=[^;]+/.exec(back.headers.get('set-cookie') || '')?.[0] || '';
  return { start, location, back, cookie };
}

test('the dashboard is off unless enabled', async () => {
  await withDashboard({ enable: false }, async ({ base }) => {
    assert.equal((await fetch(`${base}/approve/dashboard`)).status, 404);
    assert.equal((await fetch(`${base}/approve/dashboard/signin`, { redirect: 'manual' })).status, 404);
  });
});

test('signed out, the dashboard offers the GitLab sign-in and its data endpoint answers 401', async () => {
  await withDashboard({}, async ({ base }) => {
    const gate = await fetch(`${base}/approve/dashboard`);
    assert.equal(gate.status, 200);
    assert.match(await gate.text(), /Sign in with GitLab/);
    assert.equal((await fetch(`${base}/approve/dashboard/data`)).status, 401);
  });
});

test('sign-in uses PKCE without a card link and opens a session for a group member', async () => {
  await withDashboard({}, async ({ base, seen }) => {
    const { start, location, back, cookie } = await signIn(base);
    assert.equal(start.status, 302);
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(location.searchParams.get('redirect_uri'), `${ORIGIN}/approve/oauth/callback`);
    assert.equal(back.status, 200);
    assert.ok(cookie, 'a dashboard session cookie');
    assert.match(back.headers.get('set-cookie'), /tl_dash=[^;]+; Path=\/approve; Max-Age=\d+; HttpOnly; SameSite=Strict; Secure/);
    const member = seen.find((c) => c.url.includes('/members/all/9'));
    assert.equal(member.options.headers.Authorization, 'Bearer tok', 'membership is asked with the visitor’s own token');
  });
});

test('a GitLab user outside the group gets no session', async () => {
  await withDashboard({ member: false }, async ({ base }) => {
    const { back, cookie } = await signIn(base);
    assert.equal(back.status, 403);
    assert.equal(cookie, '');
    assert.match(await back.text(), /not a member/);
  });
});

test('the page shows the merge requests read as the visitor, escaped, with the bot sources next to them', async () => {
  const sources = {
    sprint: async () => ({ total: 1, todo: [{ key: 'ABC-1', summary: 'Rotate <keys>', assignee: 'Alice Example', status: 'Open', url: 'https://jira.example.com/browse/ABC-1' }], inProgress: [], inReview: [] }),
    alerts: async () => { throw new Error('boom'); },
    meetings: async () => [{ subject: 'Standup', startTime: new Date(Date.now() + 3_600_000).toISOString(), endTime: new Date(Date.now() + 5_400_000).toISOString(), joinUrl: 'javascript:alert(1)', organizer: '' }],
  };
  await withDashboard({ nodes: [node({ title: 'Fix <script>alert(1)</script>' })], sources }, async ({ base, seen }) => {
    const { cookie } = await signIn(base);
    const res = await fetch(`${base}/approve/dashboard`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Fix &lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('<script>alert(1)'));
    assert.match(html, /data-approve data-project="group\/app" data-iid="7"/);
    assert.match(html, /data-f="human review"/);
    assert.match(html, /data-mrf="review"/, 'what waits for the visitor is shown first');
    assert.ok(html.includes('Rotate &lt;keys&gt;'));
    assert.match(html, /Could not read OpsGenie right now/, 'a failing source is named, not its error');
    assert.ok(!html.includes('boom'));
    assert.ok(!html.includes('javascript:'), 'only http(s) links');
    const graphql = seen.find((c) => c.url.endsWith('/api/graphql'));
    assert.equal(graphql.options.headers.Authorization, 'Bearer tok');
    const csp = res.headers.get('content-security-policy');
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
    assert.ok(csp.includes(`'sha256-${crypto.createHash('sha256').update(script).digest('base64')}'`), 'the inline script is allowed by its hash');
    const data = await (await fetch(`${base}/approve/dashboard/data`, { headers: { Cookie: cookie } })).json();
    assert.ok(data.sections.mrs.includes('Fix &lt;script&gt;'));
    assert.ok(data.csrf);
  });
});

test('an inline approval is one POST as the visitor, checked like the approval page', async () => {
  await withDashboard({}, async ({ base, seen }) => {
    const { cookie } = await signIn(base);
    const html = await (await fetch(`${base}/approve/dashboard`, { headers: { Cookie: cookie } })).text();
    const csrf = /id="dash-csrf" value="([^"]+)"/.exec(html)[1];
    const post = (body, headers = { Origin: ORIGIN }) =>
      fetch(`${base}/approve/dashboard/approve`, { method: 'POST', headers: { ...FORM, Accept: 'application/json', Cookie: cookie, ...headers }, body: new URLSearchParams(body).toString() });
    const writes = () => seen.filter((c) => c.url.endsWith('/approve') && c.options.method === 'POST').length;

    assert.equal((await post({ csrf, project: 'group/app', iid: '7', sha: SHA }, { Origin: 'https://evil.example.com' })).status, 403);
    assert.equal((await post({ csrf: 'x', project: 'group/app', iid: '7', sha: SHA })).status, 403);
    assert.equal((await post({ csrf, project: 'other/app', iid: '7', sha: SHA })).status, 403, 'only the dashboard’s group');
    assert.equal(writes(), 0);

    const ok = await post({ csrf, project: 'group/app', iid: '7', sha: SHA });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).status, 'approved');
    assert.equal(writes(), 1);
    const write = seen.find((c) => c.url.endsWith('/approve') && c.options.method === 'POST');
    assert.equal(write.options.headers.Authorization, 'Bearer tok');
    assert.deepEqual(JSON.parse(write.options.body), { sha: SHA });

    const changed = await post({ csrf, project: 'group/app', iid: '7', sha: 'c'.repeat(40) });
    assert.equal((await changed.json()).status, 'failed', 'a head that moved is refused');
    assert.equal(writes(), 1);
  });
});

test('sign-out ends the dashboard session', async () => {
  await withDashboard({}, async ({ base }) => {
    const { cookie } = await signIn(base);
    const html = await (await fetch(`${base}/approve/dashboard`, { headers: { Cookie: cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)" data-csrf/.exec(html)[1];
    const out = await fetch(`${base}/approve/dashboard/signout`, { method: 'POST', redirect: 'manual', headers: { ...FORM, Origin: ORIGIN, Cookie: cookie }, body: new URLSearchParams({ csrf }).toString() });
    assert.equal(out.status, 303);
    assert.equal((await fetch(`${base}/approve/dashboard/data`, { headers: { Cookie: cookie } })).status, 401);
  });
});

test('filters: review requests, own and bot merge requests', () => {
  const mr = normalizeMr(node());
  assert.deepEqual(mrFilters(mr, 'Alice'), ['human', 'review']);
  assert.deepEqual(mrFilters(mr, 'bob'), ['human', 'mine']);
  const approved = normalizeMr(node({ approvedBy: { nodes: [{ username: 'alice', name: 'Alice' }] } }));
  assert.deepEqual(mrFilters(approved, 'alice'), ['human'], 'approved already: no longer waiting');
  const draft = normalizeMr(node({ draft: true }));
  assert.ok(!mrFilters(draft, 'alice').includes('review'));
  assert.ok(isBotMr(normalizeMr(node({ author: { username: 'renovate-bot', name: 'Renovate', bot: true } }))));
  assert.equal(defaultFilter([mr], 'alice'), 'review');
  assert.equal(defaultFilter([mr], 'zoe'), 'human');
});

test('sections: links stay on their hosts, failures read plainly', () => {
  assert.equal(webLink('javascript:alert(1)'), '');
  assert.equal(webLink('https://teams.example.com/x'), 'https://teams.example.com/x');
  const ctx = { username: 'alice', name: 'Alice', host: GL, avatars: {}, now: Date.now(), timeZone: 'UTC' };
  const offHost = mrsSection({ items: [normalizeMr(node({ webUrl: 'https://evil.example.com/x' }))] }, ctx);
  assert.ok(!offHost.includes('evil.example.com'), 'merge request links only on the GitLab host');
  assert.match(alertsSection({ data: { alerts: [], duty: [{ queue: 'On-call', who: 'Alice Example' }] } }, ctx), /No open alerts[\s\S]*Alice Example/);
  assert.match(meetingsSection({ data: [] }, ctx), /No more meetings/);
});
