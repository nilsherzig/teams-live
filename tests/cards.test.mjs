import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMergeRequestCard,
  buildJobCard,
  buildPipelineCard,
  buildJiraIssueCard,
  buildOpsGenieAlertCard,
  buildConfluencePageCard,
  ciStatusInfo,
} from '../src/cards.mjs';
import { SERVICE_ICONS } from '../src/card-icons.mjs';

const items = (card) => card.body[0].items;
const facts = (card) => Object.fromEntries(items(card).find((i) => i.type === 'FactSet').facts.map((f) => [f.title, f.value]));
const style = (card) => card.body[0].style;
const actionUrls = (card) => (card.actions || []).map((a) => a.url);
const header = (card) => items(card)[0];
const headerLabel = (card) => header(card).columns[1].items[0].text;
const headerIcon = (card) => header(card).columns[0].items[0];
const mainTitle = (card) => items(card)[1].text;
const subtitle = (card) => items(card).find((i) => i.type === 'TextBlock' && i.isSubtle && i !== header(card))?.text;

function assertValidCard(card) {
  assert.equal(card.type, 'AdaptiveCard');
  assert.equal(card.version, '1.4');
  assert.ok(card.$schema.includes('adaptivecards.io'));
  assert.ok(Array.isArray(card.body) && card.body.length > 0);
  // The card must survive a JSON round trip (it is sent as a JSON string).
  assert.deepEqual(JSON.parse(JSON.stringify(card)), card);
}

const baseMr = {
  iid: 42,
  project: 'group/project',
  title: 'Add example feature',
  url: 'https://gitlab.example.com/group/project/-/merge_requests/42',
};

test('ciStatusInfo maps statuses to labels and container styles', () => {
  assert.deepEqual(ciStatusInfo('success'), { label: 'Passed', style: 'good' });
  assert.deepEqual(ciStatusInfo('failed'), { label: 'Failed', style: 'attention' });
  assert.equal(ciStatusInfo('running').style, 'accent');
  assert.equal(ciStatusInfo('waiting_for_resource').label, 'waiting for resource');
  assert.equal(ciStatusInfo(undefined).label, 'Unknown');
});

test('merge request card: open, approved, green pipeline, auto-merge', () => {
  const card = buildMergeRequestCard({
    ...baseMr,
    state: 'open',
    approved: true,
    approvedBy: ['Alice Example', 'Bob Example'],
    autoMerge: true,
    autoMergeUser: 'Alice Example',
    targetBranch: 'main',
    pipeline: { id: 7, status: 'success', url: 'https://gitlab.example.com/group/project/-/pipelines/7' },
    jira: { key: 'EX-123', url: 'https://jira.example.com/browse/EX-123' },
  });
  assertValidCard(card);
  assert.equal(mainTitle(card), 'Add example feature');
  assert.equal(style(card), 'good');
  const f = facts(card);
  assert.equal(f.Status, 'Open');
  assert.equal(f.Approval, 'Approved by Alice Example, Bob Example');
  assert.equal(f.Pipeline, 'Passed (#7)');
  assert.equal(f['Auto-merge'], 'Enabled by Alice Example');
  assert.equal(f.Target, 'main');
  assert.equal(f.Jira, 'EX-123');
  assert.equal(f.Rebase, undefined);
  assert.deepEqual(actionUrls(card), [
    baseMr.url,
    'https://gitlab.example.com/group/project/-/pipelines/7',
    'https://jira.example.com/browse/EX-123',
  ]);
});

test('merge request card: failed pipeline wins over everything else for open MRs', () => {
  const card = buildMergeRequestCard({
    ...baseMr,
    approved: true,
    pipeline: { id: 8, status: 'failed' },
  });
  assert.equal(style(card), 'attention');
  assert.equal(facts(card).Pipeline, 'Failed (#8)');
});

test('merge request card: needs rebase and not approved', () => {
  const card = buildMergeRequestCard({ ...baseMr, needsRebase: true, hasConflicts: true });
  assert.equal(style(card), 'warning');
  const f = facts(card);
  assert.equal(f.Approval, 'Not approved yet');
  assert.equal(f.Rebase, 'Required (merge conflicts)');
});

