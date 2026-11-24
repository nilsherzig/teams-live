import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isRichMessage, messageMarkdown, richMessageWireBytes, setRichMessages } from '../src/teams.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { MAX_CARD_BYTES, buildMrListCard, mrListState } from '../src/cards.mjs';
import { GITLAB_ICONS_SMALL } from '../src/gitlab-icons-small.mjs';
import { CI_STATUS_ICONS } from '../src/ci-icons.mjs';

const ciUrls = new Set(Object.values(CI_STATUS_ICONS).map((i) => i.url));

beforeEach(() => setRichMessages(false));

const GL = 'https://gitlab.example.com/example-group';

function newWatcher(teams = { rich_messages: true }, jira = null) {
  const watcher = new MergeRequestWatcher({
    config: { conversations: [], gitlab: { group: 'example-group', notify: {} }, teams },
    gitlab: { findMrLinks: () => [], mrLink: () => '', pipelineLink: () => '', getMr: async () => null },
    jira,
    opsgenie: null,
  });
  watcher.saveState = () => {};
  watcher.userDirectory.formatMention = (a) => `@[${a.name}](8:orgid:0000)`;
  return watcher;
}

const mr = (project, iid, title, extra = {}) => ({
  iid,
  title,
  web_url: `${GL}/${project}/-/merge_requests/${iid}`,
  references: { full: `example-group/${project}!${iid}` },
  author: { name: 'Alice Example', username: 'alice' },
  draft: false,
  state: 'opened',
  approval_summary: { known: true, approved: false, approvedBy: [] },
  ...extra,
});

const humanMrs = [
  mr('app', 12, 'Add example feature', {
    detailed_merge_status: 'mergeable',
    head_pipeline: { status: 'success' },
    approval_summary: { known: true, approved: true, approvedBy: ['Bob Example'] },
    auto_merge_enabled: true,
  }),
  mr('app', 15, 'Fix flaky *test* in [module]', {
    author: { name: 'Bob Example', username: 'bob' },
    detailed_merge_status: 'ci_must_pass',
    head_pipeline: { status: 'failed' },
  }),
  mr('app', 18, 'WIP: refactor', { draft: true, detailed_merge_status: 'draft_status', head_pipeline: { status: 'running' } }),
  mr('docs', 4, 'Update the guide', { detailed_merge_status: 'need_rebase' }),
  mr('infra/charts', 2, 'Bump chart', { has_conflicts: true, detailed_merge_status: 'conflict' }),
];
const botMrs = (n) =>
  Array.from({ length: n }, (_, i) =>
    mr('app', 100 + i, `Update dependency example-lib to v1.${i}`, {
      author: { name: 'Renovate Bot', username: 'renovate-bot' },
      detailed_merge_status: 'mergeable',
      head_pipeline: { status: 'success' },
    })
  );

