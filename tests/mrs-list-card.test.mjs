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

test('/mrs card: projects are headings and their merge requests sit in an indented column', () => {
  const message = rich(newWatcher(), [...humanMrs, ...botMrs(2)]);
  const items = bodyItems(message);
  const headings = items.filter((i) => i.type === 'TextBlock').map((i) => i.text);
  assert.ok(headings.includes('**app**'));
  assert.ok(headings.includes('**docs**'));
  assert.ok(headings.includes('**infra/charts**'));
  // Every project heading is followed by a spacer column + a stretch column of rows (structural, not whitespace).
  const indented = items.filter((i) => i.type === 'ColumnSet' && i.columns[0].width === '16px' && i.columns[1].width === 'stretch');
  assert.equal(indented.length, 4); // app (human), docs, infra/charts, app (bots)
  const appRows = indented[0].columns[1].items;
  assert.equal(appRows.length, 3);
  assert.ok(appRows.every((r) => r.type === 'ColumnSet'));
  // The spacer holds no leading spaces (Teams would collapse them).
  assert.equal(indented[0].columns[0].items[0].text.trim(), '');
});

test('/mrs card: GitLab state glyph images with readable labels (open, draft), no external image URLs', () => {
  const message = rich(newWatcher(), humanMrs);
  const imgs = images(message).filter((i) => i.altText !== 'GitLab' && i.style !== 'Person' && !ciUrls.has(i.url));
  assert.deepEqual(imgs.map((i) => i.altText), ['Open', 'Open', 'Draft', 'Open', 'Open']);
  const open = GITLAB_ICONS_SMALL['merge-request-open'];
  const draft = GITLAB_ICONS_SMALL['merge-request'];
  assert.deepEqual(imgs.map((i) => i.url), [open, open, draft, open, open]);
  for (const img of allNodes(message).filter((n) => n.type === 'Image')) assert.match(img.url, /^data:image\/png;base64,/);
  // The state is also written out.
  assert.ok(texts(message).some((t) => t.includes('Draft')));
  assert.ok(texts(message).some((t) => t.startsWith('Open · ')));
});

