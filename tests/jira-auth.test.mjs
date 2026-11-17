import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JiraClient, JiraHttpError } from '../src/jira.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function respond(sequence) {
  const queue = [...sequence];
  globalThis.fetch = async () => {
    const status = queue.shift();
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => 'denied',
      json: async () => ({ key: 'ABC-1', fields: { summary: 'S', status: { name: 'Open' } } }),
    };
  };
}

function makeClient() {
  const events = [];
  const client = new JiraClient({
    url: 'https://jira.example.test',
    token: 'x',
    onAuthError: (err) => events.push(['auth', err]),
    onSuccess: () => events.push(['ok']),
  });
  return { client, events };
}

function makeWatcher() {
  const watcher = new MergeRequestWatcher({
    config: { conversations: [], gitlab: { poll_interval_seconds: 60 }, teams: {} },
    gitlab: { findMrLinks: () => [] },
    jira: null,
    opsgenie: null,
  });
  watcher.getAdminConversationId = () => null;
  // Connector alert state is persisted on disk; keep each test's tracker private.
  watcher.serviceAlerts.file = null;
  watcher.serviceAlerts.states.clear();
  watcher.sentAlerts = [];
  watcher.sendServiceAlert = async (event) => {
    watcher.sentAlerts.push(event.type);
  };
  return watcher;
}

for (const status of [403, 404]) {
  test(`per-issue ${status} is an issue access error and raises no auth alert`, async () => {
    const { client, events } = makeClient();
    respond([status, 200]);
    await assert.rejects(client.getIssue('ABC-1'), (err) => {
      assert.ok(err instanceof JiraHttpError);
      assert.equal(err.status, status);
      assert.equal(err.isIssueAccessError, true);
      return true;
    });
    // Another successful request afterwards must not look like a "recovery".
    await client.getIssue('ABC-1');
    assert.deepEqual(events.filter(([k]) => k === 'auth'), []);
  });
}

test('per-issue 403 then 200 emits zero admin auth notifications', async () => {
  const watcher = makeWatcher();
  const { client } = makeClient();
  client.onAuthError = (err) => watcher.notifyAdminAuthExpired('Jira', err);
  client.onSuccess = () => watcher.notifyAdminAuthRecovered('Jira');
  respond([403, 200, 403, 200]);
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(client.getIssue('ABC-1'));
    await client.getIssue('ABC-1');
  }
  assert.equal(watcher.serviceAlerts.get('jira'), undefined);
  assert.deepEqual(watcher.sentAlerts, []);
});

test('a 401 is still an auth failure, and the next success restores it', async () => {
  const watcher = makeWatcher();
  const { client } = makeClient();
  const seen = [];
  client.onAuthError = (err) => {
    seen.push('expired');
    return watcher.notifyAdminAuthExpired('Jira', err);
  };
  client.onSuccess = () => watcher.notifyAdminAuthRecovered('Jira');
  respond([401, 200]);
  await assert.rejects(client.getIssue('ABC-1'), (err) => {
    assert.equal(err.isIssueAccessError, false);
    return true;
  });
  assert.deepEqual(seen, ['expired']);
  assert.equal(watcher.serviceAlerts.get('jira').failing, true);
  await client.getIssue('ABC-1');
  // Recovery is only announced once the connector stayed healthy for a while.
  assert.equal(watcher.serviceAlerts.get('jira').failing, true);
  assert.deepEqual(watcher.sentAlerts, ['expired']);
});

test('a 403 on a non-issue request (credentials level) still raises the auth alert', async () => {
  const { client, events } = makeClient();
  respond([403]);
  await assert.rejects(client.request('rest/api/2/myself'), (err) => {
    assert.equal(err.isIssueAccessError, false);
    return true;
  });
  assert.equal(events.filter(([k]) => k === 'auth').length, 1);
});

test('denied watched issues back off exponentially up to a cap and are keyed per issue', () => {
  const watcher = makeWatcher();
  const t0 = 1_000_000;
  assert.equal(watcher.isJiraIssueDenied('mr|ABC-1', t0), false);
  assert.equal(watcher.recordJiraIssueDenial('mr|ABC-1', t0), 120_000);
  assert.equal(watcher.isJiraIssueDenied('mr|ABC-1', t0 + 119_000), true);
  assert.equal(watcher.isJiraIssueDenied('mr|ABC-1', t0 + 120_000), false);
  assert.equal(watcher.isJiraIssueDenied('mr|ABC-2', t0 + 1), false);
  assert.equal(watcher.recordJiraIssueDenial('mr|ABC-1', t0), 240_000);
  for (let i = 0; i < 20; i += 1) watcher.recordJiraIssueDenial('mr|ABC-1', t0);
  assert.equal(watcher.recordJiraIssueDenial('mr|ABC-1', t0), 6 * 60 * 60 * 1000);
});

test('alternating 401/200 produces one expired and one flapping alert, then a single summary', async () => {
  const watcher = makeWatcher();
  const { client } = makeClient();
  let t = 1_700_000_000_000;
  watcher.serviceAlerts.now = () => t;
  client.onAuthError = (err) => watcher.notifyAdminAuthExpired('Jira', err);
  client.onSuccess = () => watcher.notifyAdminAuthRecovered('Jira');
  respond(Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? 401 : 200)));
  for (let i = 0; i < 6; i += 1) {
    await assert.rejects(client.getIssue('ABC-1'));
    t += 30_000;
    await client.getIssue('ABC-1');
    t += 30_000;
  }
  assert.deepEqual(watcher.sentAlerts, ['expired', 'flapping']);
  t += 5 * 60_000 + 1000;
  watcher.serviceAlerts.tick();
  assert.deepEqual(watcher.sentAlerts, ['expired', 'flapping', 'flapping-restored']);
});

test('the watcher closes the alert tick timer on stop()', () => {
  const watcher = makeWatcher();
  watcher.serviceAlerts.start(60_000);
  assert.ok(watcher.serviceAlerts.timer);
  watcher.stop();
  assert.equal(watcher.serviceAlerts.timer, null);
});
