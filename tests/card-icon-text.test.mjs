import test from 'node:test';
import assert from 'node:assert/strict';
import { ICON_GAP_PX, gapColumn, iconTextColumns, iconTextRow } from '../src/card-icon-text.mjs';
import { NAME_GAP_PX } from '../src/card-user-row.mjs';

const icon = { type: 'Image', url: 'data:image/png;base64,AAAA', altText: 'Passed', width: '16px', height: '16px' };
const text = { type: 'TextBlock', text: 'Passed (#1)', wrap: true };

test('an icon and its text are three columns: the icon, one exact gap, the text', () => {
  const [first, gap, last] = iconTextColumns({ icon, content: text });
  assert.deepEqual(first, { type: 'Column', width: 'auto', verticalContentAlignment: 'Center', items: [icon] });
  assert.equal(gap.width, `${ICON_GAP_PX}px`);
  assert.equal(gap.spacing, 'None', 'no card column spacing in front of the gap');
  assert.equal(last.width, 'stretch');
  assert.equal(last.spacing, 'None', 'no card column spacing in front of the text');
  assert.deepEqual(last.items, [text]);
});

test('the content may be several items, the gap and widths can be chosen, and it can be a row of its own', () => {
  const [, gap, content] = iconTextColumns({ icon, content: [text, text], gapPx: 4, iconWidth: '16px', contentWidth: 'auto' });
  assert.equal(gap.width, '4px');
  assert.equal(content.width, 'auto');
  assert.equal(content.items.length, 2);
  const row = iconTextRow({ icon, content: text });
  assert.equal(row.type, 'ColumnSet');
  assert.equal(row.spacing, 'None');
  assert.equal(row.columns.length, 3);
});

test('pictures and names use the same gap as every other icon and text', () => {
  assert.equal(NAME_GAP_PX, ICON_GAP_PX);
  assert.equal(gapColumn().width, `${ICON_GAP_PX}px`);
});
