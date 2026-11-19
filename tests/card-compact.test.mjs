import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMergeRequestCard } from '../src/cards.mjs';
import { initialsAvatar } from '../src/initials-avatar.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { stubDirectoryLookups } from './stub-transport.mjs';

const MR = {
  iid: 218,
  project: 'example-group/example-project',
  title: 'Add example feature',
  url: 'https://gitlab.example.com/example-group/example-project/-/merge_requests/218',
  state: 'open',
  author: 'Alice Example',
  approved: true,
  approvedBy: ['Bob Example', 'Carol Example', 'Dave Example'],
  approvalsGiven: 3,
  approvalsRequired: 3,
  autoMerge: true,
  pipeline: { id: 7, status: 'success', url: 'https://gitlab.example.com/p/7' },
  pipelineKnown: true,
  jira: { key: 'EX-1', url: 'https://jira.example.com/browse/EX-1' },
  avatars: Object.fromEntries(['Alice Example', 'Bob Example', 'Carol Example', 'Dave Example'].map((n) => [n, initialsAvatar(n)])),
};
const items = (card) => card.body[0].items;
const labels = (card) => JSON.stringify(card).match(/"text":"(Status|Author|Approval|Pipeline|Merge|Ticket|Rebase|Auto-merge)"/g)?.map((m) => m.slice(8, -1)) ?? [];
const images = (card, alt) => JSON.stringify(card).split(`"altText":"${alt}"`).length - 1;

test('the regular card keeps its rows, with the repository icon, no project line and the auto-merge icon', () => {
  const card = buildMergeRequestCard(MR);
  assert.deepEqual(labels(card), ['Status', 'Author', 'Approval', 'Pipeline', 'Auto-merge', 'Ticket']);
  assert.equal(JSON.stringify(card).includes('"text":"example-group/example-project"'), false, 'no project line');
  assert.equal(images(card, 'Repository'), 1);
  assert.equal(images(card, 'Auto-merge enabled'), 1);
  assert.equal(images(buildMergeRequestCard({ ...MR, autoMerge: false }), 'Auto-merge disabled'), 1);
});

test('the compact card keeps the header, title and icons, with short labels in two columns', () => {
  const card = buildMergeRequestCard(MR, { compact: true });
  const [header, title, grid] = items(card);
  assert.equal(header.type, 'ColumnSet');
  assert.equal(title.type, 'Container');
  assert.equal(grid.type, 'ColumnSet');
  assert.equal(grid.columns.length, 2);
  assert.equal(grid.spacing, 'Medium');
  assert.deepEqual(labels(card).sort(), ['Approval', 'Author', 'Merge', 'Pipeline', 'Status', 'Ticket']);
  // No project line under the title; a repository icon in the header links to the project instead.
  assert.equal(JSON.stringify(items(card).slice(1)).includes('"text":"example-group/example-project"'), false);
  const repo = header.columns.find((c) => c.items?.[0]?.altText === 'Repository');
  assert.equal(repo.selectAction.url, 'https://gitlab.example.com/example-group/example-project');
  // The reference stays last, right of the repository icon.
  assert.equal(header.columns.indexOf(repo), header.columns.length - 2);
  for (const alt of ['GitLab', 'Open', 'Approved', 'Passed', 'Jira', 'Auto-merge on']) assert.equal(images(card, alt) >= 1, true, alt);
});

test('the approval is one line: the pill and the approvers pictures, no names', () => {
  const card = buildMergeRequestCard(MR, { compact: true });
  const approval = JSON.stringify(card);
  for (const name of ['Bob Example', 'Carol Example', 'Dave Example']) {
    assert.equal(images(card, name), 1, `${name} has a picture`);
    assert.equal(approval.includes(`"text":"${name}"`), false, `${name} is not printed`);
  }
  const grid = items(card)[2];
  const row = grid.columns[0].items.find((r) => r.columns[0].items[0].text === 'Approval');
  assert.equal(row.columns.length, 1 + 1 + 3, 'label, pill, three pictures');
});

test('more than five approvers show five pictures and a count', () => {
  const names = ['A One', 'B Two', 'C Three', 'D Four', 'E Five', 'F Six', 'G Seven'];
  const avatars = Object.fromEntries(names.map((n) => [n, initialsAvatar(n)]));
  const card = buildMergeRequestCard({ ...MR, approvedBy: names, approvalsGiven: 7, avatars }, { compact: true });
  const row = items(card)[2].columns[0].items.find((r) => r.columns[0].items[0].text === 'Approval');
  assert.equal(row.columns.length, 1 + 1 + 5 + 1);
  assert.equal(row.columns.at(-1).items[0].text, '+2');
});

