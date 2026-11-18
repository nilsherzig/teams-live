// Shared logger: every line is `<timestamp> [tag] message`. The severity is not
// spelled out; on a color-enabled stream the `[tag]` is colored by severity
// (cyan debug, green info, bold yellow warn, bold red error). Output goes to
// stderr (stdout carries the event stream of `--json` / human mode), through
// `console.error` looked up at call time so tests can capture it.
//
// Colors are applied only to a TTY (or when forced), never to a file, so
// service logs stay plain text:
//   NO_COLOR=1                   never color (https://no-color.org)
//   FORCE_COLOR=1                color even when stderr is not a TTY
//   TEAMS_LIVE_LOG_COLOR=always|never|auto   explicit override (wins over both)
//
// When stderr is the systemd journal (JOURNAL_STREAM names the very stream
// behind fd 2) every line starts with an sd-daemon priority (`<3>` .. `<7>`),
// so `journalctl -p warning` works. The journal adds its own timestamp, so the
// line has none, and no ANSI escapes are written unless
// TEAMS_LIVE_LOG_COLOR=always (FORCE_COLOR is ignored): journalctl colors
// warning and error lines by priority itself (info is left uncolored by
// journalctl, which is why there is no severity text either).
// Verbosity: TEAMS_LIVE_LOG_LEVEL=debug|info|warn|error (default info, so DBG
// lines are hidden unless asked for).

import fs from 'node:fs';
import util from 'node:util';

export const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

// sd-daemon(3) priorities: LOG_ERR, LOG_WARNING, LOG_INFO, LOG_DEBUG.
export const JOURNAL_PRIORITIES = Object.freeze({ debug: 7, info: 6, warn: 4, error: 3 });

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const STYLES = Object.freeze({
  debug: '\x1b[36m', // cyan
  info: '\x1b[32m', // green
  warn: '\x1b[1;33m', // bold yellow
  error: '\x1b[1;31m', // bold red
});

export function parseLevel(value, fallback = 'info') {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'dbg' || v === 'trace') return 'debug';
  if (v === 'inf') return 'info';
  if (v === 'wrn' || v === 'warning') return 'warn';
  if (v === 'err') return 'error';
  return Object.hasOwn(LEVELS, v) ? v : fallback;
}

export function colorEnabled({ env = process.env, stream = process.stderr } = {}) {
  const forced = String(env.TEAMS_LIVE_LOG_COLOR ?? '').toLowerCase();
  if (forced === 'always' || forced === '1' || forced === 'true') return true;
  if (forced === 'never' || forced === '0' || forced === 'false') return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
  return Boolean(stream?.isTTY) && env.TERM !== 'dumb';
}

function stderrIdentity() {
  try {
    const st = fs.fstatSync(2);
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

/**
 * True when stderr is connected to the systemd journal. systemd sets
 * JOURNAL_STREAM=<device>:<inode> for the stream it created for stdout and/or
 * stderr, so the variable alone does not prove stderr is the journal (stdout
 * may be, while stderr was redirected): compare it with fd 2.
 */
export function journalStderr({ env = process.env, identity = stderrIdentity } = {}) {
  const value = String(env.JOURNAL_STREAM ?? '').trim();
  if (!/^\d+:\d+$/.test(value)) return false;
  return value === identity();
}

// A plain `log(message)` states no severity, and some callbacks injected into
// other modules (webhook reconciler, service alerts) can only take a string.
// Classify those from the wording: a failure that is recovered from (fallback,
// retry, degraded mode) is a warning, an unrecovered failure an error, a few
// state-change phrases are warnings, anything else info. Call sites that this
// guesses wrong, or that are trace noise, use `log.warn` / `log.debug`.
const RECOVERED = /\b(falling back|fall back|fallback|retrying|using (?:generic|plain)|serving stale|will retry|next check in|paused)\b/i;
const FAILURE = /\b(fatal|errors?|failed|failures?|fails|cannot|can't|could not|couldn't|unable to|threw|exception|crashed)\b/i;
const WARNING = /\b(no longer|too large|not accessible|unavailable|deprecated|timed out|exceeded|not deleting|not adopting|left in place|left alone|limit reached)\b/i;

export function inferLevel(message) {
  const text = typeof message === 'string' ? message : message instanceof Error ? message.message : '';
  if (/^\s*(?:\[[^\]]*\]\s*)?warning\b/i.test(text)) return 'warn';
  if (/^\s*(?:\[[^\]]*\]\s*)?(?:fatal|error)\b/i.test(text)) return 'error';
  if (FAILURE.test(text)) return RECOVERED.test(text) ? 'warn' : 'error';
  if (WARNING.test(text) || /\bnext check in\b/i.test(text)) return 'warn';
  return 'info';
}

export function formatPrefix({ level, tag, now = new Date(), color = false, timestamp = true }) {
  const head = [];
  if (timestamp) {
    const stamp = now.toISOString();
    head.push(color ? `${DIM}${stamp}${RESET}` : stamp);
  }
  if (tag) head.push(color ? `${STYLES[level] ?? STYLES.info}[${tag}]${RESET}` : `[${tag}]`);
  return head.join(' ');
}

/**
 * One journal record: every line of a multi-line message gets the priority
 * prefix, since journald parses it per line and a continuation line without it
 * would be stored as info.
 */
export function formatJournalLines({ level, tag, args, color = false }) {
  const priority = `<${JOURNAL_PRIORITIES[level] ?? JOURNAL_PRIORITIES.info}>`;
  const prefix = formatPrefix({ level, tag, color, timestamp: false });
  const text = util.format(...args);
  const lead = prefix ? `${prefix} ` : '';
  return text
    .split(/\r?\n/)
    .map((line, i) => (i === 0 ? `${priority}${lead}${line}` : `${priority}${line}`))
    .join('\n');
}

/**
 * Create a logger for a component. The returned function is the legacy
 * `log(...args)` form (severity inferred from the message); `.debug`, `.info`,
 * `.warn` and `.error` state the severity explicitly. Environment is read on
 * every call so a level or color change takes effect without a restart.
 */
export function createLogger(tag, { env = process.env, stream, now = () => new Date(), identity } = {}) {
  let journalFor = null;
  let journal = false;
  const emit = (level, args) => {
    if (LEVELS[level] < LEVELS[parseLevel(env.TEAMS_LIVE_LOG_LEVEL)]) return;
    // fstat once per JOURNAL_STREAM value, not once per line.
    if (journalFor !== env.JOURNAL_STREAM) {
      journalFor = env.JOURNAL_STREAM;
      journal = journalStderr({ env, ...(identity ? { identity } : {}) });
    }
    if (journal) {
      const color = String(env.TEAMS_LIVE_LOG_COLOR ?? '').toLowerCase() === 'always';
      console.error(formatJournalLines({ level, tag, args, color }));
      return;
    }
    const color = colorEnabled({ env, stream: stream ?? process.stderr });
    console.error(formatPrefix({ level, tag, now: now(), color }), ...args);
  };
  const log = (...args) => emit(inferLevel(args[0]), args);
  log.debug = (...args) => emit('debug', args);
  log.info = (...args) => emit('info', args);
  log.warn = (...args) => emit('warn', args);
  log.error = (...args) => emit('error', args);
  log.tag = tag;
  return log;
}
