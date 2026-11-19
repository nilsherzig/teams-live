// The compact merge request card: same header, title and icons as the regular card, but the facts sit in
// two columns with short labels, the approval is one line (pill and pictures), and the project line under
// the title is replaced by a repository icon in the header. Pure functions on the card's own blocks.

import { GITLAB_ICONS_SMALL } from './gitlab-icons-small.mjs';

const LABEL_WIDTH = '72px';
const MAX_APPROVER_PICTURES = 5;

const text = (value, extra = {}) => ({ type: 'TextBlock', text: value, wrap: true, ...extra });

/** The fact row (a ColumnSet whose first column holds the label) with this label, or null. */
const rowOf = (blocks, label) => blocks.find((b) => b?.type === 'ColumnSet' && b.columns?.[0]?.items?.[0]?.text === label) || null;

/** Icon and text for the auto-merge fact: the GitLab clock when on, the gray pause when off. */
export function autoMergeFact(autoMerge) {
  if (autoMerge === true) return ['Merge', 'Auto-merge on', { logo: GITLAB_ICONS_SMALL.clock, alt: 'Auto-merge on' }];
  if (autoMerge === false) return ['Merge', 'Auto-merge off', { logo: GITLAB_ICONS_SMALL.status_pending, alt: 'Auto-merge off' }];
  return ['Merge', 'Unknown'];
}

/** The auto-merge fact of the regular card: the same icons, the label stays, the text is Enabled or Disabled. */
export function autoMergeRegularFact(autoMerge, fallbackText = '') {
  // Nothing to say (a finished merge request that never had auto-merge): no row.
  if (!fallbackText) return ['Auto-merge', ''];
  if (autoMerge === true) return ['Auto-merge', 'Enabled', { logo: GITLAB_ICONS_SMALL.clock, alt: 'Auto-merge enabled' }];
  if (autoMerge === false) return ['Auto-merge', 'Disabled', { logo: GITLAB_ICONS_SMALL.status_pending, alt: 'Auto-merge disabled' }];
  return ['Auto-merge', fallbackText];
}

/** The header column with the repository icon, linking to the project; null without a project URL. */
export function repoIconColumn(projectUrl) {
  if (!projectUrl || !GITLAB_ICONS_SMALL.repository) return null;
  return {
    type: 'Column',
    width: 'auto',
    verticalContentAlignment: 'Center',
    selectAction: { type: 'Action.OpenUrl', url: projectUrl },
    items: [{ type: 'Image', url: GITLAB_ICONS_SMALL.repository, altText: 'Repository', width: '16px', height: '16px' }],
  };
}

/**
 * The approval row on one line: the pill, then only the approvers' pictures (their names stay as alt text),
 * five at most and "+N" for the rest. A row without a pill or without pictures stays as it is.
 */
function oneLineApproval(row) {
  if (!row) return row;
  const images = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === 'Image') images.push(node);
    walk(node.columns);
    walk(node.items);
  };
  walk(row.columns.slice(1));
  const pill = images.find((i) => i.style !== 'Person');
  const people = images.filter((i) => i.style === 'Person');
  if (!pill || people.length === 0) return row;
  const shown = people.slice(0, MAX_APPROVER_PICTURES);
  const more = people.length - shown.length;
  const cell = (item, width = 'auto', extra = {}) => ({ type: 'Column', width, verticalContentAlignment: 'Center', ...extra, items: [item] });
  return {
    ...row,
    columns: [
      row.columns[0],
      cell(pill),
      ...shown.map((p) => cell(p, `${parseInt(p.width, 10) || 18}px`, { spacing: 'Small' })),
      ...(more > 0 ? [cell(text(`+${more}`, { size: 'Small', isSubtle: true, wrap: false }))] : []),
    ],
  };
}

/** One of the card's fact rows with the short label column. */
const narrow = (row) => ({ ...row, columns: [{ ...row.columns[0], width: LABEL_WIDTH }, ...row.columns.slice(1)] });

/**
 * Re-lays the fact rows of a merge request card: Status, Approval and Pipeline on the left, Author, Merge and
 * Ticket on the right, the rebase warning in a line of its own. Blocks it does not know follow unchanged; when
 * the rows are not the expected ones (a plain FactSet) the blocks are returned as they are.
 */
export function compactMrFacts(blocks) {
  if (!rowOf(blocks, 'Status') && !rowOf(blocks, 'Approval') && !rowOf(blocks, 'Pipeline')) return blocks;
  const column = (labels) => ({
    type: 'Column',
    width: 'stretch',
    items: labels
      .map((label) => (label === 'Approval' ? oneLineApproval(rowOf(blocks, label)) : rowOf(blocks, label)))
      .filter(Boolean)
      .map(narrow),
  });
  const known = new Set(['Status', 'Approval', 'Pipeline', 'Author', 'Merge', 'Ticket', 'Rebase']);
  const rebase = rowOf(blocks, 'Rebase');
  const rebaseText = rebase?.columns?.[1]?.items?.[0]?.text;
  const rest = blocks.filter((b) => !(b?.type === 'ColumnSet' && known.has(b.columns?.[0]?.items?.[0]?.text)));
  return [
    { type: 'ColumnSet', spacing: 'Medium', columns: [column(['Status', 'Approval', 'Pipeline']), column(['Author', 'Merge', 'Ticket'])] },
    ...(rebaseText ? [text(rebaseText, { size: 'Small', spacing: 'Small' })] : []),
    ...rest,
  ];
}
