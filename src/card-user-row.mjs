/**
 * Adaptive Card row for people: a small round profile picture next to each
 * name. Pure data in, card JSON out; the pictures come from `avatars.mjs`
 * (prefetched, so card building stays synchronous).
 *
 * Without a usable picture a person is shown by name only, and when nobody in
 * a row has one `userRow` returns null so the caller keeps its plain text
 * layout unchanged.
 */

import { PLACEHOLDER_AVATAR } from './placeholder-avatar.mjs';

export const AVATAR_PX = 18;
// Total size of the embedded pictures per card (characters of the data URIs).
// Cards are limited on the wire (MAX_CARD_BYTES), so extra pictures are dropped
// in favour of names before the card could outgrow it: a full MR card is already
// about 17 KB without photos and a real 32px photo costs about 3 KB.
export const MAX_AVATAR_CHARS_PER_CARD = 6500;
export const MAX_AVATARS_PER_ROW = 3;

/** Cards only ever embed a plain base64 JPEG/PNG data URI, never a remote URL. */
export function isImageDataUri(value) {
  return typeof value === 'string' && /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

const text = (value) => (value === undefined || value === null ? '' : String(value).trim());

function textColumn(content, extra = {}, width = 'auto') {
  return {
    type: 'Column',
    width,
    verticalContentAlignment: 'Center',
    items: [{ type: 'TextBlock', text: content, wrap: true, ...extra }],
  };
}

export function avatarColumn(name, dataUri, width = 'auto') {
  return {
    type: 'Column',
    width,
    verticalContentAlignment: 'Center',
    items: [{ type: 'Image', url: dataUri, altText: name, style: 'Person', width: `${AVATAR_PX}px`, height: `${AVATAR_PX}px` }],
  };
}

/**
 * Names worth a picture on a card, in display order: the assignee, the owner,
 * the merge request author, the approvers and the auto-merge user, without "Unassigned" placeholders and
 * duplicates. Reads the same fields the card builders do.
 */
export function collectCardPeople(data) {
  const names = [data?.assignee, data?.owner, data?.author, ...(Array.isArray(data?.approvedBy) ? data.approvedBy : []), data?.autoMergeUser]
    .map(text)
    .filter((n) => n && n.toLowerCase() !== 'unassigned');
  return [...new Set(names)];
}

// Keeps a name aligned with its neighbours' names when it has no picture itself.
function pictureSpacer() {
  return {
    type: 'Column',
    width: `${AVATAR_PX}px`,
    verticalContentAlignment: 'Center',
    items: [{ type: 'TextBlock', text: '\u00A0', wrap: false }],
  };
}

// The widest a pill may be: the value column of a 308px card is about 190px and
// the label column eats the rest, so a wider image would run into the card padding.
export const MAX_PILL_PX = 132;

/** The pixel size of a pill image, scaled down (keeping its proportions) to MAX_PILL_PX. */
export function pillSize({ width, height }) {
  if (!(width > MAX_PILL_PX)) return { width, height };
  return { width: MAX_PILL_PX, height: Math.round((height * MAX_PILL_PX) / width) };
}

/** A status pill image (an embedded data URI, never a remote URL). */
export function pillImage(pill) {
  const { width, height } = pillSize(pill);
  return { type: 'Image', url: pill.url, altText: text(pill.alt), width: `${width}px`, height: `${height}px`, horizontalAlignment: 'Left' };
}

const usablePill = (pill) =>
  pill && isImageDataUri(pill.url) && Number.isFinite(pill.width) && pill.width > 0 && Number.isFinite(pill.height) && pill.height > 0;

/**
 * @param {string} label  row label (bold)
 * @param {Array<{name: string, avatar?: string}>} people
 * @param {object} [opts]
 * @param {string} [opts.headline]  a short lead such as "👍 By" or "🔀 Enabled by", written in front of the first name (same wrapping text, no line of its own)
 * @param {{url: string, alt?: string, width: number, height: number}} [opts.pill]  a status pill image, the first item of the flowing value
 * @param {number} [opts.charBudget]  remaining picture budget for this card
 * @param {string} [opts.labelWidth]  fixed label column width, so the label lines up with the other fact rows
 * @returns {{row: object, usedChars: number}|null}
 *
 * Layout: the label column, then ONE stretch value column (so the value starts
 * where every other fact row's value starts). With a pill or several people the
 * value column holds one Layout.Flow container (Adaptive Cards 1.5, which
 * makeRichMessage then declares): [pill] [picture name] [picture name] ... flowing
 * left to right and wrapping to the next line only when the card is too narrow.
 * Each person is a small auto-width [picture][name] pair that wraps its own name
 * at word boundaries, so no name is ever cut off and the label, the pictures and
 * the pill never shrink. The normal case, one person without a pill, stays one
 * compact line, the lead being part of the name's own text ("👍 By Alice Example").
 * There is no fixed text column beside the names: it would eat the width they need.
 */
export function userRow(label, people, { headline = '', pill = null, charBudget = MAX_AVATAR_CHARS_PER_CARD, maxAvatars = MAX_AVATARS_PER_ROW, labelWidth = 'auto' } = {}) {
  let remaining = charBudget;
  let shown = 0;
  let used = 0;
  const entries = [];
  for (const person of people || []) {
    const name = text(person?.name);
    if (!name) continue;
    entries.push({ name, avatar: null, candidate: isImageDataUri(person.avatar) ? person.avatar : null });
  }
  // Real pictures take the room first (row order); the neutral placeholder
  // (a few hundred characters) only takes what is left of the caps.
  for (const real of [true, false]) {
    for (const entry of entries) {
      if (!entry.candidate || entry.avatar || (entry.candidate !== PLACEHOLDER_AVATAR) !== real) continue;
      if (shown < maxAvatars && entry.candidate.length <= remaining) {
        remaining -= entry.candidate.length;
        used += entry.candidate.length;
        shown += 1;
        entry.avatar = entry.candidate;
      }
    }
  }
  // A person whose real picture did not fit the budget gets the neutral
  // placeholder instead (a few hundred characters), so the people of a row that
  // shows pictures are never a mix of pictures and bare names.
  if (shown > 0) {
    for (const entry of entries) {
      if (!entry.candidate || entry.avatar) continue;
      if (shown < maxAvatars && PLACEHOLDER_AVATAR.length <= remaining) {
        remaining -= PLACEHOLDER_AVATAR.length;
        used += PLACEHOLDER_AVATAR.length;
        shown += 1;
        entry.avatar = PLACEHOLDER_AVATAR;
      }
    }
  }
  if (shown === 0) return null;
  const lead = text(headline);
  const hasPill = usablePill(pill);
  const labelColumn = textColumn(text(label), { weight: 'Bolder' }, labelWidth);
  let valueItems;
  if (hasPill || entries.length > 1) {
    // Pill and people flow left to right and wrap only when the card is too
    // narrow (Layout.Flow, Adaptive Cards 1.5: Teams honours it; an older
    // renderer ignores it and stacks the same items, which is still readable).
    // Each person stays together: [picture] [name], the name wraps in its own column.
    const people = entries.map(({ name, avatar }, index) => {
      const columns = [];
      if (avatar) columns.push(avatarColumn(name, avatar, 'auto'));
      columns.push(textColumn(index === 0 && lead ? `${lead} ${name}` : name, {}, 'auto'));
      return { type: 'ColumnSet', columns };
    });
    valueItems = [
      {
        type: 'Container',
        layouts: [{ type: 'Layout.Flow', horizontalItemsAlignment: 'Left', verticalItemsAlignment: 'Center', columnSpacing: 'Medium', rowSpacing: 'Small' }],
        items: hasPill ? [pillImage(pill), ...people] : people,
      },
    ];
  } else {
    // One person, no pill: one compact line, only the name stretches.
    const { name, avatar } = entries[0];
    const columns = [avatar ? avatarColumn(name, avatar, `${AVATAR_PX}px`) : pictureSpacer(), textColumn(lead ? `${lead} ${name}` : name, {}, 'stretch')];
    valueItems = [{ type: 'ColumnSet', columns }];
  }
  // With the pill and people stacked or wrapped, the label stays with the first line.
  if (hasPill || entries.length > 1) labelColumn.verticalContentAlignment = 'Top';
  const valueColumn = { type: 'Column', width: 'stretch', items: valueItems };
  return { row: { type: 'ColumnSet', spacing: 'Small', columns: [labelColumn, valueColumn] }, usedChars: used };
}
