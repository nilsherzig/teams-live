import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { WebhookReconciler, deriveGenerationToken, parseMarker } from '../src/webhook-reconcile.mjs';
import { GitLabWebhookServer } from '../src/webhook.mjs';
import { GitLabClient } from '../src/gitlab.mjs';

const SECRET = 's'.repeat(40);
const URL_A = 'https://old.example.com/webhook/gitlab';
const URL_B = 'https://new.example.com/webhook/gitlab';

function fakeGitlab(initial = []) {
  const hooks = initial.map((h) => ({ ...h }));
  let nextId = 100;
  const calls = [];
  const g = {
    token: 'dummy',
    group: 'my-group',
    hooks,
    calls,
    failList: false,
    async listGroupHooks() {
      calls.push(['list']);
      if (g.failList) throw new Error('GitLab error (500): boom');
      return hooks.map((h) => ({ ...h }));
    },
    async getGroupHook(_g, id) {
      calls.push(['get', id]);
      const h = hooks.find((x) => x.id === id);
      return h ? { ...h } : null;
    },
    async addGroupHook(_g, body) {
      calls.push(['post', body]);
      const h = { id: nextId++, ...body };
      delete h.token;
      h.__token = body.token;
      hooks.push(h);
      return { ...h };
    },
    async editGroupHook(_g, id, body) {
      calls.push(['put', id, body]);
      Object.assign(
        hooks.find((x) => x.id === id),
        body
      );
      return { ...hooks.find((x) => x.id === id) };
    },
    async deleteGroupHook(_g, id) {
      calls.push(['delete', id]);
      const i = hooks.findIndex((x) => x.id === id);
      if (i < 0) throw new Error('GitLab error (404): Not found');
      hooks.splice(i, 1);
      return {};
    },
    async testGroupHook(_g, id) {
      calls.push(['test', id]);
      return {};
    },
  };
  return g;
}

function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-wh-'));
  return { dir, file: path.join(dir, 'webhook-reconcile.json') };
}

function make(gitlab, file, extra = {}) {
  const logs = [];
  const r = new WebhookReconciler({
    gitlab,
    url: URL_A,
    secret: SECRET,
    stateFile: file,
    intervalMs: 0,
    log: (m) => logs.push(m),
    ...extra,
  });
  r.logs = logs;
  return r;
}

const writes = (g) => g.calls.filter((c) => ['post', 'put', 'delete'].includes(c[0]));

test('fresh install creates one marked hook with a derived token and no PUT', async () => {
  const { file } = tmpState();
  const g = fakeGitlab();
  const r = make(g, file);
  const res = await r.reconcile();
  assert.equal(res.ok, true);
  assert.equal(res.action, 'created');
  assert.equal(g.hooks.length, 1);
  const hook = g.hooks[0];
  const marker = parseMarker(hook);
  assert.ok(marker);
  assert.equal(marker.ownerId, r.state.ownerId);
  assert.notEqual(hook.__token, SECRET);
  assert.equal(hook.__token, deriveGenerationToken(SECRET, marker.ownerId, marker.genId));
  assert.ok(hook.name.startsWith('teams-live '));
  assert.equal(g.calls.some((c) => c[0] === 'put'), false);
  // state: 0600, no secret, no token
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes(SECRET), false);
  assert.equal(raw.includes(hook.__token), false);
  assert.equal(r.state.current.id, hook.id);
  assert.equal(r.state.replacement, null);
  // log never carries tokens
  assert.equal(r.logs.join('\n').includes(hook.__token), false);
  assert.equal(r.logs.join('\n').includes(SECRET), false);
});

test('a second run changes nothing', async () => {
  const { file } = tmpState();
  const g = fakeGitlab();
  const r = make(g, file);
  await r.reconcile();
  g.calls.length = 0;
  const r2 = make(g, file);
  const res = await r2.reconcile();
  assert.equal(res.action, 'unchanged');
  assert.deepEqual(writes(g), []);
});

test('changed event flags are updated without touching URL or token', async () => {
  const { file } = tmpState();
  const g = fakeGitlab();
  await make(g, file).reconcile();
  g.hooks[0].pipeline_events = false;
  g.calls.length = 0;
  const res = await make(g, file).reconcile();
  assert.equal(res.action, 'updated');
  const put = g.calls.find((c) => c[0] === 'put');
  assert.equal(put[2].url, URL_A);
  assert.equal('token' in put[2], false);
  assert.equal(g.hooks[0].pipeline_events, true);
});

