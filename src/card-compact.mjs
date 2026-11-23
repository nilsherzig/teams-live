// The compact merge request card groups short fact rows into responsive columns and shows
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
  const flow = row.columns[1]?.items[0];
  if (flow?.type !== 'Container') return row;
  // userRow places the pill first, followed by person chips. A Teams-badged
  // avatar is already cropped and therefore has no Person style.
  const [pill, ...chips] = flow.items;
  if (pill?.type !== 'Image') return row;
  const people = chips.flatMap((chip) =>
    (chip.columns ?? []).flatMap((column) => column.items.filter((item) => item.type === 'Image'))
  );
  if (people.length === 0) return row;
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
          ...flow,
          items: [pill, ...shown, ...(more > 0 ? [text(`+${more}`, { size: 'Small', isSubtle: true, wrap: false })] : [])],
        }],
      },
    ],
  };
}

/** One of the card's fact rows with the short label column. */
const narrow = (row) => ({ ...row, columns: [{ ...row.columns[0], width: LABEL_WIDTH }, ...row.columns.slice(1)] });

export function compactMrFacts(blocks) {
  if (!rowOf(blocks, 'Status') && !rowOf(blocks, 'Approval') && !rowOf(blocks, 'Pipeline')) return blocks;
  const groups = [
    { name: 'review', labels: ['Status', 'Approval', 'Pipeline'] },
    { name: 'details', labels: ['Author', 'Merge', 'Ticket'] },
  ];
  const items = groups.map(({ name, labels }) => ({
    type: 'Container',
    'grid.area': name,
    items: labels.map((label) => {
      const row = rowOf(blocks, label);
      return row && narrow(label === 'Approval' ? flowApproval(row) : row);
    }).filter(Boolean),
  })).filter((group) => group.items.length);
  // Below the grid breakpoint, Teams falls back to its default stack layout.
  const facts = {
    type: 'Container',
    spacing: 'Medium',
    layouts: [{
      type: 'Layout.AreaGrid',
      targetWidth: 'atLeast:standard',
      columns: [50, 50],
      columnSpacing: 'Small',
      areas: items.map((group, index) => ({ name: group['grid.area'], column: index + 1 })),
    }],
    items,
  };
  const rebase = rowOf(blocks, 'Rebase');
  const rebaseText = rebase?.columns?.[1]?.items?.[0]?.text?.replace('Required:', 'Rebase required:');
  const known = new Set([...groups.flatMap(({ labels }) => labels), 'Rebase']);
  const rest = blocks.filter((b) => !(b?.type === 'ColumnSet' && known.has(b.columns?.[0]?.items?.[0]?.text)));
  return [facts, ...(rebaseText ? [text(rebaseText, { size: 'Small', spacing: 'Small' })] : []), ...rest];
}
