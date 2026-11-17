import test from 'node:test';
import assert from 'node:assert/strict';
import { addReaction, isTestRun, removeReaction, sendDirectMessage, transport, uploadImageToAms } from '../src/teams.mjs';
import { refusedLiveAttempts, resetRefusedLiveAttempts } from '../src/test-guard.mjs';
import { GitLabClient } from '../src/gitlab.mjs';
import { JiraClient } from '../src/jira.mjs';

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