test('a hostname change creates a replacement, keeps the old hook until delivery proof, then deletes it', async () => {
  const { file } = tmpState();
  const g = fakeGitlab();
  await make(g, file).reconcile();
  const oldId = g.hooks[0].id;
  g.calls.length = 0;

  const r = make(g, file, { url: URL_B });
  const res = await r.reconcile();
  assert.equal(res.action, 'created');
  assert.equal(g.hooks.length, 2);
  assert.equal(g.calls.some((c) => c[0] === 'put'), false);
  assert.equal(g.calls.some((c) => c[0] === 'delete'), false);
  const replacement = g.hooks.find((h) => h.url === URL_B);
  assert.ok(replacement);
  assert.equal(parseMarker(replacement).ownerId, r.state.ownerId);
  assert.notEqual(parseMarker(replacement).genId, parseMarker(g.hooks.find((h) => h.id === oldId)).genId);
  assert.equal(res.awaitingDelivery, true);
  assert.equal(r.state.stale.length, 1);
  assert.equal(r.state.stale[0].id, oldId);
  // best-effort test delivery asked for
  assert.ok(g.calls.some((c) => c[0] === 'test' && c[1] === replacement.id));

  // still no deletion on another run before proof
  await r.reconcile();
  assert.equal(g.calls.some((c) => c[0] === 'delete'), false);

  // receiver accepts both generations' tokens
  const tokens = r.acceptedTokens().map((t) => t.token);
  assert.ok(tokens.includes(replacement.__token));
  assert.ok(tokens.includes(g.hooks.find((h) => h.id === oldId).__token));
  assert.equal(tokens.includes(SECRET), false);

  // delivery of the replacement proves it
  r.noteDelivery(parseMarker(replacement).genId);
  const res2 = await r.reconcile();
  assert.equal(res2.ok, true);
  assert.deepEqual(
    g.hooks.map((h) => h.id),
    [replacement.id]
  );
  assert.equal(r.state.stale.length, 0);
  assert.equal(r.state.current.id, replacement.id);
  assert.equal(r.state.replacement, null);
});

test('a delivery from the old generation does not verify the replacement', async () => {
  const { file } = tmpState();
  const g = fakeGitlab();
  await make(g, file).reconcile();
  const oldGen = parseMarker(g.hooks[0]).genId;
  const r = make(g, file, { url: URL_B });
  await r.reconcile();
  r.noteDelivery(oldGen);
  await r.reconcile();
  assert.equal(g.hooks.length, 2);
  assert.equal(r.state.replacement.verifiedAt, null);
});

test('an unmarked hook with the configured URL is never adopted, modified or deleted', async () => {
  const { file } = tmpState();
  const foreign = { id: 7, url: URL_A, description: 'hand made', merge_requests_events: false, pipeline_events: false, enable_ssl_verification: false };
  const g = fakeGitlab([foreign]);
  const r = make(g, file);
  const res = await r.reconcile();
  assert.equal(res.ok, true);
  assert.equal(g.calls.some((c) => (c[0] === 'put' || c[0] === 'delete') && c[1] === 7), false);
  assert.deepEqual(g.hooks.find((h) => h.id === 7), foreign);
  assert.equal(g.hooks.length, 2);
  assert.notEqual(r.state.current.id, 7);
  // and a later run still leaves it alone
  await make(g, file).reconcile();
  assert.deepEqual(g.hooks.find((h) => h.id === 7), foreign);
});

test('a hook marked by another owner or named like ours is ignored', async () => {
  const { file } = tmpState();
  const other = '11111111-1111-4111-8111-111111111111';
  const g = fakeGitlab([
    { id: 5, url: URL_A, name: 'teams-live', description: `teams-live-owner:${other} gen:${other} v1` },
    { id: 6, url: 'https://x.example.com/h', name: 'teams-live abcdef12', description: 'teams-live' },
  ]);
  const r = make(g, file);
  await r.reconcile();
  r.noteDelivery('whatever');
  await r.reconcile();
  assert.ok(g.hooks.some((h) => h.id === 5));
  assert.ok(g.hooks.some((h) => h.id === 6));
  assert.equal(g.calls.some((c) => c[0] === 'delete'), false);
});