test('auto-merge is an icon and a short text: on, off, unknown', () => {
  const on = buildMergeRequestCard(MR, { compact: true });
  assert.equal(images(on, 'Auto-merge on'), 1);
  const off = buildMergeRequestCard({ ...MR, autoMerge: false }, { compact: true });
  assert.equal(images(off, 'Auto-merge off'), 1);
  assert.ok(JSON.stringify(off).includes('Auto-merge off'));
  const unknown = buildMergeRequestCard({ ...MR, autoMerge: null }, { compact: true });
  assert.ok(JSON.stringify(unknown).includes('"text":"Unknown"'));
  assert.equal(images(unknown, 'Auto-merge on') + images(unknown, 'Auto-merge off'), 0);
});

test('the rebase warning is a line of its own and only when needed', () => {
  const ok = buildMergeRequestCard(MR, { compact: true });
  assert.equal(JSON.stringify(ok).includes('Required'), false);
  const behind = buildMergeRequestCard({ ...MR, needsRebase: true }, { compact: true });
  const warning = items(behind)[3];
  assert.equal(warning.type, 'TextBlock');
  assert.equal(warning.text, '\u26a0\ufe0f Rebase required: behind target branch');
  assert.equal(JSON.stringify(behind).includes('status:'), false, 'the merge status is not repeated');
});

test('merged and closed cards stay valid and keep their buttons rules', () => {
  const merged = buildMergeRequestCard({ ...MR, state: 'merged', autoMerge: null }, { compact: true });
  assert.equal(merged.actions, undefined);
  assert.equal(images(merged, 'Auto-merge on') + images(merged, 'Auto-merge off'), 0, 'no auto-merge row once merged');
  const closed = buildMergeRequestCard({ ...MR, state: 'closed', reopenUrl: 'https://example.com/r' }, { compact: true });
  assert.equal(closed.actions[0].title, '🔄 Reopen');
});

test('the watcher builds the compact card only when teams.compact_cards is true', () => {
  const build = (teams) => {
    const watcher = stubDirectoryLookups(
      new MergeRequestWatcher({
        config: { conversations: [], gitlab: { group: 'group' }, teams },
        gitlab: { mrLink: (project, iid) => `https://gitlab.example.com/${project}/-/merge_requests/${iid}` },
        jira: null,
        opsgenie: null,
      }),
    );
    return watcher.buildMrCard({ project: 'group/app', iid: 7, title: 'Example' }, { title: 'Example', author: 'Alice Example', approved: false, autoMerge: false });
  };
  // The compact grid is one ColumnSet whose columns hold the fact rows; the classic card's rows hold a label and a value.
  const compactGrid = (card) => card.body[0].items[2].columns?.[0]?.items?.[0]?.type === 'ColumnSet';
  assert.equal(compactGrid(build({ rich_messages: true, compact_cards: true })), true);
  assert.equal(compactGrid(build({ rich_messages: true })), false, 'the classic card without the setting (the default comes from the config loader)');
  assert.equal(compactGrid(build({ rich_messages: true, compact_cards: false })), false);
});

test('an approver without a photo gets an initials picture in the compact card, not the generic silhouette', async () => {
  const { PLACEHOLDER_AVATAR } = await import('../src/placeholder-avatar.mjs');
  for (const approvedBy of [['Lena Muster'], ['Lena Muster', 'Max Mustermann']]) {
    const card = buildMergeRequestCard({ ...MR, approvedBy, approvalsGiven: approvedBy.length, avatars: { 'Alice Example': initialsAvatar('Alice Example') } }, { compact: true });
    const row = items(card)[2].columns[0].items.find((r) => r.columns[0].items[0].text === 'Approval');
    const pictures = row.columns.map((c) => c.items?.[0]).filter((i) => i?.style === 'Person');
    assert.equal(pictures.length, approvedBy.length);
    for (const picture of pictures) {
      assert.notEqual(picture.url, PLACEHOLDER_AVATAR, 'initials, not the silhouette');
      assert.ok(approvedBy.includes(picture.altText));
    }
    assert.equal(pictures[0].url, initialsAvatar('Lena Muster'));
  }
});