test('merge request card: merged, closed, rebase and rebased states', () => {
  const merged = buildMergeRequestCard({ ...baseMr, state: 'merged', targetBranch: 'main', approved: false });
  assert.equal(style(merged), 'good');
  assert.equal(facts(merged).Status, 'Merged');
  assert.equal(facts(merged).Approval, undefined);

  const closed = buildMergeRequestCard({ ...baseMr, state: 'closed' });
  assert.equal(style(closed), 'attention');
  assert.equal(facts(closed).Status, 'Closed (unmerged)');

  const rebase = buildMergeRequestCard({ ...baseMr, state: 'rebase', hasConflicts: false });
  assert.equal(style(rebase), 'warning');
  assert.equal(facts(rebase).Status, 'Rebase required');

  const rebased = buildMergeRequestCard({ ...baseMr, state: 'rebased' });
  assert.equal(style(rebased), 'good');
  assert.equal(facts(rebased).Status, 'Rebased, up to date');
  for (const c of [merged, closed, rebase, rebased]) assertValidCard(c);
});

test('job card shows stage, ref, duration, failure reason, pipeline and MR', () => {
  const card = buildJobCard({
    id: 99,
    name: 'unit-tests',
    project: 'project',
    status: 'failed',
    stage: 'test',
    ref: 'feature/example',
    duration: '2m 3s',
    failureReason: 'script_failure',
    url: 'https://gitlab.example.com/group/project/-/jobs/99',
    pipeline: { id: 7, status: 'failed', url: 'https://gitlab.example.com/group/project/-/pipelines/7' },
    mr: { iid: 42, title: 'Add example feature', url: baseMr.url },
  });
  assertValidCard(card);
  assert.equal(mainTitle(card), 'unit-tests');
  assert.equal(style(card), 'attention');
  const f = facts(card);
  assert.equal(f.Status, 'Failed');
  assert.equal(f.Stage, 'test');
  assert.equal(f['Failure reason'], 'script_failure');
  assert.equal(f.Pipeline, 'Failed (#7)');
  assert.equal(f['Merge request'], '!42 Add example feature');
  assert.equal(actionUrls(card).length, 3);

  const ok = buildJobCard({ id: 100, name: 'lint', status: 'success', failureReason: 'ignored' });
  assert.equal(style(ok), 'good');
  assert.equal(facts(ok)['Failure reason'], undefined);
  assert.equal(ok.actions, undefined);
});

test('pipeline card', () => {
  const card = buildPipelineCard({
    id: 7,
    project: 'project',
    status: 'running',
    ref: 'main',
    duration: '1m',
    yamlErrors: 'jobs:build config should be a hash',
    url: 'https://gitlab.example.com/group/project/-/pipelines/7',
    mr: { iid: 42, title: 'Add example feature', url: baseMr.url },
  });
  assertValidCard(card);
  assert.equal(mainTitle(card), 'Pipeline #7');
  assert.equal(style(card), 'accent');
  assert.equal(facts(card)['YAML errors'], 'jobs:build config should be a hash');
  assert.deepEqual(actionUrls(card), ['https://gitlab.example.com/group/project/-/pipelines/7', baseMr.url]);
});

test('jira issue card styles by status and shows assignee/priority', () => {
  const issue = {
    key: 'EX-1',
    summary: 'Something is broken',
    url: 'https://jira.example.com/browse/EX-1',
    issueType: 'Bug',
    status: 'In Progress',
    statusCategory: 'indeterminate',
    priority: 'High',
    assignee: 'Alice Example',
  };
  const card = buildJiraIssueCard(issue);
  assertValidCard(card);
  assert.equal(mainTitle(card), 'Something is broken');
  assert.equal(headerLabel(card), 'Jira \u00b7 Bug');
  assert.equal(subtitle(card), 'EX-1');
  assert.equal(style(card), 'accent');
  assert.deepEqual(facts(card), { Status: 'In Progress', Priority: 'High', Assignee: 'Alice Example' });
  assert.deepEqual(actionUrls(card), [issue.url]);

  assert.equal(style(buildJiraIssueCard({ ...issue, status: 'Done', statusCategory: 'done' })), 'good');
  assert.equal(style(buildJiraIssueCard({ ...issue, status: 'Open', statusCategory: 'new' })), 'emphasis');
  const bare = buildJiraIssueCard({ ...issue, assignee: '', priority: '' });
  assert.equal(facts(bare).Assignee, 'Unassigned');
  assert.equal(facts(bare).Priority, 'None');
});

