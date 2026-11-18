/**
 * The /dice command (alias /roll): a real dice roller and a random picker.
 *
 * Pure logic plus the card; the watcher only parses, rolls and sends. Two modes:
 *
 * - roll: standard dice notation. `[N]d<S>`, optionally with `kh<K>` / `kl<K>`
 *   (keep the highest / lowest K dice), a `+M` / `-M` modifier, or `adv` / `dis`
 *   (roll a d20 twice and keep the higher / lower one). A bare number is a die
 *   with that many sides (`/dice 100`), and no argument is one d6.
 * - pick: two or more options separated by `|`, `,` or " or ", one is drawn
 *   (`/dice pizza | sushi | tacos`). This is what a dice roll is good for in a
 *   chat: settling who goes first, who takes the ticket, where to eat.
 *
 * The card shows the total large, the dice as chips (dropped dice dimmed, a
 * natural maximum or a natural 1 on a d20 marked) and the breakdown as text;
 * the markdown fallback carries the same figures.
 */

import { assembleCard, str, textBlock } from './cards.mjs';

export const MAX_DICE = 20;
export const MAX_SIDES = 1000;
export const MAX_MODIFIER = 1000;
export const MAX_OPTIONS = 12;
const OPTION_MAX_LENGTH = 80;
const CHIPS_PER_ROW = 5;
const D6_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

export const DICE_USAGE =
  '🎲 Usage: `/dice` (one d6), `/dice d20`, `/dice 2d6+3`, `/dice 4d6kh3`, `/dice d20 adv`, `/dice 100` or `/dice pizza | sushi | tacos`';

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const randomInt = (rng, sides) => Math.floor(rng() * sides) + 1;

/**
 * Splits "pizza | sushi, tacos or ramen" into its options (trimmed, de-duplicated
 * case-insensitively, empty ones dropped). Returns null when the text has no
 * separator, i.e. is not a pick.
 */
export function parsePickOptions(text) {
  const raw = str(text);
  if (!/[|,]|\sor\s/i.test(raw)) return null;
  const seen = new Set();
  const options = [];
  for (const part of raw.split(/\s*\|\s*|\s*,\s*|\s+or\s+/i)) {
    const option = part.trim().slice(0, OPTION_MAX_LENGTH);
    const key = option.toLowerCase();
    if (!option || seen.has(key)) continue;
    seen.add(key);
    options.push(option);
  }
  return options.length >= 2 ? options.slice(0, MAX_OPTIONS) : null;
}

/**
 * Parses the arguments of /dice. Returns `{ mode: 'roll', count, sides, keep,
 * modifier, advantage }`, `{ mode: 'pick', options }` or null for something that
 * is neither (the caller shows the usage).
 */
export function parseDiceArgs(args) {
  const text = (Array.isArray(args) ? args.join(' ') : str(args)).trim();
  if (!text) return { mode: 'roll', count: 1, sides: 6, keep: null, modifier: 0, advantage: null };

  const options = parsePickOptions(text);
  if (options) return { mode: 'pick', options };

  // "d20 adv", "d20 +5 adv", "2d6 + 3": spaces never matter inside a roll.
  let expr = text.toLowerCase().replace(/\s+/g, '');
  let advantage = null;
  const adv = expr.match(/^(.*?)(adv|advantage|dis|disadvantage)(.*)$/);
  if (adv) {
    advantage = adv[2].startsWith('dis') ? 'dis' : 'adv';
    expr = `${adv[1]}${adv[3]}`;
  }

  const match = expr.match(/^(\d*)(?:d(\d+))?(?:k([hl]?)(\d+))?([+-]\d+)?$/);
  if (!match) return null;
  const [, lead, dSides, keepKind, keepCount, mod] = match;

  let count;
  let sides;
  if (advantage && dSides === undefined && !lead && keepCount === undefined) {
    // "adv" alone (with an optional modifier) is a d20.
    count = 1;
    sides = 20;
  } else if (dSides === undefined) {
    // A bare number is a die with that many sides; modifiers and keeps need a real "d".
    if (!lead || keepCount !== undefined || mod !== undefined) return null;
    count = 1;
    sides = parseInt(lead, 10);
  } else {
    count = lead ? parseInt(lead, 10) : 1;
    sides = parseInt(dSides, 10);
  }
  if (sides < 2 || count < 1) return null;
  count = Math.min(count, MAX_DICE);
  sides = Math.min(sides, MAX_SIDES);

  let keep = null;
  if (keepCount !== undefined) {
    const n = clamp(parseInt(keepCount, 10), 1, count);
    keep = { kind: keepKind === 'l' ? 'low' : 'high', count: n };
  }

  if (advantage) {
    // Advantage is "two dice, keep one": it fixes the dice and cannot be combined with a keep.
    if (keep || count !== 1) return null;
    count = 2;
    keep = { kind: advantage === 'adv' ? 'high' : 'low', count: 1 };
  }

  const modifier = mod === undefined ? 0 : clamp(parseInt(mod, 10), -MAX_MODIFIER, MAX_MODIFIER);
  return { mode: 'roll', count, sides, keep, modifier, advantage };
}

