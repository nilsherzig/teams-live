import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ApproveServer } from '../src/approve.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';

// The Rebase button: its link and its confirmation flow. One PUT to GitLab, never repeated; the result is read back.

const ORIGIN = 'https://approve.example.com';
const SHA = 'a'.repeat(40);
const PROJECT = 'group/app';
const IID = 7;
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

function makeGitlab({ mr = {}, reads = [], rebaseError = null, rebases = [], hasApproved = false } = {}) {
  const gitlab = {
    host: 'gitlab.example.com',
    calls: { rebase: [], reads: 0, approve: [], notes: [] },
    mr: { state: 'opened', sha: SHA, title: 'Example', detailed_merge_status: 'need_rebase', author: { username: 'author' }, ...mr },
    queue: [...reads],
    async getCurrentUser() {
      return { id: 1, username: 'owner' };
    },
    async getMr() {
      gitlab.calls.reads++;
      // The first reads are the page's own; the ones after a rebase come from `reads` in order.
      if (gitlab.calls.rebase.length > 0 && gitlab.queue.length > 0) gitlab.mr = { ...gitlab.mr, ...gitlab.queue.shift() };
      return gitlab.mr;
    },
    async getUserApprovalState() {
      return { known: true, user: { id: 1, username: 'owner' }, hasApproved, canApprove: true };
    },
    async approveMr(project, iid, opts) {
      gitlab.calls.approve.push({ project, iid, opts });
      return {};
    },
    async addMrNote(project, iid, note) {
      gitlab.calls.notes.push(note);
    },
    async rebaseMr(project, iid, opts) {
      gitlab.calls.rebase.push({ project, iid, opts });
      if (rebaseError) throw rebaseError;
      return { rebase_in_progress: true };
    },
  };
  void rebases;
  return gitlab;
}