test('opsgenie alert card styles by priority, acknowledgement and status', () => {
  const alert = {
    message: 'Disk almost full',
    tinyId: '123',
    url: 'https://opsgenie.example.com/alert/detail/abc',
    priority: 'P1',
    status: 'open',
    acknowledged: false,
    owner: 'Alice Example',
  };
  const card = buildOpsGenieAlertCard(alert);
  assertValidCard(card);
  assert.equal(mainTitle(card), 'Disk almost full');
  assert.equal(headerLabel(card), 'OpsGenie \u00b7 Alert');
  assert.equal(subtitle(card), '#123');
  assert.equal(style(card), 'attention');
  assert.equal(facts(card).Status, 'open, unacknowledged');
  assert.equal(facts(card).Owner, 'Alice Example');

  assert.equal(style(buildOpsGenieAlertCard({ ...alert, acknowledged: true })), 'accent');
  assert.equal(style(buildOpsGenieAlertCard({ ...alert, priority: 'P3' })), 'warning');
  assert.equal(style(buildOpsGenieAlertCard({ ...alert, status: 'closed' })), 'emphasis');
  assert.equal(facts(buildOpsGenieAlertCard({ ...alert, owner: '' })).Owner, 'Unassigned');
});

test('confluence page card', () => {
  const card = buildConfluencePageCard({
    title: 'Runbook',
    spaceName: 'Operations',
    spaceKey: 'OPS',
    author: 'Alice Example',
    url: 'https://confluence.example.com/pages/1',
  });
  assertValidCard(card);
  assert.equal(mainTitle(card), 'Runbook');
  assert.deepEqual(facts(card), { Space: 'Operations (OPS)', 'Last edited by': 'Alice Example' });
  assert.deepEqual(actionUrls(card), ['https://confluence.example.com/pages/1']);

  const noSpaceName = buildConfluencePageCard({ title: 'Page', spaceKey: 'OPS', url: 'https://confluence.example.com/pages/2' });
  assert.equal(facts(noSpaceName).Space, 'OPS');
});

test('cards never contain empty facts or empty actions', () => {
  const card = buildMergeRequestCard({ iid: 1, title: '' });
  assertValidCard(card);
  for (const fact of card.body[0].items.find((i) => i.type === 'FactSet').facts) {
    assert.ok(fact.title && fact.value);
  }
  assert.equal(card.actions, undefined);
});

