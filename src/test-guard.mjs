/**
 * Default-deny guard for test runs.
 *
 * Tests build watchers around mocked connectors, but the process can still
 * find real Teams credentials and reach the real network. While running under
 * `node --test`:
 *   - every Teams write (messages, edits, reactions, uploads) is refused, and
 *   - every `fetch` to a non-loopback host is refused (GitLab, Jira, OpsGenie,
 *     Confluence, HRworks, screenshot and browser-auth adapters all use the
 *     global fetch).
 * A refusal is recorded and makes the test process exit non-zero, so an
 * unstubbed transport can never pass silently. Tests that need an outgoing
 * payload stub `transport.*` or `globalThis.fetch` themselves.
 *
 * The state directory is also redirected to a temporary one.
 *
 * There is deliberately no environment switch to lift the guard. Real sends
 * belong in a dedicated script that is not a test process and names its
 * destination explicitly.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function isTestRun() {
  return (
    Boolean(process.env.NODE_TEST_CONTEXT) ||
    process.execArgv.includes('--test') ||
    /\.test\.m?js$/.test(process.argv[1] || '')
  );
}

const refusals = [];

export function refusedLiveAttempts() {
  return refusals.map((entry) => ({ ...entry }));
}

export function resetRefusedLiveAttempts() {
  refusals.length = 0;
}

/** Returns a failed result when a Teams write must not run, otherwise null. */
export function refuseLiveWriteInTests(what) {
  if (!isTestRun()) return null;
  refusals.push({ kind: 'teams', what });
  return {
    ok: false,
    error: new Error(`Refused live Teams ${what} during a test run (stub transport.* in the test)`),
  };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function urlOf(input) {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input instanceof URL) return input;
    if (input && typeof input.url === 'string') return new URL(input.url);
  } catch {
    // fall through
  }
  return null;
}

const GUARD_MARK = Symbol.for('teams-live.testFetchGuard');

if (isTestRun()) {
  if (globalThis.fetch && !globalThis.fetch[GUARD_MARK]) {
    const realFetch = globalThis.fetch;
    const guardedFetch = function guardedFetch(input, init) {
      const url = urlOf(input);
      if (url && LOOPBACK_HOSTS.has(url.hostname)) return realFetch(input, init);
      refusals.push({ kind: 'fetch', what: url ? `${url.protocol}//${url.hostname}` : 'unknown' });
      return Promise.reject(
        new TypeError(`Refused real network request to ${url ? url.hostname : 'unknown host'} during a test run (stub globalThis.fetch in the test)`)
      );
    };
    guardedFetch[GUARD_MARK] = true;
    globalThis.fetch = guardedFetch;
  }

  // Tests must neither read nor write the real watcher state (rate-limit
  // timestamps, bot message ids): give the process a private, throwaway state
  // directory. Tests that set XDG_STATE_HOME themselves still override it.
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-live-test-state-'));
  process.env.XDG_STATE_HOME = stateDir;

  process.on('exit', (code) => {
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
    if (refusals.length === 0) return;
    console.error(
      `[test-guard] ${refusals.length} unstubbed live attempt(s) during this test run: ` +
        refusals.map((r) => `${r.kind}:${r.what}`).join(', ')
    );
    if (code === 0) process.exitCode = 1;
  });
}
