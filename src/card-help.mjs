/**
 * Adaptive Card for the /help command: the slash commands grouped by domain.
 *
 * Pure data in, card JSON out. The input is the command catalogue of the
 * watcher (`COMMAND_CATEGORIES`): one markdown line per command, in the form
 * "- `/cmd [args]` (or `/alias`) [more args]: Description." The card never
 * invents or drops information: every command, alias, argument and the whole
 * description of a line is shown; a line this parser cannot read is shown as
 * plain text instead.
 *
 * Layout, all phone-safe (no fixed-width columns, only wrapping text):
 *
 * - the header ("teams-live · Help") and the title "Slash commands";
 * - per domain (one when a domain was asked for) a bold accent heading with a separator, then per command a
 *   two-level entry: the command in bold accent with its arguments dimmed (and
 *   "admin only" flagged in red), its aliases after it, the description below,
 *   and an "e.g." line when the description carried examples;
 * - a footer with the tip on filtering by domain.
 */

import { assembleCard, str, textBlock } from './cards.mjs';

const BOLD_RE = /\*\*/g;
const ENTRY_RE = /^-\s+(`[^`]+`(?:,\s*`[^`]+`)*)\s*(?:\(or\s+((?:`[^`]+`(?:,\s*)?)+)\)\s*)?([^:`]*?):\s+(.*)$/s;
const EXAMPLES_RE = /\s*\(e\.g\.\s*((?:`[^`]+`(?:,\s*)?)+)\)/;
const ADMIN_RE = /\s*\[admin only\]\.?\s*$/i;

/** Plain text of a markdown fragment: no bold markers, no code ticks. */
const plain = (value) => str(value).replace(BOLD_RE, '').replace(/`/g, '');

/** The contents of every `code` span of a text, in order. */
const codeSpans = (value) => [...str(value).matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);

/**
 * Splits "/tv ard" or "/mrs [all|me]" into the command (bold) and its
 * arguments (dimmed): arguments start at the first bracketed, angle or quoted
 * token. "/tv ard" stays whole, since "ard" is part of the command.
 */
function splitCommand(code) {
  const text = str(code);
  const at = text.search(/\s[[<"]/);
  return at < 0 ? { name: text, args: '' } : { name: text.slice(0, at), args: text.slice(at + 1).trim() };
}

/**
 * One catalogue line as data, or null when the line is not a command line.
 * `{ commands: [{ name, args }], aliases: [name], args, description, examples, adminOnly, raw }`.
 */
export function parseHelpEntry(line) {
  const raw = str(line);
  const match = ENTRY_RE.exec(raw);
  if (!match) return null;
  const [, head, aliasGroup, trailingArgs, rest] = match;
  const commands = codeSpans(head).map(splitCommand);
  if (commands.length === 0 || !commands[0].name.startsWith('/')) return null;
  let description = str(rest);
  const examples = [];
  const exampleMatch = EXAMPLES_RE.exec(description);
  if (exampleMatch) {
    examples.push(...codeSpans(exampleMatch[1]));
    description = description.replace(EXAMPLES_RE, '');
  }
  const adminOnly = ADMIN_RE.test(description);
  if (adminOnly) description = description.replace(ADMIN_RE, '.');
  return {
    commands,
    aliases: codeSpans(aliasGroup),
    args: str(trailingArgs),
    description: plain(description).replace(/\s+\./g, '.'),
    examples,
    adminOnly,
    raw,
  };
}

const run = (text, extra = {}) => ({ type: 'TextRun', text, ...extra });

/** The command line of an entry: bold accent commands, dimmed arguments, aliases, the admin flag. */
function commandLine(entry) {
  const inlines = [];
  entry.commands.forEach(({ name, args }, i) => {
    if (i > 0) inlines.push(run(', ', { isSubtle: true }));
    inlines.push(run(name, { weight: 'Bolder', color: 'Accent' }));
    if (args) inlines.push(run(` ${args}`, { isSubtle: true }));
  });
  if (entry.args) inlines.push(run(` ${entry.args}`, { isSubtle: true }));
  if (entry.aliases.length > 0) inlines.push(run(`  or ${entry.aliases.join(', ')}`, { isSubtle: true, size: 'Small' }));
  if (entry.adminOnly) inlines.push(run('  admin only', { color: 'Attention', size: 'Small', weight: 'Bolder' }));
  return { type: 'RichTextBlock', inlines, spacing: 'Medium' };
}

function entryItems(entry) {
  const items = [commandLine(entry), textBlock(entry.description, { spacing: 'None' })];
  if (entry.examples.length > 0) {
    items.push(textBlock(`e.g. ${entry.examples.join(' · ')}`, { isSubtle: true, spacing: 'None' }));
  }
  return items;
}

/** A line that is not a command entry: shown as plain text, so nothing is lost. */
const looseItem = (line) => textBlock(plain(line.replace(/^-\s+/, '')), { spacing: 'Small' });

/** The heading of a domain without markdown: "🦊 **GitLab**" becomes "🦊 GitLab". */
export const helpCategoryHeading = (category) => plain(category.title);

/**
 * The text of one catalogue entry: a string, or `{ text, requires }` for a
 * command that only exists when a feature is configured (see `helpEntries`).
 */
export const helpEntryText = (entry) => (typeof entry === 'string' ? entry : entry?.text);

/**
 * The entries of a category that are available: an entry that `requires` a
 * feature is dropped unless `has(feature)` says it is there, so the help never
 * advertises a command the daemon cannot run.
 */
export function helpEntries(category, has = () => true) {
  return (category.commands || []).filter((e) => !(e && typeof e === 'object' && e.requires) || has(e.requires)).map(helpEntryText).filter(Boolean);
}

function categoryItems(category, has, { heading, footer }) {
  const items = [];
  if (heading) {
    items.push(textBlock(helpCategoryHeading(category), { weight: 'Bolder', size: 'Medium', color: 'Accent', spacing: 'Large', separator: true }));
  }
  for (const line of helpEntries(category, has)) {
    const entry = parseHelpEntry(line);
    items.push(...(entry ? entryItems(entry) : [looseItem(line)]));
  }
  if (footer && category.footer) items.push(textBlock(plain(category.footer).replace(/^_|_$/g, ''), { isSubtle: true, size: 'Small', spacing: 'Medium' }));
  return items;
}

/**
 * The help card for these categories (all of them, one, or a part of a split
 * help). `part` is `[index, total]` for one card of several.
 */
export function buildHelpCard(categories, { has = () => true, part = null, single = false, notes = [], fallbackText } = {}) {
  const extraItems = [];
  for (const category of categories) extraItems.push(...categoryItems(category, has, { heading: true, footer: single }));
  notes.forEach((note, i) => extraItems.push(textBlock(plain(note).replace(/^_|_$/g, ''), { isSubtle: true, size: 'Small', spacing: i === 0 ? 'Large' : 'Small', separator: i === 0 })));
  const title = 'Slash commands';
  return assembleCard({
    service: 'bot',
    kind: part && part[1] > 1 ? `Help ${part[0]}/${part[1]}` : 'Help',
    title,
    extraItems,
    fallbackText,
  });
}

/**
 * The help as one card, or several when one is too big: `fits(categories)`
 * tells whether a card of exactly these categories is within the wire limit
 * (the caller measures it). Whole categories are packed greedily in
 * order, never cut; the result lists the categories of every card. A category
 * that fits no card alone is returned as `null` so the caller can fall back to
 * plain text.
 */
export function splitHelpCategories(categories, fits) {
  if (categories.length === 0) return [];
  if (fits(categories)) return [categories];
  const parts = [];
  let current = [];
  for (const category of categories) {
    if (current.length > 0 && !fits([...current, category])) {
      parts.push(current);
      current = [];
    }
    current.push(category);
    if (!fits(current)) return null;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}
