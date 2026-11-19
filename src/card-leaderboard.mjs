/**
 * Adaptive Card for the /leaderboard command: who talks to the bot most.
 *
 * Pure data in, card JSON out (the watcher fetches the profile pictures and
 * measures the card, see `executeLeaderboardCommand`). Layout:
 *
 * - the header ("Leaderboard · Bot interactions", no second heading), then three stat tiles (interactions, users, top command);
 * - a podium: the top three with a medal, a larger picture, the name, their
 *   most used commands, a bar relative to the leader and the count with its
 *   share of all interactions; the leader's bar and count are gold;
 * - the remaining ranks (up to `LEADERBOARD_MAX_ENTRIES` in all) as compact rows
 *   without a bar (the wire budget is tight), with a small picture when there
 *   is room for one;
 * - a note when more users exist than are shown.
 *
 * A name without a picture simply has none (a spacer keeps the names aligned).
 */

import { assembleCard, str, textBlock } from './cards.mjs';
import { gapColumn } from './card-icon-text.mjs';
import { isImageDataUri } from './card-user-row.mjs';

export const LEADERBOARD_MAX_ENTRIES = 8;
export const PODIUM_SIZE = 3;
export const PODIUM_AVATAR_PX = 28;
export const ROW_AVATAR_PX = 18;
const MEDALS = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];
const MAX_COMMANDS_SHOWN = 3;

const count = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/** "/mrs ×12 · /status ×4": the most used commands of one person, most used first. */
export function topCommandsText(commands, limit = MAX_COMMANDS_SHOWN) {
  return topCommands(commands, limit)
    .map(([cmd, n]) => `${cmd} ×${n}`)
    .join(' · ');
}