/** The canonical notation of a roll spec: "2d6+3", "4d6kh3", "d20 adv". */
export function diceNotation(spec) {
  if (spec.advantage) return `d${spec.sides} ${spec.advantage === 'adv' ? 'adv' : 'dis'}${modifierText(spec.modifier)}`;
  const keep = spec.keep ? `k${spec.keep.kind === 'low' ? 'l' : 'h'}${spec.keep.count}` : '';
  return `${spec.count === 1 ? '' : spec.count}d${spec.sides}${keep}${modifierText(spec.modifier)}`;
}

const modifierText = (m) => (m ? (m > 0 ? `+${m}` : `−${Math.abs(m)}`) : '');

/**
 * Rolls a spec. `rolls` are in throw order, each flagged `dropped` when a keep
 * rule left it out of the total. A `natural` is set for a single d20 that came
 * up 20 ('max') or 1 ('min'), counting the kept die under advantage.
 */
export function rollDice(spec, rng = Math.random) {
  const rolls = Array.from({ length: spec.count }, () => ({ value: randomInt(rng, spec.sides), dropped: false }));
  if (spec.keep) {
    const order = rolls
      .map((roll, index) => ({ roll, index }))
      .sort((a, b) => (spec.keep.kind === 'high' ? b.roll.value - a.roll.value : a.roll.value - b.roll.value) || a.index - b.index);
    order.slice(spec.keep.count).forEach(({ roll }) => {
      roll.dropped = true;
    });
  }
  const kept = rolls.filter((r) => !r.dropped);
  const subtotal = kept.reduce((sum, r) => sum + r.value, 0);
  let natural = null;
  if (spec.sides === 20 && kept.length === 1) natural = kept[0].value === 20 ? 'max' : kept[0].value === 1 ? 'min' : null;
  return { ...spec, mode: 'roll', rolls, subtotal, total: subtotal + spec.modifier, natural };
}

/** Draws one of the options. */
export function pickOption(options, rng = Math.random) {
  return { mode: 'pick', options, index: Math.floor(rng() * options.length) };
}

function breakdownText(result) {
  const shown = result.rolls.map((r) => (r.dropped ? `~~${r.value}~~` : String(r.value)));
  const dice = result.rolls.length === 1 && !result.modifier ? '' : `[${shown.join(', ')}]`;
  const mod = result.modifier ? ` ${result.modifier > 0 ? '+' : '−'} ${Math.abs(result.modifier)}` : '';
  return `${dice}${mod}`.trim();
}

/** Plain markdown of a result: the fallback of the card and the whole reply when cards are off. */
export function formatDiceMarkdown(result, who = '') {
  const lead = who ? `**${who}** ` : '';
  if (result.mode === 'pick') {
    return `🎯 ${lead}drew: **${result.options[result.index]}**\n\n_from ${result.options.join(' · ')}_`;
  }
  const breakdown = breakdownText(result);
  const mark = result.natural === 'max' ? ' 🎉 natural 20!' : result.natural === 'min' ? ' 💀 natural 1' : '';
  return `🎲 ${lead}rolled **${diceNotation(result)}**: **${result.total}**${breakdown ? ` = ${breakdown}` : ''}${mark}`;
}

