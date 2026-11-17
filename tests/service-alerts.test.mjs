import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SERVICE_ALERT_OPTIONS,
  ServiceAlertTracker,
  formatServiceAlert,
  serviceAlertOptionsFromConfig,
} from '../src/service-alerts.mjs';

// Pure unit tests: the tracker takes an injected clock and notifier, so nothing
// here touches the network, Teams or a real timer.

const SEC = 1000;
const MIN = 60 * SEC;

function setup({ file = null, options = {}, startAt = 1_700_000_000_000 } = {}) {
  const clock = { t: startAt };
  const events = [];
  const logs = [];
  const make = (f = file) =>
    new ServiceAlertTracker({
      notify: (event) => events.push(event),
      file: f,
      options,
      now: () => clock.t,
      log: (m) => logs.push(m),
    });
  return { clock, events, logs, tracker: make(), make };
}

const types = (events) => events.map((e) => `${e.service}:${e.type}`);

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-alerts-test-'));
  return { dir, file: path.join(dir, 'service-alerts.json') };
}

test('the first failure is announced at once, repeats are not', () => {
  const { tracker, events, clock } = setup();
  tracker.reportFailure('Jira', 'HTTP 401');
  assert.deepEqual(types(events), ['jira:expired']);
  assert.equal(events[0].name, 'Jira');
  assert.equal(events[0].error, 'HTTP 401');
  for (let i = 0; i < 20; i++) {
    clock.t += 5 * SEC;
    tracker.reportFailure('Jira', 'HTTP 401');
  }
  assert.equal(events.length, 1);
  assert.equal(tracker.get('jira').transitions.length, 1, 'repeated failures are one transition');
});

test('success for a connector that never failed does nothing', () => {
  const { tracker, events } = setup();
  for (let i = 0; i < 5; i++) tracker.reportSuccess('GitLab');
  tracker.tick();
  assert.deepEqual(events, []);
  assert.equal(tracker.get('gitlab'), undefined);
});

test('recovery is announced only after the connector stayed healthy', () => {
  const { tracker, events, clock } = setup();
  tracker.reportFailure('Jira', 'HTTP 401');
  clock.t += 30 * SEC;
  tracker.reportSuccess('Jira');
  assert.deepEqual(types(events), ['jira:expired'], 'no immediate restored');
  clock.t += 119 * SEC;
  tracker.reportSuccess('Jira');
  tracker.tick();
  assert.equal(events.length, 1);
  clock.t += 2 * SEC;
  tracker.tick();
  assert.deepEqual(types(events), ['jira:expired', 'jira:restored']);
  // And exactly once.
  clock.t += 10 * MIN;
  tracker.reportSuccess('Jira');
  tracker.tick();
  assert.equal(events.length, 2);
});

test('a pending recovery is cancelled by an error and neither restores nor re-alerts', () => {
  // Raise the flapping threshold so only the recovery logic is under test.
  const { tracker, events, clock } = setup({ options: { flapTransitions: 16 } });
  tracker.reportFailure('Jira', 'HTTP 401');
  clock.t += 10 * SEC;
  tracker.reportSuccess('Jira');
  clock.t += 100 * SEC;
  tracker.reportFailure('Jira', 'HTTP 401');
  clock.t += 100 * SEC;
  tracker.tick();
  assert.deepEqual(types(events), ['jira:expired']);
  // The healthy period restarts from the next success.
  tracker.reportSuccess('Jira');
  clock.t += 119 * SEC;
  tracker.tick();
  assert.equal(events.length, 1);
  clock.t += 2 * SEC;
  tracker.tick();
  assert.deepEqual(types(events), ['jira:expired', 'jira:restored']);
});

test('a stable failure never recovers on its own', () => {
  const { tracker, events, clock } = setup();
  tracker.reportFailure('Jira', 'HTTP 401');
  for (let i = 0; i < 100; i++) {
    clock.t += MIN;
    tracker.reportFailure('Jira', 'HTTP 401');
    tracker.tick();
  }
  assert.deepEqual(types(events), ['jira:expired']);
  assert.equal(tracker.get('jira').failing, true);
});

