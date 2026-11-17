// Lifecycle announcements (startup and shutdown / "last will") of the daemon.
//
// Both go to the admin chat. A lifecycle message is described once, as plain
// data (`{ kind, facts, notice }`), and rendered two ways:
//
// - `lifecycleMarkdown()` is the regular message, byte for byte what the
//   daemon has always sent. It is the whole message without
//   `teams.rich_messages` and the fallback text next to the card with it.
// - `buildLifecycleCard()` is the dedicated Adaptive Card of the optional rich
//   messages: green for the start, red for the last will. It is a layout of its
//   own (status icon, colored heading with the status word under it, fact
//   grid), not the generic markdown wrapper of the command replies.
//
// The color never carries the meaning alone. Container `style` (`good` and
// `attention`) is a 1.2+ feature that some hosts ignore, so the heading text is
// colored explicitly (`Good` / `Attention`), the status icon is an emoji and
// the status line has a word ("ONLINE", "STOPPED").
//
// Each fact row has a small icon in front of its label (the real logo for a
// service, a neutral gray glyph for the rest), so the grid reads at a glance.
// The icon never carries the meaning alone: the label and the value are always
// there. A fact without a known icon keeps an empty slot, so the labels stay
// aligned.
//
// This module only depends on the card constants, so it stays independent of
// the entity builders in cards.mjs.

import { ADAPTIVE_CARD_SCHEMA, ADAPTIVE_CARD_VERSION } from './cards.mjs';
import { SERVICE_ICONS } from './card-icons.mjs';
import { LIFECYCLE_ICONS, LIFECYCLE_ICONS_PX } from './lifecycle-icons.mjs';

export const LIFECYCLE_KINDS = Object.freeze({
  startup: Object.freeze({
    icon: '\u{1F7E2}',
    title: 'teams-live started',
    pill: 'ONLINE',
    style: 'good',
    color: 'Good',
  }),
  shutdown: Object.freeze({
    icon: '\u{1F6D1}',
    title: 'teams-live shutting down',
    pill: 'STOPPED',
    style: 'attention',
    color: 'Attention',
  }),
});

const str = (value) => (value === undefined || value === null ? '' : String(value).trim());

function kindOf(kind) {
  const spec = LIFECYCLE_KINDS[kind];
  if (!spec) throw new Error(`unknown lifecycle kind: ${kind}`);
  return spec;
}

/**
 * The regular markdown message. `facts` are `[label, value]` pairs; a value may
 * carry markdown (code spans). `notice` is an optional warning block:
 * `{ title, facts, body, command }`.
 */
export function lifecycleMarkdown({ kind, facts = [], notice = null }) {
  const spec = kindOf(kind);
  let msg = `${spec.icon} **${spec.title}**\n\n${facts.map(([label, value]) => `- **${label}**: ${value}`).join('\n')}`;
  if (notice) {
    msg += `\n\n⚠️ **${notice.title}**`;
    for (const [label, value] of notice.facts || []) msg += `\n- **${label}**: ${value}`;
    if (notice.body) msg += `\n- ${notice.body}`;
    if (notice.command) msg += `\n  \`${notice.command}\``;
  }
  return msg;
}

/** Card text: code spans shown as plain text, and what a TextBlock would read as markdown escaped. */
function cardText(value) {
  return str(value)
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/([\\*_[\]])/g, '\\$1');
}

function textBlock(text, extra = {}) {
  return { type: 'TextBlock', text, wrap: true, ...extra };
}

function factSet(facts) {
  const entries = facts
    .map(([title, value]) => ({ title: cardText(title), value: cardText(value) }))
    .filter((f) => f.title && f.value);
  return entries.length > 0 ? { type: 'FactSet', facts: entries, spacing: 'Medium' } : null;
}

const px = `${LIFECYCLE_ICONS_PX}px`;

/** The icon of a fact label: a service logo or a glyph of lifecycle-icons.mjs; null for an unknown label. */
const FACT_ICONS = Object.freeze({
  Host: LIFECYCLE_ICONS.host,
  PID: LIFECYCLE_ICONS.pid,
  Runtime: LIFECYCLE_ICONS.node,
  Memory: LIFECYCLE_ICONS.memory,
  Started: LIFECYCLE_ICONS.started,
  'Watched Conversations': LIFECYCLE_ICONS.conversations,
  GitLab: { alt: 'GitLab', url: SERVICE_ICONS.gitlab },
  Jira: { alt: 'Jira', url: SERVICE_ICONS.jira },
  'Home Assistant (HR works)': LIFECYCLE_ICONS.homeassistant,
  'Precompute Cache': LIFECYCLE_ICONS.cache,
  Signal: LIFECYCLE_ICONS.signal,
  Uptime: LIFECYCLE_ICONS.uptime,
  Time: LIFECYCLE_ICONS.time,
});

/**
 * Shorter labels for the card only: the regular (plain) message keeps the full
 * label the watcher sends, so the plain text is unchanged. Icons are looked up
 * by the full label.
 */
const CARD_LABELS = Object.freeze({
  'Watched Conversations': 'Chats',
  'Home Assistant (HR works)': 'HA', // the logo names the brand; the alt text says Home Assistant
  'Precompute Cache': 'Cache',
});