test('adopt_hooks takes over a legacy hook, accepts its shared secret and deletes it after the replacement is proven', async () => {
  const { file } = tmpState();
  const legacy = { id: 9, url: URL_A, description: '', merge_requests_events: true, pipeline_events: true, enable_ssl_verification: true };
  const g = fakeGitlab([legacy]);
  const r = make(g, file, { url: URL_B, adoptHooks: [{ id: 9, url: URL_A }] });
  await r.reconcile();
  assert.equal(g.hooks.length, 2);
  assert.ok(r.acceptedTokens().some((t) => t.token === SECRET));
  const replacement = g.hooks.find((h) => h.id !== 9);
  assert.equal(r.state.stale[0].id, 9);
  assert.equal(g.calls.some((c) => c[0] === 'delete'), false);
  r.noteDelivery(parseMarker(replacement).genId);
  await r.reconcile();
  assert.deepEqual(
    g.hooks.map((h) => h.id),
    [replacement.id]
  );
  // legacy gone: the shared secret is no longer accepted
  assert.equal(r.acceptedTokens().some((t) => t.token === SECRET), false);
});

test('adopt_hooks with the configured URL becomes the current legacy hook and is left as is', async () => {
  const { file } = tmpState();
  const legacy = { id: 9, url: URL_A, description: '', merge_requests_events: true, pipeline_events: true, enable_ssl_verification: true };
  const g = fakeGitlab([legacy]);
  const r = make(g, file, { adoptHooks: [{ id: 9, url: URL_A }] });
  const res = await r.reconcile();
  assert.equal(res.action, 'unchanged');
  assert.deepEqual(writes(g), []);
  assert.equal(r.state.current.legacy, true);
  assert.ok(r.acceptedTokens().some((t) => t.token === SECRET));
});

test('adopt_hooks refuses a wrong URL, a marker, and a missing hook', async () => {
  const { file } = tmpState();
  const other = '11111111-1111-4111-8111-111111111111';
  const g = fakeGitlab([
    { id: 1, url: 'https://elsewhere.example.com/h', description: '' },
    { id: 2, url: URL_A, description: `teams-live-owner:${other} gen:${other} v1` },
  ]);
  const r = make(g, file, {
    url: URL_B,
    adoptHooks: [
      { id: 1, url: URL_A },
      { id: 2, url: URL_A },
      { id: 3, url: URL_A },
    ],
  });
  await r.reconcile();
  assert.equal(r.state.stale.length, 0);
  assert.equal(r.state.current.url, URL_B);
  assert.equal(r.acceptedTokens().some((t) => t.token === SECRET), false);
  r.noteDelivery(parseMarker(g.hooks.find((h) => h.url === URL_B)).genId);
  await r.reconcile();
  assert.equal(g.calls.some((c) => c[0] === 'delete'), false);
});

test('a listing error means no change at all', async () => {
  const { file } = tmpState();
  const g = fakeGitlab();
  g.failList = true;
  const res = await make(g, file).reconcile();
  assert.equal(res.ok, false);
  assert.deepEqual(writes(g), []);
});

test('the listing is paginated and a failed page fails the whole run', async () => {
  const pages = [];
  const client = new GitLabClient({ host: 'git.example.com', token: 't', group: 'my-group' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push(page);
    if (page === 3) return { ok: false, status: 500, text: async () => 'boom' };
    return { ok: true, status: 200, json: async () => Array.from({ length: 100 }, (_, i) => ({ id: page * 1000 + i })) };
  };
  try {
    await assert.rejects(() => client.listGroupHooks(), /500/);
    assert.deepEqual(pages, [1, 2, 3]);
    pages.length = 0;
    globalThis.fetch = async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      pages.push(page);
      return { ok: true, status: 200, json: async () => Array.from({ length: page === 3 ? 5 : 100 }, (_, i) => ({ id: page * 1000 + i })) };
    };
    const all = await client.listGroupHooks();
    assert.equal(all.length, 205);
    assert.deepEqual(pages, [1, 2, 3]);
    globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'Not found' });
    assert.equal(await client.getGroupHook('my-group', 5), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deletion is re-checked: a stale hook that changed or lost its marker is not deleted', async () => {
  const { file } = tmpState();
  const g = fakeGitlab();
  await make(g, file).reconcile();
  const oldId = g.hooks[0].id;
  const r = make(g, file, { url: URL_B });
  await r.reconcile();
  const replacement = g.hooks.find((h) => h.url === URL_B);
  // someone repurposes the old hook in the meantime
  g.hooks.find((h) => h.id === oldId).description = 'now mine';
  r.noteDelivery(parseMarker(replacement).genId);
  await r.reconcile();
  assert.ok(g.hooks.some((h) => h.id === oldId));
  assert.equal(r.state.stale.length, 0);
});