test('a reminder is sent every reminder interval while failing', () => {
  const { tracker, events, clock } = setup();
  tracker.reportFailure('Jira', 'HTTP 401');
  clock.t += DEFAULT_SERVICE_ALERT_OPTIONS.reminderMs - SEC;
  tracker.reportFailure('Jira', 'HTTP 401');
  assert.equal(events.length, 1);
  clock.t += 2 * SEC;
  tracker.reportFailure('Jira', 'HTTP 401');
  assert.equal(events.length, 2);
  assert.equal(events[1].type, 'expired');
  assert.equal(events[1].reminder, true);
});

/** One failure+recovery cycle's raw transitions, without waiting for notifications. */
function flip(tracker, clock, n, stepMs = MIN) {
  for (let i = 0; i < n; i++) {
    clock.t += stepMs;
    if (tracker.get('jira')?.lastRaw === 'fail') tracker.reportSuccess('Jira');
    else tracker.reportFailure('Jira', 'HTTP 401');
  }
}

test('4 state changes in 10 minutes raise one flapping alert and suppress the rest', () => {
  const { tracker, events, clock } = setup();
  tracker.reportFailure('Jira', 'HTTP 401'); // change 1 (expired)
  flip(tracker, clock, 2); // changes 2 and 3
  assert.deepEqual(types(events), ['jira:expired']);
  flip(tracker, clock, 1); // change 4
  assert.deepEqual(types(events), ['jira:expired', 'jira:flapping']);
  assert.equal(events[1].transitions, 4);
  assert.equal(events[1].windowMs, 10 * MIN);
  // Keep flapping for a while: no further messages at all.
  flip(tracker, clock, 6, 30 * SEC);
  assert.deepEqual(types(events), ['jira:expired', 'jira:flapping']);
  assert.ok(tracker.get('jira').suppressed >= 6);
});

test('3 state changes in the window are not flapping, and old changes age out', () => {
  const { tracker, events, clock } = setup();
  tracker.reportFailure('Jira', 'e');
  flip(tracker, clock, 2);
  assert.equal(tracker.get('jira').flapping, false);
  // The first change falls out of the 10 minute window before the fourth happens.
  flip(tracker, clock, 1, 9 * MIN);
  assert.equal(tracker.get('jira').flapping, false);
  assert.ok(!types(events).includes('jira:flapping'));
});

test('flapping ends with one summary after a stable healthy period and counts what was suppressed', () => {
  const { tracker, events, clock } = setup();
  tracker.reportFailure('Jira', 'e');
  flip(tracker, clock, 3); // flapping, currently healthy (4 changes)
  flip(tracker, clock, 4, 20 * SEC); // fail, ok, fail, ok: 4 suppressed changes
  assert.equal(tracker.get('jira').lastRaw, 'ok');
  assert.equal(tracker.get('jira').suppressed, 4);
  clock.t += 4 * MIN + 59 * SEC;
  tracker.reportSuccess('Jira');
  tracker.tick();
  assert.deepEqual(types(events), ['jira:expired', 'jira:flapping']);
  clock.t += 2 * SEC;
  tracker.tick();
  assert.deepEqual(types(events), ['jira:expired', 'jira:flapping', 'jira:flapping-restored']);
  assert.equal(events[2].suppressed, 4);
  // Settled: forgotten at once (its history was cleared), and no extra "restored" follows.
  assert.equal(tracker.get('jira'), undefined);
  clock.t += 11 * MIN;
  tracker.tick();
  assert.equal(events.length, 3);
});

