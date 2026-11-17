// The cards of the `/tv` command, in a module of their own.
//
// - `tvControlReply()` is the reply of a control (`/tv ard|zdf|tagesschau|off`,
//   `next|prev`, `mute`, `unmute`, `vol up|down`) and of its refusals and errors: the
//   regular markdown message and a compact Adaptive Card for the optional rich
//   messages. The card is a layout of its own (channel logo, channel name and
//   the state under it, the programme when known), not the generic markdown
//   wrapper of the command replies.
// - `buildTvProgrammeCard()` is the card of `/tv program`.
//
// The state is worded precisely. A webhook only says that Home Assistant queued
// the request, so a switch is "requested" until the readback of the TV scene
// shows the channel ("confirmed"), and mute and volume stay "requested, not
// verified". The color never carries the meaning alone: the state is always
// a word, and the logos have alt text.
//
// Programme artwork comes only from the EPG sources themselves and only through
// `safeArtworkUrl()`: https, an allowlisted host and path, no credentials, no
// query of the source (a tracking parameter cannot ride along). It is shown by
// URL, never embedded, and a missing picture leaves no empty frame.
//
// This module only depends on the card constants, so it stays independent of
// the entity builders in cards.mjs and of the TV logic in tv.mjs.

import { ADAPTIVE_CARD_SCHEMA, ADAPTIVE_CARD_VERSION, textBlock } from './cards.mjs';
import { TV_LOGOS } from './tv-logos.mjs';

const str = (value) => (value === undefined || value === null ? '' : String(value).trim());

// ---------------------------------------------------------------- text helpers

