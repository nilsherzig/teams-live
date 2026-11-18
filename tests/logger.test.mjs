import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import {
  colorEnabled,
  createLogger,
  formatJournalLines,
  formatPrefix,
  inferLevel,
  journalStderr,
  parseLevel,
} from '../src/logger.mjs';

const FIXED = new Date('2026-01-02T03:04:05.678Z');
const ANSI = /\x1b\[/;

function capture(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args);
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

test('lines carry a timestamp and tag but no severity text', () => {
  const log = createLogger('demo', { env: {}, now: () => FIXED, stream: { isTTY: false } });
  const lines = capture(() => {
    log.info('started');
    log.warn('slow');
    log.error('broke');
    log.debug('hidden by default');
  });
  for (const [prefix] of lines) assert.doesNotMatch(prefix, /\b(?:DBG|INF|WRN|ERR)\b/);
  assert.deepEqual(lines, [
    ['2026-01-02T03:04:05.678Z [demo]', 'started'],
    ['2026-01-02T03:04:05.678Z [demo]', 'slow'],
    ['2026-01-02T03:04:05.678Z [demo]', 'broke'],
  ]);
});

test('debug lines appear when the level is lowered, and warn hides info', () => {
  const env = { TEAMS_LIVE_LOG_LEVEL: 'debug' };
  const log = createLogger('demo', { env, now: () => FIXED, stream: { isTTY: false } });
  assert.deepEqual(capture(() => log.debug('trace')), [['2026-01-02T03:04:05.678Z [demo]', 'trace']]);
  env.TEAMS_LIVE_LOG_LEVEL = 'warn';
  assert.deepEqual(capture(() => { log.info('quiet'); log.warn('loud'); }).map((l) => l[1]), ['loud']);
  env.TEAMS_LIVE_LOG_LEVEL = 'nonsense';
  assert.deepEqual(capture(() => { log.debug('no'); log.info('yes'); }).map((l) => l[1]), ['yes']);
});

test('level names and aliases parse, unknown values fall back', () => {
  assert.equal(parseLevel('DEBUG'), 'debug');
  assert.equal(parseLevel('dbg'), 'debug');
  assert.equal(parseLevel('WRN'), 'warn');
  assert.equal(parseLevel('warning'), 'warn');
  assert.equal(parseLevel('err'), 'error');
  assert.equal(parseLevel('inf'), 'info');
  assert.equal(parseLevel(undefined), 'info');
  assert.equal(parseLevel('loud', 'warn'), 'warn');
});

test('colors are used on a TTY only, and NO_COLOR / FORCE_COLOR / TEAMS_LIVE_LOG_COLOR override', () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };
  assert.equal(colorEnabled({ env: {}, stream: tty }), true);
  assert.equal(colorEnabled({ env: {}, stream: pipe }), false);
  assert.equal(colorEnabled({ env: { TERM: 'dumb' }, stream: tty }), false);
  assert.equal(colorEnabled({ env: { NO_COLOR: '1' }, stream: tty }), false);
  assert.equal(colorEnabled({ env: { FORCE_COLOR: '1' }, stream: pipe }), true);
  assert.equal(colorEnabled({ env: { FORCE_COLOR: '0' }, stream: pipe }), false);
  assert.equal(colorEnabled({ env: { NO_COLOR: '1', TEAMS_LIVE_LOG_COLOR: 'always' }, stream: pipe }), true);
  assert.equal(colorEnabled({ env: { FORCE_COLOR: '1', TEAMS_LIVE_LOG_COLOR: 'never' }, stream: tty }), false);
});