test('a failure during the flapping recovery period restarts that period', () => {
  const { tracker, events, clock } = setup();
  tracker.reportFailure('Jira', 'e');
  flip(tracker, clock, 3);
  clock.t += 4 * MIN;
  tracker.reportSuccess('Jira');
  flip(tracker, clock, 1, SEC); // failure
  flip(tracker, clock, 1, SEC); // success again
  clock.t += 4 * MIN;
  tracker.tick();
  assert.ok(!types(events).includes('jira:flapping-restored'));
  clock.t += 2 * MIN;
  tracker.tick();
  assert.deepEqual(types(events).slice(-1), ['jira:flapping-restored']);
});

test('flapping that settles into a stable failure sends one still-failing summary, not a recovery', () => {
  const { tracker, events, clock } = setup();
  tracker.reportFailure('Jira', 'HTTP 401');
  flip(tracker, clock, 3);
  flip(tracker, clock, 1, 20 * SEC); // ends failing
  assert.equal(tracker.get('jira').lastRaw, 'fail');
  assert.deepEqual(types(events), ['jira:expired', 'jira:flapping']);
  // Quiet failure for just under a window: still silent.
  clock.t += 10 * MIN - 30 * SEC;
  tracker.reportFailure('Jira', 'HTTP 401');
  tracker.tick();
  assert.deepEqual(types(events), ['jira:expired', 'jira:flapping']);
  clock.t += MIN;
  tracker.tick();
  assert.deepEqual(types(events), ['jira:expired', 'jira:flapping', 'jira:expired']);
  assert.equal(events[2].stillFailing, true);
  assert.ok(events[2].suppressed >= 1);
  // Nothing more while it stays broken, and it recovers normally later.
  clock.t += 60 * MIN;
  tracker.reportFailure('Jira', 'HTTP 401');
  tracker.tick();
  assert.equal(events.length, 3);
  tracker.reportSuccess('Jira');
  clock.t += 2 * MIN;
  tracker.tick();
  assert.deepEqual(types(events).slice(-1), ['jira:restored']);
});

test('connectors are tracked independently', () => {
  const { tracker, events, clock } = setup();
  tracker.reportFailure('Jira', 'a');
  tracker.reportFailure('GitLab', 'b');
  flip(tracker, clock, 3); // only Jira flaps
  tracker.reportSuccess('GitLab');
  clock.t += 3 * MIN;
  tracker.tick();
  assert.deepEqual(
    types(events).sort(),
    ['gitlab:expired', 'gitlab:restored', 'jira:expired', 'jira:flapping'].sort()
  );
  assert.equal(tracker.get('gitlab')?.flapping ?? false, false);
  assert.equal(tracker.get('jira').flapping, true);
});

test('the service name is case insensitive and keeps its display name', () => {
  const { tracker, events } = setup();
  tracker.reportFailure('OpsGenie', 'x');
  tracker.reportFailure('opsgenie', 'x');
  tracker.reportFailure('  OPSGENIE ', 'x');
  assert.equal(events.length, 1);
  assert.equal(events[0].service, 'opsgenie');
  assert.equal(events[0].name, 'OpsGenie');
});

test('custom options are honoured', () => {
  const { tracker, events, clock } = setup({ options: { stableRecoveryMs: 10 * SEC, flapTransitions: 2 } });
  tracker.reportFailure('Jira', 'e');
  tracker.reportSuccess('Jira'); // 2 changes within the window
  assert.deepEqual(types(events), ['jira:expired', 'jira:flapping']);
  const second = setup({ options: { stableRecoveryMs: 10 * SEC, flapTransitions: 16 } });
  second.tracker.reportFailure('Jira', 'e');
  second.tracker.reportSuccess('Jira');
  second.clock.t += 11 * SEC;
  second.tracker.tick();
  assert.deepEqual(types(second.events), ['jira:expired', 'jira:restored']);
  void clock;
});

