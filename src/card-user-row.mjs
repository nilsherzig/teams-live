/**
 * Adaptive Card row for people: a small round profile picture next to each
 * name. Pure data in, card JSON out; the pictures come from `avatars.mjs`
 * (prefetched, so card building stays synchronous).
 *
 * Without a usable picture a person is shown by name only, and when nobody in
 * a row has one `userRow` returns null so the caller keeps its plain text
 * layout unchanged.
 */

export const AVATAR_PX = 24;
// Total size of the embedded pictures per card (characters of the data URIs).
// Cards are limited on the wire (MAX_CARD_BYTES), so extra pictures are dropped
// in favour of names before the card could outgrow it.
export const MAX_AVATAR_CHARS_PER_CARD = 9000;
export const MAX_AVATARS_PER_ROW = 3;

/** Cards only ever embed a plain base64 JPEG/PNG data URI, never a remote URL. */
export function isImageDataUri(value) {
  return typeof value === 'string' && /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

const text = (value) => (value === undefined || value === null ? '' : String(value).trim());

function textColumn(content, extra = {}) {
  return {
    type: 'Column',
    width: 'auto',
    verticalContentAlignment: 'Center',
    items: [{ type: 'TextBlock', text: content, wrap: true, ...extra }],
  };
}

function avatarColumn(name, dataUri) {
  return {
    type: 'Column',
    width: 'auto',
    verticalContentAlignment: 'Center',
    items: [{ type: 'Image', url: dataUri, altText: name, style: 'Person', width: `${AVATAR_PX}px`, height: `${AVATAR_PX}px` }],
  };
}

/**
 * Names worth a picture on a card, in display order: the assignee, the owner,
 * the approvers and the auto-merge user, without "Unassigned" placeholders and
 * duplicates. Reads the same fields the card builders do.
 */
export function collectCardPeople(data) {
  const names = [data?.assignee, data?.owner, ...(Array.isArray(data?.approvedBy) ? data.approvedBy : []), data?.autoMergeUser]
    .map(text)
    .filter((n) => n && n.toLowerCase() !== 'unassigned');
  return [...new Set(names)];
}

/**
 * @param {string} label  row label (bold)
 * @param {Array<{name: string, avatar?: string}>} people
 * @param {object} [opts]
 * @param {string} [opts.lead]  text between label and people, e.g. "Approved by"
 * @param {number} [opts.charBudget]  remaining picture budget for this card
 * @returns {{row: object, usedChars: number}|null}
 */
export function userRow(label, people, { lead = '', charBudget = MAX_AVATAR_CHARS_PER_CARD, maxAvatars = MAX_AVATARS_PER_ROW } = {}) {
  let remaining = charBudget;
  let shown = 0;
  let used = 0;
  const personColumns = [];
  for (const person of people || []) {
    const name = text(person?.name);
    if (!name) continue;
    const avatar = person.avatar;
    if (isImageDataUri(avatar) && shown < maxAvatars && avatar.length <= remaining) {
      remaining -= avatar.length;
      used += avatar.length;
      shown += 1;
      personColumns.push(avatarColumn(name, avatar), textColumn(name));
    } else {
      personColumns.push(textColumn(name));
    }
  }
  if (shown === 0) return null;
  const columns = [textColumn(text(label), { weight: 'Bolder' })];
  if (text(lead)) columns.push(textColumn(text(lead)));
  columns.push(...personColumns);
  return { row: { type: 'ColumnSet', spacing: 'Small', columns }, usedChars: used };
}
