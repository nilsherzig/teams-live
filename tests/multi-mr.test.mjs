import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMultiMrCard } from '../src/card-multi-mr.mjs';
import { ApproveServer } from '../src/approve.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { setRichMessages, transport } from '../src/teams.mjs';

const origin = 'https://approve.example.com';
const sha = 'a'.repeat(40);
const items = [{ project: 'group/app', iid: '1', sha }, { project: 'group/app', iid: '2', sha }];
const rows = items.map((item, i) => ({ ...item, title: `Change ${i}`, url: `https://gitlab.example.com/group/app/-/merge_requests/${item.iid}`, state: i ? 'open' : 'merged', author: 'Alice Example', approved: true, approvedBy: ['Bob Example'], pipeline: { status: 'success' } }));

test('multi-MR card links titles and references, shows people, merged progress and actions', () => {
  const card = buildMultiMrCard(rows, { approveUrl: 'https://example.com/approve', openUrl: 'https://example.com/open' });
  const content = JSON.stringify(card);
  assert.match(content, /1\/2/);
  assert.match(content, /Alice Example/);
  assert.match(content, /Bob Example/);
  assert.match(content, /Approve all/);
  assert.match(content, /Open all/);
  assert.equal((content.match(/Action.OpenUrl/g) || []).length, 4);
  assert.match(content, /merge_requests\/1/);
  assert.match(content, /merge_requests\/2/);
});

test('bulk confirmation rechecks heads and approves only the still-valid item', async () => {
  const writes = [];
  const heads = { 1: sha, 2: sha };
  const gitlab = {
    host: 'gitlab.example.com',
    mrLink: (project, iid) => `https://gitlab.example.com/${project}/-/merge_requests/${iid}`,
    pipelineLink: (project, iid) => `https://gitlab.example.com/${project}/-/pipelines/${iid}`,
    getMr: async (_project, iid) => ({ state: 'opened', sha: heads[iid], title: `Change ${iid}`, author: { username: 'author' } }),
    getUserApprovalState: async () => ({ known: true, hasApproved: false, canApprove: true, user: { id: 1, username: 'bot' } }),
    approveMr: async (project, iid, options) => { writes.push({ project, iid, sha: options.sha }); },
  };
  const server = new ApproveServer({ gitlab, baseUrl: `${origin}/approve`, port: 0, oauth: { clientId: 'cid', clientSecret: 'secret' } });
  await server.start();
  const base = `http://127.0.0.1:${server.port}/approve`;
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (!target.startsWith('https://gitlab.example.com/')) return originalFetch(url, options);
    if (target.endsWith('/oauth/token')) return Response.json({ access_token: 'user-token' });
    if (target.endsWith('/api/v4/user')) return Response.json({ id: 9, username: 'alice' });
    if (target.endsWith('/approvals')) return Response.json({ approved_by: [], user_can_approve: true });
    const iid = /merge_requests\/(\d+)/.exec(target)?.[1];
    if (target.endsWith('/approve')) {
      assert.equal(options.headers.Authorization, 'Bearer user-token');
      writes.push({ project: 'group/app', iid, sha: JSON.parse(options.body).sha });
      return Response.json({});
    }
    return Response.json({ state: 'opened', sha: heads[iid], author: { username: 'author' } });
  };
  try {
    const url = server.batchLinkFor(items, 'approve');
    const token = url.split('#')[1];
    const bootstrap = await fetch(`${base}/session`, { method: 'POST', headers, body: new URLSearchParams({ token }) });
    const cookie = /tl_approve=[^;]+/.exec(bootstrap.headers.get('set-cookie'))[0];
    const start = await fetch(`${base}/oauth/start`, { headers: { Cookie: cookie }, redirect: 'manual' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    await fetch(`${base}/oauth/callback?code=example&state=${state}`);
    const html = await (await fetch(`${base}/confirm`, { headers: { Cookie: cookie } })).text();
    assert.match(html, /Approve 2 eligible/);
    const fields = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]));
    const tampered = await fetch(`${base}/confirm`, { method: 'POST', headers: { ...headers, Cookie: cookie }, body: new URLSearchParams({ ...fields, actors: 'W10' }) });
    assert.equal(tampered.status, 403);
    assert.deepEqual(writes, [], 'the account list is bound to the confirmation token');
    heads[2] = 'b'.repeat(40);
    const newer = server.store.linkFor({ ...items[1], sha: heads[2], action: 'approve' });
    const response = await fetch(`${base}/confirm`, { method: 'POST', headers: { ...headers, Cookie: cookie }, body: new URLSearchParams(fields) });
    const result = await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(writes, [{ project: 'group/app', iid: '1', sha }]);
    assert.match(result, /merge request changed/i);
    assert.equal(server.store.byId(newer.record.id).status, 'open', 'an old batch cannot stale the new card link');
  } finally { globalThis.fetch = originalFetch; await server.stop(); }
});

