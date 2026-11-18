import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_HIGHLIGHTED_CODE_BYTES, buildCodePreviewCard, buildReplyCard, MAX_CARD_BYTES } from '../src/cards.mjs';
import { NBSP, languageForPath, preserveWhitespace, tokenizeLines } from '../src/code-highlight.mjs';
import { makeRichMessage, richMessageWireBytes } from '../src/teams.mjs';

const previewOf = (filePath, texts, extra = {}) => ({
  project: 'group/app',
  ref: 'main',
  path: filePath,
  startLine: 8,
  endLine: 7 + texts.length,
  requestedEndLine: 7 + texts.length,
  totalLines: 100,
  truncated: false,
  lines: texts.map((text, i) => ({ n: 8 + i, text })),
  url: 'https://gitlab.example.com/group/app/-/blob/main/' + filePath + '#L8',
  ...extra,
});

const find = (node, pred, out = []) => {
  if (Array.isArray(node)) node.forEach((n) => find(n, pred, out));
  else if (node && typeof node === 'object') {
    if (pred(node)) out.push(node);
    Object.values(node).forEach((n) => find(n, pred, out));
  }
  return out;
};
const rowText = (block) => block.inlines.map((r) => r.text).join('');

test('preserveWhitespace keeps indentation, tabs, space runs and empty lines', () => {
  assert.equal(preserveWhitespace('    x'), `${NBSP.repeat(4)}x`);
  assert.equal(preserveWhitespace('\tx'), `${NBSP.repeat(4)}x`);
  assert.equal(preserveWhitespace('a\tb'), `a${NBSP.repeat(2)} b`);
  assert.equal(preserveWhitespace('a   b'), `a${NBSP.repeat(2)} b`);
  assert.equal(preserveWhitespace('a b'), 'a b', 'a single space stays wrappable');
  assert.equal(preserveWhitespace(''), NBSP);
});

test('languageForPath recognizes common files and leaves the rest plain', () => {
  assert.equal(languageForPath('src/a.mjs'), 'js');
  assert.equal(languageForPath('a/b/Main.PY'), 'python');
  assert.equal(languageForPath('flake.nix'), 'nix');
  assert.equal(languageForPath('justfile'), 'shell');
  assert.equal(languageForPath('infra/provider.tf'), 'hcl');
  assert.equal(languageForPath('prod.tfvars'), 'hcl');
  assert.equal(languageForPath('.terraform.hcl'), 'hcl');
  assert.equal(languageForPath('notes.txt'), null);
  assert.equal(languageForPath('Makefile'), null);
  assert.equal(languageForPath('.gitignore'), null);
});

test('tokenizeLines classifies keywords, strings, comments, numbers and literals', () => {
  const [line] = tokenizeLines(['const a = "x // y"; // note 42'], 'js');
  assert.deepEqual(
    line.map((t) => [t.type, t.text]),
    [
      ['keyword', 'const'],
      ['plain', ' a = '],
      ['string', '"x // y"'],
      ['plain', '; '],
      ['comment', '// note 42'],
    ]
  );
  const [nums] = tokenizeLines(['return 0x1F + 3.5 + foo2 + true'], 'js');
  assert.deepEqual(
    nums.filter((t) => t.type !== 'plain').map((t) => [t.type, t.text]),
    [['keyword', 'return'], ['number', '0x1F'], ['number', '3.5'], ['literal', 'true']]
  );
  assert.equal(tokenizeLines(['x'], 'cobol'), null);
});

test('tokenizeLines carries block comments, template strings and python docstrings across lines', () => {
  const js = tokenizeLines(['a /* one', 'two const', 'three */ const', 'const'], 'js');
  assert.deepEqual(js[1], [{ type: 'comment', text: 'two const' }]);
  assert.deepEqual(js[2][0], { type: 'comment', text: 'three */' });
  assert.equal(js[3][0].type, 'keyword');
  const tpl = tokenizeLines(['x = `a', 'if', 'b` + if'], 'js');
  assert.equal(tpl[1][0].type, 'string');
  assert.deepEqual(tpl[2].map((t) => t.type), ['string', 'plain', 'keyword']);
  const py = tokenizeLines(['"""doc', 'def', '"""', 'def f(): # c'], 'python');
  assert.equal(py[1][0].type, 'string');
  assert.equal(py[3][0].type, 'keyword');
  assert.equal(py[3].at(-1).type, 'comment');
});