test('deletion is skipped when the replacement lost its marker', async () => {
  const { file } = tmpState();
  const g = fakeGitlab();
  await make(g, file).reconcile();
  const r = make(g, file, { url: URL_B });
  await r.reconcile();
  const replacement = g.hooks.find((h) => h.url === URL_B);
  r.noteDelivery(parseMarker(replacement).genId);
  replacement.description = '';
  const res = await r.reconcile();
  assert.equal(res.ok, false);
  assert.equal(g.calls.some((c) => c[0] === 'delete'), false);
});

test('a 404 when deleting counts as done', async () => {
  const { file } = tmpState();
  const g = fakeGitlab();
  await make(g, file).reconcile();
  const oldId = g.hooks[0].id;
  const r = make(g, file, { url: URL_B });
  await r.reconcile();
  const replacement = g.hooks.find((h) => h.url === URL_B);
  r.noteDelivery(parseMarker(replacement).genId);
  const realDelete = g.deleteGroupHook;
  g.deleteGroupHook = async (grp, id) => {
    await realDelete(grp, id);
    throw new Error('GitLab error (404): Not found');
  };
  const res = await r.reconcile();
  assert.equal(res.ok, true);
  assert.equal(g.hooks.some((h) => h.id === oldId), false);
  assert.equal(r.state.stale.length, 0);
});

test('at most three deletions per run, the rest on the next run', async () => {
  const { file } = tmpState();
  const legacy = Array.from({ length: 5 }, (_, i) => ({ id: 20 + i, url: `https://old${i}.example.com/h`, description: '' }));
  const g = fakeGitlab(legacy);
  const r = make(g, file, { url: URL_B, adoptHooks: legacy.map((h) => ({ id: h.id, url: h.url })) });
  await r.reconcile();
  const replacement = g.hooks.find((h) => h.url === URL_B);
  r.noteDelivery(parseMarker(replacement).genId);
  await r.reconcile();
  assert.equal(g.calls.filter((c) => c[0] === 'delete').length, 3);
  assert.equal(r.state.stale.length, 2);
  await r.reconcile();
  assert.equal(g.calls.filter((c) => c[0] === 'delete').length, 5);
  assert.equal(g.hooks.length, 1);
});

test('without a strong secret hooks are only registered, never replaced or deleted', async () => {
  for (const secret of [null, 'short']) {
    const { file } = tmpState();
    const g = fakeGitlab();
    const r = make(g, file, { secret });
    assert.equal(r.managed, false);
    await r.reconcile();
    assert.equal(g.hooks.length, 1);
    const r2 = make(g, file, { secret, url: URL_B });
    await r2.reconcile();
    assert.equal(g.hooks.length, 2);
    r2.noteDelivery(parseMarker(g.hooks[1]).genId);
    await r2.reconcile();
    assert.equal(g.calls.some((c) => c[0] === 'delete'), false);
    assert.equal(g.calls.some((c) => c[0] === 'put'), false);
  }
});

test('fail closed: two owned hooks on the configured URL, and a tracked hook whose URL changed', async () => {
  const { file } = tmpState();
  const g = fakeGitlab();
  const r = make(g, file);
  await r.reconcile();
  const ownerId = r.state.ownerId;
  const gen2 = '22222222-2222-4222-8222-222222222222';
  g.hooks.push({ id: 50, url: URL_A, description: `teams-live-owner:${ownerId} gen:${gen2} v1` });
  g.calls.length = 0;
  let res = await make(g, file).reconcile();
  assert.equal(res.ok, false);
  assert.deepEqual(writes(g), []);
  g.hooks.pop();

  g.hooks[0].url = 'https://moved.example.com/h';
  res = await make(g, file).reconcile();
  assert.equal(res.ok, false);
  assert.deepEqual(writes(g), []);
});