async function withFlow(opts, fn) {
  const gitlab = makeGitlab(opts);
  const server = new ApproveServer({ gitlab, baseUrl: `${ORIGIN}/approve`, port: 0, oauth: { clientId: 'example', clientSecret: 'example' }, mergePollMs: 0, mergePollAttempts: 3, sleep: async () => {}, ...(opts.server || {}) });
  await server.start();
  const base = `http://127.0.0.1:${server.port}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (!target.startsWith('https://gitlab.example.com/api/v4/')) return originalFetch(url, options);
    if (target.endsWith('/user')) return Response.json({ id: 1, username: 'owner' });
    if (target.endsWith('/approvals')) return Response.json({ approved_by: opts.hasApproved ? [{ user: { id: 1 } }] : [], user_can_approve: true });
    if (target.endsWith('/approve')) {
      await gitlab.approveMr(PROJECT, IID, JSON.parse(options.body));
      return Response.json({});
    }
    return Response.json(gitlab.mr);
  };
  try {
    const link = server.store.linkFor({ project: PROJECT, iid: IID, action: 'rebase' });
    const boot = await fetch(`${base}/approve/session`, { method: 'POST', headers: { ...FORM, Origin: ORIGIN }, body: new URLSearchParams({ token: link.token }).toString() });
    const cookie = /tl_approve=[^;]+/.exec(boot.headers.get('set-cookie') || '')?.[0];
    const stored = server.sessions.get(crypto.createHash('sha256').update(cookie.split('=')[1]).digest('hex'));
    stored.user = { id: 1, username: 'owner' };
    stored.accessToken = 'mock-token';
    const page = () => fetch(`${base}/approve/confirm`, { headers: { Cookie: cookie } });
    const confirm = async () => {
      const html = await (await page()).text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
      return fetch(`${base}/approve/confirm`, { method: 'POST', headers: { ...FORM, Origin: ORIGIN, Cookie: cookie }, body: new URLSearchParams({ csrf, user: '1', cred: '' }).toString() });
    };
    // The follow-up form of a page: its hidden fields, posted back as the browser would (with overrides).
    const follow = async (html, overrides = {}) => {
      const fields = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]));
      return fetch(`${base}/approve/confirm`, { method: 'POST', headers: { ...FORM, Origin: ORIGIN, Cookie: cookie }, body: new URLSearchParams({ ...fields, ...overrides }).toString() });
    };
    await fn({ gitlab, server, page, confirm, follow, record: link.record });
  } finally {
    globalThis.fetch = originalFetch;
    await server.stop();
  }
}

test('the page offers the rebase and one confirmed request rebases once, reading the result back', async () => {
  await withFlow({ reads: [{ rebase_in_progress: true }, { rebase_in_progress: false, detailed_merge_status: 'not_approved' }] }, async ({ gitlab, server, page, confirm, record }) => {
    const html = await (await page()).text();
    assert.match(html, /Rebase this merge request/);
    assert.match(html, /name="csrf"/);
    const res = await confirm();
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Rebased in GitLab/);
    assert.equal(gitlab.calls.rebase.length, 1, 'one PUT');
    assert.equal(server.store.byId(record.id).status, 'used');
  });
});

test('a rebase GitLab reports as failed says why, and one still running is reported as started', async () => {
  await withFlow({ reads: [{ rebase_in_progress: false, merge_error: 'Rebase failed. Please rebase locally' }] }, async ({ confirm }) => {
    const res = await confirm();
    assert.equal(res.status, 409);
    assert.match(await res.text(), /could not rebase the merge request: Rebase failed/);
  });
  await withFlow({ reads: Array.from({ length: 12 }, () => ({ rebase_in_progress: true })) }, async ({ confirm, gitlab }) => {
    const res = await confirm();
    assert.equal(res.status, 200);
    assert.match(await res.text(), /still working on it/);
    assert.equal(gitlab.calls.rebase.length, 1);
  });
});

test('nothing is offered or sent when the merge request is up to date, has conflicts or is no longer open', async () => {
  await withFlow({ mr: { detailed_merge_status: 'mergeable' } }, async ({ page, gitlab }) => {
    const html = await (await page()).text();
    assert.match(html, /already up to date/);
    assert.doesNotMatch(html, /Rebase this merge request/, 'no rebase form');
    assert.equal(gitlab.calls.rebase.length, 0);
  });
  await withFlow({ mr: { has_conflicts: true } }, async ({ page }) => {
    const res = await page();
    assert.equal(res.status, 409);
    assert.match(await res.text(), /merge conflicts/);
  });
  await withFlow({ mr: { state: 'merged' } }, async ({ page }) => {
    assert.match(await (await page()).text(), /merged\. Nothing to rebase/);
  });
});

test('a refused rebase keeps the link, a rejected one explains', async () => {
  const refused = new Error('GitLab error (403): forbidden');
  await withFlow({ rebaseError: refused }, async ({ confirm, server, record }) => {
    const res = await confirm();
    assert.equal(res.status, 403);
    assert.match(await res.text(), /Rebase refused/);
    assert.equal(server.store.byId(record.id).status, 'open', 'not used up');
  });
  const rejected = new Error('GitLab error (409): rebase already running');
  await withFlow({ rebaseError: rejected }, async ({ confirm }) => {
    const res = await confirm();
    assert.equal(res.status, 409);
    assert.match(await res.text(), /Nothing was rebased/);
  });
});

test('rebase links can be switched off, and records are stored under their own key', async () => {
  const off = new ApproveServer({ gitlab: makeGitlab(), baseUrl: `${ORIGIN}/approve`, rebaseEnabled: false });
  assert.equal(off.linkFor({ project: PROJECT, iid: IID, action: 'rebase' }), null);
  assert.ok(off.linkFor({ project: PROJECT, iid: IID, sha: SHA }), 'approve links are unaffected');
  assert.equal(new ApproveServer({ gitlab: makeGitlab(), baseUrl: `${ORIGIN}/approve` }).rebaseEnabled, true);
  // Signed-in users: only an approval is barred for the author; rebasing, merging and reopening are not.
  const signedIn = new ApproveServer({ gitlab: makeGitlab(), baseUrl: `${ORIGIN}/approve`, oauth: { clientId: 'c', clientSecret: 's' } });
  const author = { username: 'author' };
  const mr = { author: { username: 'author' } };
  assert.match(signedIn.signInDenied(author, mr, 'approve'), /author/);
  for (const kind of ['rebase', 'merge', 'reopen']) assert.equal(signedIn.signInDenied(author, mr, kind), '', kind);
});

test('the card offers Rebase first, then Approve, and Merge only when GitLab says it is mergeable', () => {
  const flow = new ApproveServer({ gitlab: makeGitlab(), baseUrl: `${ORIGIN}/approve`, mergeEnabled: true });
  const watcher = new MergeRequestWatcher({
    config: { conversations: [], gitlab: { group: 'group', notify: { ci: { enable: true } } }, teams: { rich_messages: true } },
    gitlab: { mrLink: (p, i) => `https://gitlab.example.com/${p}/-/merge_requests/${i}`, findMrLinks: () => [] },
    jira: null,
    opsgenie: null,
  });
  watcher.saveState = () => {};
  watcher.setApproveFlow(flow);
  const mr = { project: PROJECT, iid: IID, title: 'Example' };
  const buttons = (details, state = 'open') => (watcher.buildMrCard(mr, { sha: SHA, draft: false, approved: false, title: 'Example', ...details }, { state }).actions ?? []).map((a) => a.title);

  assert.deepEqual(buttons({ needsRebase: true, detailedMergeStatus: 'need_rebase' }), ['🔁 Rebase', '👍 Approve']);
  assert.deepEqual(buttons({ needsRebase: false, detailedMergeStatus: 'mergeable' }), ['👍 Approve', '🔀 Merge']);
  assert.deepEqual(buttons({ needsRebase: false, detailedMergeStatus: 'ci_still_running' }), ['👍 Approve'], 'Merge hidden: not mergeable');
  assert.deepEqual(buttons({ needsRebase: true, hasConflicts: true, detailedMergeStatus: 'conflict' }), ['👍 Approve'], 'conflicts: no Rebase');
  assert.deepEqual(buttons({ needsRebase: true, detailedMergeStatus: 'need_rebase' }, 'merged'), []);
  const rebases = [...flow.store.records.values()].filter((r) => r.action === 'rebase');
  assert.equal(rebases.length, 1, 'one rebase link, reused across refreshes');
});

