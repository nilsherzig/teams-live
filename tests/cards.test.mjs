import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMergeRequestCard,
  buildJobCard,
  buildPipelineCard,
  buildJiraIssueCard,
  buildOpsGenieAlertCard,
  buildConfluencePageCard,
  buildMarkdownCard,
  stripMentionMarkup,
  ciStatusEmoji,
  ciStatusInfo,
  mdLink,
} from '../src/cards.mjs';
import { SERVICE_ICONS } from '../src/card-icons.mjs';

const items = (card) => card.body[0].items;
// Text with markdown links reduced to their labels (and escapes removed).
const plain = (text) => text.replace(/\[((?:\\.|[^\]\\])*)\]\([^)]*\)/g, '$1').replace(/\\([\\[\]])/g, '$1');
const rawFacts = (card) => Object.fromEntries(items(card).find((i) => i.type === 'FactSet').facts.map((f) => [f.title, f.value]));
const facts = (card) => Object.fromEntries(Object.entries(rawFacts(card)).map(([k, v]) => [k, plain(v)]));
const style = (card) => card.body[0].style;
const header = (card) => items(card)[0];
const headerLabel = (card) => header(card).columns[1].items[0].text;
const headerIcon = (card) => header(card).columns[0].items[0];
const rawTitle = (card) => items(card)[1].text;
const mainTitle = (card) => plain(rawTitle(card));
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
  assert.equal(f.Approval, '\u{1F44D} Approved by Alice Example, Bob Example');
  assert.equal(f.Pipeline, '\u2705 Passed (#7)');
  assert.equal(f['Auto-merge'], '\u{1F500} Enabled by Alice Example');
  assert.equal(f.Target, 'main');
  assert.equal(f.Jira, 'EX-123');
  assert.equal(f.Rebase, undefined);
  assert.equal(rawTitle(card), `[Add example feature](${baseMr.url})`);
  assert.equal(rawFacts(card).Pipeline, '\u2705 [Passed (#7)](https://gitlab.example.com/group/project/-/pipelines/7)');
  assert.equal(rawFacts(card).Jira, '[EX-123](https://jira.example.com/browse/EX-123)');
});

test('merge request card: failed pipeline wins over everything else for open MRs', () => {
  const card = buildMergeRequestCard({
    ...baseMr,
    approved: true,
    pipeline: { id: 8, status: 'failed' },
  });
  assert.equal(style(card), 'attention');
  assert.equal(facts(card).Pipeline, '\u274c Failed (#8)');
});

test('merge request card: needs rebase and not approved', () => {
  const card = buildMergeRequestCard({ ...baseMr, approved: false, needsRebase: true, hasConflicts: true });
  assert.equal(style(card), 'warning');
  const f = facts(card);
  assert.equal(f.Approval, '\u23f3 Not approved yet');
  assert.equal(f.Rebase, '\u26a0\ufe0f Required: merge conflicts');
});