test('each severity colors the tag differently and the text stays readable without escapes', () => {
  const colored = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [level, formatPrefix({ level, tag: 't', now: FIXED, color: true })])
  );
  assert.equal(new Set(Object.values(colored)).size, 4);
  assert.match(colored.error, /\x1b\[1;31m\[t\]\x1b\[0m$/);
  assert.match(colored.warn, /\x1b\[1;33m\[t\]\x1b\[0m$/);
  assert.match(colored.info, /\x1b\[32m\[t\]\x1b\[0m$/);
  assert.match(colored.debug, /\x1b\[36m\[t\]\x1b\[0m$/);
  for (const prefix of Object.values(colored)) assert.doesNotMatch(prefix, /DBG|INF|WRN|ERR/);
  for (const level of ['debug', 'info', 'warn', 'error']) {
    const plain = formatPrefix({ level, tag: 't', now: FIXED, color: false });
    assert.equal(plain, '2026-01-02T03:04:05.678Z [t]');
    assert.ok(!ANSI.test(plain));
  }
  assert.equal(formatPrefix({ level: 'info', now: FIXED }), '2026-01-02T03:04:05.678Z');
});

test('a forced-color logger colors the tag but never the message', () => {
  const log = createLogger('demo', { env: { FORCE_COLOR: '1' }, now: () => FIXED });
  const [[prefix, message]] = capture(() => log.error('secret=none'));
  assert.match(prefix, /\x1b\[1;31m\[demo\]\x1b\[0m$/);
  assert.equal(message, 'secret=none');
});

test('extra arguments such as errors are passed through untouched', () => {
  const log = createLogger('demo', { env: {}, now: () => FIXED, stream: { isTTY: false } });
  const err = new Error('boom');
  const [[prefix, text, passed]] = capture(() => log.error('Fatal:', err));
  assert.equal(prefix, '2026-01-02T03:04:05.678Z [demo]');
  assert.equal(text, 'Fatal:');
  assert.equal(passed, err);
});

test('a plain log() call infers a severity from its wording', () => {
  const cases = [
    ['Started teams-live', 'info'],
    ['Approved group/app!1 successfully', 'info'],
    ['Error approving group/app!1: boom', 'error'],
    ['Failed to send alert: boom', 'error'],
    ['Could not read the state file: ENOENT', 'error'],
    ['History poll failed: timeout', 'error'],
    ['Warning: something odd', 'warn'],
    ['editing original message failed (x), falling back to reply', 'warn'],
    ['Failed to refresh /mrs cache (x), serving stale cache', 'warn'],
    ['building the help card failed, using plain text: x', 'warn'],
    ['History scan of a failed (x), retrying in 2s...', 'warn'],
    ['Adaptive Card too large (10 bytes), splitting into several cards', 'warn'],
    ['The tracked webhook 1 no longer exists', 'warn'],
    ['Polling every 30s as push fallback', 'info'],
    ['Deleted superseded webhook 1 (stale)', 'info'],
    ['Fatal error in teams-live', 'error'],
  ];
  for (const [message, level] of cases) assert.equal(inferLevel(message), level, message);
  assert.equal(inferLevel(new Error('request failed')), 'error');
  assert.equal(inferLevel({ failed: true }), 'info', 'only strings and errors are classified');
  assert.equal(inferLevel(undefined), 'info');
});

test('the legacy callable uses the inferred severity', () => {
  const log = createLogger('demo', { env: { TEAMS_LIVE_LOG_COLOR: 'always' }, now: () => FIXED });
  const lines = capture(() => {
    log('Started');
    log('Merge failed: boom');
    log('Falling back after it failed');
  });
  const styles = lines.map(([prefix]) => prefix.match(/(\x1b\[[\d;]+m)\[demo\]/)[1]);
  assert.deepEqual(styles, ['\x1b[32m', '\x1b[1;31m', '\x1b[1;33m']);
});

const JOURNAL = { JOURNAL_STREAM: '8:1234' };
const journalLogger = (env = {}) =>
  createLogger('demo', {
    env: { ...JOURNAL, ...env },
    now: () => FIXED,
    stream: { isTTY: false },
    identity: () => '8:1234',
  });

test('journal mode prefixes each severity with its sd-daemon priority, no timestamp and no severity text', () => {
  const log = journalLogger({ TEAMS_LIVE_LOG_LEVEL: 'debug' });
  const lines = capture(() => {
    log.debug('trace');
    log.info('started');
    log.warn('slow');
    log.error('broke');
  });
  assert.deepEqual(lines, [
    ['<7>[demo] trace'],
    ['<6>[demo] started'],
    ['<4>[demo] slow'],
    ['<3>[demo] broke'],
  ]);
});

test('journal mode prefixes every line of a multi-line message', () => {
  const log = journalLogger();
  const lines = capture(() => log.error('failed:\n  at a\r\n  at b'));
  assert.deepEqual(lines, [['<3>[demo] failed:\n<3>  at a\n<3>  at b']]);
  for (const line of lines[0][0].split('\n')) assert.match(line, /^<3>/);
});

test('journal mode formats extra arguments like console.error would', () => {
  const log = journalLogger();
  const lines = capture(() => log.warn('got', 42, { a: 1 }));
  assert.deepEqual(lines, [['<4>[demo] got 42 { a: 1 }']]);
});

test('journal mode keeps the inferred severity for plain log() calls', () => {
  const log = journalLogger();
  const lines = capture(() => {
    log('all good');
    log('request failed');
  });
  assert.deepEqual(lines, [['<6>[demo] all good'], ['<3>[demo] request failed']]);
});

test('journal mode writes no ANSI unless TEAMS_LIVE_LOG_COLOR=always', () => {
  const plain = capture(() => journalLogger({ FORCE_COLOR: '1' }).warn('x'));
  assert.doesNotMatch(plain[0][0], ANSI);
  const tty = createLogger('demo', {
    env: JOURNAL,
    stream: { isTTY: true },
    identity: () => '8:1234',
  });
  assert.doesNotMatch(capture(() => tty.warn('x'))[0][0], ANSI);
  const forced = capture(() => journalLogger({ TEAMS_LIVE_LOG_COLOR: 'always' }).warn('x'));
  assert.match(forced[0][0], /^<4>\x1b\[1;33m\[demo\]\x1b\[0m x$/);
});

test('journal mode still honors the level filter', () => {
  const log = journalLogger({ TEAMS_LIVE_LOG_LEVEL: 'warn' });
  assert.deepEqual(
    capture(() => {
      log.debug('a');
      log.info('b');
      log.warn('c');
    }),
    [['<4>[demo] c']],
  );
});

test('journal mode needs JOURNAL_STREAM to match the stream behind fd 2', () => {
  assert.equal(journalStderr({ env: {}, identity: () => '8:1234' }), false);
  assert.equal(journalStderr({ env: { JOURNAL_STREAM: 'junk' }, identity: () => 'junk' }), false);
  assert.equal(journalStderr({ env: JOURNAL, identity: () => '8:1234' }), true);
  assert.equal(journalStderr({ env: JOURNAL, identity: () => '8:9999' }), false);
  assert.equal(journalStderr({ env: JOURNAL, identity: () => null }), false);

  // stdout may be the journal while stderr was redirected: keep the plain format.
  const log = createLogger('demo', {
    env: JOURNAL,
    now: () => FIXED,
    stream: { isTTY: false },
    identity: () => '8:9999',
  });
  assert.deepEqual(capture(() => log.info('hi')), [['2026-01-02T03:04:05.678Z [demo]', 'hi']]);
});

test('the journal check is redone when JOURNAL_STREAM changes, not on every line', () => {
  const env = { ...JOURNAL };
  let calls = 0;
  const log = createLogger('demo', {
    env,
    now: () => FIXED,
    stream: { isTTY: false },
    identity: () => {
      calls += 1;
      return '8:1234';
    },
  });
  capture(() => {
    log.info('a');
    log.info('b');
  });
  assert.equal(calls, 1);
  delete env.JOURNAL_STREAM;
  const plain = capture(() => log.info('c'));
  assert.equal(plain[0][0], '2026-01-02T03:04:05.678Z [demo]');
});

test('formatJournalLines and formatPrefix agree on the tag', () => {
  assert.equal(formatJournalLines({ level: 'warn', tag: 'x', args: ['a\nb'] }), '<4>[x] a\n<4>b');
  assert.equal(formatPrefix({ level: 'warn', tag: 'x', timestamp: false }), '[x]');
  assert.equal(formatJournalLines({ level: 'info', args: ['a'] }), '<6>a');
});

test('no source file builds its own timestamp prefix or writes to the console directly', () => {
  const allowed = new Set(['logger.mjs', 'smoke-rich.mjs']);
  for (const file of fs.readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.mjs'))) {
    if (allowed.has(file)) continue;
    const text = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.ok(!/new Date\(\)\.toISOString\(\),\s*['`]\[/.test(text), `${file} formats its own log prefix`);
    const direct = text.split('\n').filter((l) => /console\.(warn|error|info|debug)\(/.test(l));
    assert.deepEqual(direct, [], `${file} logs through console.* instead of the logger`);
  }
});
