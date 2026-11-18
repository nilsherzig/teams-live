import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { loadConfig } from '../src/config.mjs';
import { useStubbedTransport } from './stub-transport.mjs';

// Nothing in this file may reach a real Teams account.
useStubbedTransport(beforeEach, afterEach);

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'teams-live-rotation-'));
const inDays = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function watcherWith({ override, gitlab }) {
  return new MergeRequestWatcher({
    config: { conversations: [], teams: {}, gitlab: {
      fallback_tokens: ['old'], fallback_token_sources: [{ file: '/read-only/token', override }],
    } },
    gitlab,
  });
}

test('a new fallback token survives a failed save and is saved by the retry without rotating again', async () => {
  const dir = tmpDir();
  try {
    // The parent of the override directory is a regular file: nothing can be written below it.
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const override = path.join(blocker, 'overrides', 'fallback');
    let rotations = 0;
    const gitlab = { rotateToken: async () => ({ token: `rotated-${++rotations}`, expires_at: '2027-01-01' }) };
    const watcher = watcherWith({ override, gitlab });

    await assert.rejects(watcher.renewGitLabFallbackToken(1), (error) => {
      assert.equal(error.rotatedUnsaved, true);
      assert.doesNotMatch(error.message, /rotated-1/, 'the token never appears in the message');
      return true;
    });
    assert.equal(watcher.config.gitlab.fallback_tokens[0], 'rotated-1', 'the revoked token is replaced in memory');

    fs.unlinkSync(blocker);
    const result = await watcher.renewGitLabFallbackToken(1);
    assert.equal(rotations, 1, 'the retry saves the held token instead of rotating again');
    assert.equal(result.rotated.token, 'rotated-1');
    assert.equal(fs.readFileSync(override, 'utf8'), 'rotated-1');
    assert.equal(fs.statSync(override).mode & 0o777, 0o600);
    assert.equal(watcher.unsavedFallbackTokens.size, 0);
    assert.deepEqual(fs.readdirSync(path.dirname(override)), ['fallback'], 'no pending or temporary file is left');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a token that only reached the pending file is reported as saved and recovered after a restart', async () => {
  const dir = tmpDir();
  const oldHome = process.env.HOME;
  try {
    const file = '/read-only/fallback-token';
    const key = createHash('sha256').update(file).digest('hex');
    process.env.HOME = dir;
    const override = path.join(dir, 'overrides', `gitlab-token-${key}`);
    // A directory in the way makes the final rename fail after the pending file was written.
    fs.mkdirSync(path.join(override, 'in-the-way'), { recursive: true });
    const gitlab = { rotateToken: async () => ({ token: 'rotated-pending' }) };
    const watcher = watcherWith({ override, gitlab });

    const result = await watcher.renewGitLabFallbackToken(1);
    assert.equal(result.savedPath, `${override}.pending`);
    assert.equal(fs.readFileSync(`${override}.pending`, 'utf8'), 'rotated-pending');
    assert.equal(watcher.config.gitlab.fallback_tokens[0], 'rotated-pending');
    assert.equal(watcher.unsavedFallbackTokens.size, 0);

    // Restart: the configured file still holds the revoked token.
    const secret = path.join(dir, 'secret');
    fs.writeFileSync(secret, 'revoked-token\n');
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ gitlab: { fallback_token_files: [secret] } }));
    const secretKey = createHash('sha256').update(secret).digest('hex');
    const secretOverride = path.join(dir, 'overrides', `gitlab-token-${secretKey}`);
    fs.writeFileSync(`${secretOverride}.pending`, 'rotated-pending\n');
    fs.writeFileSync(secretOverride, 'older-override\n');

    const config = loadConfig(configPath);
    assert.deepEqual(config.gitlab.fallback_tokens, ['rotated-pending']);
    assert.equal(fs.readFileSync(secretOverride, 'utf8'), 'rotated-pending\n', 'the pending token replaced the override');
    assert.equal(fs.existsSync(`${secretOverride}.pending`), false);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable pending file is ignored and the override or configured file is used', () => {
  const dir = tmpDir();
  const oldHome = process.env.HOME;
  try {
    process.env.HOME = dir;
    const secret = path.join(dir, 'secret');
    fs.writeFileSync(secret, 'configured-token\n');
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ gitlab: { fallback_token_files: [secret] } }));
    const key = createHash('sha256').update(secret).digest('hex');
    const override = path.join(dir, 'overrides', `gitlab-token-${key}`);
    fs.mkdirSync(path.dirname(override), { recursive: true });
    fs.writeFileSync(`${override}.pending`, '\n');
    assert.deepEqual(loadConfig(configPath).gitlab.fallback_tokens, ['configured-token']);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fallback token expiry is checked and renewed even without a primary token', async () => {
  const renewed = [];
  const gitlab = {
    token: null,
    getTokenInfo: async ({ tokenIndex = 0 } = {}) => (tokenIndex === 1 ? { expires_at: inDays(2) } : null),
  };
  const watcher = watcherWith({ override: '/unused', gitlab });
  watcher.renewGitLabFallbackToken = async (index) => {
    renewed.push(index);
    return { rotated: { token: 'x' }, savedPath: '/unused', isReadOnlySecret: true };
  };
  await watcher.checkGitLabTokenExpiryAndAutoRenew();
  assert.deepEqual(renewed, [1]);
});

test('a rotated-but-unsaved fallback token is saved first, whatever its expiry, and the primary is still checked', async () => {
  const calls = [];
  const gitlab = {
    token: 'primary',
    getTokenInfo: async ({ tokenIndex = 0 } = {}) => {
      calls.push(tokenIndex);
      return { expires_at: inDays(60) };
    },
  };
  const watcher = watcherWith({ override: '/unused', gitlab });
  watcher.unsavedFallbackTokens.set(1, { token: 'held' });
  const renewed = [];
  watcher.renewGitLabFallbackToken = async (index) => {
    renewed.push(index);
    watcher.unsavedFallbackTokens.delete(index);
    return { rotated: { token: 'held' }, savedPath: '/unused', isReadOnlySecret: true };
  };
  await watcher.checkGitLabTokenExpiryAndAutoRenew();
  assert.deepEqual(renewed, [1], 'the held token is saved although its expiry is far away');
  assert.deepEqual(calls, [0], 'no expiry lookup for the held token; the primary is still checked');
});