const NEW = 'b'.repeat(40);

test('after a rebase the result page offers Approve for the new head, and one click approves exactly that head', async () => {
  await withFlow({ reads: [{ rebase_in_progress: false, sha: NEW, detailed_merge_status: 'not_approved' }] }, async ({ gitlab, confirm, follow }) => {
    const done = await confirm();
    const html = await done.text();
    assert.match(html, /Rebased in GitLab/);
    assert.match(html, /name="follow" value="approve"/);
    assert.match(html, new RegExp(`name="sha" value="${NEW}"`));
    assert.match(html, /👍 Approve/);
    assert.equal(gitlab.calls.approve.length, 0, 'nothing approved by the rebase');
    const res = await follow(html);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Approved in GitLab/);
    assert.equal(gitlab.calls.approve.length, 1);
    assert.equal(gitlab.calls.approve[0].opts.sha, NEW, 'guarded by the head the page showed');
    assert.equal(gitlab.calls.notes.length, 1, 'only the bot rebase needs an attribution comment');
  });
});

test('no Approve is offered when the account already approved, and a head that moved on is refused', async () => {
  await withFlow({ hasApproved: true, reads: [{ rebase_in_progress: false, sha: NEW }] }, async ({ confirm }) => {
    assert.doesNotMatch(await (await confirm()).text(), /name="follow"/);
  });
  await withFlow({ reads: [{ rebase_in_progress: false, sha: NEW }] }, async ({ gitlab, confirm, follow }) => {
    const html = await (await confirm()).text();
    gitlab.mr = { ...gitlab.mr, sha: 'c'.repeat(40) };
    const res = await follow(html);
    assert.equal(res.status, 409);
    assert.match(await res.text(), /merge request changed/i);
    assert.equal(gitlab.calls.approve.length, 0);
  });
});

test('the follow-up cannot be redirected to another head or forged', async () => {
  await withFlow({ reads: [{ rebase_in_progress: false, sha: NEW }] }, async ({ gitlab, confirm, follow }) => {
    const html = await (await confirm()).text();
    const other = await follow(html, { sha: 'd'.repeat(40) });
    assert.equal(other.status, 403, 'the head is bound into the CSRF token');
    const forged = await follow(html, { csrf: 'x.y' });
    assert.equal(forged.status, 403);
    const wrongAccount = await follow(html, { user: '99' });
    assert.equal(wrongAccount.status, 403);
    assert.equal(gitlab.calls.approve.length, 0);
  });
});

