// Local, dependency-free syntax highlighting for Adaptive Card code blocks.
//
// Teams renders a card's text with HTML whitespace rules (leading spaces and
// runs of spaces collapse) and offers no per-token colour except through the
// runs of a RichTextBlock, whose `color` is limited to the card palette
// (Default, Dark, Light, Accent, Good, Warning, Attention). Everything here is
// pure string processing: no code leaves the process and nothing is fetched.

export const NBSP = '\u00a0';
const TAB_WIDTH = 4;

/** Expands tabs to the next tab stop (every 4 columns). */
export function expandTabs(text) {
  let column = 0;
  let expanded = '';
  for (const ch of String(text ?? '')) {
    if (ch === '\t') {
      const width = TAB_WIDTH - (column % TAB_WIDTH);
      expanded += ' '.repeat(width);
      column += width;
    } else {
      expanded += ch;
      column += 1;
    }
  }
  return expanded;
}

/**
 * Makes a line of code keep its layout in a Teams card: tabs are expanded,
 * leading whitespace and runs of spaces become non-breaking spaces (the last
 * space of a run stays a regular one so a long line can still wrap), and an
 * empty line becomes a single non-breaking space so it keeps its height.
 */
export function preserveWhitespace(text) {
  const out = expandTabs(text)
    .replace(/^ +/, (lead) => NBSP.repeat(lead.length))
    .replace(/ {2,}/g, (run) => NBSP.repeat(run.length - 1) + ' ');
  return out === '' ? NBSP : out;
}

const set = (words = '') => new Set(words.split(/\s+/).filter(Boolean));

const C_LIKE = { lineComment: ['//'], blockComment: ['/*', '*/'] };

const LANGUAGES = {
  js: {
    ...C_LIKE,
    quotes: ['"', "'"],
    multiline: ['`'],
    keywords: set(
      'async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield'
    ),
    literals: set('true false null undefined NaN Infinity'),
  },
  ts: {
    ...C_LIKE,
    quotes: ['"', "'"],
    multiline: ['`'],
    keywords: set(
      'abstract as async await break case catch class const continue declare default delete do else enum export extends finally for from function if implements import in instanceof interface let namespace new of private protected public readonly return static super switch this throw try type typeof var void while with yield'
    ),
    literals: set('true false null undefined NaN Infinity'),
  },
  python: {
    lineComment: ['#'],
    quotes: ['"', "'"],
    multiline: ['"""', "'''"],
    keywords: set(
      'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'
    ),
    literals: set('True False None'),
  },
  shell: {
    lineComment: ['#'],
    quotes: ['"', "'"],
    keywords: set('if then else elif fi for while until do done case esac in function select return exit local export readonly declare unset source'),
    literals: set(),
  },
  nix: {
    lineComment: ['#'],
    blockComment: ['/*', '*/'],
    quotes: ['"'],
    multiline: ["''"],
    keywords: set('let in if then else with inherit rec assert import or'),
    literals: set('true false null'),
  },
  go: {
    ...C_LIKE,
    quotes: ['"', "'"],
    multiline: ['`'],
    keywords: set(
      'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'
    ),
    literals: set('true false nil iota'),
  },
  rust: {
    ...C_LIKE,
    quotes: ['"'],
    keywords: set(
      'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while'
    ),
    literals: set('true false'),
  },
  c: {
    ...C_LIKE,
    quotes: ['"', "'"],
    keywords: set(
      'auto break case const continue default do else enum extern for goto if inline register return sizeof static struct switch typedef union volatile while class namespace template typename public private protected virtual new delete using'
    ),
    literals: set('true false NULL nullptr'),
  },
  java: {
    ...C_LIKE,
    quotes: ['"', "'"],
    keywords: set(
      'abstract assert break case catch class continue default do else enum extends final finally for if implements import instanceof interface native new package private protected public return static super switch synchronized this throw throws try void volatile while var'
    ),
    literals: set('true false null'),
  },
  json: { quotes: ['"'], keywords: set(), literals: set('true false null') },
  yaml: { lineComment: ['#'], quotes: ['"', "'"], keywords: set(), literals: set('true false null yes no') },
  toml: { lineComment: ['#'], quotes: ['"', "'"], keywords: set(), literals: set('true false') },
  hcl: {
    lineComment: ['#', '//'],
    blockComment: ['/*', '*/'],
    quotes: ['"'],
    keywords: set(
      'resource data variable output locals module provider terraform provisioner backend moved import check removed dynamic for in if else endif endfor'
    ),
    literals: set('true false null'),
  },
  sql: {
    lineComment: ['--'],
    blockComment: ['/*', '*/'],
    quotes: ["'"],
    caseInsensitive: true,
    keywords: set(
      'select from where and or not insert into values update set delete create alter drop table index view join left right inner outer on group by order having limit offset as union distinct case when then else end null is in like between'
    ),
    literals: set('true false'),
  },
};

