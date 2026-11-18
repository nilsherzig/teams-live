import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { loadConfig } from '../src/config.mjs';
import { useStubbedTransport } from './stub-transport.mjs';

// Nothing in this file may reach a real Teams account.
useStubbedTransport(beforeEach, afterEach);

const inDays = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** Runs `fn(dir)` with HOME and XDG_STATE_HOME pointing into a fresh temporary directory. */
async function withHome(fn, { home = (dir) => dir } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-live-primary-'));
  const saved = { HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  try {
    process.env.HOME = home(dir);
    process.env.XDG_STATE_HOME = path.join(dir, 'state');
    return await fn(dir);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function rotatingGitlab() {
  const gitlab = {
    token: 'revoked',
    rotations: 0,
    rotateToken: async () => ({ token: `rotated-${++gitlab.rotations}`, expires_at: '2027-01-01' }),
  };
  return gitlab;
}

const watcherWith = (gitlab, gitlabConfig = {}) => new MergeRequestWatcher({
  config: { conversations: [], teams: {}, gitlab: { token: 'revoked', ...gitlabConfig } },
  gitlab,
});

test('a rotated primary token survives a failed save and the retry saves it without rotating again', async () => {
  await withHome(async (dir) => {
    // The parent of the override directory is a regular file: nothing can be written below it.
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const gitlab = rotatingGitlab();
    const watcher = watcherWith(gitlab);

    await assert.rejects(watcher.renewGitLabToken({ reason: 'test' }), (error) => {
      assert.equal(error.rotatedUnsaved, true);
      assert.doesNotMatch(error.message, /rotated-1/, 'the token never appears in the message');
      return true;
    });
    assert.equal(watcher.config.gitlab.token, 'rotated-1', 'the revoked token is replaced in the config');
    assert.equal(gitlab.token, 'rotated-1', 'and in the client');
    assert.equal(watcher.unsavedPrimaryToken.token, 'rotated-1');

    fs.unlinkSync(blocker);
    const result = await watcher.renewGitLabToken({ reason: 'retry' });
    const override = path.join(blocker, 'overrides', 'gitlab-token');
    assert.equal(gitlab.rotations, 1, 'the retry saves the held token instead of rotating again');
    assert.equal(result.rotated.token, 'rotated-1');
    assert.equal(result.savedPath, override);
    assert.equal(fs.readFileSync(override, 'utf8'), 'rotated-1');
    assert.equal(fs.statSync(override).mode & 0o777, 0o600);
    assert.equal(watcher.unsavedPrimaryToken, null);
    assert.deepEqual(fs.readdirSync(path.dirname(override)), ['gitlab-token'], 'no pending or temporary file is left');
  }, { home: (dir) => path.join(dir, 'blocker') });
});

test('a writable configured token file is overwritten in place and no pending file is left', async () => {
  await withHome(async (dir) => {
    const secrets = path.join(dir, 'secrets');
    fs.mkdirSync(secrets);
    const configured = path.join(secrets, 'gitlab-token');
    fs.writeFileSync(configured, 'revoked\n');
    const watcher = watcherWith(rotatingGitlab(), { token_file: configured });

    const result = await watcher.renewGitLabToken();
    assert.equal(result.savedPath, configured);
    assert.equal(result.isReadOnlySecret, false);
    assert.equal(fs.readFileSync(configured, 'utf8'), 'rotated-1');
    assert.equal(watcher.config.gitlab.is_token_override, undefined, 'it is not an override');
    assert.equal(fs.existsSync(path.join(dir, 'overrides', 'gitlab-token.pending')), false);
    assert.equal(fs.existsSync(path.join(dir, 'overrides', 'gitlab-token')), false);
  });
});

test('an unwritable configured token file falls back to the override file', async () => {
  await withHome(async (dir) => {
    // A directory where the file should be: opening it for writing fails.
    const configured = path.join(dir, 'configured');
    fs.mkdirSync(configured);
    const watcher = watcherWith(rotatingGitlab(), { token_file: configured });

    const result = await watcher.renewGitLabToken();
    const override = path.join(dir, 'overrides', 'gitlab-token');
    assert.equal(result.savedPath, override);
    assert.equal(result.isReadOnlySecret, true);
    assert.equal(fs.readFileSync(override, 'utf8'), 'rotated-1');
    assert.equal(watcher.config.gitlab.is_token_override, true);
    assert.equal(watcher.config.gitlab.override_token_path, override);
    assert.equal(fs.existsSync(`${override}.pending`), false);
  });
});

test('a token that only reached the pending file is reported as saved and recovered after a restart', async () => {
  await withHome(async (dir) => {
    const override = path.join(dir, 'overrides', 'gitlab-token');
    // A directory in the way makes the final rename fail after the pending file was written.
    fs.mkdirSync(path.join(override, 'in-the-way'), { recursive: true });
    const watcher = watcherWith(rotatingGitlab());

    const result = await watcher.renewGitLabToken();
    assert.equal(result.savedPath, `${override}.pending`);
    assert.equal(fs.readFileSync(`${override}.pending`, 'utf8'), 'rotated-1');
    assert.equal(watcher.config.gitlab.token, 'rotated-1');
    assert.equal(watcher.unsavedPrimaryToken, null, 'the token is durable, nothing is left to retry');

    // Restart: the configured file still holds the revoked token and an older override exists.
    fs.rmSync(override, { recursive: true });
    fs.writeFileSync(override, 'older-override\n');
    const secret = path.join(dir, 'secret');
    fs.writeFileSync(secret, 'revoked\n');
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ gitlab: { token_file: secret } }));

    const config = loadConfig(configPath);
    assert.equal(config.gitlab.token, 'rotated-1');
    assert.equal(config.gitlab.is_token_override, true);
    assert.equal(config.gitlab.override_token_path, override);
    assert.equal(fs.readFileSync(override, 'utf8'), 'rotated-1', 'the pending token replaced the override');
    assert.equal(fs.existsSync(`${override}.pending`), false);
  });
});

