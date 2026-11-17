import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addReaction,
  getMessage,
  isTestRun,
  removeReaction,
  resolveProfiles,
  searchPeople,
  sendDirectMessage,
  transport,
  uploadImageToAms,
} from '../src/teams.mjs';
import { refusedLiveAttempts, resetRefusedLiveAttempts } from '../src/test-guard.mjs';
import { GitLabClient } from '../src/gitlab.mjs';
import { JiraClient } from '../src/jira.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';

// Unstubbed tests must never reach the real Teams account or any real host.
// Every refusal is recorded and fails the test process at exit, so this file
// resets the counter once it has asserted on it.
test('a test run refuses every unstubbed Teams write', async () => {
  assert.equal(isTestRun(), true);
  assert.equal(process.env.TEAMS_LIVE_ALLOW_LIVE_IN_TESTS, undefined, 'there is no env switch to lift the guard');
  resetRefusedLiveAttempts();
  for (const result of [
    await transport.sendMessage('48:notes', '<p>x</p>', {}),
    await transport.editMessage('48:notes', '1', '<p>x</p>', 'html', {}),
    await addReaction('48:notes', '1', 'like'),
    await removeReaction('48:notes', '1', 'like'),
  ]) {
    assert.equal(result.ok, false);
    assert.match(result.error.message, /Refused live Teams/);
  }
  const sent = await sendDirectMessage('48:notes', 'hello');
  assert.equal(sent.ok, false);
  assert.equal(refusedLiveAttempts().filter((entry) => entry.kind === 'teams').length, 5);
  resetRefusedLiveAttempts();
  // The AMS upload is an HTTP call, so the fetch guard covers it (it also
  // fails earlier when no credentials exist, e.g. in CI).
  assert.equal((await uploadImageToAms(Buffer.from('x'), '48:notes')).ok, false);
  assert.ok(refusedLiveAttempts().every((entry) => entry.kind === 'fetch'));
  resetRefusedLiveAttempts();
});

test('a test run refuses unstubbed network requests to non-loopback hosts', async () => {
  resetRefusedLiveAttempts();
  await assert.rejects(fetch('https://example.invalid/'), /Refused real network request/);
  await assert.rejects(fetch(new URL('https://git.example.invalid/api/v4/user')), /Refused real network request/);
  await new GitLabClient({ host: 'git.example.invalid', token: 'x' }).getTokenInfo().catch(() => null);
  await new JiraClient({ url: 'https://jira.example.invalid', token: 'x' }).request('/rest/api/3/myself').catch(() => null);
  assert.ok(refusedLiveAttempts().length >= 4);
  assert.ok(refusedLiveAttempts().every((entry) => entry.kind === 'fetch'));
  resetRefusedLiveAttempts();
});

test('loopback requests are not refused', async () => {
  resetRefusedLiveAttempts();
  await assert.rejects(fetch('http://127.0.0.1:9/'), (err) => !/Refused real network request/.test(String(err.message)));
  assert.equal(refusedLiveAttempts().length, 0);
});

test('a test run refuses unstubbed Teams reads before any session or token is touched', async () => {
  resetRefusedLiveAttempts();
  const logged = [];
  const originals = {};
  for (const level of ['log', 'warn', 'error']) {
    originals[level] = console[level];
    console[level] = (...args) => logged.push(args.join(' '));
  }
  let results;
  try {
    results = [
      await searchPeople('Alice Example'),
      await resolveProfiles(['8:orgid:00000000-0000-0000-0000-000000000000']),
      await getMessage('19:test@thread.v2', '1'),
    ];
  } finally {
    Object.assign(console, originals);
  }
  for (const result of results) {
    assert.equal(result.ok, false);
    assert.match(result.error.message, /Refused live Teams/);
  }
  // Refused up front: no request, no token refresh, no browser fallback, whether or not this machine has a session.
  assert.deepEqual(refusedLiveAttempts().map((entry) => `${entry.kind}:${entry.what}`), [
    'teams:searchPeople',
    'teams:resolveProfiles',
    'teams:getMessage',
  ]);
  assert.deepEqual(logged.filter((line) => /token-refresh|Auth error|refresh/i.test(line)), []);
  resetRefusedLiveAttempts();
});

test('a rich watcher with no stubs makes no external request and no token refresh', async () => {
  resetRefusedLiveAttempts();
  const logged = [];
  const original = { warn: console.warn, error: console.error, log: console.log };
  console.warn = console.error = console.log = (...args) => logged.push(args.join(' '));
  try {
    const watcher = new MergeRequestWatcher({
      config: { conversations: [], gitlab: { group: 'group', notify: {} }, teams: { rich_messages: true } },
      gitlab: { findMrLinks: () => [] },
      jira: null,
      opsgenie: null,
    });
    // The two paths a rich card takes to a person: a directory search by name and a profile picture.
    assert.ok(watcher.avatarService, 'rich mode builds the avatar service');
    await watcher.avatarService.avatarsFor([{ name: 'Alice Example' }]);
    await watcher.avatarService.fetchPhoto('8:orgid:00000000-0000-0000-0000-000000000000').catch(() => null);
    await watcher.userDirectory.resolveUser({ name: 'Alice Example', username: 'alice' });
  } finally {
    Object.assign(console, original);
  }
  const attempts = refusedLiveAttempts();
  assert.ok(attempts.length > 0, 'the lookups were refused rather than silently answered');
  assert.ok(attempts.every((entry) => entry.kind === 'teams'), `no network request was attempted: ${JSON.stringify(attempts)}`);
  assert.deepEqual(logged.filter((line) => /token-refresh/i.test(line)), []);
  resetRefusedLiveAttempts();
});