function chip(roll, sides, mark) {
  const text = sides === 6 ? D6_FACES[roll.value - 1] : String(roll.value);
  const colour = roll.dropped ? undefined : mark === 'max' ? 'Good' : mark === 'min' ? 'Attention' : 'Accent';
  return {
    type: 'Column',
    width: 'auto',
    style: 'default',
    bleed: false,
    verticalContentAlignment: 'Center',
    items: [
      textBlock(text, {
        size: sides === 6 ? 'ExtraLarge' : 'Large',
        weight: 'Bolder',
        wrap: false,
        spacing: 'None',
        horizontalAlignment: 'Center',
        ...(colour ? { color: colour } : { isSubtle: true }),
      }),
    ],
  };
}

function chipRows(result) {
  const rows = [];
  for (let i = 0; i < result.rolls.length; i += CHIPS_PER_ROW) {
    const slice = result.rolls.slice(i, i + CHIPS_PER_ROW);
    rows.push({
      type: 'ColumnSet',
      spacing: i === 0 ? 'Small' : 'None',
      columns: slice.map((roll) => chip(roll, result.sides, roll.dropped ? null : result.natural)),
    });
  }
  return rows;
}

function rollItems(result) {
  const totalColour = result.natural === 'max' ? 'Good' : result.natural === 'min' ? 'Attention' : 'Accent';
  const explain = [];
  if (result.advantage) explain.push(result.advantage === 'adv' ? 'advantage: the higher die counts' : 'disadvantage: the lower die counts');
  else if (result.keep) explain.push(`keeping the ${result.keep.kind === 'high' ? 'highest' : 'lowest'} ${result.keep.count}`);
  const breakdown = breakdownText(result);
  const head = {
    type: 'ColumnSet',
    spacing: 'Medium',
    columns: [
      {
        type: 'Column',
        width: 'auto',
        verticalContentAlignment: 'Center',
        items: [textBlock(String(result.total), { size: 'ExtraLarge', weight: 'Bolder', color: totalColour, wrap: false, spacing: 'None' })],
      },
      {
        type: 'Column',
        width: 'stretch',
        verticalContentAlignment: 'Center',
        items: [
          textBlock(diceNotation(result), { weight: 'Bolder', spacing: 'None', wrap: false }),
          ...(explain.length ? [textBlock(explain.join(' · '), { size: 'Small', isSubtle: true, spacing: 'None' })] : []),
          ...(result.natural
            ? [textBlock(result.natural === 'max' ? '🎉 Natural 20!' : '💀 Natural 1', { size: 'Small', weight: 'Bolder', color: totalColour, spacing: 'None' })]
            : []),
        ],
      },
    ],
  };
  const items = [head];
  // One die with no modifier: the big total already is the roll.
  if (result.rolls.length > 1 || result.sides === 6) items.push(...chipRows(result));
  if (result.rolls.length > 1 && result.modifier) items.push(textBlock(breakdown, { size: 'Small', isSubtle: true, spacing: 'Small', wrap: true }));
  return items;
}

function pickItems(result) {
  const chosen = result.options[result.index];
  return [
    textBlock(chosen, { size: 'Large', weight: 'Bolder', color: 'Good', spacing: 'Medium' }),
    ...result.options.map((option, i) =>
      textBlock(i === result.index ? `🎯 ${option}` : `• ${option}`, {
        size: 'Small',
        spacing: i === 0 ? 'Medium' : 'None',
        ...(i === result.index ? { weight: 'Bolder' } : { isSubtle: true }),
      })
    ),
  ];
}

/**
 * The card of a result from `rollDice` or `pickOption`.
 * @param {object} result
 * @param {object} [options]
 * @param {string} [options.who] the person who rolled, shown as the subtitle
 * @param {string} [options.fallbackText]
 */
export function buildDiceCard(result, { who = '', fallbackText } = {}) {
  const pick = result.mode === 'pick';
  const who_ = str(who);
  return assembleCard({
    service: 'dice',
    kind: pick ? 'Pick' : 'Roll',
    style: 'emphasis',
    title: null,
    fallbackText: fallbackText ?? formatDiceMarkdown(result, who_),
    extraItems: [
      ...(who_ ? [textBlock(pick ? `${who_} drew from ${result.options.length} options` : `${who_} rolled`, { size: 'Small', isSubtle: true, spacing: 'Small' })] : []),
      ...(pick ? pickItems(result) : rollItems(result)),
    ],
  });
}
