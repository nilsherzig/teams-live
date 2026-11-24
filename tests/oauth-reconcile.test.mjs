import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureOAuthApplication } from '../src/oauth-reconcile.mjs';

test('creates once, persists private credentials and reloads without creating again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-test-'));
  const stateFile = path.join(dir, 'oauth.json');
  const calls = [];
  const gitlab = { host: 'gitlab.example.com', token: 'fixture', async request(endpoint, options = {}) {
    calls.push({ endpoint, options });
    if (options.method === 'POST') return { id: 7, application_id: 'example-client', secret: 'example-secret' };
    if (endpoint === 'user/applications/7') return { id: 7, application_id: 'example-client', callback_url: 'https://teams.example.com/approve/oauth/callback', confidential: true };
    return [];
  } };
  try {
    const options = { gitlab, baseUrl: 'https://teams.example.com/approve', stateFile };
    assert.deepEqual(await ensureOAuthApplication(options), { clientId: 'example-client', clientSecret: 'example-secret' });
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.retry, false);
    assert.equal(calls[1].options.body.redirect_uri, 'https://teams.example.com/approve/oauth/callback');
    assert.equal(calls[1].options.body.scopes, 'api');
    assert.deepEqual(await ensureOAuthApplication(options), { clientId: 'example-client', clientSecret: 'example-secret' });
    assert.equal(calls.length, 3);
    await assert.rejects(ensureOAuthApplication({ ...options, baseUrl: 'https://other.example.com/approve' }), /does not match/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('does not take over an existing application or retry an ambiguous create', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-test-'));
  const stateFile = path.join(dir, 'oauth.json');
  let writes = 0;
  let existing = true;
  const gitlab = { host: 'gitlab.example.com', token: 'fixture', async request(_endpoint, options = {}) {
    if (options.method === 'POST') { writes++; throw new Error('network error'); }
    return existing ? [{ application_name: 'teams-live (managed)', callback_url: 'https://teams.example.com/approve/oauth/callback' }] : [];
  } };
  const options = { gitlab, baseUrl: 'https://teams.example.com/approve', stateFile };
  try {
    await assert.rejects(ensureOAuthApplication(options), /already exists|lookup failed/);
    assert.equal(writes, 0);
    assert.equal(fs.existsSync(`${stateFile}.pending`), false);
    existing = false;
    await assert.rejects(ensureOAuthApplication(options), /could not be confirmed/);
    assert.equal(writes, 1);
    assert.equal(fs.statSync(`${stateFile}.pending`).mode & 0o777, 0o600);
    await assert.rejects(ensureOAuthApplication(options), /interrupted/);
    assert.equal(writes, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('saved credentials fail closed on remote drift and private-file errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-test-'));
  const stateFile = path.join(dir, 'oauth.json');
  const state = { host: 'gitlab.example.com', redirect: 'https://teams.example.com/approve/oauth/callback', id: 7, clientId: 'example-client', clientSecret: 'example-secret' };
  const gitlab = { host: 'gitlab.example.com', token: 'fixture', async request() { return { id: 7, application_id: 'example-client', callback_url: 'https://other.example.com/callback', confidential: true }; } };
  const options = { gitlab, baseUrl: 'https://teams.example.com/approve', stateFile };
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
    await assert.rejects(ensureOAuthApplication(options), /no longer matches/);
    fs.chmodSync(stateFile, 0o644);
    await assert.rejects(ensureOAuthApplication(options), /private regular file/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