test('crash recovery: a generation persisted before the hook existed is matched by its marker', async () => {
  const { file } = tmpState();
  const g = fakeGitlab();
  const r = make(g, file);
  // simulate: state written, POST succeeded, id never persisted
  const genId = '33333333-3333-4333-8333-333333333333';
  r.loadState();
  r.state.replacement = { id: null, url: URL_A, genId, verifiedAt: null };
  r.saveState();
  g.hooks.push({ id: 77, url: URL_A, description: `teams-live-owner:${r.state.ownerId} gen:${genId} v1` });
  const res = await make(g, file).reconcile();
  assert.equal(res.ok, true);
  assert.equal(g.hooks.length, 1);
});

test('a rotated secret replaces the managed generation', async () => {
  const { file } = tmpState();
  const g = fakeGitlab();
  await make(g, file).reconcile();
  const oldId = g.hooks[0].id;
  const secret2 = 'r'.repeat(40);
  const r = make(g, file, { secret: secret2 });
  await r.reconcile();
  assert.equal(g.hooks.length, 2);
  const fresh = g.hooks.find((h) => h.id !== oldId);
  assert.equal(fresh.__token, deriveGenerationToken(secret2, r.state.ownerId, parseMarker(fresh).genId));
  assert.ok(r.state.stale.some((s) => s.id === oldId));
  assert.equal(g.calls.some((c) => c[0] === 'delete'), false);
  r.noteDelivery(parseMarker(fresh).genId);
  await r.reconcile();
  assert.deepEqual(
    g.hooks.map((h) => h.id),
    [fresh.id]
  );
});

test('tokens are domain separated and per generation', () => {
  const a = deriveGenerationToken(SECRET, 'o1', 'g1');
  assert.notEqual(a, deriveGenerationToken(SECRET, 'o1', 'g2'));
  assert.notEqual(a, deriveGenerationToken(SECRET, 'o2', 'g1'));
  assert.notEqual(a, SECRET);
  // canonical serialization: field boundaries cannot be shifted
  assert.notEqual(deriveGenerationToken(SECRET, 'o', '1g1'), deriveGenerationToken(SECRET, 'o1', 'g1'));
  assert.equal(parseMarker({ description: 'x' }), null);
});

function post(urlStr, headers) {
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

test('the receiver accepts generation tokens, reports the generation and rejects the shared secret when managed', async () => {
  const { file } = tmpState();
  const g = fakeGitlab();
  const r = make(g, file, { url: URL_B });
  r.loadState();
  await r.reconcile();
  const hook = g.hooks[0];
  const delivered = [];
  const events = [];
  const server = new GitLabWebhookServer({
    port: 0,
    host: '127.0.0.1',
    secret: SECRET,
    acceptedTokens: () => r.acceptedTokens(),
    onDelivery: (gen) => delivered.push(gen),
    onEvent: (t) => events.push(t),
  });
  await server.start();
  const port = server.server.address().port;
  const target = `http://127.0.0.1:${port}/webhook/gitlab`;
  try {
    assert.equal(await post(target, { 'X-Gitlab-Token': hook.__token, 'X-Gitlab-Event': 'Merge Request Hook' }), 200);
    assert.deepEqual(delivered, [parseMarker(hook).genId]);
    assert.equal(await post(target, { 'X-Gitlab-Token': SECRET }), 401);
    assert.equal(await post(target, {}), 401);
    assert.equal(await post(target, { 'X-Gitlab-Token': 'x'.repeat(10) }), 401);
    assert.equal(delivered.length, 1);
    assert.equal(events.length, 1);
    // escape hatch accepts the shared secret, without claiming a generation
    r.acceptSharedSecret = true;
    assert.equal(await post(target, { 'X-Gitlab-Token': SECRET }), 200);
    assert.equal(delivered.length, 1);
  } finally {
    await server.stop();
  }
});

test('the plain receiver is unchanged: single shared secret, or open without one', () => {
  const s = new GitLabWebhookServer({ secret: 'abc' });
  assert.equal(s.verifyToken('abc'), true);
  assert.equal(s.verifyToken('abd'), false);
  assert.equal(s.verifyToken(''), false);
  assert.equal(new GitLabWebhookServer({}).verifyToken(undefined), true);
});
