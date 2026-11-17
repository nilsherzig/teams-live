import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMergeRequestCard, mrStateBadge } from '../src/cards.mjs';
import { MR_BADGES } from '../src/mr-badges.mjs';

const baseMr = {
  iid: 42,
  project: 'group/project',
  title: 'Add example feature',
  url: 'https://gitlab.example.com/group/project/-/merge_requests/42',
};

const rows = (card) =>
  card.body[0].items.filter((i) => i.type === 'ColumnSet' && /^\d+px$/.test(i.columns[0]?.width || ''));
const statusRow = (card) => rows(card).find((r) => r.columns[0].items[0].text === 'Status');
const badgeImage = (card) => statusRow(card).columns.flatMap((c) => c.items).find((i) => i.type === 'Image');
const trailText = (card) =>
  statusRow(card)
    .columns.slice(2)
    .flatMap((c) => c.items.map((i) => i.text));

test('the badge assets: one PNG pill per state, with its state in words as altText', () => {
  assert.deepEqual(Object.keys(MR_BADGES).sort(), ['closed', 'draft', 'merged', 'open']);
  const labels = { open: 'Open', merged: 'Merged', closed: 'Closed', draft: 'Draft' };
  for (const [key, badge] of Object.entries(MR_BADGES)) {
    assert.equal(badge.alt, labels[key]);
    assert.match(badge.url, /^data:image\/png;base64,iVBOR/);
    // Small enough not to bloat the message (a card shows one).
    assert.ok(badge.url.length < 3_000, `${key} badge is ${badge.url.length} bytes`);
    assert.equal(badge.height, 22);
    assert.ok(Number.isInteger(badge.width) && badge.width >= 60 && badge.width <= 100);
    // The PNG is drawn at 3x: its header carries 3x the displayed size.
    const png = Buffer.from(badge.url.split(',')[1], 'base64');
    assert.equal(png.readUInt32BE(16), badge.width * 3);
    assert.equal(png.readUInt32BE(20), badge.height * 3);
  }
});

test('mrStateBadge: merged and closed win over a draft flag, draft only while open', () => {
  assert.equal(mrStateBadge('open'), MR_BADGES.open);
  assert.equal(mrStateBadge('rebase'), MR_BADGES.open);
  assert.equal(mrStateBadge('open', true), MR_BADGES.draft);
  assert.equal(mrStateBadge('merged', true), MR_BADGES.merged);
  assert.equal(mrStateBadge('closed', true), MR_BADGES.closed);
  assert.equal(mrStateBadge(undefined), MR_BADGES.open);
});

test('merge request card: the Status row is the state badge, not an emoji', () => {
  const cases = [
    [{ state: 'open' }, 'open'],
    [{ state: 'open', draft: true }, 'draft'],
    [{ state: 'merged' }, 'merged'],
    [{ state: 'closed' }, 'closed'],
  ];
  for (const [mr, key] of cases) {
    const card = buildMergeRequestCard({ ...baseMr, ...mr });
    const row = statusRow(card);
    assert.equal(row.columns[0].items[0].text, 'Status', 'the bold label stays, aligned with the other facts');
    const image = badgeImage(card);
    assert.equal(image.url, MR_BADGES[key].url);
    assert.equal(image.altText, MR_BADGES[key].alt);
    assert.equal(image.width, `${MR_BADGES[key].width}px`);
    assert.equal(image.height, `${MR_BADGES[key].height}px`);
    // Nothing else in the row: the state is in the image, no dot, no repeated text.
    assert.equal(row.columns.length, 2);
    assert.doesNotMatch(JSON.stringify(card.body).replace(/data:image[^"]*/g, ''), /[\u{1F7E0}-\u{1F7EB}⚪]/u);
  }
});

test('merge request card: rebase notices stay readable text next to the badge', () => {
  const rebase = buildMergeRequestCard({ ...baseMr, state: 'rebase', hasConflicts: true });
  assert.equal(badgeImage(rebase).altText, 'Open');
  assert.deepEqual(trailText(rebase), ['⚠️ Rebase required (merge conflicts)']);
  const draft = buildMergeRequestCard({ ...baseMr, state: 'rebase', draft: true });
  assert.equal(badgeImage(draft).altText, 'Draft');
  const rebased = buildMergeRequestCard({ ...baseMr, state: 'rebased' });
  assert.deepEqual(trailText(rebased), ['✅ Rebased, up to date and conflict-free']);
});

test('merge request card: still Adaptive Card 1.4 and valid JSON with the badge', () => {
  const card = buildMergeRequestCard({ ...baseMr, state: 'merged' });
  assert.equal(card.version, '1.4');
  assert.deepEqual(JSON.parse(JSON.stringify(card)), card);
});

test('merge request card: the outer container stays neutral for every state and signal', () => {
  const variants = [
    {},
    { state: 'open', approved: true, pipeline: { id: 1, status: 'success' } },
    { state: 'open', pipeline: { id: 2, status: 'failed' } },
    { state: 'open', needsRebase: true, approved: false },
    { state: 'open', draft: true },
    { state: 'rebase' },
    { state: 'rebased' },
    { state: 'merged' },
    { state: 'closed' },
  ];
  for (const v of variants) {
    const card = buildMergeRequestCard({ ...baseMr, ...v });
    assert.equal(card.body[0].style, 'emphasis', JSON.stringify(v));
    // Only the state badge image carries colour: no coloured column or text on the card.
    assert.doesNotMatch(JSON.stringify(card.body).replace(/data:image[^"]*/g, ''), /"style":"(good|attention|warning|accent)"/);
  }
});

test('badge colours: open teal, merged light blue (not purple), closed red, draft neutral', () => {
  const palette = (badge) => {
    const png = Buffer.from(badge.url.split(',')[1], 'base64');
    const at = png.indexOf('PLTE');
    const length = png.readUInt32BE(at - 4);
    const colours = [];
    for (let i = 0; i < length; i += 3) colours.push([...png.subarray(at + 4 + i, at + 7 + i)]);
    return colours;
  };
  const has = (badge, test) => palette(badge).some(([r, g, b]) => test(r, g, b));
  assert.ok(has(MR_BADGES.open, (r, g, b) => g > r + 40 && Math.abs(g - b) < 50 && g > 200), 'teal fill');
  assert.ok(has(MR_BADGES.merged, (r, g, b) => b > r + 20 && b > 220 && g > r), 'light blue fill');
  assert.ok(!has(MR_BADGES.merged, (r, g, b) => r > g + 20 && b > g + 20), 'no purple anywhere');
  assert.ok(has(MR_BADGES.closed, (r, g, b) => r > 240 && g > 200 && b > 200 && r > g), 'light red fill');
  assert.ok(!has(MR_BADGES.draft, (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) > 12), 'draft is neutral grey');
  // Dark glyph and text on every fill.
  for (const badge of Object.values(MR_BADGES)) assert.ok(has(badge, (r, g, b) => r + g + b < 330), badge.alt);
});
