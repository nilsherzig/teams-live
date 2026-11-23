// The compact merge request card uses short labels in full-width fact rows and shows
// approver pictures beside the approval pill when there is room.

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
 * Let the approval pill and up to five approver pictures wrap within the value column.
 * Names remain in image alt text, with a "+N" count for the remaining approvers.
 */
function flowApproval(row) {
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
  return {
    ...row,
    columns: [
      row.columns[0],
      {
        type: 'Column',
        width: 'stretch',
        items: [{
          type: 'Container',
          layouts: [{ type: 'Layout.Flow', horizontalItemsAlignment: 'Left', verticalItemsAlignment: 'Center', columnSpacing: 'Small', rowSpacing: 'Small' }],
          items: [pill, ...shown, ...(more > 0 ? [text(`+${more}`, { size: 'Small', isSubtle: true, wrap: false })] : [])],
        }],
      },
    ],
  };
}

/** One of the card's fact rows with the short label column. */
const narrow = (row) => ({ ...row, columns: [{ ...row.columns[0], width: LABEL_WIDTH }, ...row.columns.slice(1)] });

/** Give each compact fact its own row so its value can use the available card width. */
export function compactMrFacts(blocks) {
  if (!rowOf(blocks, 'Status') && !rowOf(blocks, 'Approval') && !rowOf(blocks, 'Pipeline')) return blocks;
  const labels = ['Status', 'Approval', 'Pipeline', 'Author', 'Merge', 'Ticket'];
  const rows = labels.map((label) => rowOf(blocks, label)).filter(Boolean).map((row, index) => {
    const fact = row.columns[0].items[0].text === 'Approval' ? flowApproval(row) : row;
    return { ...narrow(fact), spacing: index === 0 ? 'Medium' : fact.spacing };
  });
  const rebase = rowOf(blocks, 'Rebase');
  const rebaseText = rebase?.columns?.[1]?.items?.[0]?.text?.replace('Required:', 'Rebase required:');
  const known = new Set([...labels, 'Rebase']);
  const rest = blocks.filter((b) => !(b?.type === 'ColumnSet' && known.has(b.columns?.[0]?.items?.[0]?.text)));
  return [...rows, ...(rebaseText ? [text(rebaseText, { size: 'Small', spacing: 'Small' })] : []), ...rest];
}