test('a rebase still running offers no Approve yet, and an up-to-date merge request offers it right away', async () => {
  await withFlow({ reads: Array.from({ length: 12 }, () => ({ rebase_in_progress: true })) }, async ({ confirm }) => {
    const html = await (await confirm()).text();
    assert.match(html, /still rebasing/);
    assert.doesNotMatch(html, /name="follow"/);
  });
  await withFlow({ mr: { detailed_merge_status: 'not_approved', sha: NEW } }, async ({ page }) => {
    const html = await (await page()).text();
    assert.match(html, /already up to date/);
    assert.match(html, /name="follow" value="approve"/);
  });
});

test('the action forms are sent in the background: busy button, the answer in place, never a second request', async () => {
  const { liveScript } = await import('../src/approve-page.mjs');
  const script = liveScript('/approve/state');
  assert.match(script, /hasAttribute\('data-act'\)/);
  assert.match(script, /fetch\(f\.action,\{method:'POST'/);
  assert.match(script, /data-busy/);
  assert.match(script, /m\.innerHTML=n\.innerHTML/, 'the answer replaces the page content');
  assert.doesNotMatch(script, /\.submit\(\)/, 'a failed request is reported, never repeated');
  assert.match(script, /data-sent/, 'a second click is ignored');
  await withFlow({}, async ({ page }) => {
    const html = await (await page()).text();
    assert.match(html, /<form method="post" data-act /);
    assert.match(html, /data-busy="Rebasing…"/);
    assert.ok(html.includes('type="submit"'), 'still a normal form without the script');
  });
  await withFlow({ reads: [{ rebase_in_progress: false, sha: NEW }] }, async ({ confirm }) => {
    const html = await (await confirm()).text();
    assert.match(html, /data-busy="Approving…"/, 'the follow-up Approve is sent the same way');
  });
});

test('every successful action leaves a comment; the address is only in it when nobody signed in', async () => {
  const notes = [];
  const gitlab = makeGitlab();
  gitlab.addMrNote = async (project, iid, note) => {
    notes.push(note);
  };
  const server = new ApproveServer({ gitlab, baseUrl: `${ORIGIN}/approve`, mergeEnabled: true });
  const record = { project: PROJECT, iid: IID };
  const result = { user: { id: 1, username: 'owner' }, tokenIndex: undefined };
  for (const [action, button, title] of [
    ['approved', 'Approve', 'Approved via Microsoft Teams'],
    ['merged', 'Merge', 'Merged via Microsoft Teams'],
    ['rebased', 'Rebase', 'Rebase requested via Microsoft Teams'],
    ['reopened', 'Reopen', 'Reopened via Microsoft Teams'],
  ]) {
    notes.length = 0;
    await server.noteAction(record, result, { action, button, ip: '203.0.113.9', signedIn: null });
    assert.match(notes[0], new RegExp(`\\*\\*${title}\\*\\*`), action);
    assert.match(notes[0], new RegExp(`${button} button on a Teams card`), action);
    assert.match(notes[0], /someone with the card's .* link \(confirmed as @owner\)/);
    assert.match(notes[0], /IP address:\*\* `203\.0\.113\.9`/, 'nobody signed in: the address is shown');

    notes.length = 0;
    await server.noteAction(record, result, { action, button, ip: '203.0.113.9', signedIn: { username: 'alice' } });
    assert.match(notes[0], /@alice \(signed in with GitLab\)/, action);
    assert.doesNotMatch(notes[0], /IP address|203\.0\.113\.9/, 'a known requester: no address');
  }
});

test('a confirmed rebase comments, while the personal approval needs no bot attribution', async () => {
  await withFlow({ reads: [{ rebase_in_progress: false, sha: NEW }] }, async ({ gitlab, confirm, follow }) => {
    const html = await (await confirm()).text();
    assert.equal(gitlab.calls.notes.length, 1);
    assert.match(gitlab.calls.notes[0], /Rebase requested via Microsoft Teams/);
    await follow(html);
    assert.equal(gitlab.calls.notes.length, 1);
  });
});
