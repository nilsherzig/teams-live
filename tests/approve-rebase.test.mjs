import test from 'node:test';
import assert from 'node:assert/strict';
import { ApproveServer } from '../src/approve.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';

// The Rebase button: its link and its confirmation flow. One PUT to GitLab, never repeated; the result is read back.

const ORIGIN = 'https://approve.example.com';
const SHA = 'a'.repeat(40);
const PROJECT = 'group/app';
const IID = 7;
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

function makeGitlab({ mr = {}, reads = [], rebaseError = null, rebases = [] } = {}) {
  const gitlab = {
    calls: { rebase: [], reads: 0 },
    mr: { state: 'opened', sha: SHA, title: 'Example', detailed_merge_status: 'need_rebase', author: { username: 'author' }, ...mr },
    queue: [...reads],
    async getCurrentUser() {
      return { id: 1, username: 'owner' };
    },
    async getMr() {
      gitlab.calls.reads++;
      // The first reads are the page's own; the ones after a rebase come from `reads` in order.
      return gitlab.calls.rebase.length > 0 && gitlab.queue.length > 0 ? { ...gitlab.mr, ...gitlab.queue.shift() } : gitlab.mr;
    },
    async getUserApprovalState() {
      return { known: true, user: { id: 1, username: 'owner' }, hasApproved: false, canApprove: true };
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
  const server = new ApproveServer({ gitlab, baseUrl: `${ORIGIN}/approve`, port: 0, mergePollMs: 0, mergePollAttempts: 3, sleep: async () => {}, ...(opts.server || {}) });
  await server.start();
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const link = server.store.linkFor({ project: PROJECT, iid: IID, action: 'rebase' });
    const boot = await fetch(`${base}/approve/session`, { method: 'POST', headers: { ...FORM, Origin: ORIGIN }, body: new URLSearchParams({ token: link.token }).toString() });
    const cookie = /tl_approve=[^;]+/.exec(boot.headers.get('set-cookie') || '')?.[0];
    const page = () => fetch(`${base}/approve/confirm`, { headers: { Cookie: cookie } });
    const confirm = async () => {
      const html = await (await page()).text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
      return fetch(`${base}/approve/confirm`, { method: 'POST', headers: { ...FORM, Origin: ORIGIN, Cookie: cookie }, body: new URLSearchParams({ csrf, user: '1', cred: '' }).toString() });
    };
    await fn({ gitlab, server, page, confirm, record: link.record });
  } finally {
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
    assert.doesNotMatch(html, /name="csrf"/);
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