const rich = (watcher, mrs, parsed = {}) => {
  const message = watcher.formatMrsMessage(mrs, parsed);
  assert.equal(isRichMessage(message), true, 'expected a card');
  return message;
};
const bodyItems = (message) => message.card.body[0].items;
const walk = (node, visit) => {
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((v) => v && typeof v === 'object' && walk(v, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
};
const allNodes = (message) => {
  const nodes = [];
  walk(message.card, (n) => nodes.push(n));
  return nodes;
};
const texts = (message) => allNodes(message).filter((n) => n.type === 'TextBlock').map((n) => n.text);
const images = (message) => allNodes(message).filter((n) => n.type === 'Image');

test('mrListState: draft never masks merged or closed', () => {
  assert.equal(mrListState({ state: 'opened' }), 'open');
  assert.equal(mrListState({ state: 'opened', draft: true }), 'draft');
  assert.equal(mrListState({ state: 'merged', draft: true }), 'merged');
  assert.equal(mrListState({ state: 'closed', draft: true }), 'closed');
  assert.equal(mrListState({}), 'open');
});




test('/mrs card: a row without a pipeline has no CI icon and keeps a single meta line', () => {
  const rows = [{ project: 'app', ref: '!1', url: `${GL}/app/-/merge_requests/1`, title: 'No pipeline', state: 'open', author: 'Alice' }];
  const card = buildMrListCard({ title: 'Merge requests', sections: [{ rows }] });
  const nodes = [];
  walk(card, (n) => nodes.push(n));
  assert.equal(nodes.filter((n) => n.type === 'Image' && ciUrls.has(n.url)).length, 0);
  assert.ok(nodes.some((n) => n.type === 'TextBlock' && n.text === 'Open \u00b7 Alice'));
});

test('/mrs card: without images the CI status falls back to its emoji in the meta line', () => {
  const rows = [{ project: 'app', ref: '!1', url: `${GL}/app/-/merge_requests/1`, title: 'T', state: 'open', author: 'Alice', ciStatus: 'success' }];
  const card = buildMrListCard({ title: 'Merge requests', sections: [{ rows }], images: false });
  const nodes = [];
  walk(card, (n) => nodes.push(n));
  assert.equal(nodes.filter((n) => n.type === 'Image' && ciUrls.has(n.url)).length, 0);
  assert.ok(nodes.some((n) => n.type === 'TextBlock' && n.text.includes('\u2705 CI passed')));
});

test('/mrs card: merged and closed rows get their own GitLab glyphs', () => {
  const card = buildMrListCard({
    title: 'Merge requests',
    sections: [
      {
        rows: [
          { project: 'app', ref: '!1', url: `${GL}/app/-/merge_requests/1`, title: 'Done', state: 'merged', author: 'Alice' },
          { project: 'app', ref: '!2', url: `${GL}/app/-/merge_requests/2`, title: 'Dropped', state: 'closed', author: 'Alice' },
        ],
      },
    ],
  });
  const nodes = [];
  walk(card, (n) => nodes.push(n));
  const imgs = nodes.filter((n) => n.type === 'Image' && n.altText !== 'GitLab');
  assert.deepEqual(imgs.map((i) => [i.altText, i.url]), [
    ['Merged', GITLAB_ICONS_SMALL.merge],
    ['Closed', GITLAB_ICONS_SMALL['merge-request-close']],
  ]);
});

test('/mrs card: the image-free fallback uses a coloured dot per state (red for closed)', () => {
  const rows = ['open', 'merged', 'closed'].map((state, i) => ({
    project: 'app', ref: `!${i + 1}`, url: `${GL}/app/-/merge_requests/${i + 1}`, title: state, state, author: 'Alice',
  }));
  const card = buildMrListCard({ title: 'Merge requests', sections: [{ rows }], images: false });
  const nodes = [];
  walk(card, (n) => nodes.push(n));
  assert.equal(nodes.filter((n) => n.type === 'Image' && n.altText !== 'GitLab').length, 0);
  const dots = nodes.filter((n) => n.type === 'TextBlock' && /^[\u{1F7E2}\u{1F7E3}\u{1F534}]$/u.test(n.text)).map((n) => n.text);
  assert.deepEqual(dots, ['\u{1F7E2}', '\u{1F7E3}', '\u{1F534}']);
});




test('/mrs card: the markdown copy is the regular list, unchanged', () => {
  const w = newWatcher();
  const message = rich(w, [...humanMrs, ...botMrs(8)], { mode: 'all' });
  const regular = newWatcher({}).formatMrsMessage([...humanMrs, ...botMrs(8)], { mode: 'all' });
  assert.equal(typeof regular, 'string');
  // The rich list adds the approval badges to the regular lines, nothing else changes.
  // A list split into one card per section repeats the headline in the markdown, so compare line by line.
  const md = messageMarkdown(message);
  for (const line of w.formatMrsText([...humanMrs, ...botMrs(8)], { rich: true, mode: 'all' }).split('\n').filter(Boolean)) {
    assert.ok(md.includes(line), `markdown keeps: ${line.slice(0, 60)}`);
  }
  assert.ok(regular.startsWith('\u{1F4CB} **Open Merge Requests** (13 total: 5 human, 8 bot):\n\n\u{1F464} **Human Merge Requests** (5):\n\n- '));
  assert.ok(regular.includes('Renovate / Bot Updates** (8)'));
});



test('/mrs card: empty lists and regular mode stay as they are', () => {
  assert.equal(typeof newWatcher().formatMrsMessage([], {}), 'string');
  assert.equal(typeof newWatcher({}).formatMrsMessage(humanMrs, {}), 'string');
  assert.equal(buildMrListCard({ title: 'x', sections: [] }), null);
  assert.equal(buildMrListCard({ title: 'x', sections: [{ rows: [] }] }), null);
});

test('/mrs card: rows without a project stay unindented, a row without a URL has no link', () => {
  const card = buildMrListCard({
    title: 'Merge requests',
    sections: [{ rows: [{ project: '', ref: '!9', url: '', title: 'No URL', state: 'open' }] }],
  });
  const items = card.body[0].items;
  assert.ok(items.some((i) => i.type === 'ColumnSet' && i.columns[0].items[0]?.type === 'Image' && i.columns.length === 2));
  const text = JSON.stringify(card);
  assert.ok(text.includes('!9 No URL'));
  assert.ok(!text.includes('](' ));
});