test('every card has a compact branded header: logo plus "Service - kind"', () => {
  const cases = [
    [buildMergeRequestCard({ ...baseMr, state: 'open' }), 'GitLab', 'GitLab \u00b7 Merge request', '!42 in group/project'],
    [buildJobCard({ id: 5, name: 'build', status: 'failed', project: 'group/project' }), 'GitLab', 'GitLab \u00b7 CI job', '#5 in group/project'],
    [buildPipelineCard({ id: 9, status: 'success', project: 'group/project' }), 'GitLab', 'GitLab \u00b7 Pipeline', 'group/project'],
    [buildJiraIssueCard({ key: 'EX-1', summary: 'S', issueType: 'Story', status: 'Open' }), 'Jira', 'Jira \u00b7 Story', 'EX-1'],
    [buildOpsGenieAlertCard({ message: 'M', tinyId: '7' }), 'OpsGenie', 'OpsGenie \u00b7 Alert', '#7'],
    [buildConfluencePageCard({ title: 'T', spaceKey: 'EX' }), 'Confluence', 'Confluence \u00b7 Page', undefined],
  ];
  const icons = new Set();
  for (const [card, service, label, sub] of cases) {
    assertValidCard(card);
    assert.equal(header(card).type, 'ColumnSet');
    assert.equal(headerLabel(card), label);
    assert.equal(subtitle(card), sub);
    const icon = headerIcon(card);
    assert.equal(icon.type, 'Image');
    assert.equal(icon.altText, service);
    // Self-contained PNG, small enough not to bloat the message.
    assert.match(icon.url, /^data:image\/png;base64,iVBOR/);
    assert.ok(icon.url.length < 10_000, `${service} icon is ${icon.url.length} bytes`);
    assert.equal(icon.width, '16px');
    icons.add(`${service}:${icon.url}`);
    // Compact: header, title, optional subtitle, facts. No grid or roster.
    assert.ok(items(card).length <= 4);
    assert.ok(!JSON.stringify(card.body).includes('"Table"'));
  }
  // One logo per service, shared by cards of the same service, never across services.
  const byService = new Map();
  for (const entry of icons) {
    const [service, ...rest] = entry.split(':');
    byService.set(service, new Set([...(byService.get(service) || []), rest.join(':')]));
  }
  assert.equal(byService.size, 4);
  for (const set of byService.values()) assert.equal(set.size, 1);
  assert.equal(new Set([...byService.values()].map((set) => [...set][0])).size, 4);
});

test('link buttons carry the logo of the service they open', () => {
  const iconOf = (card) => Object.fromEntries((card.actions || []).map((a) => [a.title, a.iconUrl]));

  const mr = buildMergeRequestCard({
    ...baseMr,
    state: 'open',
    pipeline: { id: 7, status: 'success', url: 'https://gitlab.example.com/group/project/-/pipelines/7' },
    jira: { key: 'EX-123', url: 'https://jira.example.com/browse/EX-123' },
  });
  assert.deepEqual(iconOf(mr), {
    'Open merge request': SERVICE_ICONS.gitlab,
    'Open pipeline': SERVICE_ICONS.gitlab,
    'Open EX-123': SERVICE_ICONS.jira,
  });

  const job = buildJobCard({
    id: 5,
    name: 'build',
    status: 'failed',
    url: 'https://gitlab.example.com/-/jobs/5',
    pipeline: { id: 9, url: 'https://gitlab.example.com/-/pipelines/9' },
    mr: { iid: 42, url: baseMr.url },
  });
  assert.deepEqual(iconOf(job), {
    'Open job': SERVICE_ICONS.gitlab,
    'Open pipeline': SERVICE_ICONS.gitlab,
    'Open merge request': SERVICE_ICONS.gitlab,
  });

  const pipeline = buildPipelineCard({
    id: 9,
    status: 'success',
    url: 'https://gitlab.example.com/-/pipelines/9',
    mr: { iid: 42, url: baseMr.url },
  });
  assert.deepEqual(iconOf(pipeline), {
    'Open pipeline': SERVICE_ICONS.gitlab,
    'Open merge request': SERVICE_ICONS.gitlab,
  });

  assert.deepEqual(iconOf(buildJiraIssueCard({ key: 'EX-1', status: 'Open', url: 'https://jira.example.com/browse/EX-1' })), {
    'Open EX-1': SERVICE_ICONS.jira,
  });
  assert.deepEqual(iconOf(buildOpsGenieAlertCard({ message: 'M', url: 'https://opsgenie.example.com/alert/1' })), {
    'Open alert': SERVICE_ICONS.opsgenie,
  });
  assert.deepEqual(iconOf(buildConfluencePageCard({ title: 'T', url: 'https://confluence.example.com/pages/1' })), {
    'Open page': SERVICE_ICONS.confluence,
  });

  // A Jira cross-link without a key keeps a clear label and the Jira logo.
  const noKey = buildMergeRequestCard({ ...baseMr, state: 'open', jira: { url: 'https://jira.example.com/browse/EX-9' } });
  assert.deepEqual(iconOf(noKey), { 'Open merge request': SERVICE_ICONS.gitlab, 'Open Jira issue': SERVICE_ICONS.jira });
});
