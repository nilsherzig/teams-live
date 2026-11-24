import test from 'node:test';
import assert from 'node:assert/strict';
import { userApprovalPreflight, userApprovalWrite } from '../src/user-approval.mjs';

const record = { project: 'group/app', iid: 4, sha: 'a'.repeat(40), status: 'open' };
const session = { user: { id: 9 }, accessToken: 'example-token' };

test('preflight and write use the signed-in token and pinned SHA', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/user')) return Response.json({ id: 9, username: 'alice' });
    if (url.endsWith('/approvals')) return Response.json({ approved_by: [], user_can_approve: true });
    if (url.endsWith('/approve')) return Response.json({});
    return Response.json({ state: 'opened', sha: record.sha });
  };
  try {
    assert.equal((await userApprovalPreflight('gitlab.example.com', record, session)).status, 'ready');
    await userApprovalWrite('gitlab.example.com', record, session);
    assert.ok(calls.every(({ options }) => options.headers.Authorization === 'Bearer example-token'));
    assert.deepEqual(JSON.parse(calls.at(-1).options.body), { sha: record.sha });
  } finally { globalThis.fetch = original; }
});

test('preflight refuses a different identity, changed head and missing token', async () => {
  const original = globalThis.fetch;
  let userId = 10;
  let sha = record.sha;
  globalThis.fetch = async (url) => {
    if (url.endsWith('/user')) return Response.json({ id: userId });
    if (url.endsWith('/approvals')) return Response.json({ approved_by: [] });
    return Response.json({ state: 'opened', sha });
  };
  try {
    assert.equal((await userApprovalPreflight('gitlab.example.com', record, session)).status, 'blocked');
    userId = 9;
    sha = 'b'.repeat(40);
    assert.equal((await userApprovalPreflight('gitlab.example.com', record, session)).status, 'blocked');
    assert.equal((await userApprovalPreflight('gitlab.example.com', record, {})).status, 'blocked');
  } finally { globalThis.fetch = original; }
});
