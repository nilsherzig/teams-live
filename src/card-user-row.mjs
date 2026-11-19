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
import { initialsAvatar, nameInitials } from './initials-avatar.mjs';
import { badgeAvatar, badgedDisplayPx } from './badge-avatar.mjs';
import { ICON_GAP_PX, gapColumn } from './card-icon-text.mjs';

export { gapColumn };

export const AVATAR_PX = 18;
// Total size of the embedded pictures per card (characters of the data URIs).
// Cards are limited on the wire (MAX_CARD_BYTES), so extra pictures are dropped
// before the card could outgrow it. Actual wire size is checked after rendering,
// and oversized cards are rebuilt.
export const MAX_AVATAR_CHARS_PER_CARD = 12000;

/** Cards only ever embed a plain base64 JPEG/PNG data URI, never a remote URL. */
export function isImageDataUri(value) {
  return typeof value === 'string' && /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

const text = (value) => (value === undefined || value === null ? '' : String(value).trim());

// The one gap between a picture and a name: an exact spacer column, because the card spacing presets
// are either too wide or too tight. Between pictures the flow uses PICTURE_GAP (a preset, about 4px).
export const PICTURE_GAP = 'Small';
export const NAME_GAP_PX = ICON_GAP_PX;
// A badged picture has a transparent margin of about 2px on each side, so it needs that much less.
const BADGE_MARGIN_PX = 2;

function textColumn(content, extra = {}, width = 'auto', spacing = undefined) {
  return {
    type: 'Column',
    width,
    ...(spacing ? { spacing } : {}),
    verticalContentAlignment: 'Center',
    items: [{ type: 'TextBlock', text: content, wrap: true, ...extra }],
  };
}

/**
 * A person's picture as a card item. With `badged` (the person's approval was made by the MS Teams bot
 * on their behalf) the picture carries the Teams badge: a pre-rendered round PNG with a transparent
 * margin for the badge, shown without the card's circular crop and larger by that margin, so the
 * picture itself keeps the size of every other picture.
 */
export function pictureItem(name, dataUri, { badged = false, profile = null } = {}) {
  const badgedUri = badged ? badgeAvatar(dataUri) : null;
  // A click opens the person's profile; the tooltip is what the client shows on hover. Neither changes how the picture looks.
  const action = profileAction(profile);
  if (badgedUri) {
    const px = `${badgedDisplayPx(AVATAR_PX)}px`;
    return { type: 'Image', url: badgedUri, altText: `${name} (approved via the MS Teams bot)`, width: px, height: px, ...action };
  }
  return { type: 'Image', url: dataUri, altText: name, style: 'Person', width: `${AVATAR_PX}px`, height: `${AVATAR_PX}px`, ...action };
}

/** `{ selectAction }` for a profile `{ url, tooltip }` with an http(s) URL; nothing otherwise. */
function profileAction(profile) {
  let url = '';
  try {
    const parsed = new URL(String(profile?.url ?? ''));
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') url = parsed.href;
  } catch {}
  if (!url) return {};
  const tooltip = text(profile.tooltip);
  return { selectAction: { type: 'Action.OpenUrl', url, ...(tooltip ? { tooltip } : {}) } };
}

export function avatarColumn(name, dataUri, width = 'auto', { badged = false, spacing = undefined, profile = null } = {}) {
  return {
    type: 'Column',
    width,
    ...(spacing ? { spacing } : {}),
    verticalContentAlignment: 'Center',
    items: [pictureItem(name, dataUri, { badged, profile })],
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

/**
 * THE way a person is shown on every card: `<picture> <name>`, the picture
 * always directly left of the name (a placeholder-sized spacer keeps the names
 * aligned when a picture is missing). A `lead` ("🔀 Enabled by") is plain text
 * BEFORE the pair, so it never separates a picture from its name. In compact
 * mode only the picture is shown, with initials inside placeholder pictures.
 */
export function personChip({ name, avatar, viaBot = false, profile = null }, { lead = '', compact = false, stretch = false, textStyle = {} } = {}) {
  const columns = [];
  if (lead) columns.push(textColumn(lead, textStyle, 'auto'));
  if (avatar) columns.push(avatarColumn(name, avatar, stretch ? `${viaBot ? badgedDisplayPx(AVATAR_PX) : AVATAR_PX}px` : 'auto', { badged: viaBot, profile }));
  else if (!compact) columns.push(pictureSpacer());
  if (!compact) {
    columns.push(gapColumn(avatar && viaBot ? NAME_GAP_PX - BADGE_MARGIN_PX : NAME_GAP_PX));
    columns.push(textColumn(name, textStyle, stretch ? 'stretch' : 'auto', 'None'));
  } else if (!avatar || avatar === PLACEHOLDER_AVATAR) {
    columns.push(gapColumn());
    columns.push(textColumn(nameInitials(name), textStyle, 'auto', 'None'));
  }
  // The whole chip (picture and name, or just the picture when no name is shown) opens the profile and hovers.
  return { type: 'ColumnSet', columns, ...profileAction(profile) };
}

/**
 * The same `<picture> <name>` pair as flat items for a Layout.Flow container (no Column wrappers, so
 * long lists stay small on the wire): the picture, then the name directly after it. `trail` is
 * text that continues in the same block after the name.
 */
export function personChipItems({ name, avatar }, { textStyle = {}, trail = '' } = {}) {
  const items = [];
  if (avatar) items.push({ type: 'Image', url: avatar, altText: name, style: 'Person', width: `${AVATAR_PX}px`, height: `${AVATAR_PX}px` });
  items.push({ type: 'TextBlock', text: trail ? `${name} ${trail}` : name, wrap: false, ...textStyle });
  return items;
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
 * The picture of a person who has no photo: their initials on a round ground, else (a name it cannot draw)
 * the neutral silhouette. One rule for every card, so nobody is shown with a generic picture when initials
 * would say more.
 */
export function fallbackAvatar(name) {
  return initialsAvatar(text(name)) || PLACEHOLDER_AVATAR;
}

/**
 * Select one image per person for every occurrence on a card, accounting for each copy on the wire.
 * Once any person on the card has a picture, EVERYONE named gets one: a photo when it fits the
 * budget, else a placeholder. Placeholders do not use the photo budget, so a heavy photo can never
 * starve another person (a bot, a service account) of their picture.
 */
export function planCardAvatars(people, budget = MAX_AVATAR_CHARS_PER_CARD) {
  const groups = new Map();
  for (const person of people) {
    const name = text(person.name);
    if (!name) continue;
    const key = name.toLocaleLowerCase().replace(/\s+/gu, ' ');
    const group = groups.get(key) || { name, count: 0, photo: null, compact: false, placeholder: false };
    group.count++;
    group.compact ||= Boolean(person.compact);
    group.placeholder ||= person.avatar === PLACEHOLDER_AVATAR;
    if (isImageDataUri(person.avatar) && person.avatar !== PLACEHOLDER_AVATAR) group.photo ||= person.avatar;
    groups.set(key, group);
  }
  const inPlay = [...groups.values()].some((group) => group.photo || group.placeholder || group.compact);
  const selected = new Map();
  // Pass 1: the cheap fallback for everybody. Placeholders are tiny and never count against the photo budget.
  for (const [key, group] of groups) {
    const fallback = inPlay ? fallbackAvatar(group.name) : null;
    group.fallback = fallback;
    selected.set(key, fallback);
  }
  // Pass 2: upgrade to the real photo where the remaining budget allows it.
  for (const [key, group] of groups) {
    if (!group.photo) continue;
    const cost = group.photo.length * group.count;
    if (cost <= budget) {
      budget -= cost;
      selected.set(key, group.photo);
    }
  }
  return (name) => selected.get(text(name).toLocaleLowerCase().replace(/\s+/gu, ' ')) ?? null;
}

/**
 * @param {string} label  row label (bold)
 * @param {Array<{name: string, avatar?: string}>} people
 * @param {object} [opts]
 * @param {string} [opts.headline]  a short lead such as "👍 By" or "🔀 Enabled by", written in front of the first name (same wrapping text, no line of its own)
 * @param {{url: string, alt?: string, width: number, height: number}} [opts.pill]  a status pill image, the first item of the flowing value
 * @param {boolean} [opts.compact]  show only pictures, with initials inside generated placeholders
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
export function userRow(label, people, { headline = '', pill = null, compact = false, charBudget = MAX_AVATAR_CHARS_PER_CARD, labelWidth = 'auto', avatarPlan = null } = {}) {
  const validPeople = (people || []).filter((person) => text(person?.name));
  const selectAvatar = avatarPlan || planCardAvatars(validPeople.map((person) => ({ ...person, compact })), charBudget);
  const entries = validPeople.map((person) => ({ name: text(person.name), avatar: selectAvatar(person.name), viaBot: person.viaBot === true, profile: person.profile || null }));
  const used = entries.reduce((total, entry) => total + (entry.avatar?.length || 0), 0);
  if (!entries.some((entry) => entry.avatar) && !compact) return null;
  const lead = text(headline);
  const hasPill = usablePill(pill);
  const labelColumn = textColumn(text(label), { weight: 'Bolder' }, labelWidth);
  let valueItems;
  if (hasPill || entries.length > 1) {
    // Pill and people flow left to right and wrap only when the card is too
    // narrow (Layout.Flow, Adaptive Cards 1.5: Teams honours it; an older
    // renderer ignores it and stacks the same items, which is still readable).
    const people = entries.map((entry, index) => personChip(entry, { lead: index === 0 ? lead : '', compact }));
    valueItems = [
      {
        type: 'Container',
        layouts: [{ type: 'Layout.Flow', horizontalItemsAlignment: 'Left', verticalItemsAlignment: 'Center', columnSpacing: PICTURE_GAP, rowSpacing: 'Small' }],
        items: hasPill ? [pillImage(pill), ...people] : people,
      },
    ];
  } else {
    // One person, no pill: one compact line, only the name stretches.
    valueItems = [personChip(entries[0], { lead, compact, stretch: true })];
  }
  // With the pill and people stacked or wrapped, the label stays with the first line.
  if (hasPill || entries.length > 1) labelColumn.verticalContentAlignment = 'Top';
  const valueColumn = { type: 'Column', width: 'stretch', items: valueItems };
  return { row: { type: 'ColumnSet', spacing: 'Small', columns: [labelColumn, valueColumn] }, usedChars: used };
}
