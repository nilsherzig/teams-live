/**
 * Adaptive Card row for people: a small round profile picture next to each
 * name. Pure data in, card JSON out; the pictures come from `avatars.mjs`
 * (prefetched, so card building stays synchronous).
 *
 * Without a usable picture a person is shown by name only, and when nobody in
 * a row has one `userRow` returns null so the caller keeps its plain text
 * layout unchanged.
 */

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

/** A status pill image at the end of the first line (an embedded data URI, never a remote URL). */
function pillColumn(pill) {
  return {
    type: 'Column',
    width: 'auto',
    verticalContentAlignment: 'Center',
    items: [{ type: 'Image', url: pill.url, altText: text(pill.alt), width: `${pill.width}px`, height: `${pill.height}px` }],
  };
}

const usablePill = (pill) =>
  pill && isImageDataUri(pill.url) && Number.isFinite(pill.width) && pill.width > 0 && Number.isFinite(pill.height) && pill.height > 0;

/**
 * @param {string} label  row label (bold)
 * @param {Array<{name: string, avatar?: string}>} people
 * @param {object} [opts]
 * @param {string} [opts.headline]  a short lead such as "👍 By" or "🔀 Enabled by", written in front of the first name (same wrapping text, no line of its own)
 * @param {{url: string, alt?: string, width: number, height: number}} [opts.pill]  a status pill image at the end of the first line
 * @param {number} [opts.charBudget]  remaining picture budget for this card
 * @param {string} [opts.labelWidth]  fixed label column width, so the label lines up with the other fact rows
 * @returns {{row: object, usedChars: number}|null}
 *
 * Layout: the label column, then ONE stretch value column (so the value starts
 * where every other fact row's value starts) holding one line per person:
 * [picture] [name] and, on the first line only, an optional pill. The normal
 * case, one person, is one compact line: the lead is part of the name's own
 * text ("👍 By Alice Example"), so it never takes a row or a column of its own.
 * Only the name column stretches, so on a narrow screen only the name wraps, at
 * word boundaries; the label, the picture and the pill never shrink or break.
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
    const avatar = person.avatar;
    if (isImageDataUri(avatar) && shown < maxAvatars && avatar.length <= remaining) {
      remaining -= avatar.length;
      used += avatar.length;
      shown += 1;
      entries.push({ name, avatar });
    } else {
      entries.push({ name, avatar: null });
    }
  }
  if (shown === 0) return null;
  const lead = text(headline);
  const lines = entries.map(({ name, avatar }, index) => {
    const columns = [];
    columns.push(avatar ? avatarColumn(name, avatar, `${AVATAR_PX}px`) : pictureSpacer());
    columns.push(textColumn(index === 0 && lead ? `${lead} ${name}` : name, {}, 'stretch'));
    if (index === 0 && usablePill(pill)) columns.push(pillColumn(pill));
    return index === 0 ? { type: 'ColumnSet', columns } : { type: 'ColumnSet', spacing: 'Small', columns };
  });
  const labelColumn = textColumn(text(label), { weight: 'Bolder' }, labelWidth);
  // With several lines stacked, the label stays with the first line.
  if (entries.length > 1) labelColumn.verticalContentAlignment = 'Top';
  const valueColumn = { type: 'Column', width: 'stretch', items: lines };
  return { row: { type: 'ColumnSet', spacing: 'Small', columns: [labelColumn, valueColumn] }, usedChars: used };
}
