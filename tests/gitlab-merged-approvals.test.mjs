import test from 'node:test';
import assert from 'node:assert/strict';
import { GitLabClient } from '../src/gitlab.mjs';

// A merged or closed merge request still has its approvers in GitLab: the status read fetches them, so a card
// for an already merged merge request shows who approved it. The state stays merged/closed.

const HOST = 'git.example.com';
const json = (status, body = {}) => new Response(JSON.stringify(body), { status });

async function statusOf(state, { approvalsStatus = 200 } = {}) {
  const original = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async (url) => {
    if (!String(url).startsWith(`https://${HOST}/`)) return original(url);
    const path = new URL(url).pathname.replace('/api/v4/', '');
    paths.push(path);
    if (path.endsWith('/approvals')) {
      return approvalsStatus === 200
        ? json(200, { approved: true, approvals_required: 1, approvals_left: 0, approved_by: [{ user: { name: 'Bob Example', username: 'bob' } }] })
        : json(approvalsStatus, {});
    }
    if (path.endsWith('/pipelines')) return json(200, []);
    if (/\/merge_requests\/7(\?|$)/.test(path) || path.endsWith('/merge_requests/7')) return json(200, { iid: 7, title: 'Example', state, author: { name: 'Alice Example' }, detailed_merge_status: 'not_open' });
    return json(404, {});
  };
  try {
    const gitlab = new GitLabClient({ host: HOST, token: 't' });
    return { result: await gitlab.getMrStatus('group/app', 7), paths };
  } finally {
    globalThis.fetch = original;
  }
}

test('a merged merge request reports its approvers and stays merged', async () => {
  const { result, paths } = await statusOf('merged');
  assert.equal(result.status, 'merged');
  assert.deepEqual(result.approvedBy, ['Bob Example']);
  assert.equal(result.approved, true);
  assert.equal(result.approvalKnown, true);
  assert.ok(paths.some((p) => p.endsWith('/approvals')));
});

test('a closed merge request does the same, and a failed approvals lookup stays unknown', async () => {
  const closed = await statusOf('closed');
  assert.equal(closed.result.status, 'closed');
  assert.deepEqual(closed.result.approvedBy, ['Bob Example']);
  const failed = await statusOf('merged', { approvalsStatus: 403 });
  assert.equal(failed.result.status, 'merged');
  assert.equal(failed.result.approvalKnown, false);
  assert.deepEqual(failed.result.approvedBy, []);
});