/** `HH:MM` of an instant in a time zone (the zone of the programme source). */
export function clock(date, timeZone) {
  return new Intl.DateTimeFormat('de-DE', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

/** Escapes what would be read as markdown or HTML in text from a programme source. */
export function plain(text) {
  return str(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]).replace(/([\\`*_[\]])/g, '\\$1');
}

/** Escapes what a card TextBlock reads as markdown (it has no HTML to escape). */
export const cardText = (text) => str(text).replace(/([\\`*_[\]])/g, '\\$1');

export function progressPercent(programme, now) {
  const total = programme.end - programme.start;
  if (!(total > 0)) return null;
  return Math.max(0, Math.min(100, Math.round(((now - programme.start) / total) * 100)));
}

export function programmeLine(programme, timeZone) {
  return `${clock(programme.start, timeZone)}–${clock(programme.end, timeZone)}`;
}

/** Progress as a text bar (colour independent), e.g. `▰▰▰▱▱`. */
export function progressBar(pct, width = 10) {
  const filled = Math.round((pct / 100) * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

// ---------------------------------------------------------------- channels

/** How the channels are named (the controls, the cards). */
export const TV_CHANNEL_LABELS = Object.freeze({ ard: 'ARD', zdf: 'ZDF', tagesschau: 'Tagesschau' });

const OFF_LABEL = 'off (brb)';
const TV = '\u{1F4FA}';

/** The title of an audio control; the reply says "requested" because a webhook cannot prove more. */
export const TV_AUDIO_TITLES = Object.freeze({
  mute: 'Mute requested',
  unmute: 'Unmute requested',
  volume_up: 'Volume increase and unmute requested',
  volume_down: 'Volume decrease requested',
});

// ---------------------------------------------------------------- artwork

/**
 * Pixel width asked of the artwork service. The picture is shown at the full width of the
 * card (about 310 px on a phone, up to a few hundred on a desktop), so 960 px stays sharp
 * at 3x. It is fetched by URL, never embedded: the card itself carries only the short link.
 */
const ARTWORK_WIDTH = 960;
const MAX_ARTWORK_URL = 300;

// The only hosts a programme picture may come from: the picture CDNs of the EPG sources.
// Each rule pins the path shape, and the query is rebuilt from scratch, so a tracking or
// cache parameter of the source (its `ch=` hash, say) is dropped.
const sized = (url) => {
  url.search = '';
  url.searchParams.set('w', String(ARTWORK_WIDTH));
};
const ARTWORK_HOSTS = Object.freeze({
  // ARD programme API: `/images/<day>/<id>_<ts>.jpg?w={width}`.
  'programm-api.ard.de': { path: /^\/images\/[A-Za-z0-9=_-]+\/[0-9a-f]{16,40}_\d{6,16}\.(?:jpe?g|png)$/, build: sized },
  // ARD Mediathek image service: single images and 16:9 collections, both resized by `w`.
  'api.ardmediathek.de': {
    path: /^\/image-service\/(?:images\/urn:ard:image:[0-9a-f]{8,40}|image-collections\/urn:ard:image-collection:[0-9a-f]{8,40}\/16x9)$/,
    build: sized,
  },
  // XMLTV `<icon>` of the community guide (TV Spielfilm pictures, ZDF): fixed size, no query.
  'img.tvspielfilm.de': {
    path: /^\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{16,40}\.(?:jpe?g|png)$/i,
    build: (url) => {
      url.search = '';
    },
  },
});

/**
 * An artwork URL from an EPG source as a safe `https` URL for a card, or null.
 * The host and the path must match the allowlist exactly (no credentials, no
 * port, no other host, no look-alike), the query is rebuilt from scratch. A
 * plain `http` URL of an allowlisted host is upgraded, anything else (other
 * schemes, `data:`, relative URLs) is refused. Nothing is fetched here.
 */
export function safeArtworkUrl(raw) {
  const text = str(raw).replace('{width}', String(ARTWORK_WIDTH));
  if (!text || text.length > MAX_ARTWORK_URL) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.port) return null;
  const rule = Object.hasOwn(ARTWORK_HOSTS, url.hostname) ? ARTWORK_HOSTS[url.hostname] : null;
  if (!rule || !rule.path.test(url.pathname)) return null;
  url.protocol = 'https:';
  url.hash = '';
  rule.build(url);
  return url.href;
}

// ---------------------------------------------------------------- card pieces

const imageOf = (logo) => ({ type: 'Image', url: logo.url, altText: logo.alt, width: `${logo.width}px`, height: `${logo.height}px` });

/** Logo (or a glyph) in front of a heading and the text under it. */
function headerRow({ logo, glyph, title, status, color }) {
  const lead = logo
    ? { type: 'Column', width: 'auto', verticalContentAlignment: 'Center', items: [imageOf(logo)] }
    : { type: 'Column', width: 'auto', verticalContentAlignment: 'Center', items: [textBlock(glyph || '\u{1F4FA}', { size: 'Large', spacing: 'None' })] };
  const text = [textBlock(cardText(title), { size: 'Medium', weight: 'Bolder', spacing: 'None' })];
  if (status) text.push(textBlock(cardText(status), { size: 'Small', weight: 'Bolder', spacing: 'None', ...(color ? { color } : {}) }));
  return {
    type: 'ColumnSet',
    columns: [lead, { type: 'Column', width: 'stretch', verticalContentAlignment: 'Center', items: text }],
  };
}

/** The channel logo as a right-hand column (no heading row: the logo carries the channel name as alt text). */
function logoColumn(logo, name) {
  if (!logo) return { type: 'Column', width: 'auto', verticalContentAlignment: 'Center', items: [textBlock(cardText(name), { size: 'Small', weight: 'Bolder', isSubtle: true, spacing: 'None' })] };
  return { type: 'Column', width: 'auto', verticalContentAlignment: 'Center', items: [{ ...imageOf(logo), horizontalAlignment: 'Right' }] };
}

/** The width of the progress bar in cells: short enough to never wrap or clip on a phone. */
const PROGRESS_CELLS = 8;

/**
 * The running programme, laid out for a phone first. From top to bottom:
 * - the picture at the full width of the card (16:9 as the source delivers it),
 * - an info row: "NOW" with the time on a line of its own, the title and the subtitle on
 *   the left, the channel logo (`trailing`, a Column) at the right edge, so the row doubles
 *   as the channel's heading,
 * - the progress on a line of its own that never wraps (`wrap: false`): a short bar and
 *   the percentage, outside every column so it has the whole width.
 * A programme without a usable picture simply starts at the info row (no empty frame).
 */
function nowRow(programme, { now, timeZone, artwork }, trailing = null) {
  const pct = now ? progressPercent(programme, now) : null;
  const lines = [
    textBlock(`NOW · ${programmeLine(programme, timeZone)}`, { size: 'Small', weight: 'Bolder', isSubtle: true, spacing: 'None', wrap: false }),
    textBlock(cardText(programme.title), { weight: 'Bolder', spacing: 'None' }),
  ];
  if (programme.subtitle) lines.push(textBlock(cardText(programme.subtitle), { size: 'Small', isSubtle: true, spacing: 'None' }));
  const items = [];
  const picture = artwork ? safeArtworkUrl(programme.image) : null;
  if (picture) {
    items.push({
      type: 'Image',
      url: picture,
      altText: programme.title ? `Picture of ${cardText(programme.title)}` : 'Programme picture',
      size: 'Stretch',
      style: 'Default',
    });
  }
  const columns = [{ type: 'Column', width: 'stretch', items: lines }];
  if (trailing) columns.push(trailing);
  items.push({ type: 'ColumnSet', spacing: picture ? 'Small' : 'None', columns });
  if (pct !== null) {
    items.push(textBlock(`${progressBar(pct, PROGRESS_CELLS)} ${pct}%`, { size: 'Small', isSubtle: true, spacing: 'Small', wrap: false }));
  }
  return { type: 'Container', spacing: 'Small', items };
}

/** The next programme: one line, the start time first so the hierarchy reads time, then title. */
function nextRow(programme, { timeZone }) {
  return textBlock(`NEXT · **${clock(programme.start, timeZone)}**  ${cardText(programme.title)}`, {
    size: 'Small',
    isSubtle: true,
    spacing: 'Small',
  });
}

/** `{ current, next }` as card items (empty when there is nothing to say). */
function programmeItems(programme, ctx, trailing = null) {
  if (!programme) return [];
  const items = [];
  if (programme.current) items.push(nowRow(programme.current, ctx, trailing));
  if (programme.next) items.push(nextRow(programme.next, ctx));
  return items;
}

const TONES = Object.freeze({
  neutral: { style: 'emphasis', color: 'Accent' },
  confirmed: { style: 'good', color: 'Good' },
  warning: { style: 'warning', color: 'Warning' },
  error: { style: 'attention', color: 'Attention' },
});

function cardOf(body, fallbackText) {
  const card = {
    $schema: ADAPTIVE_CARD_SCHEMA,
    type: 'AdaptiveCard',
    version: ADAPTIVE_CARD_VERSION,
    msteams: { width: 'Full' },
    body,
  };
  if (fallbackText) card.fallbackText = str(fallbackText);
  return card;
}

const capitalize = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);
const sentence = (text) => {
  const t = capitalize(str(text));
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

// ---------------------------------------------------------------- the programme in a reply

/** The programme lines of a control reply, as markdown (the plain reply and the card's fallback text). */
function programmeMarkdown(programme, { timeZone }) {
  if (!programme) return [];
  const lines = [];
  if (programme.current) lines.push(`- Now: **${plain(programme.current.title)}** (${programmeLine(programme.current, timeZone)})`);
  if (programme.next) lines.push(`- Next: ${clock(programme.next.start, timeZone)} **${plain(programme.next.title)}**`);
  return lines;
}

// ---------------------------------------------------------------- control replies

/**
 * The reply of a `/tv` control as `{ markdown, card }`.
 *
 * `outcome` is one of
 * - `{ type: 'switch', target, state: 'requested' | 'confirmed', programme }`:
 *   `target` is a channel key or `'off'`; `state` is "confirmed" only when the
 *   readback of the scene showed it; `programme` is `{ current, next }`
 *   or null (a channel without a programme source).
 * - `{ type: 'audio', action, channel, level }`: mute or volume, always "requested".
 * - `{ type: 'noop', command, reason }`: the scene gate refused, nothing was sent.
 * - `{ type: 'failed', doing, error }`: the control failed.
 * - `{ type: 'unconfigured', command }`.
 * `ctx` is `{ now, timezone, artwork }`.
 */
export function tvControlReply(outcome, { now = null, timezone = 'Europe/Berlin', artwork = true } = {}) {
  const view = { now, timeZone: timezone, artwork };
  const logoOf = (key) => (Object.hasOwn(TV_LOGOS, key) ? TV_LOGOS[key] : null);
  let spec;
  switch (outcome.type) {
    case 'switch': {
      const off = outcome.target === 'off';
      const label = off ? OFF_LABEL : TV_CHANNEL_LABELS[outcome.target] || str(outcome.target);
      const confirmed = outcome.state === 'confirmed';
      spec = {
        logo: off ? null : logoOf(outcome.target),
        glyph: off ? '\u{1F4F4}' : null,
        title: off ? 'TV off' : label,
        status: off
          ? confirmed ? 'Confirmed off (brb scene)' : 'Off requested'
          : confirmed ? 'Confirmed on air' : 'Switch requested',
        tone: confirmed ? 'confirmed' : 'neutral',
        markdown: off
          ? confirmed ? `${TV} The TV is off (brb scene, confirmed).` : `${TV} Switch to off (brb) requested.`
          : confirmed ? `${TV} Switched to ${label} (confirmed on air).` : `${TV} Switch to ${label} requested.`,
        programme: off ? null : outcome.programme,
      };
      break;
    }
    case 'audio': {
      const title = TV_AUDIO_TITLES[outcome.action];
      const label = TV_CHANNEL_LABELS[outcome.channel] || '';
      const target = Number.isFinite(outcome.level) ? `target ${Math.round(outcome.level * 100)}%` : '';
      spec = {
        logo: logoOf(outcome.channel),
        glyph: outcome.action === 'mute' ? '\u{1F507}' : '\u{1F50A}',
        title,
        status: [label, target, 'accepted, not verified'].filter(Boolean).join(' · '),
        tone: 'neutral',
        markdown: `${TV} ${title}. Home Assistant accepted the request; the result is not verified.`,
      };
      break;
    }
    case 'noop':
      spec = {
        glyph: '⚠️',
        title: `${outcome.command} did nothing`,
        status: sentence(outcome.reason),
        tone: 'warning',
        markdown: `⚠️ \`${outcome.command}\` did nothing: ${str(outcome.reason).replace(/[.]$/, '')}.`,
      };
      break;
    case 'failed':
      spec = {
        glyph: '❌',
        title: `${outcome.doing} failed`,
        status: capitalize(str(outcome.error)),
        tone: 'error',
        markdown: `❌ ${outcome.doing} failed: ${outcome.error}`,
      };
      break;
    case 'unconfigured':
      spec = {
        glyph: '⚠️',
        title: `${outcome.command} is not configured`,
        status: 'Set tv.switch on this daemon',
        tone: 'warning',
        markdown: `⚠️ \`${outcome.command}\` is not configured on this daemon (\`tv.switch\`).`,
      };
      break;
    default:
      throw new Error(`unknown /tv outcome: ${outcome.type}`);
  }

  const lines = programmeMarkdown(spec.programme, view);
  const markdown = lines.length ? `${spec.markdown}\n\n${lines.join('\n')}` : spec.markdown;
  const tone = TONES[spec.tone];
  const items = [headerRow({ logo: spec.logo, glyph: spec.glyph, title: spec.title, status: spec.status, color: tone.color })];
  const programme = programmeItems(spec.programme, view);
  if (programme.length > 0) items.push({ type: 'Container', spacing: 'Small', separator: true, items: programme });
  return { markdown, card: cardOf([{ type: 'Container', style: tone.style, bleed: false, items }], markdown.replace(/\\([\\`*_[\]])/g, '$1')) };
}

// ---------------------------------------------------------------- /tv program

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

/**
 * Adaptive Card of `/tv program`: one block per channel with no heading row of its
 * own. The running programme (its picture at the full card width when the source has
 * one, then "NOW" with the time, title and subtitle and the channel logo at the right
 * edge, then the progress on a line of its own) comes first, then the next programme. A channel whose source failed, or that
 * has nothing on now, says so in a row that carries the logo the same way.
 */
export function buildTvProgrammeCard({ now, timezone, channels }, { artwork = true } = {}) {
  if (!channels || channels.length === 0) return null;
  const view = { now, timeZone: timezone, artwork };
  const items = [textBlock(`On now and next · ${clock(now, timezone)}`, { size: 'Small', weight: 'Bolder', isSubtle: true, spacing: 'None' })];
  channels.forEach((ch) => {
    const logo = logoColumn(Object.hasOwn(TV_LOGOS, ch.key) ? TV_LOGOS[ch.key] : null, ch.name);
    const inner = [];
    if (!ch.error && ch.current) {
      inner.push(...programmeItems({ current: ch.current, next: ch.next }, view, logo));
    } else {
      // No running programme to hang the logo on: the status line takes it.
      const status = ch.error ? `⚠️ ${cardText(ch.name)}: ${cardText(ch.error)}` : `${cardText(ch.name)}: nothing on now`;
      inner.push({
        type: 'ColumnSet',
        spacing: 'Small',
        columns: [
          { type: 'Column', width: 'stretch', verticalContentAlignment: 'Center', items: [textBlock(status, { size: 'Small', spacing: 'None', ...(ch.error ? { color: 'Attention' } : { isSubtle: true }) })] },
          logo,
        ],
      });
      if (!ch.error && ch.next) inner.push(nextRow(ch.next, view));
    }
    items.push({ type: 'Container', spacing: 'Medium', separator: true, items: inner });
  });
  return cardOf(
    [{ type: 'Container', style: 'emphasis', bleed: false, items }],
    formatProgrammeText({ now, timezone, channels }).replace(/\\([\\`*_[\]])/g, '$1')
  );
}