test('an unreadable pending file is ignored at startup and the override or configured file is used', async () => {
  await withHome(async (dir) => {
    const secret = path.join(dir, 'secret');
    fs.writeFileSync(secret, 'configured-token\n');
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ gitlab: { token_file: secret } }));
    fs.mkdirSync(path.join(dir, 'overrides'));
    fs.writeFileSync(path.join(dir, 'overrides', 'gitlab-token.pending'), '\n');

    assert.equal(loadConfig(configPath).gitlab.token, 'configured-token');
    fs.writeFileSync(path.join(dir, 'overrides', 'gitlab-token'), 'override-token\n');
    assert.equal(loadConfig(configPath).gitlab.token, 'override-token');
  });
});

test('overlapping renewals share one rotation', async () => {
  await withHome(async (dir) => {
    const gitlab = rotatingGitlab();
    const watcher = watcherWith(gitlab);
    const [first, second] = await Promise.all([
      watcher.renewGitLabToken({ reason: 'timer' }),
      watcher.renewGitLabToken({ reason: 'reaction' }),
    ]);
    assert.equal(gitlab.rotations, 1);
    assert.equal(first, second);
    assert.equal(fs.readFileSync(path.join(dir, 'overrides', 'gitlab-token'), 'utf8'), 'rotated-1');
    await watcher.renewGitLabToken();
    assert.equal(gitlab.rotations, 2, 'a later renewal rotates again');
  });
});

test('the expiry check saves a rotated-but-unsaved primary token first, whatever its expiry', async () => {
  const gitlab = { token: 'held', getTokenInfo: async () => ({ expires_at: inDays(60) }) };
  const watcher = watcherWith(gitlab);
  watcher.unsavedPrimaryToken = { token: 'held' };
  const renewed = [];
  watcher.renewGitLabToken = async ({ reason }) => {
    renewed.push(reason);
    watcher.unsavedPrimaryToken = null;
    return { rotated: { token: 'held' }, savedPath: '/unused', isReadOnlySecret: true };
  };
  await watcher.checkGitLabTokenExpiryAndAutoRenew();
  assert.deepEqual(renewed, ['save_retry']);
});

test('the expiry check stops after a failed save so the held token is not lost', async () => {
  let lookups = 0;
  const gitlab = { token: 'held', getTokenInfo: async () => { lookups++; return { expires_at: inDays(1) }; } };
  const watcher = watcherWith(gitlab);
  watcher.unsavedPrimaryToken = { token: 'held' };
  let calls = 0;
  watcher.renewGitLabToken = async () => {
    calls++;
    throw Object.assign(new Error('could not be saved'), { rotatedUnsaved: true });
  };
  await watcher.checkGitLabTokenExpiryAndAutoRenew();
  assert.equal(calls, 1, 'one save attempt, no second rotation through the near-expiry path');
  assert.equal(lookups, 0);
  assert.equal(watcher.unsavedPrimaryToken.token, 'held');
});
