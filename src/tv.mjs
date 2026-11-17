/**
 * `/tv`: what is on ARD and ZDF right now (and next), and, for the owner, a
 * switch of the OBS input through a Home Assistant webhook.
 *
 * Everything that differs between installations is runtime configuration
 * (see `normalizeTvConfig`): the programme sources, the time zone, the Home
 * Assistant base URL and the webhook ids. Nothing in here names a host or an id.
 */

import zlib from 'node:zlib';

const str = (value) => (value === undefined || value === null ? '' : String(value).trim());

export const TV_CHANNEL_KEYS = ['ard', 'zdf'];

// Public sources: the ARD programme API (no key) and a community XMLTV file (the
// ZDF has no keyless API of its own). Any of it can be replaced in the config.
const DEFAULT_CHANNELS = {
  ard: {
    name: 'Das Erste',
    type: 'ard-api',
    url: 'https://programm-api.ard.de/program/api/program',
    channel_id: 'daserste',
  },
  zdf: {
    name: 'ZDF',
    type: 'xmltv',
    url: 'https://epgshare01.online/epgshare01/epg_ripper_DE1.xml.gz',
    channel_id: 'ZDF.de',
  },
};

const SOURCE_TYPES = new Set(['ard-api', 'xmltv']);
const DEFAULT_TIMEZONE = 'Europe/Berlin';
const FETCH_TIMEOUT_MS = 30_000;

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('de-DE', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The `tv` section of the config, with defaults. Never throws on bad input: an
 * unusable value falls back to the default, so a typo cannot take the daemon down.
 */
export function normalizeTvConfig(raw = {}, { baseUrl = '', token = '' } = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const channels = {};
  for (const key of TV_CHANNEL_KEYS) {
    const given = input.channels?.[key] && typeof input.channels[key] === 'object' ? input.channels[key] : {};
    const base = DEFAULT_CHANNELS[key];
    const type = SOURCE_TYPES.has(given.type) ? given.type : base.type;
    // A changed source type brings its own URL and channel id: mixing the defaults of
    // another type with the given values would only produce a broken request.
    const sameType = type === base.type;
    channels[key] = {
      name: str(given.name) || base.name,
      type,
      url: str(given.url) || (sameType ? base.url : ''),
      channel_id: str(given.channel_id) || (sameType ? base.channel_id : ''),
    };
  }
  const ttl = Number(input.cache_ttl_seconds);
  return {
    timezone: validTimeZone(str(input.timezone)) ? str(input.timezone) : DEFAULT_TIMEZONE,
    cache_ttl_seconds: Number.isFinite(ttl) && ttl >= 0 ? ttl : 300,
    // Programme pictures in the rich cards (only from the allowlisted EPG hosts, see tv-cards.mjs).
    artwork: input.artwork !== false,
    channels,
    switch: normalizeSwitchConfig(input.switch, { baseUrl, token }),
  };
}

// The input switch: one Home Assistant webhook per target. The webhook ids are
// secrets (the id is the only authentication), so they come from the runtime
// config (`{ "_secret": "/path" }` references, see config.mjs), never from this
// repository, and are never logged or sent to chat.
// The cycle order of `/tv next` (and, reversed, `/tv prev`).
export const TV_SWITCH_TARGETS = ['ard', 'zdf', 'tagesschau'];
export const TV_SWITCH_ACTIONS = [...TV_SWITCH_TARGETS, 'off'];
export const TV_CYCLE_ACTIONS = ['next', 'prev'];
// Audio controls; the routing itself is configured elsewhere, these only fire its webhooks.
export const TV_AUDIO_ACTIONS = ['mute', 'unmute', 'volume_up', 'volume_down'];
export const TV_CONTROL_ACTIONS = [...TV_SWITCH_ACTIONS, ...TV_CYCLE_ACTIONS, ...TV_AUDIO_ACTIONS];
const TV_WEBHOOK_KEYS = [...TV_SWITCH_ACTIONS, ...TV_AUDIO_ACTIONS, 'volume'];
const DEFAULT_VOLUME_STEP = 0.05;
const DEFAULT_OFF_SCENE = 'brb';

function httpBase(value) {
  const base = str(value).replace(/\/+$/, '');
  return /^https?:\/\/[^/\s]+/i.test(base) ? base : '';
}

// What Home Assistant reports for each target, lowercased; by default the
// target's own name. Only the configured off values (default: the off scene)
// mean "off"; any other value is unknown and stops a cycle.
function normalizeStateValues(raw, key) {
  const list = Array.isArray(raw) ? raw : [raw];
  const values = list.map((v) => str(v).toLowerCase()).filter(Boolean);
  return values.length ? [...new Set(values)] : [key];
}

function normalizeSwitchConfig(raw, fallback) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const webhooks = {};
  for (const action of TV_WEBHOOK_KEYS) {
    const value = input.webhooks?.[action];
    if (typeof value === 'string' && value.trim()) webhooks[action] = value.trim();
  }
  const timeout = Number(input.timeout_seconds);
  const ownBase = httpBase(input.base_url);
  const state = input.state && typeof input.state === 'object' ? input.state : {};
  // The Home Assistant token of the daemon is only ever sent to the Home Assistant URL it belongs to.
  const token = str(state.token) || (ownBase ? '' : str(fallback.token));
  const map = {};
  for (const key of TV_SWITCH_TARGETS) map[key] = normalizeStateValues(state.map?.[key], key);
  const offScene = str(input.off_scene) || DEFAULT_OFF_SCENE;
  map.off = normalizeStateValues(state.map?.off, offScene.toLowerCase());
  const volume = input.volume && typeof input.volume === 'object' ? input.volume : {};
  const step = Number(volume.step);
  return {
    base_url: ownBase || httpBase(fallback.baseUrl),
    webhooks,
    off_scene: offScene,
    timeout_seconds: Number.isFinite(timeout) && timeout > 0 ? timeout : 10,
    state: {
      entity_id: str(state.entity_id),
      // Read this attribute instead of the entity state (e.g. the active input of an OBS entity).
      attribute: str(state.attribute),
      token,
      map,
      // Without a readback, cycle from the channel this process switched to last (never after a restart).
      trust_last_switch: state.trust_last_switch === true,
    },
    // One step of `/tv vol up|down`, as a fraction of the full range.
    volume: {
      entity_id: str(volume.entity_id),
      step: Number.isFinite(step) && step > 0 && step <= 1 ? step : DEFAULT_VOLUME_STEP,
    },
  };
}

