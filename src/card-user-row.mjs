/**
 * Adaptive Card row for people: a small round profile picture next to each
 * name. Pure data in, card JSON out; the pictures come from `avatars.mjs`
 * (prefetched, so card building stays synchronous).
 *
 * Without a usable picture a person is shown by name only, and when nobody in
 * a row has one `userRow` returns null so the caller keeps its plain text
 * layout unchanged.
 */

export const AVATAR_PX = 20;
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

// The lead ("By") sits in a fixed-width, non-wrapping cell so it can never break
// character by character; its width follows its length like the label column does.
const LEAD_PX_PER_CHAR = 9;
const LEAD_PX_PAD = 6;

function leadColumn(lead, width) {
  return {
    type: 'Column',
    width,
    verticalContentAlignment: 'Center',
    items: [{ type: 'TextBlock', text: lead || '\u00A0', wrap: false }],
  };
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

/**
 * @param {string} label  row label (bold)
 * @param {Array<{name: string, avatar?: string}>} people
 * @param {object} [opts]
 * @param {string} [opts.lead]  short text before the first person, e.g. "By"; it keeps its own fixed width
 * @param {string} [opts.headline]  a state line (wrapping text) above the people, e.g. "Enabled", when the state is not in the lead
 * @param {number} [opts.charBudget]  remaining picture budget for this card
 * @param {string} [opts.labelWidth]  fixed label column width, so the label lines up with the other fact rows
 * @returns {{row: object, usedChars: number}|null}
 *
 * Layout: the label column, then ONE stretch value column (so the value starts
 * where every other fact row's value starts) holding one line per person:
 * [lead] [picture] [name]. Only the name column stretches, so on a narrow
 * screen only the name wraps, at word boundaries; the label, the lead and the
 * picture never shrink or break.
 */
export function userRow(label, people, { lead = '', headline = '', charBudget = MAX_AVATAR_CHARS_PER_CARD, maxAvatars = MAX_AVATARS_PER_ROW, labelWidth = 'auto' } = {}) {
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
  const leadText = text(lead);
  const leadWidth = `${Math.ceil(Array.from(leadText).length * LEAD_PX_PER_CHAR) + LEAD_PX_PAD}px`;
  const lines = entries.map(({ name, avatar }, index) => {
    const columns = [];
    if (leadText) columns.push(leadColumn(index === 0 ? leadText : '', leadWidth));
    columns.push(avatar ? avatarColumn(name, avatar, `${AVATAR_PX}px`) : pictureSpacer());
    columns.push(textColumn(name, {}, 'stretch'));
    return index === 0 ? { type: 'ColumnSet', columns } : { type: 'ColumnSet', spacing: 'Small', columns };
  });
  const labelColumn = textColumn(text(label), { weight: 'Bolder' }, labelWidth);
  const headlineText = text(headline);
  // With several lines stacked, the label stays with the first line.
  if (entries.length > 1 || headlineText) labelColumn.verticalContentAlignment = 'Top';
  if (headlineText) {
    lines.unshift({ type: 'TextBlock', text: headlineText, wrap: true });
    // The people follow the state line closely, like the lines of one value.
    for (let i = 1; i < lines.length; i += 1) lines[i].spacing = 'Small';
  }
  const valueColumn = { type: 'Column', width: 'stretch', items: lines };
  return { row: { type: 'ColumnSet', spacing: 'Small', columns: [labelColumn, valueColumn] }, usedChars: used };
}
