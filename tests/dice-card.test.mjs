import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CARD_BYTES } from '../src/cards.mjs';
import { makeRichMessage, richMessageWireBytes } from '../src/teams.mjs';
import {
  MAX_DICE,
  MAX_OPTIONS,
  MAX_SIDES,
  buildDiceCard,
  diceNotation,
  formatDiceMarkdown,
  parseDiceArgs,
  parsePickOptions,
  pickOption,
  rollDice,
} from '../src/card-dice.mjs';

// The /dice card and its notation. All names are generic fakes.

const seq = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};
// rng() is in [0, 1): the value of a d<S> is floor(r * S) + 1.
const at = (value, sides) => (value - 1) / sides + 0.0001;

const walkAll = (node, fn) => {
  if (Array.isArray(node)) return node.forEach((n) => walkAll(n, fn));
  if (!node || typeof node !== 'object') return;
  fn(node);
  Object.values(node).forEach((v) => walkAll(v, fn));
};
const texts = (card) => {
  const out = [];
  walkAll(card, (n) => n.type === 'TextBlock' && out.push(n.text));
  return out;
};

test('no argument is one d6; a bare number is a die with that many sides', () => {
  assert.deepEqual(parseDiceArgs([]), { mode: 'roll', count: 1, sides: 6, keep: null, modifier: 0, advantage: null });
  assert.equal(parseDiceArgs(['100']).sides, 100);
  assert.equal(parseDiceArgs(['d20']).sides, 20);
  assert.equal(parseDiceArgs(['2d6']).count, 2);
});

test('notation: modifiers, keep rules, advantage and spaces', () => {
  assert.equal(diceNotation(parseDiceArgs(['2d6+3'])), '2d6+3');
  assert.equal(diceNotation(parseDiceArgs(['2d6', '-', '1'])), '2d6−1');
  assert.equal(diceNotation(parseDiceArgs(['4d6kh3'])), '4d6kh3');
  assert.deepEqual(parseDiceArgs(['4d6kl2']).keep, { kind: 'low', count: 2 });
  assert.deepEqual(parseDiceArgs(['4d6k3']).keep, { kind: 'high', count: 3 });
  const adv = parseDiceArgs(['d20', 'adv']);
  assert.deepEqual([adv.count, adv.sides, adv.keep], [2, 20, { kind: 'high', count: 1 }]);
  assert.equal(diceNotation(adv), 'd20 adv');
  assert.equal(parseDiceArgs(['adv']).sides, 20);
  assert.deepEqual(parseDiceArgs(['d20+5', 'dis']).keep, { kind: 'low', count: 1 });
  assert.equal(parseDiceArgs(['d20+5', 'dis']).modifier, 5);
});

test('limits: dice, sides, modifier and keep are clamped; nonsense is rejected', () => {
  assert.equal(parseDiceArgs(['99d6']).count, MAX_DICE);
  assert.equal(parseDiceArgs(['d99999']).sides, MAX_SIDES);
  assert.equal(parseDiceArgs(['2d6kh9']).keep.count, 2);
  for (const bad of [['1'], ['0d6'], ['2d1'], ['+3'], ['2d6x'], ['banana'], ['2d6', 'adv'], ['4d6kh3', 'adv'], ['5+2']]) {
    assert.equal(parseDiceArgs(bad), null, bad.join(' '));
  }
});

test('a separator makes it a pick; options are trimmed, de-duplicated and capped', () => {
  assert.deepEqual(parseDiceArgs(['pizza', '|', 'sushi', '|', 'tacos']), { mode: 'pick', options: ['pizza', 'sushi', 'tacos'] });
  assert.deepEqual(parsePickOptions('Alice, bob or Carol'), ['Alice', 'bob', 'Carol']);
  assert.deepEqual(parsePickOptions('a | A | b'), ['a', 'b'], 'duplicates ignoring case');
  assert.equal(parsePickOptions('a |'), null, 'one option is not a pick');
  assert.equal(parsePickOptions('pizza'), null);
  assert.equal(parsePickOptions(Array.from({ length: 30 }, (_, i) => `o${i}`).join('|')).length, MAX_OPTIONS);
});

test('rolling: totals, modifier and the keep rules drop the right dice', () => {
  const plain = rollDice(parseDiceArgs(['2d6+3']), seq(at(4, 6), at(5, 6)));
  assert.deepEqual(plain.rolls.map((r) => r.value), [4, 5]);
  assert.equal(plain.total, 12);

  const keep = rollDice(parseDiceArgs(['4d6kh3']), seq(at(1, 6), at(6, 6), at(3, 6), at(5, 6)));
  assert.deepEqual(keep.rolls.map((r) => r.dropped), [true, false, false, false]);
  assert.equal(keep.total, 14);

  const low = rollDice(parseDiceArgs(['3d6kl1']), seq(at(4, 6), at(2, 6), at(6, 6)));
  assert.equal(low.total, 2);

  const dis = rollDice(parseDiceArgs(['d20', 'dis']), seq(at(15, 20), at(8, 20)));
  assert.equal(dis.total, 8);
});