// ---------------------------------------------------------------- parsing

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text) {
  return String(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ent) => {
      if (ent[0] === '#') {
        const code = ent[1].toLowerCase() === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      return XML_ENTITIES[ent.toLowerCase()] ?? match;
    });
}

/** `20261117001500 +0000` (XMLTV) to a Date, or null. A missing offset means UTC. */
export function parseXmltvTime(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?$/.exec(str(value));
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '00', off = '+0000'] = m;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${off.slice(0, 3)}:${off.slice(3)}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function xmlField(body, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(body);
  return m ? decodeXml(m[1]).replace(/\s+/g, ' ').trim() : '';
}

/** The `<icon src>` of a programme (the raw URL; the cards only show what passes `safeArtworkUrl`). */
function xmlIcon(body) {
  const m = /<icon\b[^>]*\bsrc="([^"]*)"/.exec(body);
  return m ? decodeXml(m[1]).trim() : '';
}

/** Programmes of one channel from an XMLTV document, sorted by start. */
export function parseXmltv(xml, channelId) {
  const wanted = str(channelId);
  const out = [];
  if (!wanted) return out;
  const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const channel = /\bchannel="([^"]*)"/.exec(attrs)?.[1];
    if (channel === undefined || decodeXml(channel) !== wanted) continue;
    const start = parseXmltvTime(/\bstart="([^"]*)"/.exec(attrs)?.[1]);
    const end = parseXmltvTime(/\bstop="([^"]*)"/.exec(attrs)?.[1]);
    const title = xmlField(m[2], 'title');
    if (!start || !end || !title) continue;
    out.push({
      start,
      end,
      title,
      subtitle: xmlField(m[2], 'sub-title'),
      description: xmlField(m[2], 'desc'),
      image: xmlIcon(m[2]),
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Programmes of one channel from the ARD programme API (one day), sorted by start. */
export function parseArdProgram(json, channelId) {
  const wanted = str(channelId);
  const out = [];
  for (const channel of Array.isArray(json?.channels) ? json.channels : []) {
    if (str(channel?.id) !== wanted) continue;
    for (const slot of Array.isArray(channel.timeSlots) ? channel.timeSlots : []) {
      for (const item of Array.isArray(slot) ? slot : []) {
        const start = new Date(item?.broadcastedOn || item?.beginNet || '');
        let end = new Date(item?.broadcastEnd || '');
        if (Number.isNaN(end.getTime()) && Number.isFinite(item?.duration)) {
          end = new Date(start.getTime() + item.duration * 1000);
        }
        const title = str(item?.title || item?.coreTitle);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || !title) continue;
        out.push({
          start,
          end,
          title,
          subtitle: str(item.subline || item.coreSubline),
          description: str(item.synopsis).replace(/\s+/g, ' '),
          image: str(item.images?.aspect16x9?.src),
        });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The running programme and the one after it (either may be null). */
export function currentAndNext(programmes, now = new Date()) {
  const t = now.getTime();
  const list = [...programmes].sort((a, b) => a.start - b.start);
  const current = list.find((p) => p.start.getTime() <= t && t < p.end.getTime()) || null;
  const after = current ? current.end.getTime() : t;
  const next = list.find((p) => p.start.getTime() >= after && p !== current) || null;
  return { current, next };
}

// ---------------------------------------------------------------- fetching

/** `YYYY-MM-DD` of an instant in a time zone. */
export function localDay(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function localHour(date, timeZone) {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(date);
  return Number(h);
}

async function fetchBody(fetchImpl, url, label) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'teams-live', Accept: '*/*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Programme list of one configured channel at `now`. The ARD API serves a day
 * at a time (a programme day ends in the early morning), so the neighbouring
 * day is read too when the running or the next programme is not in today's.
 */
export async function loadProgrammes(source, { fetchImpl = globalThis.fetch, now = new Date(), timeZone = DEFAULT_TIMEZONE } = {}) {
  if (!source.url) throw new Error('no programme source configured');
  if (!source.channel_id) throw new Error('no channel id configured');

  if (source.type === 'xmltv') {
    let body = await fetchBody(fetchImpl, source.url, 'XMLTV');
    if (body[0] === 0x1f && body[1] === 0x8b) body = zlib.gunzipSync(body);
    return parseXmltv(body.toString('utf8'), source.channel_id);
  }

  const dayUrl = (day) => {
    const url = new URL(source.url);
    url.searchParams.set('day', day);
    return url.toString();
  };
  const load = async (day) => parseArdProgram(JSON.parse((await fetchBody(fetchImpl, dayUrl(day), 'ARD programme')).toString('utf8')), source.channel_id);

  const today = localDay(now, timeZone);
  let programmes = await load(today);
  const found = currentAndNext(programmes, now);
  if (!found.current || !found.next) {
    const offsetDays = localHour(now, timeZone) < 6 ? -1 : 1;
    const other = localDay(new Date(now.getTime() + offsetDays * 86_400_000), timeZone);
    try {
      programmes = programmes.concat(await load(other));
    } catch {
      // the other day is a best effort: today's data stays usable
    }
  }
  return programmes;
}

/** What is on, per configured channel, with a short cache (the sources are large). */
export class TvProgrammeService {
  constructor(config, { fetchImpl = (...args) => globalThis.fetch(...args), now = () => new Date() } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.cache = new Map();
    this.inflight = new Map();
  }

  /** One load per channel at a time: a second caller joins the first one's request. */
  load(key, source, now) {
    let run = this.inflight.get(key);
    if (!run) {
      run = loadProgrammes(source, { fetchImpl: this.fetchImpl, now, timeZone: this.config.timezone })
        .then((programmes) => {
          this.cache.set(key, { at: now.getTime(), programmes });
          return programmes;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, run);
    }
    return run;
  }

  async channelData(key, { force = false } = {}) {
    const source = this.config.channels[key];
    const now = this.now();
    const ttlMs = this.config.cache_ttl_seconds * 1000;
    const cached = this.cache.get(key);
    let programmes = cached && !force && now.getTime() - cached.at < ttlMs ? cached.programmes : null;
    let error = null;
    if (!programmes) {
      try {
        programmes = await this.load(key, source, now);
      } catch (err) {
        error = err.message;
        // A stale list still answers "what is on" when the source is down.
        programmes = cached?.programmes || [];
      }
    }
    const { current, next } = currentAndNext(programmes, now);
    if (!error && !current && !next) error = 'no programme data for this time';
    return { key, name: source.name, current, next, error };
  }

  /**
   * What is on one channel, for a control reply: `{ current, next }`, or null
   * when the channel has no programme source here, the data is missing or stale,
   * the source failed, or it did not answer within `timeoutMs`. It never throws
   * and never waits longer than the bound; a lookup that is still running goes
   * on and fills the cache for the next call.
   */
  async channelNow(key, { timeoutMs = 2500 } = {}) {
    if (!Object.hasOwn(this.config.channels, key)) return null;
    let timer;
    const bound = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs, null);
    });
    try {
      const data = await Promise.race([this.channelData(key).catch(() => null), bound]);
      if (!data || data.error || (!data.current && !data.next)) return null;
      return { current: data.current, next: data.next };
    } finally {
      clearTimeout(timer);
    }
  }

  /** `{ now, timezone, channels: [{ key, name, current, next, error }] }`; one channel failing does not hide the other. */
  async getProgramme(opts = {}) {
    const now = this.now();
    const channels = await Promise.all(TV_CHANNEL_KEYS.map((key) => this.channelData(key, opts)));
    return { now, timezone: this.config.timezone, channels };
  }
}

// ---------------------------------------------------------------- command

const PROGRAMME_ALIASES = new Set(['program', 'programm', 'programme', 'prog']);
const NEXT_ALIASES = new Set(['next', 'n', 'weiter']);
const PREV_ALIASES = new Set(['prev', 'previous', 'p', 'zurueck']);
const VOLUME_ALIASES = new Set(['vol', 'volume']);
const UP_ALIASES = new Set(['up', 'louder', '+']);
const DOWN_ALIASES = new Set(['down', 'quieter', '-']);
const TAGESSCHAU_ALIASES = new Set(['ts', 'tagesschau', 'tagesshau', 'tageschau']);

/** Optimal string alignment distance: insertions, deletions, substitutions and adjacent swaps. */
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

// "tagesschau" is long and easy to mistype, so a few slips (even a swapped pair) are accepted.
const isTagesschau = (word) =>
  TAGESSCHAU_ALIASES.has(word) || (word.length >= 6 && editDistance(word, 'tagesschau') <= 3);

/**
 * `/tv` arguments to an action: `programme`, `ard`, `zdf`, `tagesschau`, `off`,
 * `next`, `prev`, `mute`, `unmute`, `volume_up`, `volume_down`, `help` (no argument) or `unknown`.
 */
export function parseTvArgs(args = []) {
  const first = str(args[0]).toLowerCase();
  if (!first) return { action: 'help' };
  if (first === 'mute') return { action: 'mute' };
  if (first === 'unmute') return { action: 'unmute' };
  if (VOLUME_ALIASES.has(first)) {
    const dir = str(args[1]).toLowerCase();
    if (UP_ALIASES.has(dir)) return { action: 'volume_up' };
    if (DOWN_ALIASES.has(dir)) return { action: 'volume_down' };
    return { action: 'unknown', arg: `${first} ${dir}`.trim() };
  }
  if (PROGRAMME_ALIASES.has(first)) return { action: 'programme' };
  if (TV_CHANNEL_KEYS.includes(first)) return { action: first };
  if (first === 'off') return { action: 'off' };
  if (NEXT_ALIASES.has(first)) return { action: 'next' };
  if (PREV_ALIASES.has(first)) return { action: 'prev' };
  if (isTagesschau(first)) return { action: 'tagesschau' };
  return { action: 'unknown', arg: first };
}

export const TV_USAGE =
  'Usage: `/tv program` (what is on now and next on ARD and ZDF); owner only: `/tv ard`, `/tv zdf`, `/tv tagesschau`, `/tv next`, `/tv prev`, `/tv off`, `/tv mute`, `/tv unmute`, `/tv vol up` (also unmutes), `/tv vol down`.';

// ---------------------------------------------------------------- switching

// Home Assistant webhooks are fire and forget: a 2xx proves the request was
// queued, not that OBS did anything. The replies (src/tv-cards.mjs) must not
// claim more: a switch is "requested" until `confirm()` reads it back.

/** How long, and how often, `confirm()` waits for the scene readback to show a switch. */
const CONFIRM_SETTLE_MS = 700;
const CONFIRM_ATTEMPTS = 3;

/** How long a successful switch outranks a readback that still shows the previous channel. */
const RECENT_SWITCH_MS = 5000;

/**
 * Switches the OBS input through Home Assistant webhooks and cycles through the
 * channels. Failures are reported as a short, fixed text: neither a webhook
 * URL or id, nor the Home Assistant token, nor the low-level error (which may
 * contain the host) ever leaves this class.
 *
 * Every switch and cycle runs through one queue, so two commands never
 * overlap: a `/tv next` always reads the channel the previous one left.
 */
export class TvSwitch {
  constructor(
    config,
    { fetchImpl = (...args) => globalThis.fetch(...args), now = () => Date.now(), settleMs = CONFIRM_SETTLE_MS, attempts = CONFIRM_ATTEMPTS } = {}
  ) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.settleMs = settleMs;
    this.attempts = attempts;
    // The last successful switch and when it happened: a readback that still
    // shows the previous channel right after it is Home Assistant lagging.
    this.recentSwitch = null;
    this.queue = Promise.resolve();
    // The channel this daemon switched to last (null: off). Only a fallback
    // for cycling when no Home Assistant readback is configured.
    this.lastKnown = undefined;
  }

  /** The webhook URL of an action, or null when it is not configured (or unusable). */
  webhookUrl(action) {
    const value = this.config.webhooks?.[action];
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return /^https?:\/\/[^/\s]+\/\S/i.test(value) ? value : null;
    if (!this.config.base_url) return null;
    return `${this.config.base_url}/api/webhook/${encodeURIComponent(value)}`;
  }

  isConfigured(action) {
    return this.webhookUrl(action) !== null;
  }

  /** Whether a `/tv` control has what it needs configured (any one of the targets for next/prev). */
  canRun(action) {
    if (action === 'next' || action === 'prev') return TV_SWITCH_TARGETS.some((key) => this.isConfigured(key));
    if (action === 'volume_up' || action === 'volume_down') {
      // The absolute `volume` webhook needs the level readback; without it only the step webhooks work.
      return this.isConfigured(action) || (this.isConfigured('volume') && Boolean(this.config.volume?.entity_id) && this.hasReadback());
    }
    return this.isConfigured(action);
  }

  /** True when the current channel can be read back from Home Assistant. */
  hasReadback() {
    const { state, base_url: base } = this.config;
    return Boolean(state?.entity_id && state.token && base);
  }

  /** Runs `task` after everything queued before it, whatever happened to that. */
  serialize(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  async request(url, init) {
    try {
      return { res: await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.config.timeout_seconds * 1000) }) };
    } catch (err) {
      return { error: err?.name === 'TimeoutError' ? 'timeout' : 'request failed' };
    }
  }

  /**
   * The channel Home Assistant says is on: `{ ok: true, channel }` with
   * `channel` null for anything that is not a channel (the brb scene, off), or
   * `{ ok: false, error }` when the state cannot be read or is not usable.
   */
  async readEntity(entityId) {
    const { state } = this.config;
    const { res, error } = await this.request(
      `${this.config.base_url}/api/states/${encodeURIComponent(entityId)}`,
      { headers: { Authorization: `Bearer ${state.token}` } }
    );
    if (error) return { ok: false, error };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    try {
      return { ok: true, body: (await res.json()) ?? {} };
    } catch {
      return { ok: false, error: 'bad response' };
    }
  }

  async readChannel() {
    if (!this.hasReadback()) return { ok: false, error: 'not configured' };
    const { state } = this.config;
    const read = await this.readEntity(state.entity_id);
    if (!read.ok) return read;
    const raw = state.attribute ? read.body.attributes?.[state.attribute] : read.body.state;
    const value = str(typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '').toLowerCase();
    if (!value || value === 'unavailable' || value === 'unknown') return { ok: false, error: 'state unavailable' };
    const channel = TV_SWITCH_TARGETS.find((key) => state.map[key].includes(value));
    if (channel) return { ok: true, channel };
    if (state.map.off.includes(value)) return { ok: true, channel: null };
    return { ok: false, error: 'unrecognized state' };
  }

  async post(action, extra = {}) {
    const url = this.webhookUrl(action);
    if (!url) return { ok: false, error: 'not configured' };
    const payload = action === 'off' ? { action, scene: this.config.off_scene } : { action, ...extra };
    const { res, error } = await this.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (error) return { ok: false, error };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    if (TV_SWITCH_ACTIONS.includes(action)) {
      this.lastKnown = action === 'off' ? null : action;
      this.recentSwitch = { channel: this.lastKnown, at: this.now() };
    }
    return { ok: true };
  }

  /**
   * Whether the readback of the scene shows `target` (a channel key, or `'off'`)
   * after a switch that the webhook accepted: `true` only when it does. A
   * webhook only says the request was queued, so the scene is read again a few
   * times (Home Assistant lags a little). No readback, a failing or unrecognized
   * one, or another scene all give `false`, which the reply words as "requested":
   * never as a failure, since the switch may well have worked. It does not use
   * the "recent switch" memory, which would only confirm the daemon to itself.
   */
  async confirm(target) {
    if (!this.hasReadback()) return false;
    const wanted = target === 'off' ? null : target;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      if (this.settleMs > 0) await new Promise((resolve) => setTimeout(resolve, this.settleMs));
      const read = await this.readChannel();
      if (read.ok && read.channel === wanted) return true;
    }
    return false;
  }

  /** `{ ok: true }` or `{ ok: false, error }` with a short error that is safe to show. */
  switchTo(action) {
    return this.serialize(() => this.post(action));
  }

  /**
   * `/tv next` and `/tv prev`: ard -> zdf -> tagesschau -> ard (reversed for
   * prev). From off (the configured off values, by default the brb scene) next is
   * the first channel (ARD) and prev the last (Tagesschau); any other value is
   * unknown and stops the command. Targets without a webhook
   * are skipped. The channel is read back from Home Assistant when that is
   * configured; a failing or unrecognized readback stops the command rather than guessing,
   * as does a missing readback (unless `state.trust_last_switch` is set, and then only
   * after this process switched once),
   * and a failing switch never counts as an advance.
   *
   * Resolves to `{ ok: true, target, from }` or `{ ok: false, error }`.
   */
  cycle(direction) {
    return this.serialize(async () => {
      const step = direction === 'prev' ? -1 : 1;
      const order = TV_SWITCH_TARGETS;
      if (!order.some((key) => this.isConfigured(key))) return { ok: false, error: 'not configured' };

      let from;
      if (this.hasReadback()) {
        const read = await this.readChannel();
        if (!read.ok) return { ok: false, error: `could not read the current channel (${read.error})` };
        from = read.channel;
        // Home Assistant can lag a switch that just succeeded; trust that switch for a few seconds.
        const recent = this.recentSwitch;
        if (recent && this.now() - recent.at < RECENT_SWITCH_MS && recent.channel !== from) from = recent.channel;
      } else {
        // No reliable truth: fail closed instead of guessing (after a restart nothing is known).
        if (!this.config.state.trust_last_switch) {
          return { ok: false, error: 'the current channel is unknown (no readback configured), pick one with /tv ard|zdf|tagesschau' };
        }
        if (this.lastKnown === undefined) {
          return { ok: false, error: 'the current channel is unknown since the restart, pick one with /tv ard|zdf|tagesschau' };
        }
        from = this.lastKnown;
      }

      // Off sits "between" the last and the first channel.
      let index = from ? order.indexOf(from) : step > 0 ? -1 : order.length;
      let target = null;
      for (let i = 0; i < order.length && !target; i++) {
        index = (index + step + order.length) % order.length;
        if (this.isConfigured(order[index])) target = order[index];
      }
      const result = await this.post(target);
      return result.ok ? { ok: true, target, from } : result;
    });
  }

  /**
   * The channel to act on for an audio control, or a refusal. The OBS helper
   * only acts while an ARD/ZDF/Tagesschau scene is on air and silently does
   * nothing otherwise, so the scene is read first and the control fails closed:
   * off (the brb scene) is a no-op (`noop: true`, nothing is posted), an
   * unreadable, unknown or unconfigured scene is an error.
   */
  async audioGate() {
    if (!this.hasReadback()) {
      return { ok: false, error: 'the TV scene cannot be checked (no state readback configured), so nothing was sent' };
    }
    const read = await this.readChannel();
    if (!read.ok) return { ok: false, error: `could not read the current channel (${read.error}), so nothing was sent` };
    let channel = read.channel;
    // Home Assistant can lag a switch that just succeeded; trust that switch for a few seconds.
    const recent = this.recentSwitch;
    if (recent && this.now() - recent.at < RECENT_SWITCH_MS && recent.channel !== channel) channel = recent.channel;
    if (!channel) return { ok: false, noop: true, error: 'the TV is off (brb scene), so there is nothing to change' };
    return { ok: true, channel };
  }

  /**
   * `/tv mute`: mute on, never a toggle, so repeating it is harmless. Only
   * while a channel scene is on air. `{ ok: true, requested: true, channel }`
   * means the webhook was accepted, not that the source got muted.
   */
  mute() {
    return this.serialize(async () => {
      const gate = await this.audioGate();
      if (!gate.ok) return gate;
      const result = await this.post('mute', { muted: true });
      return result.ok ? { ok: true, requested: true, channel: gate.channel } : result;
    });
  }

  /**
   * `/tv unmute`: mute off, explicit like `mute` (`muted: false`), never a
   * toggle, so repeating it is harmless. The same scene gate as `mute`.
   */
  unmute() {
    return this.serialize(async () => {
      const gate = await this.audioGate();
      if (!gate.ok) return gate;
      const result = await this.post('unmute', { muted: false });
      return result.ok ? { ok: true, requested: true, channel: gate.channel } : result;
    });
  }

  /**
   * `/tv vol up|down`: one bounded step. With a volume entity configured the
   * level is read, moved by one step, clamped to 0..1 and set absolutely (the
   * `volume` webhook), which keeps repeated steps exact; without it the
   * receiver gets `volume_up`/`volume_down` with the step and does the maths.
   * `up` also unmutes the source (the helper does it after the step, also at
   * the top of the range; with the absolute `volume` webhook the daemon posts
   * the `unmute` webhook after the level, when that one is configured), `down`
   * never does. Like `mute` it only runs while a channel scene is on air
   * (`audioGate`).
   */
  volumeStep(direction) {
    return this.serialize(async () => {
      const action = direction === 'down' ? 'volume_down' : 'volume_up';
      const gate = await this.audioGate();
      if (!gate.ok) return gate;
      const { step, entity_id: entity } = this.config.volume;
      if (!(entity && this.hasReadback() && this.isConfigured('volume'))) {
        const sent = await this.post(action, { step });
        return sent.ok ? { ok: true, requested: true, channel: gate.channel } : sent;
      }
      const read = await this.readEntity(entity);
      if (!read.ok) return { ok: false, error: `could not read the volume (${read.error})` };
      const level = Number(read.body.attributes?.volume_level);
      if (!Number.isFinite(level)) return { ok: false, error: 'could not read the volume (state unavailable)' };
      const next = Math.min(1, Math.max(0, Math.round((level + (action === 'volume_up' ? step : -step)) * 1000) / 1000));
      const result = await this.post('volume', { level: next });
      if (!result.ok) return result;
      if (action === 'volume_up' && this.isConfigured('unmute')) {
        const unmuted = await this.post('unmute', { muted: false });
        if (!unmuted.ok) return { ok: false, error: `the volume was requested, but the unmute failed (${unmuted.error})` };
      }
      return { ok: true, requested: true, channel: gate.channel, level: next };
    });
  }
}