const BY_EXTENSION = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
  ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'ts',
  py: 'python',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  nix: 'nix',
  go: 'go',
  rs: 'rust',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', cs: 'c',
  java: 'java', kt: 'java', scala: 'java',
  json: 'json',
  yml: 'yaml', yaml: 'yaml',
  toml: 'toml',
  tf: 'hcl', tfvars: 'hcl', hcl: 'hcl',
  sql: 'sql',
};

const BY_BASENAME = { justfile: 'shell', dockerfile: 'shell', 'flake.lock': 'json' };

/** The highlighting language of a file path, or null when it is not recognized (the code stays plain). */
export function languageForPath(filePath) {
  const base = String(filePath ?? '').split('/').pop().toLowerCase();
  if (Object.hasOwn(BY_BASENAME, base)) return BY_BASENAME[base];
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1) : '';
  return Object.hasOwn(BY_EXTENSION, ext) ? BY_EXTENSION[ext] : null;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[\w$]/;
const NUMBER = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/;

/** Index just past the closing `close` at or after `from` (escapes skipped), or -1. */
function findClose(text, close, from, escapes) {
  for (let i = from; i < text.length; i += 1) {
    if (escapes && text[i] === '\\') {
      i += 1;
    } else if (text.startsWith(close, i)) {
      return i + close.length;
    }
  }
  return -1;
}

/**
 * Splits code lines into styled tokens: `[{ type, text }]` per line, where
 * `type` is `keyword`, `string`, `comment`, `number`, `literal` or `plain`.
 * Block comments and multi-line strings carry across lines; a preview that
 * starts inside one cannot know it, which is the heuristic's main limit.
 * An unknown language yields null (the caller keeps the code plain).
 */