test('a hash is a comment only at a word start, so shell variables stay code', () => {
  const [line] = tokenizeLines(['echo ${#arr[@]} # count'], 'shell');
  assert.deepEqual(line.at(-1), { type: 'comment', text: '# count' });
  assert.ok(line.every((t) => t.type !== 'comment' || t.text === '# count'));
});

test('a recognized file gets RichTextBlock rows with coloured runs and kept indentation', () => {
  const card = buildCodePreviewCard(
    previewOf('src/a.mjs', ['function f(x) {', '    // ret', '\treturn "s" + 1;', '}', ''])
  );
  const rows = find(card, (n) => n.type === 'RichTextBlock' && n.inlines.every((r) => r.fontType === 'Monospace'));
  assert.equal(rows.length, 5);
  const plainSpaces = (text) => text.replaceAll(NBSP, ' ');
  assert.equal(plainSpaces(rowText(rows[1])), ' 9      // ret', 'number, separator and 4 columns of indentation');
  assert.equal(plainSpaces(rowText(rows[2])), '10      return "s" + 1;', 'a tab becomes 4 columns');
  assert.ok(!/^ /.test(rowText(rows[1])), 'no plain space can collapse at the start of a row');
  assert.ok(rows[1].inlines.every((r) => !/^ | $/.test(r.text)), 'no run starts or ends with a collapsible space');
  const runs = rows.flatMap((r) => r.inlines);
  const style = (text) => runs.find((r) => r.text === text);
  assert.equal(style('function').color, 'Accent');
  assert.equal(style('"s"').color, 'Good');
  assert.equal(style('1').color, 'Warning');
  assert.equal(style('// ret').isSubtle, true);
  assert.equal(rows[4].inlines.length, 2, 'an empty line still has a (blank) code run');
  // Run text is plain text in a TextRun: no markdown escaping may leak in.
  assert.ok(runs.every((r) => !/\\[*_`]/.test(r.text)));
});

test('an unrecognized file stays a plain monospace block that keeps its indentation', () => {
  const card = buildCodePreviewCard(previewOf('notes.txt', ['top', '    nested', '\ttab']));
  assert.equal(find(card, (n) => n.type === 'RichTextBlock' && n.inlines?.[0]?.fontType === 'Monospace').length, 0);
  const rows = find(card, (n) => n.type === 'TextBlock' && n.fontType === 'Monospace');
  assert.equal(rows.length, 3);
  assert.equal(rows[1].text.replaceAll(NBSP, ' '), ' 9      nested');
  assert.equal(rows[2].text.replaceAll(NBSP, ' '), '10      tab');
  assert.ok(!/^ /.test(rows[1].text));
});

test('fenced code in a reply keeps its indentation too', () => {
  const card = buildReplyCard('```\nroot\n    child\n```');
  const rows = find(card, (n) => n.type === 'TextBlock' && n.fontType === 'Monospace');
  assert.deepEqual(rows.map((r) => r.text), ['root', `${NBSP.repeat(4)}child`]);
});

const isHighlightedRow = (n) => n.type === 'RichTextBlock' && n.inlines?.[0]?.fontType === 'Monospace';

test('an oversized highlighted block loses colour levels, then falls back to plain, and stays sendable', () => {
  // Strings, keywords and numbers on every line: far beyond the block budget at any level.
  const strings = Array.from({ length: 30 }, () => `f(${Array.from({ length: 20 }, () => '"s"').join(', ')}); // c`);
  const stringCard = buildCodePreviewCard(previewOf('x.js', strings));
  assert.equal(find(stringCard, isHighlightedRow).length, 0, 'plain when even the lightest level does not fit');
  assert.equal(find(stringCard, (n) => n.type === 'TextBlock' && n.fontType === 'Monospace').length, 30);

  // Many numbers but few strings: the number colour is dropped first, the rest stays.
  const numbers = Array.from({ length: 30 }, (_, i) => `return [${Array.from({ length: 25 }, (_, j) => i + j).join(', ')}];`);
  const numberCard = buildCodePreviewCard(previewOf('x.js', numbers));
  const rows = find(numberCard, isHighlightedRow);
  assert.equal(rows.length, 30);
  const runs = rows.flatMap((r) => r.inlines);
  assert.ok(runs.some((r) => r.color === 'Accent'), 'keywords keep their colour');
  assert.ok(runs.every((r) => r.color !== 'Warning'), 'numbers lost theirs');
  assert.ok(Buffer.byteLength(JSON.stringify(numberCard)) < MAX_CARD_BYTES);
});

test('a realistic 30-line excerpt stays highlighted and within the wire limit', () => {
  const source = Array.from({ length: 30 }, (_, i) =>
    i % 3 === 0 ? `  const value${i} = compute(${i}, "name-${i}"); // note ${i}` : `    if (value${i} > 0) { return true; }`
  );
  const card = buildCodePreviewCard(previewOf('src/real.js', source));
  assert.equal(find(card, isHighlightedRow).length, 30);
  const markdown = '```\n' + source.join('\n') + '\n```';
  const wire = richMessageWireBytes(makeRichMessage(markdown, card));
  assert.ok(wire <= MAX_CARD_BYTES, `wire bytes ${wire}`);
  assert.ok(MAX_HIGHLIGHTED_CODE_BYTES > 0);
});

test('nothing in the card or the highlighter reaches for the network', async () => {
  const sources = await Promise.all(
    ['../src/code-highlight.mjs'].map((f) => import('node:fs').then((fs) => fs.readFileSync(new URL(f, import.meta.url), 'utf8')))
  );
  for (const source of sources) assert.doesNotMatch(source, /\bfetch\(|https?\.request|node:https?|node:net/);
});

test('a Terraform provider file is highlighted: strings, numbers, comments and blocks', () => {
  const lines = [
    '# Provider configuration',
    'provider "example" {',
    '  endpoint = "https://api.example.com/v1" // trailing',
    '  retries  = 3',
    '  insecure = false',
    '  /* block',
    '     comment */',
    '  tags = { name = "x-${var.name}" }',
    '}',
  ];
  const tokens = tokenizeLines(lines, 'hcl');
  const types = (i) => tokens[i].filter((t) => t.type !== 'plain').map((t) => [t.type, t.text]);
  assert.deepEqual(types(0), [['comment', '# Provider configuration']]);
  assert.deepEqual(types(1), [['keyword', 'provider'], ['string', '"example"']]);
  assert.deepEqual(types(2), [['string', '"https://api.example.com/v1"'], ['comment', '// trailing']]);
  assert.deepEqual(types(3), [['number', '3']]);
  assert.deepEqual(types(4), [['literal', 'false']]);
  assert.deepEqual(types(5), [['comment', '/* block']]);
  assert.deepEqual(types(6), [['comment', '     comment */']]);
  assert.deepEqual(types(7), [['string', '"x-${var.name}"']]);
  assert.deepEqual(tokenizeLines(['resource "a" "b" {', 'variable "x" {}'], 'hcl').map((l) => l[0]), [
    { type: 'keyword', text: 'resource' },
    { type: 'keyword', text: 'variable' },
  ]);

  const card = buildCodePreviewCard(previewOf('provider.tf', lines));
  const rows = find(card, isHighlightedRow);
  assert.equal(rows.length, lines.length);
  const runs = rows.flatMap((r) => r.inlines);
  assert.ok(runs.some((r) => r.color === 'Good' && r.text === '"example"'));
  assert.ok(runs.some((r) => r.color === 'Warning' && r.text === '3'));
  assert.ok(runs.some((r) => r.isSubtle && r.text === '# Provider configuration'));
  assert.ok(runs.some((r) => r.color === 'Accent' && r.text === 'provider'));
  assert.equal(rowText(rows[2]).replaceAll(NBSP, ' ').slice(0, 14), '10    endpoint', 'indentation is kept');
});
