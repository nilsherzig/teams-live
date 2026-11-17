import fs from 'node:fs';
import path from 'node:path';

/**
 * Notification state machine for connector (GitLab, Jira, ...) authentication
 * alerts. It only decides *when to tell the admin*. Connector health and the
 * classification of an error as an authentication failure are not its business:
 * callers report `reportFailure()` / `reportSuccess()` and receive events.
 *
 * - A first failure is announced at once ("expired").
 * - Recovery ("restored") is announced only after the connector stayed healthy
 *   for `stableRecoveryMs`, and a failure in between cancels it.
 * - `flapTransitions` state changes within `flapWindowMs` raise one "flapping"
 *   alert. While flapping, expired/restored alerts are suppressed (and the
 *   state changes counted) until the connector was healthy for
 *   `flapRecoveryMs`, which sends one "flapping-restored" summary. If it
 *   instead stays failing for `flapWindowMs`, one "expired" summary with
 *   `stillFailing: true` is sent, so a stable failure is never mistaken for a
 *   recovery and never stays silent.
 * - A repeated report of the same state is not a transition.
 *
 * There are no timers: time advances through report*() calls and tick(), which
 * the owner calls periodically. State is small and bounded and is persisted to
 * its own file (atomic write, mode 0600; this class is its only writer). After
 * a restart a connector is not assumed healthy until it reports success again,
 * so a restart never produces a "restored" by itself, and an alert that was
 * already sent is not repeated.
 */

export const DEFAULT_SERVICE_ALERT_OPTIONS = Object.freeze({
  stableRecoveryMs: 2 * 60 * 1000,
  flapTransitions: 4,
  flapWindowMs: 10 * 60 * 1000,
  flapRecoveryMs: 5 * 60 * 1000,
  reminderMs: 12 * 60 * 60 * 1000,
});

const MAX_SERVICES = 32;
const MAX_TRANSITIONS = 16;
const MAX_ERROR_LENGTH = 200;
const MAX_NAME_LENGTH = 64;

/** Builds options from the `teams.service_alerts` config block (seconds) over the defaults. */
export function serviceAlertOptionsFromConfig(block = {}) {
  const d = DEFAULT_SERVICE_ALERT_OPTIONS;
  const ms = (value, fallbackMs) => {
    const n = Number(value);
    return value !== null && value !== '' && Number.isFinite(n) && n >= 0 ? n * 1000 : fallbackMs;
  };
  const count = Number(block?.flap_transitions);
  return {
    stableRecoveryMs: ms(block?.stable_recovery_seconds, d.stableRecoveryMs),
    // At least 2 (one failure + one recovery); the tracker keeps MAX_TRANSITIONS timestamps.
    flapTransitions: Number.isInteger(count) && count >= 2 ? Math.min(count, MAX_TRANSITIONS) : d.flapTransitions,
    flapWindowMs: ms(block?.flap_window_seconds, d.flapWindowMs),
    flapRecoveryMs: ms(block?.flap_recovery_seconds, d.flapRecoveryMs),
    reminderMs: ms(block?.reminder_seconds, d.reminderMs),
  };
}

const serviceKey = (service) => String(service || '').trim().toLowerCase();

const minutes = (ms) => Math.max(1, Math.round(ms / 60000));

/** Renders a tracker event as the admin message. `hostname` and `time` are supplied by the caller. */
export function formatServiceAlert(event, { hostname = '', time = '' } = {}) {
  const name = event.name || event.service;
  const lines = [];
  const common = () => {
    if (hostname) lines.push(`- **Host**: \`${hostname}\``);
    lines.push(`- **Service**: \`${name}\``);
  };
  const tail = () => {
    if (time) lines.push(`- **Time**: ${time}`);
  };
  switch (event.type) {
    case 'expired': {
      lines.push(`⚠️ **Authentication Expired: ${name}**`, '');
      common();
      if (event.error) lines.push(`- **Error**: \`${event.error}\``);
      if (event.stillFailing) {
        lines.push(`- **Status**: Still failing after flapping; ${event.suppressed ?? 0} state changes were not announced`);
      } else if (event.reminder) {
        lines.push('- **Status**: Still failing (reminder)');
      }
      tail();
      lines.push('', `Please check or refresh the secret credentials in SOPS for **${name}**.`);
      break;
    }
    case 'restored':
      lines.push(`🟢 **Authentication Restored: ${name}**`, '');
      common();
      lines.push('- **Status**: Connection and credentials are valid again');
      tail();
      break;
    case 'flapping':
      lines.push(`🔁 **Connection Unstable: ${name}**`, '');
      common();
      lines.push(`- **Changes**: ${event.transitions} state changes in ${minutes(event.windowMs)} min`);
      if (event.error) lines.push(`- **Last error**: \`${event.error}\``);
      lines.push(`- **Status**: Further expired/restored alerts are suppressed until it is stable for ${minutes(event.recoveryMs)} min`);
      tail();
      break;
    case 'flapping-restored':
      lines.push(`🟢 **Connection Stable Again: ${name}**`, '');
      common();
      lines.push(`- **Status**: Healthy again; ${event.suppressed ?? 0} state changes were suppressed while it was unstable`);
      tail();
      break;
    default:
      return null;
  }
  return lines.join('\n');
}