export function tokenizeLines(lines, language) {
  const lang = LANGUAGES[language];
  if (!lang) return null;
  const quotes = lang.quotes ?? [];
  const multiline = [...(lang.multiline ?? [])].sort((a, b) => b.length - a.length);
  const lineComments = lang.lineComment ?? [];
  let open = null; // { type, close, escapes } when a token continues from the previous line

  return lines.map((text) => {
    const tokens = [];
    const push = (type, value) => {
      if (!value) return;
      const last = tokens.at(-1);
      if (last && last.type === type) last.text += value;
      else tokens.push({ type, text: value });
    };

    let i = 0;
    if (open) {
      const end = findClose(text, open.close, 0, open.escapes);
      if (end === -1) {
        push(open.type, text);
        return tokens;
      }
      push(open.type, text.slice(0, end));
      i = end;
      open = null;
    }

    while (i < text.length) {
      const rest = text.slice(i);
      const prev = text[i - 1];

      const lineComment = lineComments.find(
        (c) => rest.startsWith(c) && (c !== '#' || i === 0 || /\s/.test(prev))
      );
      if (lineComment) {
        push('comment', rest);
        break;
      }
      if (lang.blockComment && rest.startsWith(lang.blockComment[0])) {
        const [start, close] = lang.blockComment;
        const end = findClose(text, close, i + start.length, false);
        if (end === -1) {
          push('comment', rest);
          open = { type: 'comment', close, escapes: false };
          break;
        }
        push('comment', text.slice(i, end));
        i = end;
        continue;
      }
      const multi = multiline.find((q) => rest.startsWith(q));
      if (multi) {
        const escapes = multi !== "''";
        const end = findClose(text, multi, i + multi.length, escapes);
        if (end === -1) {
          push('string', rest);
          open = { type: 'string', close: multi, escapes };
          break;
        }
        push('string', text.slice(i, end));
        i = end;
        continue;
      }
      const quote = quotes.find((q) => rest.startsWith(q));
      if (quote) {
        const end = findClose(text, quote, i + 1, true);
        const stop = end === -1 ? text.length : end;
        push('string', text.slice(i, stop));
        i = stop;
        continue;
      }
      if (IDENT_START.test(text[i]) && !(prev && IDENT_PART.test(prev))) {
        let j = i + 1;
        while (j < text.length && IDENT_PART.test(text[j])) j += 1;
        const word = text.slice(i, j);
        const key = lang.caseInsensitive ? word.toLowerCase() : word;
        push(lang.keywords.has(key) ? 'keyword' : lang.literals.has(key) ? 'literal' : 'plain', word);
        i = j;
        continue;
      }
      if (/\d/.test(text[i]) && !(prev && IDENT_PART.test(prev))) {
        const match = NUMBER.exec(rest);
        push('number', match[0]);
        i += match[0].length;
        continue;
      }
      push('plain', text[i]);
      i += 1;
    }
    return tokens;
  });
}

/**
 * The card style of each token type. Teams only offers its palette colours on
 * a TextRun: Accent (blue) for keywords, Good (green) for strings, Warning for
 * numbers and literals; comments are subtle italics.
 */
export const TOKEN_STYLES = {
  keyword: { color: 'Accent', weight: 'Bolder' },
  string: { color: 'Good' },
  number: { color: 'Warning' },
  literal: { color: 'Warning' },
  comment: { isSubtle: true, italic: true },
  plain: {},
};

/**
 * Token types by how much a reader gains from their colour; a card that is too
 * big drops the later ones (see HIGHLIGHT_LEVELS) to save runs.
 */
export const HIGHLIGHT_LEVELS = [
  ['keyword', 'string', 'comment', 'number', 'literal'],
  ['keyword', 'string', 'comment'],
  ['comment', 'string'],
];

/** The tokens of one line with every type outside `types` turned plain (and merged with its neighbours). */
export function restrictTokens(tokens, types) {
  const out = [];
  for (const token of tokens) {
    const type = types.includes(token.type) ? token.type : 'plain';
    const last = out.at(-1);
    if (last && last.type === type) last.text += token.text;
    else out.push({ type, text: token.text });
  }
  return out;
}

/**
 * One RichTextBlock per code row: a subtle line number followed by the tokens
 * as monospace runs (`row` is `{ number }`, `tokens` come from tokenizeLines
 * of the tab-expanded line, `numberWidth` pads the numbers).
 */
export function highlightedRow(row, tokens, numberWidth) {
  const run = (text, extra = {}) => ({ type: 'TextRun', text, fontType: 'Monospace', size: 'Small', ...extra });
  const prefix = `${String(row.number).padStart(numberWidth, ' ')}  `.replace(/ /g, NBSP);
  const inlines = [run(prefix, { isSubtle: true })];
  for (const token of tokens) inlines.push(run(preserveInner(token.text), TOKEN_STYLES[token.type] ?? {}));
  if (inlines.length === 1) inlines.push(run(NBSP));
  return { type: 'RichTextBlock', spacing: 'None', inlines };
}

/**
 * Whitespace handling for one run of a line (tabs are already expanded). Spaces
 * at a run's edges become non-breaking so neighbouring runs cannot swallow them.
 */
function preserveInner(text) {
  return text
    .replace(/^ +/, (lead) => NBSP.repeat(lead.length))
    .replace(/ +$/, (trail) => NBSP.repeat(trail.length))
    .replace(/ {2,}/g, (run) => NBSP.repeat(run.length - 1) + ' ');
}