test('/mrs card: the CI status is the GitLab status icon next to its label, not an emoji', () => {
  const message = rich(newWatcher(), humanMrs);
  const ci = images(message).filter((i) => ciUrls.has(i.url));
  // Three of the five fixtures have a pipeline: passed, failed, running.
  assert.deepEqual(ci.map((i) => i.altText), ['Passed', 'Failed', 'Running']);
  assert.deepEqual(ci.map((i) => i.url), [CI_STATUS_ICONS.success.url, CI_STATUS_ICONS.failed.url, CI_STATUS_ICONS.running.url]);
  for (const img of ci) assert.deepEqual([img.width, img.height], ['16px', '16px']);
  const all = texts(message).join('\n');
  assert.ok(all.includes('CI passed'));
  assert.ok(all.includes('CI failed'));
  assert.ok(all.includes('CI running'));
  assert.ok(!/[\u2705\u274C]\s*CI /u.test(all), 'no CI emoji next to the label');
  assert.ok(!all.includes('\u23F3 CI'), 'no running emoji next to the label');
  // The icon sits in its own column, directly followed by the label column.
  const set = allNodes(message).find((n) => n.type === 'ColumnSet' && n.columns.some((c) => c.items.some((i) => i.url === CI_STATUS_ICONS.success.url)));
  const at = set.columns.findIndex((c) => c.items.some((i) => i.url === CI_STATUS_ICONS.success.url));
  assert.equal(set.columns[at].width, '16px');
  assert.equal(set.columns[at + 1].items[0].text.startsWith('CI passed'), true);
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

test('/mrs card: every fact of the regular list is kept (links, title, author, CI, Jira, badges)', () => {
  const jira = { findAssociatedIssue: (m) => (m.iid === 12 ? { key: 'APP-123', url: 'https://jira.example.com/browse/APP-123' } : null) };
  const message = rich(newWatcher({ rich_messages: true }, jira), humanMrs);
  const all = texts(message).join('\n');
  for (const m of humanMrs) {
    assert.ok(all.includes(`[!${m.iid}](${m.web_url})`), `link of !${m.iid}`);
  }
  assert.ok(all.includes('Add example feature'));
  // Markdown characters of a title are escaped, not interpreted.
  assert.ok(all.includes('Fix flaky \\*test\\* in \\[module\\]'));
  assert.ok(all.includes('**Alice Example**') || all.includes('Alice Example'));
  assert.ok(all.includes('Bob Example'));
  assert.ok(all.includes('CI passed'));
  assert.ok(all.includes('CI failed'));
  assert.ok(all.includes('CI running'));
  assert.ok(all.includes('[APP-123](https://jira.example.com/browse/APP-123)'));
  assert.ok(all.includes('\u{1F44D} approved'));
  assert.ok(all.includes('⏳ not approved'));
  assert.ok(all.includes('\u{1F500} auto-merge'));
  assert.ok(all.includes('⚠️ rebase!'));
  assert.ok(all.includes('\u{1F4A5} conflicts'));
  assert.ok(all.includes('✅ ready to merge'));
  // Count and sections.
  assert.ok(all.includes('Open Merge Requests (5 total: 5 human, 0 bot)'));
  assert.ok(all.includes('Human Merge Requests (5)'));
  // No mention markup in the card; the markdown copy keeps the mention.
  assert.ok(!JSON.stringify(message.card).includes('8:orgid'));
  assert.ok(messageMarkdown(message).includes('@[Alice Example](8:orgid:0000)'));
});

test('/mrs card: bot truncation note and counts are kept', () => {
  const message = rich(newWatcher(), [...humanMrs, ...botMrs(8)]);
  const all = texts(message).join('\n');
  assert.ok(all.includes('Renovate / Bot Updates (8, showing top 5 ready/recent)'));
  assert.ok(all.includes('...and 3 more bot MRs (use /mrs all to view all, or /mrs bots for only bot MRs)'));
  assert.ok(all.includes('[!104]'));
  assert.ok(!all.includes('[!105]'));
  // /mrs all lists them all.
  const allMode = rich(newWatcher(), [...humanMrs, ...botMrs(8)], { mode: 'all' });
  assert.ok(texts(allMode).join('\n').includes('[!107]'));
});

test('/mrs card: the user and bot views have their own headline and no sections heading', () => {
  const byUser = rich(newWatcher(), humanMrs, { mode: 'user', userFilter: 'alice', userFilterLabel: 'Alice Example' });
  const t = texts(byUser).join('\n');
  assert.ok(t.includes('Open Merge Requests by'));
  assert.ok(!t.includes('Human Merge Requests'));
  const bots = rich(newWatcher(), [...humanMrs, ...botMrs(2)], { mode: 'bots' });
  assert.ok(texts(bots).join('\n').includes('Renovate / Bot Updates (2)'));
  assert.ok(!texts(bots).join('\n').includes('[!12]'));
});

test('/mrs card: the markdown copy is the regular list, unchanged', () => {
  const w = newWatcher();
  const message = rich(w, [...humanMrs, ...botMrs(8)]);
  const regular = newWatcher({}).formatMrsMessage([...humanMrs, ...botMrs(8)], {});
  assert.equal(typeof regular, 'string');
  // The rich list adds the approval badges to the regular lines, nothing else changes.
  assert.equal(messageMarkdown(message), w.formatMrsText([...humanMrs, ...botMrs(8)], { rich: true }));
  assert.ok(regular.startsWith('\u{1F4CB} **Open Merge Requests** (13 total: 5 human, 8 bot):\n\n\u{1F464} **Human Merge Requests** (5):\n\n- '));
  assert.ok(regular.endsWith('_...and 3 more bot MRs (use `/mrs all` to view all, or `/mrs bots` for only bot MRs)_'));
});

test('/mrs card: a long list drops the images, a very long one falls back to the full markdown', () => {
  const w = newWatcher();
  const fits = (message) => isRichMessage(message) && richMessageWireBytes(message) <= MAX_CARD_BYTES;

  const medium = w.formatMrsMessage([...humanMrs, ...humanMrs.map((m, i) => ({ ...m, iid: 200 + i })), ...botMrs(3)], {});
  assert.ok(fits(medium));

  // Enough rows for the images to overflow a card but not the emoji form.
  const rows = Array.from({ length: 15 }, (_, i) =>
    mr('app', 300 + i, `Example change number ${i} with a reasonably descriptive title`, { head_pipeline: { status: 'success' } })
  );
  const noImages = w.formatMrsMessage(rows, {});
  assert.ok(fits(noImages), 'still a card');
  const withImages = buildMrListCard({
    title: 'x',
    sections: [{ rows: rows.map((r) => ({ project: 'app', ref: `!${r.iid}`, url: r.web_url, title: r.title, state: 'open', ciStatus: 'success' })) }],
  });
  assert.ok(JSON.stringify(withImages).includes('data:image/png'));

  const many = Array.from({ length: 400 }, (_, i) => mr('app', 1000 + i, `Example change number ${i} with a reasonably long descriptive title`));
  const message = w.formatMrsMessage(many, { mode: 'all' });
  assert.equal(typeof message, 'string');
  assert.ok(message.includes('!1399') || message.includes('!1000'));
});

test('/mrs card: a list too long for the CI icons keeps the state glyphs and writes the CI status as an emoji', () => {
  const w = newWatcher();
  // The forms of the card itself, without the author pictures (see mrs-list-avatars.test.mjs).
  w.avatarService = null;
  const list = (n) =>
    Array.from({ length: n }, (_, i) =>
      mr('app', 400 + i, `Example change number ${i} with a reasonably descriptive title`, { head_pipeline: { status: 'success' } })
    );
  const ciIcons = (message) => images(message).filter((i) => ciUrls.has(i.url)).length;
  const glyphs = (message) => images(message).filter((i) => i.altText === 'Open').length;

  const short = rich(w, list(6));
  assert.equal(ciIcons(short), 6);
  assert.equal(glyphs(short), 6);

  const long = rich(w, list(14));
  assert.ok(richMessageWireBytes(long) <= MAX_CARD_BYTES);
  assert.equal(ciIcons(long), 0, 'CI icons are the first thing given up');
  assert.equal(glyphs(long), 14, 'the state glyphs stay');
  assert.ok(texts(long).some((t) => t.includes('\u2705 CI passed')));

  const huge = rich(w, list(22));
  assert.equal(glyphs(huge) + ciIcons(huge), 0, 'beyond that, emojis only');
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