// Fixed label column: wide enough for the longest card label ("Runtime", "Started",
// "Memory": about 54px in bold, with room to spare) so every short fact is one line
// and the value gets the rest of a 308px phone card. An unknown long label wraps at
// its words. (130px starved the values, 104px to 112px were sized for "Home Assistant".)
const LABEL_COLUMN = '76px';

/**
 * One fact as a row of three columns: a fixed 16px icon slot, a fixed-width bold
 * label and the value, which takes the rest and wraps. The icon is top-aligned
 * so it stays beside the first line of a label that wraps.
 */
function factRow({ label, value, icon }) {
  return {
    type: 'ColumnSet',
    spacing: 'Small',
    columns: [
      {
        type: 'Column',
        width: px,
        items: icon ? [{ type: 'Image', url: icon.url, altText: icon.alt, width: px, height: px }] : [],
      },
      { type: 'Column', width: LABEL_COLUMN, items: [textBlock(label, { weight: 'Bolder', spacing: 'None' })] },
      { type: 'Column', width: 'stretch', items: [textBlock(value, { spacing: 'None' })] },
    ],
  };
}

/** The fact grid of the card body: one icon row per fact, as one container so the grid keeps its spacing. */
function factGrid(facts) {
  const rows = facts
    .map(([label, value]) => ({
      label: cardText(CARD_LABELS[str(label)] ?? label),
      value: cardText(value),
      icon: FACT_ICONS[str(label)],
    }))
    .filter((f) => f.label && f.value)
    .map(factRow);
  return rows.length > 0 ? { type: 'Container', spacing: 'Medium', items: rows } : null;
}

/**
 * Icon beside the heading, with the status word as a compact second line under
 * it. Two columns only (auto icon, stretch text): a third column for the
 * status squeezed the title to about 95px at 308px, which wrapped it to four
 * lines on a phone.
 */
function headerRow(spec) {
  return {
    type: 'ColumnSet',
    columns: [
      {
        type: 'Column',
        width: 'auto',
        verticalContentAlignment: 'Center',
        items: [textBlock(spec.icon, { size: 'ExtraLarge', spacing: 'None' })],
      },
      {
        type: 'Column',
        width: 'stretch',
        verticalContentAlignment: 'Center',
        items: [
          textBlock(spec.title, { size: 'Large', weight: 'Bolder', color: spec.color, spacing: 'None' }),
          textBlock(spec.pill, { size: 'Small', weight: 'Bolder', color: spec.color, spacing: 'None' }),
        ],
      },
    ],
  };
}

/** Escapes what a TextBlock would read as markdown, for verbatim (code) text; a code span has no escapes of its own. */
const verbatim = (value) => str(value).replace(/([\\*_[\]`])/g, '\\$1');

/**
 * Code-like inset for a path or a command: a subtle `emphasis` container with a
 * little padding around monospace text. Cards do not render backtick code
 * spans, so this is a real container. The text wraps instead of overflowing a
 * narrow card and stays plain text, so it can be selected and copied as is.
 */
function codeInset(text) {
  return {
    type: 'Container',
    style: 'emphasis',
    bleed: false,
    spacing: 'Small',
    items: [textBlock(verbatim(text), { size: 'Small', fontType: 'Monospace', spacing: 'None' })],
  };
}

const CODE_SPAN = /^`([^`\n]+)`$/;

/** A notice fact: a small bold label, then its value; a value that is one code span becomes a code inset. */
function noticeFact([label, value]) {
  const title = cardText(label);
  const code = CODE_SPAN.exec(str(value));
  const body = code ? codeInset(code[1]) : textBlock(cardText(value), { spacing: 'None' });
  return title && str(value)
    ? [textBlock(title, { size: 'Small', weight: 'Bolder', spacing: 'Small' }), body]
    : [];
}

/** The warning block (for example an active token override), in its own warning container. */
function noticeContainer(notice) {
  const items = [
    textBlock(`⚠️ ${cardText(notice.title)}`, { weight: 'Bolder', color: 'Warning', spacing: 'None' }),
    ...(notice.facts || []).flatMap(noticeFact),
    notice.body ? textBlock(cardText(notice.body), { size: 'Small', spacing: 'Small' }) : null,
    notice.command ? codeInset(notice.command) : null,
  ].filter(Boolean);
  return { type: 'Container', style: 'warning', bleed: false, spacing: 'Medium', items };
}

/**
 * The Adaptive Card of a lifecycle message: a container styled `good` (start)
 * or `attention` (last will) holding the header row, the fact grid with every
 * fact of the regular message and, when given, the warning block.
 */
export function buildLifecycleCard({ kind, facts = [], notice = null, fallbackText } = {}) {
  const spec = kindOf(kind);
  const items = [headerRow(spec), factGrid(facts), notice ? noticeContainer(notice) : null].filter(Boolean);
  const card = {
    $schema: ADAPTIVE_CARD_SCHEMA,
    type: 'AdaptiveCard',
    version: ADAPTIVE_CARD_VERSION,
    msteams: { width: 'Full' },
    body: [{ type: 'Container', style: spec.style, bleed: false, items }],
  };
  if (fallbackText) card.fallbackText = str(fallbackText);
  return card;
}