function topCommands(commands, limit = Infinity) {
  return Object.entries(commands && typeof commands === 'object' ? commands : {})
    .map(([cmd, n]) => [str(cmd), count(n)])
    .filter(([cmd, n]) => cmd && n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

/** Entries ranked by interactions (ties by name), invalid ones dropped, with the figures the card needs. */
export function rankLeaderboard(entries) {
  const ranked = (Array.isArray(entries) ? entries : [])
    .map((e) => ({ ...e, name: str(e?.name), count: count(e?.count) }))
    .filter((e) => e.name && e.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const total = ranked.reduce((sum, e) => sum + e.count, 0);
  const overall = new Map();
  for (const e of ranked) for (const [cmd, n] of topCommands(e.commands)) overall.set(cmd, (overall.get(cmd) || 0) + n);
  const [topCommand] = [...overall.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { ranked, total, topCommand: topCommand ? { command: topCommand[0], count: topCommand[1] } : null };
}

function statTile(value, label) {
  return {
    type: 'Column',
    width: 'stretch',
    items: [
      textBlock(value, { size: 'Large', weight: 'Bolder', spacing: 'None', wrap: false }),
      textBlock(label, { size: 'Small', isSubtle: true, spacing: 'None' }),
    ],
  };
}

function statsRow({ total, users, topCommand }) {
  const tiles = [statTile(String(total), 'interactions'), statTile(String(users), users === 1 ? 'user' : 'users')];
  if (topCommand) tiles.push(statTile(topCommand.command, 'most used'));
  return { type: 'ColumnSet', spacing: 'Medium', separator: true, columns: tiles };
}

/** A bar relative to the leader: a run of block characters (thin, coloured, visible on any background). */
const BAR_CELLS = 10;
function bar(share, color) {
  const cells = Math.min(BAR_CELLS, Math.max(1, Math.round(share * BAR_CELLS)));
  return textBlock('\u2588'.repeat(cells), { size: 'Small', color, spacing: 'None', wrap: false });
}

function pictureCell(name, avatar, px) {
  const item = isImageDataUri(avatar)
    ? { type: 'Image', url: avatar, altText: name, style: 'Person', width: `${px}px`, height: `${px}px` }
    : textBlock(' ', { wrap: false });
  return { type: 'Column', width: `${px}px`, verticalContentAlignment: 'Center', items: [item] };
}

function row({ entry, rank, share, leaderCount, podium, withPictures }) {
  const px = podium ? PODIUM_AVATAR_PX : ROW_AVATAR_PX;
  const commands = topCommandsText(entry.commands);
  const columns = [
    {
      type: 'Column',
      width: '32px',
      verticalContentAlignment: 'Center',
      items: [
        podium
          ? textBlock(MEDALS[rank - 1], { size: 'Large', wrap: false, spacing: 'None' })
          : textBlock(`#${rank}`, { isSubtle: true, weight: 'Bolder', wrap: false, spacing: 'None' }),
      ],
    },
  ];
  if (withPictures) columns.push(pictureCell(entry.name, entry.avatar, px));
  if (withPictures) columns.push(gapColumn());
  columns.push({
    type: 'Column',
    width: 'stretch',
    ...(withPictures ? { spacing: 'None' } : {}),
    verticalContentAlignment: 'Center',
    items: [
      textBlock(entry.name, { weight: 'Bolder', spacing: 'None' }),
      ...(commands ? [textBlock(commands, { size: 'Small', isSubtle: true, spacing: 'None' })] : []),
      ...(podium ? [bar(entry.count / leaderCount, rank === 1 ? 'Warning' : 'Accent')] : []),
    ],
  });
  columns.push({
    type: 'Column',
    width: 'auto',
    verticalContentAlignment: 'Center',
    items: [
      textBlock(String(entry.count), { size: podium ? 'Large' : 'Medium', weight: 'Bolder', ...(rank === 1 ? { color: 'Warning' } : {}), horizontalAlignment: 'Right', spacing: 'None', wrap: false }),
      textBlock(`${Math.round(share * 100)}%`, { size: 'Small', isSubtle: true, horizontalAlignment: 'Right', spacing: 'None', wrap: false }),
    ],
  });
  return { type: 'ColumnSet', spacing: 'Small', columns };
}

/**
 * @param {object} data
 * @param {Array<{name: string, count: number, commands?: Record<string, number>, avatar?: string}>} data.entries
 *   one per person, in any order (ranked here); `avatar` is a data URI
 * @param {string} [data.fallbackText]
 * @returns {object} the card (an empty state when nobody has interacted yet)
 */
export function buildLeaderboardCard({ entries, fallbackText } = {}) {
  const { ranked, total, topCommand } = rankLeaderboard(entries);
  const base = { service: 'leaderboard', kind: 'Bot interactions', style: 'emphasis', title: null, fallbackText };
  if (ranked.length === 0) {
    return assembleCard({ ...base, extraItems: [textBlock('No interactions recorded yet. Send a command to get on the board.', { isSubtle: true })] });
  }
  const shown = ranked.slice(0, LEADERBOARD_MAX_ENTRIES);
  const leaderCount = shown[0].count;
  const podiumPictures = shown.slice(0, PODIUM_SIZE).some((e) => isImageDataUri(e.avatar));
  const rowPictures = shown.slice(PODIUM_SIZE).some((e) => isImageDataUri(e.avatar));

  const rows = shown.map((entry, index) => {
    const podium = index < PODIUM_SIZE;
    return row({ entry, rank: index + 1, share: entry.count / total, leaderCount, podium, withPictures: podium ? podiumPictures : rowPictures });
  });
  const hidden = ranked.length - shown.length;
  const note = hidden > 0 ? `Top ${shown.length} of ${ranked.length} users, ranked by interactions` : 'Ranked by interactions with the bot';
  return assembleCard({
    ...base,
    extraItems: [statsRow({ total, users: ranked.length, topCommand }), ...rows, textBlock(note, { size: 'Small', isSubtle: true, spacing: 'Medium' })],
  });
}