export class ServiceAlertTracker {
  /**
   * @param {object} opts
   * @param {(event: object) => (void|Promise<void>)} opts.notify receives
   *   `{ type: 'expired'|'restored'|'flapping'|'flapping-restored', service, name, ... }`
   * @param {string|null} [opts.file] state file; no persistence when null
   * @param {object} [opts.options] see DEFAULT_SERVICE_ALERT_OPTIONS
   * @param {() => number} [opts.now] clock, for tests
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ notify, file = null, options = {}, now = Date.now, log = () => {} } = {}) {
    this.notify = notify;
    this.file = file;
    this.options = { ...DEFAULT_SERVICE_ALERT_OPTIONS, ...options };
    this.now = now;
    this.log = log;
    this.states = new Map();
    this.lastSaved = null;
    this.timer = null;
    this.load();
  }

  /** Read-only snapshot of one connector's state, or undefined when it is not tracked. */
  get(service) {
    const state = this.states.get(serviceKey(service));
    return state ? { ...state, transitions: [...state.transitions] } : undefined;
  }

  reportFailure(service, error) {
    const key = serviceKey(service);
    if (!key) return;
    const now = this.now();
    let state = this.states.get(key);
    if (!state) {
      if (this.states.size >= MAX_SERVICES) return;
      state = this.newState(service);
      this.states.set(key, state);
    }

    if (state.lastRaw !== 'fail') {
      this.recordChange(state, now);
      state.lastRaw = 'fail';
    }
    state.healthySince = null; // cancels a pending recovery
    state.error = String(error ?? '').slice(0, MAX_ERROR_LENGTH) || null;
    this.evaluateFlapping(key, state, now);

    if (!state.failing) {
      state.failing = true;
      if (!state.flapping) this.alert('expired', key, state, now);
    } else if (!state.flapping && state.alerted && now - state.lastAlert >= this.options.reminderMs) {
      this.alert('expired', key, state, now, { reminder: true });
    }
    this.settle(key, state, now);
    this.save();
  }

  reportSuccess(service) {
    const key = serviceKey(service);
    const state = this.states.get(key);
    // Never seen failing (or already settled and forgotten): nothing to recover from.
    if (!state) return;
    const now = this.now();

    if (state.lastRaw === 'fail') {
      this.recordChange(state, now);
      state.lastRaw = 'ok';
      this.evaluateFlapping(key, state, now);
    }
    if ((state.failing || state.flapping) && state.healthySince === null) state.healthySince = now;
    this.settle(key, state, now);
    this.save();
  }

  /** Advances time-based decisions (recovery, flapping resolution, expiry). Call it periodically. */
  tick() {
    const now = this.now();
    for (const [key, state] of this.states) {
      this.pruneTransitions(state, now);
      this.settle(key, state, now);
      if (!state.failing && !state.flapping && state.transitions.length === 0 && state.lastRaw !== 'fail') {
        this.states.delete(key);
      }
    }
    this.save();
  }