test('open-all page offers each link and a user-initiated button', async () => {
  const gitlab = { host: 'gitlab.example.com', mrLink: (project, iid) => `https://gitlab.example.com/${project}/-/merge_requests/${iid}` };
  const server = new ApproveServer({ gitlab, baseUrl: `${origin}/approve`, port: 0 });
  await server.start();
  try {
    const token = server.batchLinkFor(items, 'open').split('#')[1];
    const base = `http://127.0.0.1:${server.port}/approve`;
    const boot = await fetch(`${base}/session`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin }, body: new URLSearchParams({ token }) });
    const cookie = /tl_approve=[^;]+/.exec(boot.headers.get('set-cookie'))[0];
    const response = await fetch(`${base}/confirm`, { headers: { Cookie: cookie } });
    const body = await response.text();
    assert.match(body, /id="open-all"/);
    assert.equal((body.match(/data-mr-link href/g) || []).length, 2);
    assert.match(response.headers.get('content-security-policy'), /script-src 'sha256-/);
  } finally { await server.stop(); }
});

test('watcher sends one combined reply, updates it on a merge, and persists its ID', async () => {
  const sent = [];
  const original = { ...transport };
  transport.sendMessage = async (...args) => { sent.push({ type: 'send', args }); return { ok: true, value: { timestamp: '1700000000001' } }; };
  transport.editMessage = async (...args) => { sent.push({ type: 'edit', args }); return { ok: true, value: {} }; };
  const states = { 1: 'pending', 2: 'pending' };
  const gitlab = {
    mrLink: (project, iid) => `https://gitlab.example.com/${project}/-/merge_requests/${iid}`,
    pipelineLink: (project, iid) => `https://gitlab.example.com/${project}/-/pipelines/${iid}`,
    getMrStatus: async (project, iid) => ({ project, iid, state: states[iid] === 'merged' ? 'merged' : 'opened', status: states[iid], title: `Change ${iid}`, sha, approved: false, approvalKnown: true, approvedBy: [], author: 'Alice Example', pipeline: { status: 'success', id: 4 }, autoMerge: false }),
  };
  const watcher = new MergeRequestWatcher({ config: { conversations: [], teams: { rich_messages: true }, gitlab: { notify: { ci: { enable: true, on_success: true } } } }, gitlab, jira: null, opsgenie: null });
  watcher.saveState = () => {};
  watcher.prefetchAvatars = async () => {};
  watcher.setReactionStatus = async (entry, status) => { entry.status = status; };
  const entry = { conversationId: '19:example@thread.v2', messageId: '1700000000000', from: 'Alice Example', createdAt: Date.now(), mrs: items.map((mr) => ({ ...mr, status: null, ciMessageServerId: null })), jobs: [], pipelines: [] };
  watcher.watched.set('key', entry);
  try {
    await watcher.checkWatchedKey('key');
    assert.equal(sent.filter((call) => call.type === 'send').length, 1);
    assert.equal(entry.multiMrMessageServerId, '1700000000001');
    const first = JSON.stringify(sent[0].args);
    assert.match(first, /Change 1/);
    assert.match(first, /Change 2/);
    await watcher.checkWatchedKey('key');
    assert.equal(sent.length, 1, 'unchanged polls do not edit the card');
    states[1] = 'merged';
    await watcher.checkWatchedKey('key');
    assert.equal(sent.filter((call) => call.type === 'edit').length, 1);
    assert.match(JSON.stringify(sent.at(-1).args), /1\/2/);
  } finally { Object.assign(transport, original); setRichMessages(false); }
});
