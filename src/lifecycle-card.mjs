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
//   own (status icon, colored heading, status pill, fact grid), not the
//   generic markdown wrapper of the command replies.
//
// The color never carries the meaning alone. Container `style` (`good` and
// `attention`) is a 1.2+ feature that some hosts ignore, so the heading text is
// colored explicitly (`Good` / `Attention`), the status icon is an emoji and
// the pill has a word ("ONLINE", "STOPPED").
//
// This module only depends on the card constants, so it stays independent of
// the entity builders in cards.mjs.

import { ADAPTIVE_CARD_SCHEMA, ADAPTIVE_CARD_VERSION } from './cards.mjs';

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

/** Icon, colored heading and the status pill, side by side. */
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
        items: [textBlock(spec.title, { size: 'Large', weight: 'Bolder', color: spec.color, spacing: 'None' })],
      },
      {
        type: 'Column',
        width: 'auto',
        verticalContentAlignment: 'Center',
        style: spec.style,
        bleed: false,
        items: [textBlock(spec.pill, { size: 'Small', weight: 'Bolder', color: spec.color, spacing: 'None' })],
      },
    ],
  };
}

/** The warning block (for example an active token override), in its own warning container. */
function noticeContainer(notice) {
  const items = [
    textBlock(`⚠️ ${cardText(notice.title)}`, { weight: 'Bolder', color: 'Warning', spacing: 'None' }),
    factSet(notice.facts || []),
    notice.body ? textBlock(cardText(notice.body), { size: 'Small', spacing: 'Small' }) : null,
    notice.command
      ? textBlock(cardText(notice.command), { size: 'Small', fontType: 'Monospace', spacing: 'None' })
      : null,
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
  const items = [headerRow(spec), factSet(facts), notice ? noticeContainer(notice) : null].filter(Boolean);
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