test('merge request card: merged, closed, rebase and rebased states', () => {
  const merged = buildMergeRequestCard({ ...baseMr, state: 'merged', targetBranch: 'main', approved: false });
  assert.equal(style(merged), 'good');
  assert.equal(facts(merged).Status, '\u{1F389} Merged');
  assert.equal(facts(merged).Approval, undefined);

  const closed = buildMergeRequestCard({ ...baseMr, state: 'closed' });
  assert.equal(style(closed), 'attention');
  assert.equal(facts(closed).Status, '\u{1F6AB} Closed (unmerged)');

  const rebase = buildMergeRequestCard({ ...baseMr, state: 'rebase', hasConflicts: false });
  assert.equal(style(rebase), 'warning');
  assert.equal(facts(rebase).Status, '\u26a0\ufe0f Rebase required');

  const rebased = buildMergeRequestCard({ ...baseMr, state: 'rebased' });
  assert.equal(style(rebased), 'good');
  assert.equal(facts(rebased).Status, '\u2705 Rebased, up to date and conflict-free');
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
  assert.equal(f.Status, '\u274c Failed');
  assert.equal(f.Stage, 'test');
  assert.equal(f['Failure reason'], 'script_failure');
  assert.equal(f.Pipeline, '\u274c Failed (#7)');
  assert.equal(f['Merge request'], '!42 Add example feature');

  const ok = buildJobCard({ id: 100, name: 'lint', status: 'success', failureReason: 'ignored' });
  assert.equal(style(ok), 'good');
  assert.equal(facts(ok)['Failure reason'], undefined);
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
  assert.equal(facts(card).Status, '\u23f3 Running');
  assert.equal(facts(card)['YAML errors'], 'jobs:build config should be a hash');
  assert.equal(rawTitle(card), '[Pipeline #7](https://gitlab.example.com/group/project/-/pipelines/7)');
  assert.equal(rawFacts(card)['Merge request'], `[!42 Add example feature](${baseMr.url})`);
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
  assert.equal(headerLabel(card), 'Jira \u00b7 \u{1F41B} Bug');
  assert.equal(subtitle(card), 'EX-1');
  assert.equal(style(card), 'accent');
  assert.deepEqual(facts(card), { Status: '\u{1F7E1} In Progress', Priority: '\u{1F534} High', Assignee: 'Alice Example' });
  assert.equal(rawTitle(card), `[Something is broken](${issue.url})`);

  assert.equal(style(buildJiraIssueCard({ ...issue, status: 'Done', statusCategory: 'done' })), 'good');
  assert.equal(style(buildJiraIssueCard({ ...issue, status: 'Open', statusCategory: 'new' })), 'emphasis');
  const bare = buildJiraIssueCard({ ...issue, assignee: '', priority: '' });
  assert.equal(facts(bare).Assignee, 'Unassigned');
  assert.equal(facts(bare).Priority, '\u{1F7E1} None');
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
  // The container stays neutral: the badges carry the colours.
  assert.equal(style(card), 'emphasis');
  assert.equal(facts(card).Status, '\u{1F7E2} open (unacknowledged)');
  assert.equal(facts(card).Owner, 'Alice Example');
  assert.equal(facts(buildOpsGenieAlertCard({ ...alert, owner: '' })).Owner, 'Unassigned');
});

const badges = (card) =>
  items(card)
    .find((i) => i.type === 'ColumnSet' && i !== header(card))
    .columns.map((c) => ({ text: c.items[0].text, style: c.style, color: c.items[0].color }));

test('opsgenie status badge: OPEN, ACK\'D and CLOSED (closed wins), non-interactive', () => {
  const alert = { message: 'Disk almost full', tinyId: '1', priority: 'P1', status: 'open', acknowledged: false };
  assert.deepEqual(badges(buildOpsGenieAlertCard(alert))[1], { text: 'OPEN', style: 'attention', color: 'Attention' });
  assert.deepEqual(badges(buildOpsGenieAlertCard({ ...alert, acknowledged: true }))[1], {
    text: "ACK'D",
    style: 'warning',
    color: 'Warning',
  });
  assert.deepEqual(badges(buildOpsGenieAlertCard({ ...alert, status: 'closed' }))[1], {
    text: 'CLOSED',
    style: 'emphasis',
    color: undefined,
  });
  // Closed takes precedence over acknowledged.
  assert.equal(badges(buildOpsGenieAlertCard({ ...alert, status: 'closed', acknowledged: true }))[1].text, 'CLOSED');
  const json = JSON.stringify(buildOpsGenieAlertCard(alert));
  assert.ok(!json.includes('Action.') && !json.includes('selectAction'));
});

test('opsgenie priority badges: P1 red, P2 orange, P3 amber, P4 green, P5 subdued', () => {
  const expected = {
    P1: ['\u{1F534} P1', 'attention'],
    P2: ['\u{1F7E0} P2', 'warning'],
    P3: ['\u{1F7E1} P3', 'warning'],
    P4: ['\u{1F7E2} P4', 'good'],
    P5: ['\u26aa P5', 'emphasis'],
  };
  for (const [priority, [text, style]] of Object.entries(expected)) {
    const [badge] = badges(buildOpsGenieAlertCard({ message: 'M', priority, status: 'open' }));
    assert.equal(badge.text, text);
    assert.equal(badge.style, style);
    // Never colour alone: the label is part of the badge.
    assert.ok(badge.text.endsWith(priority));
  }
});