test('a natural 20 or 1 is flagged on a single (kept) d20 only', () => {
  assert.equal(rollDice(parseDiceArgs(['d20']), seq(at(20, 20))).natural, 'max');
  assert.equal(rollDice(parseDiceArgs(['d20']), seq(at(1, 20))).natural, 'min');
  assert.equal(rollDice(parseDiceArgs(['d20']), seq(at(10, 20))).natural, null);
  assert.equal(rollDice(parseDiceArgs(['d20', 'adv']), seq(at(1, 20), at(20, 20))).natural, 'max', 'the kept die counts');
  assert.equal(rollDice(parseDiceArgs(['2d20']), seq(at(20, 20), at(20, 20))).natural, null);
  assert.equal(rollDice(parseDiceArgs(['d6']), seq(at(6, 6))).natural, null);
});

test('every die stays within 1..sides over many rolls', () => {
  const spec = parseDiceArgs(['20d1000']);
  for (let i = 0; i < 50; i++) for (const r of rollDice(spec).rolls) assert.ok(r.value >= 1 && r.value <= 1000);
});

test('picking: the rng index chooses; the first and last options are reachable', () => {
  assert.equal(pickOption(['a', 'b', 'c'], () => 0).index, 0);
  assert.equal(pickOption(['a', 'b', 'c'], () => 0.999).index, 2);
});

test('markdown fallback carries the figures', () => {
  const r = rollDice(parseDiceArgs(['4d6kh3+1']), seq(at(1, 6), at(6, 6), at(3, 6), at(5, 6)));
  assert.equal(formatDiceMarkdown(r, 'Alice Example'), '🎲 **Alice Example** rolled **4d6kh3+1**: **15** = [~~1~~, 6, 3, 5] + 1');
  assert.match(formatDiceMarkdown(rollDice(parseDiceArgs(['d20']), seq(at(20, 20)))), /natural 20/);
  assert.equal(formatDiceMarkdown(rollDice(parseDiceArgs(['d20']), seq(at(7, 20)))), '🎲 rolled **d20**: **7**');
  assert.equal(
    formatDiceMarkdown(pickOption(['pizza', 'sushi'], () => 0.9), 'Alice Example'),
    '🎯 **Alice Example** drew: **sushi**\n\n_from pizza · sushi_'
  );
});

test('the roll card: header, big total, chips, valid and small', () => {
  const r = rollDice(parseDiceArgs(['4d6kh3+1']), seq(at(1, 6), at(6, 6), at(3, 6), at(5, 6)));
  const card = buildDiceCard(r, { who: 'Alice Example' });
  assert.equal(card.type, 'AdaptiveCard');
  assert.deepEqual(JSON.parse(JSON.stringify(card)), card);
  const t = texts(card);
  assert.ok(t.some((x) => x.includes('Dice')), 'header');
  assert.ok(t.includes('15'), 'total');
  assert.ok(t.includes('4d6kh3+1'));
  assert.ok(t.includes('Alice Example rolled'));
  assert.ok(t.includes('keeping the highest 3'));
  assert.ok(t.includes('⚀') && t.includes('⚅'), 'd6 faces');
  assert.ok(richMessageWireBytes(makeRichMessage('x', card)) <= MAX_CARD_BYTES);
  assert.equal(card.fallbackText, formatDiceMarkdown(r, 'Alice Example'));
});

test('a single d20 with no modifier is just the big total; a nat 20 says so', () => {
  const card = buildDiceCard(rollDice(parseDiceArgs(['d20']), seq(at(20, 20))));
  const t = texts(card);
  assert.ok(t.includes('20') && t.includes('🎉 Natural 20!'));
  assert.ok(!t.some((x) => /rolled$/.test(x)), 'no roller line without a name');
});

test('the biggest roll still fits one card', () => {
  const r = rollDice(parseDiceArgs(['20d1000+1000']));
  assert.ok(richMessageWireBytes(makeRichMessage('x', buildDiceCard(r, { who: 'Alice Example' }))) <= MAX_CARD_BYTES);
});

test('the pick card highlights the winner and lists every option', () => {
  const card = buildDiceCard(pickOption(['pizza', 'sushi', 'tacos'], () => 0.5), { who: 'Alice Example' });
  const t = texts(card);
  assert.ok(t.includes('sushi'), 'winner');
  assert.ok(t.includes('🎯 sushi'));
  assert.ok(t.includes('• pizza') && t.includes('• tacos'));
  assert.ok(t.includes('Alice Example drew from 3 options'));
});
