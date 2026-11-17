/**
 * `/tv`: what is on ARD and ZDF right now (and next), and, for the owner, a
 * switch of the OBS input through a Home Assistant webhook.
 *
 * Everything that differs between installations is runtime configuration
 * (see `normalizeTvConfig`): the programme sources, the time zone, the Home
 * Assistant base URL and the webhook ids. Nothing in here names a host or an id.
 */

import zlib from 'node:zlib';
import { ADAPTIVE_CARD_SCHEMA, ADAPTIVE_CARD_VERSION } from './cards.mjs';

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
export function normalizeTvConfig(raw = {}) {
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
    channels,
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
    out.push({ start, end, title, subtitle: xmlField(m[2], 'sub-title'), description: xmlField(m[2], 'desc') });
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
        programmes = await loadProgrammes(source, { fetchImpl: this.fetchImpl, now, timeZone: this.config.timezone });
        this.cache.set(key, { at: now.getTime(), programmes });
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

  /** `{ now, timezone, channels: [{ key, name, current, next, error }] }`; one channel failing does not hide the other. */
  async getProgramme(opts = {}) {
    const now = this.now();
    const channels = await Promise.all(TV_CHANNEL_KEYS.map((key) => this.channelData(key, opts)));
    return { now, timezone: this.config.timezone, channels };
  }
}

// ---------------------------------------------------------------- formatting

function clock(date, timeZone) {
  return new Intl.DateTimeFormat('de-DE', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

/** Escapes what would be read as markdown or HTML in text from a programme source. */
function plain(text) {
  return str(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]).replace(/([\\`*_[\]])/g, '\\$1');
}

function progressPercent(programme, now) {
  const total = programme.end - programme.start;
  if (!(total > 0)) return null;
  return Math.max(0, Math.min(100, Math.round(((now - programme.start) / total) * 100)));
}

function programmeLine(programme, timeZone) {
  return `${clock(programme.start, timeZone)}–${clock(programme.end, timeZone)}`;
}

/** Regular (markdown) reply of `/tv program`. */
export function formatProgrammeText({ now, timezone, channels }) {
  const lines = [`\u{1F4FA} **TV programme** (${clock(now, timezone)})`, ''];
  for (const ch of channels) {
    lines.push(`**${plain(ch.name)}**`);
    if (ch.error) {
      lines.push(`- ⚠️ ${plain(ch.error)}`);
    } else {
      if (ch.current) {
        const pct = progressPercent(ch.current, now);
        const sub = ch.current.subtitle ? ` — ${plain(ch.current.subtitle)}` : '';
        lines.push(`- Now: **${plain(ch.current.title)}** (${programmeLine(ch.current, timezone)}${pct === null ? '' : `, ${pct}%`})${sub}`);
      }
      if (ch.next) {
        lines.push(`- Next: ${clock(ch.next.start, timezone)} **${plain(ch.next.title)}**`);
      }
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

const tb = (text, extra = {}) => ({ type: 'TextBlock', text, wrap: true, ...extra });

/** Progress as a text bar (colour independent), e.g. `▰▰▰▱▱`. */
function progressBar(pct, width = 10) {
  const filled = Math.round((pct / 100) * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

function programmeRow(label, programme, timeZone, { now = null } = {}) {
  const pct = now ? progressPercent(programme, now) : null;
  const rows = [
    {
      type: 'ColumnSet',
      spacing: 'Small',
      columns: [
        { type: 'Column', width: '64px', items: [tb(label, { weight: 'Bolder', size: 'Small', isSubtle: true })] },
        {
          type: 'Column',
          width: 'stretch',
          items: [
            tb(plain(programme.title), { weight: 'Bolder' }),
            programme.subtitle ? tb(plain(programme.subtitle), { isSubtle: true, size: 'Small', spacing: 'None' }) : null,
            tb(
              `${programmeLine(programme, timeZone)}${pct === null ? '' : `  ${progressBar(pct)} ${pct}%`}`,
              { size: 'Small', spacing: 'None', isSubtle: true }
            ),
          ].filter(Boolean),
        },
      ],
    },
  ];
  return rows;
}

/** Adaptive Card of `/tv program`: one block per channel, running programme first, then the next. */
export function buildProgrammeCard({ now, timezone, channels }) {
  if (!channels || channels.length === 0) return null;
  const items = [
    tb('\u{1F4FA} TV programme', { weight: 'Bolder', size: 'Medium' }),
    tb(`as of ${clock(now, timezone)}`, { isSubtle: true, size: 'Small', spacing: 'None' }),
  ];
  for (const ch of channels) {
    const inner = [tb(plain(ch.name), { weight: 'Bolder', color: 'Accent' })];
    if (ch.error) {
      inner.push(tb(`⚠️ ${plain(ch.error)}`, { color: 'Attention', size: 'Small' }));
    } else {
      if (ch.current) inner.push(...programmeRow('NOW', ch.current, timezone, { now }));
      if (ch.next) inner.push(...programmeRow('NEXT', ch.next, timezone));
    }
    items.push({ type: 'Container', style: 'default', spacing: 'Medium', bleed: false, items: inner });
  }
  return {
    $schema: ADAPTIVE_CARD_SCHEMA,
    type: 'AdaptiveCard',
    version: ADAPTIVE_CARD_VERSION,
    msteams: { width: 'Full' },
    body: [{ type: 'Container', style: 'emphasis', bleed: false, items }],
    fallbackText: formatProgrammeText({ now, timezone, channels }).replace(/\\([\\`*_[\]])/g, '$1'),
  };
}

// ---------------------------------------------------------------- command

const PROGRAMME_ALIASES = new Set(['program', 'programm', 'programme', 'prog']);

/**
 * `/tv` arguments to an action: `programme`, `ard`, `zdf`, `off`, `help` (no
 * argument) or `unknown`.
 */
export function parseTvArgs(args = []) {
  const first = str(args[0]).toLowerCase();
  if (!first) return { action: 'help' };
  if (PROGRAMME_ALIASES.has(first)) return { action: 'programme' };
  if (TV_CHANNEL_KEYS.includes(first)) return { action: first };
  if (first === 'off') return { action: 'off' };
  return { action: 'unknown', arg: first };
}

export const TV_USAGE = 'Usage: `/tv program` (what is on now and next on ARD and ZDF).';