test('opsgenie card without a tiny id falls back to a short alert id', () => {
  const card = buildOpsGenieAlertCard({ message: 'M', id: 'abcdef1234567890', status: 'open' });
  assert.equal(subtitle(card), 'Alert abcdef12');
  assert.equal(subtitle(buildOpsGenieAlertCard({ message: 'M', tinyId: '7' })), '#7');
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
  assert.equal(rawTitle(card), '[Runbook](https://confluence.example.com/pages/1)');

  const noSpaceName = buildConfluencePageCard({ title: 'Page', spaceKey: 'OPS', url: 'https://confluence.example.com/pages/2' });
  assert.equal(facts(noSpaceName).Space, 'OPS');
});

test('cards never contain empty facts', () => {
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
    [buildJiraIssueCard({ key: 'EX-1', summary: 'S', issueType: 'Story', status: 'Open' }), 'Jira', 'Jira \u00b7 \u{1F4D6} Story', 'EX-1'],
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
    assert.ok(items(card).length <= 5);
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

test('cards have no navigation buttons: links are inline, logos stay in the header', () => {
  const pipelineUrl = 'https://gitlab.example.com/-/pipelines/9';
  const cards = [
    buildMergeRequestCard({
      ...baseMr,
      state: 'open',
      pipeline: { id: 7, status: 'success', url: pipelineUrl },
      jira: { key: 'EX-123', url: 'https://jira.example.com/browse/EX-123' },
    }),
    buildMergeRequestCard({ iid: 1, title: '' }),
    buildJobCard({
      id: 5,
      name: 'build',
      status: 'failed',
      url: 'https://gitlab.example.com/-/jobs/5',
      pipeline: { id: 9, url: pipelineUrl },
      mr: { iid: 42, url: baseMr.url },
    }),
    buildPipelineCard({ id: 9, status: 'success', url: pipelineUrl, mr: { iid: 42, url: baseMr.url } }),
    buildJiraIssueCard({ key: 'EX-1', status: 'Open', url: 'https://jira.example.com/browse/EX-1' }),
    buildOpsGenieAlertCard({ message: 'M', url: 'https://opsgenie.example.com/alert/1' }),
    buildConfluencePageCard({ title: 'T', url: 'https://confluence.example.com/pages/1' }),
  ];
  for (const card of cards) {
    assertValidCard(card);
    assert.equal(card.actions, undefined);
    assert.ok(!JSON.stringify(card).includes('Action.'));
    assert.ok(headerIcon(card).url.startsWith('data:image/png;base64,'));
  }
  // The header logo is the service the card is about.
  assert.equal(headerIcon(cards[0]).url, SERVICE_ICONS.gitlab);
  assert.equal(headerIcon(cards[4]).url, SERVICE_ICONS.jira);
  assert.equal(headerIcon(cards[5]).url, SERVICE_ICONS.opsgenie);
  assert.equal(headerIcon(cards[6]).url, SERVICE_ICONS.confluence);
});

test('mdLink builds safe markdown links and keeps plain text without a valid http(s) URL', () => {
  assert.equal(mdLink('Title', 'https://example.com/a'), '[Title](https://example.com/a)');
  // Label delimiters are escaped so they cannot break the link.
  assert.equal(mdLink('Fix [WIP] a\\b', 'https://example.com/a'), '[Fix \\[WIP\\] a\\\\b](https://example.com/a)');
  // Parentheses in the URL are percent-encoded; spaces are encoded by URL parsing.
  assert.equal(mdLink('x', 'https://example.com/a_(b)'), '[x](https://example.com/a_%28b%29)');
  assert.equal(mdLink('x', 'https://example.com/a b'), '[x](https://example.com/a%20b)');
  // Missing or non-http(s) URLs leave the text untouched (no stray brackets).
  for (const bad of [undefined, null, '', '   ', 'not a url', 'javascript:alert(1)', 'ftp://example.com/x', 'data:text/html,hi']) {
    assert.equal(mdLink('Plain [text]', bad), 'Plain [text]');
  }
  assert.equal(mdLink('', 'https://example.com'), '');
  assert.equal(mdLink(undefined, 'https://example.com'), '');
});

test('card titles link to the entity URL', () => {
  const cases = [
    [buildMergeRequestCard({ ...baseMr, state: 'open' }), 'Add example feature', baseMr.url],
    [buildJobCard({ id: 5, name: 'build', status: 'failed', url: 'https://gitlab.example.com/-/jobs/5' }), 'build', 'https://gitlab.example.com/-/jobs/5'],
    [buildPipelineCard({ id: 9, status: 'success', url: 'https://gitlab.example.com/-/pipelines/9' }), 'Pipeline #9', 'https://gitlab.example.com/-/pipelines/9'],
    [buildJiraIssueCard({ key: 'EX-1', summary: 'Broken', url: 'https://jira.example.com/browse/EX-1' }), 'Broken', 'https://jira.example.com/browse/EX-1'],
    [buildOpsGenieAlertCard({ message: 'Disk full', url: 'https://opsgenie.example.com/alert/1' }), 'Disk full', 'https://opsgenie.example.com/alert/1'],
    [buildConfluencePageCard({ title: 'Runbook', url: 'https://confluence.example.com/pages/1' }), 'Runbook', 'https://confluence.example.com/pages/1'],
  ];
  for (const [card, label, url] of cases) {
    assertValidCard(card);
    assert.equal(rawTitle(card), `[${label}](${url})`);
  }
});

test('card titles stay plain text without a usable URL and escape brackets', () => {
  assert.equal(rawTitle(buildMergeRequestCard({ ...baseMr, url: undefined, title: 'Fix [WIP] thing' })), 'Fix [WIP] thing');
  assert.equal(rawTitle(buildJiraIssueCard({ key: 'EX-1', summary: 'Broken', url: 'javascript:alert(1)' })), 'Broken');
  assert.equal(rawTitle(buildConfluencePageCard({ title: 'Runbook' })), 'Runbook');
  assert.equal(
    rawTitle(buildMergeRequestCard({ ...baseMr, title: 'Fix [WIP] (a) thing' })),
    `[Fix \\[WIP\\] (a) thing](${baseMr.url})`,
  );
});

test('cross references inside the card are linked when their URL is known', () => {
  const pipelineUrl = 'https://gitlab.example.com/group/project/-/pipelines/7';
  const jiraUrl = 'https://jira.example.com/browse/EX-123';
  const mr = buildMergeRequestCard({
    ...baseMr,
    state: 'open',
    pipeline: { id: 7, status: 'success', url: pipelineUrl },
    jira: { key: 'EX-123', url: jiraUrl },
  });
  assert.equal(rawFacts(mr).Pipeline, `\u2705 [Passed (#7)](${pipelineUrl})`);
  assert.equal(rawFacts(mr).Jira, `[EX-123](${jiraUrl})`);
  // Status-like facts without a link stay plain.
  assert.equal(rawFacts(mr).Status, 'Open');

  const job = buildJobCard({
    id: 5,
    name: 'build',
    status: 'failed',
    url: 'https://gitlab.example.com/-/jobs/5',
    pipeline: { id: 9, status: 'failed', url: 'https://gitlab.example.com/-/pipelines/9' },
    mr: { iid: 42, title: 'Fix [x]', url: baseMr.url },
  });
  assert.equal(rawFacts(job).Pipeline, '\u274c [Failed (#9)](https://gitlab.example.com/-/pipelines/9)');
  assert.equal(rawFacts(job)['Merge request'], `[!42 Fix \\[x\\]](${baseMr.url})`);

  const pipeline = buildPipelineCard({ id: 9, status: 'success', mr: { iid: 42, title: 'Title', url: baseMr.url } });
  assert.equal(rawFacts(pipeline)['Merge request'], `[!42 Title](${baseMr.url})`);
});

test('cross references stay plain text when their URL is missing or invalid', () => {
  const mr = buildMergeRequestCard({
    ...baseMr,
    url: undefined,
    state: 'open',
    pipeline: { id: 7, status: 'success' },
    jira: { key: 'EX-123', url: 'not a url' },
  });
  assert.equal(rawFacts(mr).Pipeline, '\u2705 Passed (#7)');
  assert.equal(rawFacts(mr).Jira, 'EX-123');

  const job = buildJobCard({ id: 5, status: 'failed', pipeline: { id: 9, status: 'failed' }, mr: { iid: 42, title: 'T' } });
  assert.equal(rawFacts(job).Pipeline, '\u274c Failed (#9)');
  assert.equal(rawFacts(job)['Merge request'], '!42 T');
  for (const card of [mr, job]) assert.ok(!JSON.stringify(card).includes(']('));
});

test('status emojis match the ones of the regular messages', () => {
  const expected = {
    success: '\u2705',
    passed: '\u2705',
    failed: '\u274c',
    running: '\u23f3',
    pending: '\u23f1\ufe0f',
    waiting_for_resource: '\u23f1\ufe0f',
    preparing: '\u23f1\ufe0f',
    created: '\u23f1\ufe0f',
    canceled: '\u26a0\ufe0f',
    skipped: '\u23ed\ufe0f',
    manual: '\u2699\ufe0f',
    something_else: '\u{1F539}',
  };
  for (const [status, emoji] of Object.entries(expected)) assert.equal(ciStatusEmoji(status), emoji, status);

  // Merge request card: every status line carries its emoji, compactly.
  const open = buildMergeRequestCard({
    ...baseMr,
    state: 'open',
    approved: false,
    needsRebase: true,
    autoMerge: true,
    pipeline: { id: 3, status: 'running' },
  });
  assert.deepEqual(facts(open), {
    Status: 'Open',
    Approval: '\u23f3 Not approved yet',
    Pipeline: '\u23f3 Running (#3)',
    Rebase: '\u26a0\ufe0f Required: behind target branch',
    'Auto-merge': '\u{1F500} Enabled',
  });
  assert.equal(facts(buildMergeRequestCard({ ...baseMr, pipeline: { id: 4, status: 'canceled' } })).Pipeline, '\u26a0\ufe0f Canceled (#4)');
  assert.equal(facts(buildMergeRequestCard({ ...baseMr, pipeline: { id: 4, status: 'pending' } })).Pipeline, '\u23f1\ufe0f pending (#4)');

  // Job and pipeline cards: status and pipeline reference.
  for (const [status, label] of [['success', 'Passed'], ['failed', 'Failed'], ['running', 'Running'], ['manual', 'manual']]) {
    assert.equal(facts(buildJobCard({ id: 1, status }))['Status'], `${ciStatusEmoji(status)} ${label}`);
    assert.equal(facts(buildPipelineCard({ id: 1, status })).Status, `${ciStatusEmoji(status)} ${label}`);
  }
  // A pipeline without a known status keeps the neutral emoji of the regular messages.
  assert.equal(facts(buildJobCard({ id: 1, status: 'failed', pipeline: { id: 9 } })).Pipeline, '\u{1F539} Unknown (#9)');
});

test('merge request card: open cards always show approval and auto-merge, unknown differs from false', () => {
  const unknown = facts(buildMergeRequestCard({ ...baseMr, state: 'open', approved: null, autoMerge: null }));
  assert.equal(unknown.Approval, '\u2754 Unknown (not retrieved)');
  assert.equal(unknown['Auto-merge'], '\u2754 Unknown (not retrieved)');

  const disabled = facts(buildMergeRequestCard({ ...baseMr, state: 'open', approved: false, autoMerge: false }));
  assert.equal(disabled.Approval, '\u23f3 Not approved yet');
  assert.equal(disabled['Auto-merge'], '\u23f8\ufe0f Disabled');

  // Approved without approver names still says so.
  const approved = facts(buildMergeRequestCard({ ...baseMr, state: 'open', approved: true, approvedBy: [], autoMerge: true }));
  assert.equal(approved.Approval, '\u{1F44D} Approved');
  assert.equal(approved['Auto-merge'], '\u{1F500} Enabled');
});

test('merge request card: rebase line only when required, with its reason and status', () => {
  const upToDate = facts(buildMergeRequestCard({ ...baseMr, state: 'open', needsRebase: false }));
  assert.equal(upToDate.Rebase, undefined);
  assert.equal(facts(buildMergeRequestCard({ ...baseMr, state: 'open' })).Rebase, undefined);

  const behind = facts(buildMergeRequestCard({ ...baseMr, state: 'open', needsRebase: true, detailedMergeStatus: 'need_rebase' }));
  assert.equal(behind.Rebase, '\u26a0\ufe0f Required: behind target branch (status: need_rebase)');
  const conflicts = facts(buildMergeRequestCard({ ...baseMr, state: 'open', needsRebase: true, hasConflicts: true }));
  assert.equal(conflicts.Rebase, '\u26a0\ufe0f Required: merge conflicts');

  const rebase = buildMergeRequestCard({ ...baseMr, state: 'rebase', hasConflicts: true });
  assert.equal(facts(rebase).Status, '\u26a0\ufe0f Rebase required (merge conflicts)');
  assert.ok(facts(rebase).Rebase.startsWith('\u26a0\ufe0f Required'));
  // Resolved: the line goes away again.
  const rebased = facts(buildMergeRequestCard({ ...baseMr, state: 'rebased', approved: true, autoMerge: false }));
  assert.equal(rebased.Rebase, undefined);
  assert.equal(rebased.Approval, '\u{1F44D} Approved');
  assert.equal(rebased['Auto-merge'], '\u23f8\ufe0f Disabled');
});

test('merge request card: merged and closed cards keep what is known', () => {
  const merged = facts(buildMergeRequestCard({ ...baseMr, state: 'merged', approved: true, approvedBy: ['Alice Example'], autoMerge: true }));
  assert.equal(merged.Approval, '\u{1F44D} Approved by Alice Example');
  assert.equal(merged['Auto-merge'], '\u{1F500} Enabled');
  // Not approved / disabled are not worth a line once merged.
  const mergedPlain = facts(buildMergeRequestCard({ ...baseMr, state: 'merged', approved: false, autoMerge: false }));
  assert.equal(mergedPlain.Approval, undefined);
  assert.equal(mergedPlain['Auto-merge'], undefined);

  const closed = facts(buildMergeRequestCard({ ...baseMr, state: 'closed', approved: true, autoMerge: true, needsRebase: true }));
  assert.equal(closed.Approval, '\u{1F44D} Approved');
  assert.equal(closed['Auto-merge'], '\u{1F500} Enabled');
  assert.equal(closed.Rebase, '\u26a0\ufe0f Required: behind target branch');
  const closedUnknown = facts(buildMergeRequestCard({ ...baseMr, state: 'closed', approved: null }));
  assert.equal(closedUnknown.Approval, undefined);
  assert.equal(closedUnknown.Rebase, undefined);
});

test('merge request card: Jira reference without a key uses a linked fallback label', () => {
  const card = buildMergeRequestCard({ ...baseMr, state: 'open', jira: { url: 'https://jira.example.com/browse/EX-9' } });
  assert.equal(rawFacts(card).Jira, '[Jira issue](https://jira.example.com/browse/EX-9)');
  assert.equal(facts(buildMergeRequestCard({ ...baseMr, state: 'open', jira: { url: 'nope' } })).Jira, undefined);
});

test('ciStatusEmoji normalizes case and knows cancelled', () => {
  assert.equal(ciStatusEmoji('FAILED'), ciStatusEmoji('failed'));
  assert.equal(ciStatusEmoji('Success'), '\u2705');
  assert.equal(ciStatusEmoji('cancelled'), ciStatusEmoji('canceled'));
  assert.equal(ciStatusInfo('CANCELLED').label, 'Canceled');
});

test('pipeline with an id but no status reads Unknown', () => {
  const card = buildMergeRequestCard({ ...baseMr, state: 'open', pipeline: { id: 9, url: 'https://gitlab.example.com/-/pipelines/9' } });
  assert.equal(rawFacts(card).Pipeline, '\u{1F539} [Unknown (#9)](https://gitlab.example.com/-/pipelines/9)');
});

// ---------------------------------------------------------------------------
// Command reply cards generated from markdown
// ---------------------------------------------------------------------------

const bodyItems = (card) => card.body[0].items;
const isNestedRow = (i) => i.type === 'ColumnSet' && /^\d+px$/.test(i.columns[0]?.width ?? '');

test('buildMarkdownCard: head line, fact bullets and list rows', () => {
  const card = buildMarkdownCard(
    [
      '\u{1F4CB} **Open merge requests** (2):',
      '',
      '- \u{1F4DD} [!1 Draft thing](https://gitlab.example.com/g/p/-/merge_requests/1) by Alice Example \u2022 _not approved_',
      '- \u2705 [!2 Ready](https://gitlab.example.com/g/p/-/merge_requests/2) by Bob Example',
      '',
      '_Tip: use /status_',
    ].join('\n'),
    { service: 'gitlab', kind: 'Merge requests' }
  );
  assertValidCard(card);
  assert.equal(headerLabel(card), 'GitLab \u00b7 Merge requests');
  assert.equal(mainTitle(card), 'Open merge requests (2)');
  const rows = bodyItems(card).filter((i) => i.type === 'TextBlock').map((i) => i.text);
  // Status emojis and inline links stay.
  assert.ok(rows.some((t) => t.startsWith('\u{1F4DD} [!1 Draft thing](https://gitlab.example.com/g/p/-/merge_requests/1)')));
  assert.ok(rows.some((t) => t.includes('_not approved_')));
  assert.ok(rows.some((t) => t === '_Tip: use /status_'));
  assert.equal(JSON.stringify(card).includes('Action.'), false);
});

test('buildMarkdownCard: bullets of "icon **Label**: value" become a fact set', () => {
  const card = buildMarkdownCard(
    [
      '\u{1FAAA} **Contact Card**: **Alice Example**',
      '',
      '- \u{1F4BC} **Role**: Engineer',
      '- \u{1F4E7} **Email**: [alice@example.com](mailto:alice@example.com)',
    ].join('\n'),
    { service: 'directory', kind: 'Contact' }
  );
  const set = bodyItems(card).find((i) => i.type === 'FactSet');
  assert.deepEqual(
    set.facts.map((f) => [f.title, f.value]),
    [
      ['\u{1F4BC} Role', 'Engineer'],
      ['\u{1F4E7} Email', '[alice@example.com](mailto:alice@example.com)'],
    ]
  );
  assert.equal(mainTitle(card), 'Contact Card: Alice Example');
  // Directory cards use an emoji brand instead of a logo.
  assert.equal(headerIcon(card).type, 'TextBlock');
});

test('buildMarkdownCard: mentions are turned into plain bold names, code spans lose their backticks', () => {
  assert.equal(
    stripMentionMarkup('**Alice Example** (@[Alice Example](8:orgid:abc)) and @[Bob Example](8:orgid:def#contact)'),
    '**Alice Example** and **Bob Example**'
  );
  const card = buildMarkdownCard('Head\n\n- see `/whois alice@example.com` for @[Alice Example](8:orgid:abc)', {
    service: 'directory',
    kind: 'x',
  });
  const text = JSON.stringify(card);
  assert.ok(!text.includes('8:orgid'));
  assert.ok(!text.includes('`'));
});

test('buildMarkdownCard: nothing list-like gives no card', () => {
  assert.equal(buildMarkdownCard('Just a sentence.', { service: 'gitlab', kind: 'x' }), null);
  assert.equal(buildMarkdownCard('', { service: 'gitlab', kind: 'x' }), null);
});

test('buildMarkdownCard: ordered and indented rows keep their structure', () => {
  const card = buildMarkdownCard(
    ['\u{1F50D} **Multiple contacts**:', '1. \u{1F464} **Alice Example**', '   - \u{1F4E7} alice@example.com', '2. \u{1F464} **Bob Example**'].join('\n'),
    { service: 'directory', kind: 'Search results' }
  );
  const items = bodyItems(card);
  const rows = items.filter((i) => i.type === 'TextBlock').map((i) => i.text);
  assert.ok(rows.includes('1. \u{1F464} **Alice Example**'));
  assert.ok(rows.includes('2. \u{1F464} **Bob Example**'));
  // The nested row is structural (spacer column + content column), not leading spaces,
  // and keeps its own emoji marker.
  const nested = items.find(isNestedRow);
  assert.ok(nested);
  assert.match(nested.columns[0].width, /^\d+px$/);
  assert.equal(nested.columns[1].width, 'stretch');
  assert.equal(nested.columns[1].items[0].text, '\u{1F4E7} alice@example.com');
  assert.ok(!/^\s/.test(nested.columns[1].items[0].text));
  // Order is kept: parent, child, next parent.
  const order = items.map((i) => (isNestedRow(i) ? 'nested' : i.text));
  assert.ok(order.indexOf('1. \u{1F464} **Alice Example**') < order.indexOf('nested'));
  assert.ok(order.indexOf('nested') < order.indexOf('2. \u{1F464} **Bob Example**'));
});

test('buildMarkdownCard: a nested bullet without an emoji gets an explicit sub-bullet marker', () => {
  const card = buildMarkdownCard(['Head', '', '- parent', '  - child'].join('\n'), { service: 'gitlab', kind: 'x' });
  const nested = bodyItems(card).find(isNestedRow);
  assert.equal(nested.columns[1].items[0].text, '\u25e6 child');
});
