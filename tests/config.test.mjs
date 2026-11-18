import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig, resolveSecrets } from '../src/config.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'teams-live-config-'));
}

test('resolveSecrets replaces _secret references with trimmed file contents', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'key'), 'abc123\n');
  fs.writeFileSync(path.join(dir, 'conv'), '19:xyz@thread.v2\n');

  const resolved = resolveSecrets({
    opsgenie: { on_call_key: { _secret: path.join(dir, 'key') }, base_url: 'https://example.com' },
    conversations: [{ id: { _secret: path.join(dir, 'conv') }, name: 'Team' }],
    other: { _secret: path.join(dir, 'key'), extra: true },
  });

  assert.equal(resolved.opsgenie.on_call_key, 'abc123');
  assert.equal(resolved.opsgenie.base_url, 'https://example.com');
  assert.equal(resolved.conversations[0].id, '19:xyz@thread.v2');
  // Only an object with nothing but `_secret` is a reference.
  assert.deepEqual(resolved.other, { _secret: path.join(dir, 'key'), extra: true });
});

test('resolveSecrets names the config key when a secret file is missing', () => {
  assert.throws(
    () => resolveSecrets({ jira: { url: { _secret: '/nonexistent/teams-live-secret' } } }),
    /config\.jira\.url/,
  );
});

test('loadConfig resolves secrets before reading values', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'host'), 'https://git.example.com/\n');
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      gitlab: { host: { _secret: path.join(dir, 'host') } },
      conversations: [{ id: '48:notes', name: 'Notes' }],
    }),
  );

  const config = loadConfig(configPath);
  assert.equal(config.gitlab.host, 'git.example.com');
  assert.equal(config.conversations[0].id, '48:notes');
});

test('GitLab fallback token files are loaded in order and deduplicated', () => {
  const dir = tmpDir();
  const first = path.join(dir, 'first');
  const second = path.join(dir, 'second');
  fs.writeFileSync(first, 'fallback-one\n');
  fs.writeFileSync(second, 'fallback-two\n');
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ gitlab: { fallback_token_files: [first, second, first] } }));
  assert.deepEqual(loadConfig(configPath).gitlab.fallback_tokens, ['fallback-one', 'fallback-two']);
});

test('teams.rich_messages is off by default and only enabled by boolean true', () => {
  const dir = tmpDir();
  const write = (teams) => {
    const configPath = path.join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(
      configPath,
      JSON.stringify({ conversations: [{ id: '48:notes', name: 'Notes' }], ...(teams ? { teams } : {}) }),
    );
    return loadConfig(configPath);
  };

  assert.equal(write().teams.rich_messages, false);
  assert.equal(write({}).teams.rich_messages, false);
  assert.equal(write({ rich_messages: false }).teams.rich_messages, false);
  assert.equal(write({ rich_messages: 'false' }).teams.rich_messages, false);
  assert.equal(write({ rich_messages: true }).teams.rich_messages, true);
});

test('gitlab.approve defaults to off, has a 24 h link lifetime and ignores the former proxy-auth keys', () => {
  const dir = tmpDir();
  const write = (approve) => {
    const configPath = path.join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(
      configPath,
      JSON.stringify({ conversations: [{ id: '48:notes', name: 'Notes' }], ...(approve ? { gitlab: { approve } } : {}) }),
    );
    return loadConfig(configPath).gitlab.approve;
  };

  const off = write();
  assert.equal(off.enable, false);
  assert.equal(off.host, '127.0.0.1');
  assert.equal(off.port, 3006);
  assert.equal(off.link_ttl_seconds, 86400);
  assert.equal(off.base_url, '');
  for (const key of ['owner_users', 'user_header', 'proxy_secret', 'proxy_secret_header']) {
    assert.equal(key in off, false, `${key} is gone`);
  }

  const on = write({
    enable: true,
    base_url: 'https://approve.example.com/approve',
    link_ttl_seconds: 3600,
    owner_users: ['alice'],
    proxy_secret_file: '/nonexistent',
  });
  assert.equal(on.enable, true);
  assert.equal(on.base_url, 'https://approve.example.com/approve');
  assert.equal(on.link_ttl_seconds, 3600);
  assert.equal('owner_users' in on, false, 'former keys are not carried');
});