test('config block is parsed in seconds with safe fallbacks', () => {
  assert.deepEqual(serviceAlertOptionsFromConfig(), { ...DEFAULT_SERVICE_ALERT_OPTIONS });
  assert.deepEqual(
    serviceAlertOptionsFromConfig({
      stable_recovery_seconds: 30,
      flap_transitions: 6,
      flap_window_seconds: 300,
      flap_recovery_seconds: 60,
      reminder_seconds: 3600,
    }),
    { stableRecoveryMs: 30_000, flapTransitions: 6, flapWindowMs: 300_000, flapRecoveryMs: 60_000, reminderMs: 3_600_000 }
  );
  const bad = serviceAlertOptionsFromConfig({
    stable_recovery_seconds: 'soon',
    flap_transitions: 1,
    flap_window_seconds: -5,
    flap_recovery_seconds: null,
    reminder_seconds: '',
  });
  assert.deepEqual(bad, { ...DEFAULT_SERVICE_ALERT_OPTIONS });
  assert.equal(serviceAlertOptionsFromConfig({ flap_transitions: 9999 }).flapTransitions, 16);
});

test('state is persisted atomically with mode 0600 and no temp file is left behind', () => {
  const { dir, file } = tmpFile();
  try {
    const { tracker } = setup({ file });
    tracker.reportFailure('Jira', 'HTTP 401');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ['service-alerts.json']);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.services.jira.failing, true);
    assert.equal('healthySince' in saved.services.jira, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a restart neither re-announces nor spuriously recovers', () => {
  const { dir, file } = tmpFile();
  try {
    const first = setup({ file });
    first.tracker.reportFailure('Jira', 'HTTP 401');
    assert.equal(first.events.length, 1);

    const second = setup({ file, startAt: first.clock.t + 5 * MIN });
    second.tracker.tick();
    assert.deepEqual(second.events, [], 'loading and ticking announce nothing');
    second.tracker.reportFailure('Jira', 'HTTP 401');
    assert.deepEqual(second.events, [], 'the persisted alert is not repeated');
    assert.equal(second.tracker.get('jira').transitions.length, 1);

    // Healthy-looking state on disk must not recover without a fresh success.
    const third = setup({ file, startAt: second.clock.t + 6 * MIN });
    third.clock.t += 60 * MIN;
    third.tracker.tick();
    assert.deepEqual(third.events, []);
    third.tracker.reportSuccess('Jira');
    third.clock.t += 119 * SEC;
    third.tracker.tick();
    assert.deepEqual(third.events, []);
    third.clock.t += 2 * SEC;
    third.tracker.tick();
    assert.deepEqual(types(third.events), ['jira:restored']);

    // And the restored alert is not repeated after another restart.
    const fourth = setup({ file, startAt: third.clock.t + MIN });
    fourth.tracker.reportSuccess('Jira');
    fourth.clock.t += 10 * MIN;
    fourth.tracker.tick();
    assert.deepEqual(fourth.events, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('flapping and its suppression survive a restart', () => {
  const { dir, file } = tmpFile();
  try {
    const first = setup({ file });
    first.tracker.reportFailure('Jira', 'e');
    flip(first.tracker, first.clock, 3);
    assert.deepEqual(types(first.events), ['jira:expired', 'jira:flapping']);

    const second = setup({ file, startAt: first.clock.t + 30 * SEC });
    assert.equal(second.tracker.get('jira').flapping, true);
    flip(second.tracker, second.clock, 2, 10 * SEC);
    assert.deepEqual(second.events, [], 'still suppressed after the restart');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupt or hostile state files are ignored and the state stays bounded', () => {
  const { dir, file } = tmpFile();
  try {
    fs.writeFileSync(file, '{not json');
    const a = setup({ file });
    assert.equal(a.tracker.states.size, 0);
    assert.ok(a.logs.some((l) => l.includes('Could not load')));

    const services = {};
    for (let i = 0; i < 100; i++) {
      services[`svc${i}`] = {
        failing: true,
        transitions: Array.from({ length: 500 }, (_, n) => a.clock.t - n),
        error: 'x'.repeat(5000),
        suppressed: -3,
      };
    }
    services.bad = 'nope';
    fs.writeFileSync(file, JSON.stringify({ services }));
    const b = setup({ file });
    assert.ok(b.tracker.states.size <= 32);
    const s = b.tracker.get('svc0');
    assert.ok(s.transitions.length <= 16);
    assert.ok(s.error.length <= 200);
    assert.equal(s.suppressed, 0);

    // New connectors beyond the cap are ignored rather than growing without bound.
    for (let i = 0; i < 100; i++) b.tracker.reportFailure(`other${i}`, 'x');
    assert.ok(b.tracker.states.size <= 32);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('transition history stays bounded under heavy flapping', () => {
  const { tracker, clock } = setup({ options: { flapTransitions: 16 } });
  tracker.reportFailure('Jira', 'e');
  flip(tracker, clock, 500, SEC);
  assert.ok(tracker.get('jira').transitions.length <= 16);
});

test('an unwritable state file only logs', () => {
  const { dir } = tmpFile();
  try {
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, '');
    const { tracker, events, logs } = setup({ file: path.join(blocker, 'sub', 'state.json') });
    tracker.reportFailure('Jira', 'e');
    assert.equal(events.length, 1);
    assert.ok(logs.some((l) => l.includes('Could not save')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing or throwing notifier never breaks the tracker', async () => {
  const logs = [];
  let now = 1_700_000_000_000;
  const rejecting = new ServiceAlertTracker({
    notify: async () => {
      throw new Error('send failed');
    },
    now: () => now,
    log: (m) => logs.push(m),
  });
  rejecting.reportFailure('Jira', 'e');
  const throwing = new ServiceAlertTracker({
    notify: () => {
      throw new Error('sync failure');
    },
    now: () => now,
    log: (m) => logs.push(m),
  });
  throwing.reportFailure('Jira', 'e');
  await new Promise((r) => setImmediate(r));
  assert.equal(logs.length, 2);
  void now;
});

test('the tick timer is unref-ed, restartable and fully closed by stop()', () => {
  const { tracker } = setup();
  tracker.start(60_000);
  const first = tracker.timer;
  assert.ok(first);
  assert.equal(first.hasRef(), false);
  tracker.start(60_000);
  assert.notEqual(tracker.timer, first);
  tracker.stop();
  assert.equal(tracker.timer, null);
  tracker.stop();
});

test('messages are rendered for every event type without leaking anything extra', () => {
  const ctx = { hostname: 'host.example', time: '2026-01-01 00:00:00 UTC' };
  const base = { service: 'jira', name: 'Jira' };
  const expired = formatServiceAlert({ ...base, type: 'expired', error: 'HTTP 401' }, ctx);
  assert.match(expired, /Authentication Expired: Jira/);
  assert.match(expired, /HTTP 401/);
  assert.match(expired, /host\.example/);
  assert.match(formatServiceAlert({ ...base, type: 'expired', reminder: true }, ctx), /reminder/);
  assert.match(
    formatServiceAlert({ ...base, type: 'expired', stillFailing: true, suppressed: 7 }, ctx),
    /Still failing after flapping; 7 state changes/
  );
  assert.match(formatServiceAlert({ ...base, type: 'restored' }, ctx), /Authentication Restored: Jira/);
  const flapping = formatServiceAlert(
    { ...base, type: 'flapping', transitions: 4, windowMs: 10 * MIN, recoveryMs: 5 * MIN, error: 'x' },
    ctx
  );
  assert.match(flapping, /Connection Unstable: Jira/);
  assert.match(flapping, /4 state changes in 10 min/);
  assert.match(flapping, /stable for 5 min/);
  assert.match(formatServiceAlert({ ...base, type: 'flapping-restored', suppressed: 3 }, ctx), /3 state changes were suppressed/);
  assert.equal(formatServiceAlert({ ...base, type: 'unknown' }, ctx), null);
});