  /** Runs tick() every `intervalMs` until stop(). The timer never keeps the process alive. */
  start(intervalMs = 30_000) {
    this.stop();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  newState(service) {
    return {
      name: String(service).trim().slice(0, MAX_NAME_LENGTH),
      failing: false,
      alerted: false,
      lastRaw: 'ok',
      error: null,
      lastAlert: 0,
      lastChange: 0,
      healthySince: null,
      transitions: [],
      flapping: false,
      suppressed: 0,
    };
  }

  recordChange(state, now) {
    state.lastChange = now;
    if (state.flapping) state.suppressed += 1;
    state.transitions.push(now);
    this.pruneTransitions(state, now);
    if (state.transitions.length > MAX_TRANSITIONS) {
      state.transitions.splice(0, state.transitions.length - MAX_TRANSITIONS);
    }
  }

  pruneTransitions(state, now) {
    state.transitions = state.transitions.filter((t) => now - t < this.options.flapWindowMs);
  }

  evaluateFlapping(key, state, now) {
    this.pruneTransitions(state, now);
    if (state.flapping || state.transitions.length < this.options.flapTransitions) return;
    state.flapping = true;
    state.suppressed = 0;
    state.lastAlert = now;
    this.emit({
      type: 'flapping',
      service: key,
      name: state.name,
      error: state.error,
      transitions: state.transitions.length,
      windowMs: this.options.flapWindowMs,
      recoveryMs: this.options.flapRecoveryMs,
    });
  }

  /** Time-based decisions for one connector. */
  settle(key, state, now) {
    if (!state.failing && !state.flapping) return;

    if (state.lastRaw === 'ok') {
      if (state.healthySince === null) return; // not seen healthy since (re)start
      const needed = state.flapping ? this.options.flapRecoveryMs : this.options.stableRecoveryMs;
      if (now - state.healthySince < needed) return;
      if (state.flapping) {
        this.emit({ type: 'flapping-restored', service: key, name: state.name, suppressed: state.suppressed });
        state.transitions = [];
      } else if (state.alerted) {
        this.emit({ type: 'restored', service: key, name: state.name });
      }
      state.failing = false;
      state.alerted = false;
      state.flapping = false;
      state.suppressed = 0;
      state.healthySince = null;
      state.error = null;
      return;
    }

    // Still failing and quiet for a whole window: it stopped flapping and is simply broken.
    if (state.flapping && now - state.lastChange >= this.options.flapWindowMs) {
      const suppressed = state.suppressed;
      state.flapping = false;
      state.suppressed = 0;
      state.transitions = [];
      this.alert('expired', key, state, now, { stillFailing: true, suppressed });
    }
  }

  alert(type, key, state, now, extra = {}) {
    state.lastAlert = now;
    state.alerted = true;
    this.emit({ type, service: key, name: state.name, error: state.error, ...extra });
  }

  emit(event) {
    try {
      Promise.resolve(this.notify?.(event)).catch((err) => this.log(`Service alert notification failed: ${err.message}`));
    } catch (err) {
      this.log(`Service alert notification failed: ${err.message}`);
    }
  }

  load() {
    if (!this.file) return;
    try {
      if (!fs.existsSync(this.file)) return;
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const now = this.now();
      for (const [key, raw] of Object.entries(data?.services || {}).slice(0, MAX_SERVICES)) {
        if (!raw || typeof raw !== 'object' || !serviceKey(key)) continue;
        const failing = raw.failing === true;
        const state = {
          ...this.newState(typeof raw.name === 'string' && raw.name.trim() ? raw.name : key),
          failing,
          alerted: raw.alerted === true,
          // After a restart the connector is not known to be healthy until it reports success again.
          lastRaw: raw.lastRaw === 'ok' || raw.lastRaw === 'fail' ? raw.lastRaw : failing ? 'fail' : 'ok',
          error: typeof raw.error === 'string' ? raw.error.slice(0, MAX_ERROR_LENGTH) : null,
          lastAlert: Number(raw.lastAlert) || 0,
          lastChange: Number(raw.lastChange) || 0,
          transitions: Array.isArray(raw.transitions)
            ? raw.transitions.map(Number).filter((t) => Number.isFinite(t) && t <= now).slice(-MAX_TRANSITIONS)
            : [],
          flapping: raw.flapping === true,
          suppressed: Number.isInteger(raw.suppressed) && raw.suppressed >= 0 ? raw.suppressed : 0,
        };
        this.pruneTransitions(state, now);
        this.states.set(serviceKey(key), state);
      }
      this.lastSaved = JSON.stringify(this.serialize());
    } catch (err) {
      this.log(`Could not load service alert state ${this.file}: ${err.message}`);
    }
  }

  serialize() {
    const services = {};
    for (const [key, state] of this.states) {
      // healthySince is deliberately not persisted (see load()).
      const { healthySince: _omit, ...rest } = state;
      services[key] = rest;
    }
    return { version: 1, services };
  }

  save() {
    if (!this.file) return;
    try {
      const json = JSON.stringify(this.serialize());
      if (json === this.lastSaved) return;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, json, { encoding: 'utf8', mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.file);
      this.lastSaved = json;
    } catch (err) {
      this.log(`Could not save service alert state ${this.file}: ${err.message}`);
    }
  }
}
