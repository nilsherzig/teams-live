import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJobCard, buildMergeRequestCard, buildPipelineCard, ciStatusIcon, MAX_CARD_BYTES } from '../src/cards.mjs';
import { CI_STATUS_ICONS } from '../src/ci-icons.mjs';

const rows = (card) =>
  card.body[0].items.filter((i) => i.type === 'ColumnSet' && /^\d+px$/.test(i.columns[0]?.width || ''));
const rowOf = (card, title) => rows(card).find((r) => r.columns[0].items[0].text === title);
const iconOf = (row) => row.columns.flatMap((c) => c.items).find((i) => i.type === 'Image');
const textOf = (row) =>
  row.columns
    .slice(1)
    .flatMap((c) => c.items)
    .filter((i) => i.type === 'TextBlock' && i.text !== '') // the empty one is the gap column
    .map((i) => i.text)
    .join(' ');

test('the status icon assets: small PNGs with the status in words as altText', () => {
  assert.deepEqual(Object.keys(CI_STATUS_ICONS).sort(), [
    'canceled',
    'created',
    'failed',
    'manual',
    'pending',
    'preparing',
    'running',
    'scheduled',
    'skipped',
    'success',
    'unknown',
    'warning',
  ]);
  for (const [key, icon] of Object.entries(CI_STATUS_ICONS)) {
    assert.ok(icon.alt, key);
    assert.match(icon.url, /^data:image\/png;base64,iVBOR/);
    assert.ok(icon.url.length < 1_500, `${key} icon is ${icon.url.length} bytes`);
    // Drawn at 3x for a 16px display.
    const png = Buffer.from(icon.url.split(',')[1], 'base64');
    assert.equal(png.readUInt32BE(16), 48);
    assert.equal(png.readUInt32BE(20), 48);
  }
  assert.equal(new Set(Object.values(CI_STATUS_ICONS).map((i) => i.url)).size >= 9, true, 'the states look different');
});

test('ciStatusIcon maps GitLab statuses, spelling variants and unknown values', () => {
  assert.equal(ciStatusIcon('success'), CI_STATUS_ICONS.success);
  assert.equal(ciStatusIcon('passed'), CI_STATUS_ICONS.success);
  assert.equal(ciStatusIcon('FAILED'), CI_STATUS_ICONS.failed);
  assert.equal(ciStatusIcon('success_with_warnings'), CI_STATUS_ICONS.warning);
  assert.equal(ciStatusIcon('cancelled'), CI_STATUS_ICONS.canceled);
  assert.equal(ciStatusIcon('canceled'), CI_STATUS_ICONS.canceled);
  assert.equal(ciStatusIcon('waiting_for_resource'), CI_STATUS_ICONS.pending);
  for (const status of ['running', 'pending', 'preparing', 'created', 'scheduled', 'skipped', 'manual']) {
    assert.equal(ciStatusIcon(status), CI_STATUS_ICONS[status], status);
  }
  for (const status of ['weird', '', undefined, null]) assert.equal(ciStatusIcon(status), CI_STATUS_ICONS.unknown, String(status));
});

test('job and pipeline cards: neutral container, status icon next to the readable status', () => {
  for (const status of ['success', 'failed', 'running', 'canceled', 'manual', 'skipped', 'pending', 'weird']) {
    for (const card of [buildJobCard({ id: 5, name: 'build', status }), buildPipelineCard({ id: 9, status, project: 'g/p' })]) {
      assert.equal(card.body[0].style, 'emphasis', `${status}: no status background`);
      const row = rowOf(card, 'Status');
      const icon = iconOf(row);
      assert.equal(icon.altText, ciStatusIcon(status).alt);
      assert.equal(icon.url, ciStatusIcon(status).url);
      assert.equal(icon.width, '16px');
      assert.ok(textOf(row).length > 0, 'the text stays readable without the image');
    }
  }
});

test('merge request card: the Pipeline row carries the icon, the text and the link', () => {
  const url = 'https://gitlab.example.com/group/project/-/pipelines/7';
  const card = buildMergeRequestCard({
    iid: 42,
    project: 'group/project',
    title: 'T',
    url: 'https://gitlab.example.com/group/project/-/merge_requests/42',
    state: 'open',
    pipeline: { id: 7, status: 'failed', url },
  });
  const row = rowOf(card, 'Pipeline');
  assert.equal(iconOf(row).url, CI_STATUS_ICONS.failed.url);
  assert.equal(textOf(row), `[Failed (#7)](${url})`);

  const unknown = buildMergeRequestCard({
    iid: 42,
    project: 'group/project',
    title: 'T',
    url: 'https://gitlab.example.com/group/project/-/merge_requests/42',
    state: 'open',
    pipeline: { id: 9 },
  });
  assert.equal(iconOf(rowOf(unknown, 'Pipeline')).url, CI_STATUS_ICONS.unknown.url);
  assert.equal(textOf(rowOf(unknown, 'Pipeline')), 'Unknown (#9)');
});

test('wire budget: the status icons keep a card keep a card under the wire limit with headroom', () => {
  const mr = buildMergeRequestCard({
    iid: 42,
    project: 'group/project',
    title: 'T',
    url: 'https://gitlab.example.com/group/project/-/merge_requests/42',
    state: 'open',
    pipeline: { id: 7, status: 'running' },
  });
  for (const card of [mr, buildJobCard({ id: 5, name: 'b', status: 'failed' }), buildPipelineCard({ id: 9, status: 'success' })]) {
    assert.ok(Buffer.byteLength(JSON.stringify(card)) < MAX_CARD_BYTES - 8_000);
  }
});
