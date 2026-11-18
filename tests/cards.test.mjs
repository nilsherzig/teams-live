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
import { GITLAB_ICONS_SMALL } from '../src/gitlab-icons-small.mjs';

const items = (card) => card.body[0].items;
// Text with markdown links reduced to their labels (and escapes removed).
const plain = (text) => text.replace(/\[((?:\\.|[^\]\\])*)\]\([^)]*\)/g, '$1').replace(/\\([\\[\]])/g, '$1');
// Facts of a card: the FactSet entries, or, when a fact carries a picture (a logo or a person), the rows
// that replace the FactSet: a bold fixed-width label column, then the value ("Ticket" has a logo column too).
const factRows = (card) =>
  items(card).filter((i) => i.type === 'ColumnSet' && i.columns[0]?.items[0]?.weight === 'Bolder' && /^\d+px$/.test(i.columns[0].width));
const rawFacts = (card) => {
  const set = items(card).find((i) => i.type === 'FactSet');
  return {
    ...Object.fromEntries((set?.facts || []).map((f) => [f.title, f.value])),
    ...Object.fromEntries(
      factRows(card).map((r) => [
        r.columns[0].items[0].text,
        r.columns
          .slice(1)
          .flatMap((c) => c.items)
          .map((i) => (i.type === 'Image' && /^(19|20|22)px$/.test(i.height) ? i.altText : i.type === 'TextBlock' ? i.text : null))
          .filter(Boolean)
          .join(' '),
      ])
    ),
  };
};
const facts = (card) => Object.fromEntries(Object.entries(rawFacts(card)).map(([k, v]) => [k, plain(v)]));
const style = (card) => card.body[0].style;
const header = (card) => items(card)[0];
const headerLabel = (card) => header(card).columns.find((c) => c.width === 'stretch').items[0].text;
const headerGlyph = (card) => {
  const column = header(card).columns.slice(1).find((c) => c.width === 'auto' && c.items[0].type === 'Image');
  return column ? column.items[0] : null;
};
// The identifier slot: the right-aligned auto column after the label ('' when there is none).
const headerRef = (card) => {
  const column = header(card).columns.find((c) => c.items[0].horizontalAlignment === 'Right');
  return column ? column.items[0].text : '';
};
const headerRefBlock = (card) => header(card).columns.find((c) => c.items[0].horizontalAlignment === 'Right')?.items[0];
const headerIcon = (card) => header(card).columns[0].items[0];
// The title is a Markdown link, or (merge requests) a plain text line inside a clickable container.
const titleNode = (card) => items(card)[1];
const rawTitle = (card) => {
  const node = titleNode(card);
  if (node.type !== 'Container') return node.text;
  return `[${node.items[0].text}](${node.selectAction.url})`;
};
const mainTitle = (card) => plain(rawTitle(card));
// The subtitle is a subtle TextBlock, or (merge requests) the same block inside a clickable container.
const subtitleNode = (card) =>
  items(card)
    .map((i) => (i.type === 'Container' && i.selectAction ? i.items[0] : i))
    .find((i) => i.type === 'TextBlock' && i.isSubtle && i !== header(card));
const subtitle = (card) => subtitleNode(card)?.text;

// Text a reader sees: link targets removed, every text block and fact value joined.
function visibleText(nodes) {
  const out = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (typeof n.text === 'string') out.push(plain(n.text));
    if (n.type === 'FactSet') for (const f of n.facts) out.push(plain(f.title), plain(f.value));
    Object.values(n).forEach((v) => typeof v === 'object' && walk(v));
  };
  walk(nodes);
  return out.join('\n');
}

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

test('ciStatusInfo maps statuses to labels', () => {
  assert.deepEqual(ciStatusInfo('success'), { label: 'Passed' });
  assert.deepEqual(ciStatusInfo('failed'), { label: 'Failed' });
  assert.equal(ciStatusInfo('running').label, 'Running');
  assert.equal(ciStatusInfo('success_with_warnings').label, 'Passed with warnings');
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
  assert.equal(style(card), 'emphasis');
  const f = facts(card);
  assert.equal(f.Status, 'Open');
  assert.equal(f.Approval, 'Approved Alice Example, Bob Example');
  assert.equal(f.Pipeline, 'Passed (#7)');
  assert.equal(f['Auto-merge'], '\u{1F500} Enabled by Alice Example');
  assert.equal(f.Target, undefined, 'the target branch is not a rich fact');
  assert.equal(f.Ticket, 'EX-123');
  assert.equal(f.Rebase, undefined);
  assert.equal(rawTitle(card), `[Add example feature](${baseMr.url})`);
  assert.equal(rawFacts(card).Pipeline, '[Passed (#7)](https://gitlab.example.com/group/project/-/pipelines/7)');
  assert.equal(rawFacts(card).Ticket, '[EX-123](https://jira.example.com/browse/EX-123)');
});

test('merge request card: failed pipeline shows in the pipeline row, the card stays neutral', () => {
  const card = buildMergeRequestCard({
    ...baseMr,
    approved: true,
    pipeline: { id: 8, status: 'failed' },
  });
  assert.equal(style(card), 'emphasis');
  assert.equal(facts(card).Pipeline, 'Failed (#8)');
});

test('merge request card: needs rebase and not approved (neutral card)', () => {
  const card = buildMergeRequestCard({ ...baseMr, approved: false, needsRebase: true, hasConflicts: true });
  assert.equal(style(card), 'emphasis');
  const f = facts(card);
  assert.equal(f.Approval, 'Not approved yet');
  assert.equal(f.Rebase, '\u26a0\ufe0f Required: merge conflicts');
});

test('merge request card: merged, closed, rebase and rebased states', () => {
  const merged = buildMergeRequestCard({ ...baseMr, state: 'merged', targetBranch: 'main', approved: false });
  assert.equal(style(merged), 'emphasis');
  assert.equal(facts(merged).Status, 'Merged');
  assert.equal(facts(merged).Approval, undefined);

  const closed = buildMergeRequestCard({ ...baseMr, state: 'closed' });
  assert.equal(style(closed), 'emphasis');
  assert.equal(facts(closed).Status, 'Closed');

  const rebase = buildMergeRequestCard({ ...baseMr, state: 'rebase', hasConflicts: false });
  assert.equal(style(rebase), 'emphasis');
  assert.equal(facts(rebase).Status, 'Open \u26a0\ufe0f Rebase required');

  const rebased = buildMergeRequestCard({ ...baseMr, state: 'rebased' });
  assert.equal(style(rebased), 'emphasis');
  assert.equal(facts(rebased).Status, 'Open \u2705 Rebased, up to date and conflict-free');
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
  assert.equal(style(card), 'emphasis');
  const f = facts(card);
  assert.equal(f.Status, 'Failed');
  assert.equal(f.Stage, 'test');
  assert.equal(f['Failure reason'], 'script_failure');
  assert.equal(f.Pipeline, 'Failed (#7)');
  assert.equal(f['Merge request'], '!42 Add example feature');

  const ok = buildJobCard({ id: 100, name: 'lint', status: 'success', failureReason: 'ignored' });
  assert.equal(style(ok), 'emphasis');
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
  // The project is the title (a pipeline has no name); the ID is the linked header reference.
  assert.equal(mainTitle(card), 'project');
  assert.equal(headerRef(card), '[#7](https://gitlab.example.com/group/project/-/pipelines/7)');
  assert.equal(subtitle(card), undefined);
  assert.equal(style(card), 'emphasis');
  assert.equal(facts(card).Status, 'Running');
  assert.equal(facts(card)['YAML errors'], 'jobs:build config should be a hash');
  assert.equal(rawTitle(card), '[project](https://gitlab.example.com/group/project/-/pipelines/7)');
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
  // The key is in the header slot, once; no small repeat under the title.
  assert.equal(headerRef(card), `[EX-1](${issue.url})`);
  assert.equal(subtitle(card), undefined);
  assert.ok(!visibleText(items(card).slice(1)).includes('EX-1'));
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
  // The state is a badge image, so the facts of a merge request card are rows (see factRows).
  const entries = Object.entries(rawFacts(card));
  assert.ok(entries.length > 0);
  for (const [title, value] of entries) {
    assert.ok(title && value);
  }
  assert.equal(card.actions, undefined);
});

test('every card has a compact branded header: logo plus "Service - kind"', () => {
  const cases = [
    [buildMergeRequestCard({ ...baseMr, state: 'open' }), 'GitLab', 'GitLab \u00b7 Merge request', 'group/project'],
    [buildJobCard({ id: 5, name: 'build', status: 'failed', project: 'group/project' }), 'GitLab', 'GitLab \u00b7 CI job', 'group/project'],
    [buildPipelineCard({ id: 9, status: 'success', project: 'group/project' }), 'GitLab', 'GitLab \u00b7 Pipeline', undefined],
    [buildJiraIssueCard({ key: 'EX-1', summary: 'S', issueType: 'Story', status: 'Open' }), 'Jira', 'Jira \u00b7 \u{1F4D6} Story', undefined],
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
    assert.ok(items(card).filter((i) => !factRows(card).includes(i)).length <= 5);
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
    // No buttons of any kind. The only action is a title's `selectAction` (a click target, no visible control).
    assert.ok(!JSON.stringify(card).includes('ActionSet'));
    assert.ok(!JSON.stringify(card).replaceAll('"selectAction":{"type":"Action.OpenUrl"', '').includes('Action.'));
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
    [buildPipelineCard({ id: 9, status: 'success', project: 'group/project', url: 'https://gitlab.example.com/-/pipelines/9' }), 'group/project', 'https://gitlab.example.com/-/pipelines/9'],
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
  assert.equal(rawFacts(mr).Pipeline, `[Passed (#7)](${pipelineUrl})`);
  assert.equal(rawFacts(mr).Ticket, `[EX-123](${jiraUrl})`);
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
  assert.equal(rawFacts(job).Pipeline, '[Failed (#9)](https://gitlab.example.com/-/pipelines/9)');
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
  assert.equal(rawFacts(mr).Pipeline, 'Passed (#7)');
  assert.equal(rawFacts(mr).Ticket, 'EX-123');

  const job = buildJobCard({ id: 5, status: 'failed', pipeline: { id: 9, status: 'failed' }, mr: { iid: 42, title: 'T' } });
  assert.equal(rawFacts(job).Pipeline, 'Failed (#9)');
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
    Approval: 'Not approved yet',
    Pipeline: 'Running (#3)',
    Rebase: '\u26a0\ufe0f Required: behind target branch',
    'Auto-merge': '\u{1F500} Enabled',
  });
  assert.equal(facts(buildMergeRequestCard({ ...baseMr, pipeline: { id: 4, status: 'canceled' } })).Pipeline, 'Canceled (#4)');
  assert.equal(facts(buildMergeRequestCard({ ...baseMr, pipeline: { id: 4, status: 'pending' } })).Pipeline, 'pending (#4)');

  // Job and pipeline cards: status and pipeline reference.
  for (const [status, label] of [['success', 'Passed'], ['failed', 'Failed'], ['running', 'Running'], ['manual', 'manual']]) {
    assert.equal(facts(buildJobCard({ id: 1, status }))['Status'], label);
    assert.equal(facts(buildPipelineCard({ id: 1, status })).Status, label);
  }
  // A pipeline without a known status keeps the neutral emoji of the regular messages.
  assert.equal(facts(buildJobCard({ id: 1, status: 'failed', pipeline: { id: 9 } })).Pipeline, 'Unknown (#9)');
});

test('merge request card: open cards always show approval and auto-merge, unknown differs from false', () => {
  const unknown = facts(buildMergeRequestCard({ ...baseMr, state: 'open', approved: null, autoMerge: null }));
  assert.equal(unknown.Approval, '\u2754 Unknown (not retrieved)');
  assert.equal(unknown['Auto-merge'], '\u2754 Unknown (not retrieved)');

  const disabled = facts(buildMergeRequestCard({ ...baseMr, state: 'open', approved: false, autoMerge: false }));
  assert.equal(disabled.Approval, 'Not approved yet');
  assert.equal(disabled['Auto-merge'], '\u23f8\ufe0f Disabled');

  // Approved without approver names still says so.
  const approved = facts(buildMergeRequestCard({ ...baseMr, state: 'open', approved: true, approvedBy: [], autoMerge: true }));
  assert.equal(approved.Approval, 'Approved');
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
  assert.equal(facts(rebase).Status, 'Open \u26a0\ufe0f Rebase required (merge conflicts)');
  assert.ok(facts(rebase).Rebase.startsWith('\u26a0\ufe0f Required'));
  // Resolved: the line goes away again.
  const rebased = facts(buildMergeRequestCard({ ...baseMr, state: 'rebased', approved: true, autoMerge: false }));
  assert.equal(rebased.Rebase, undefined);
  assert.equal(rebased.Approval, 'Approved');
  assert.equal(rebased['Auto-merge'], '\u23f8\ufe0f Disabled');
});

test('merge request card: merged and closed cards keep what is known', () => {
  const merged = facts(buildMergeRequestCard({ ...baseMr, state: 'merged', approved: true, approvedBy: ['Alice Example'], autoMerge: true }));
  assert.equal(merged.Approval, 'Approved Alice Example');
  assert.equal(merged['Auto-merge'], '\u{1F500} Enabled');
  // Not approved / disabled are not worth a line once merged.
  const mergedPlain = facts(buildMergeRequestCard({ ...baseMr, state: 'merged', approved: false, autoMerge: false }));
  assert.equal(mergedPlain.Approval, undefined);
  assert.equal(mergedPlain['Auto-merge'], undefined);

  const closed = facts(buildMergeRequestCard({ ...baseMr, state: 'closed', approved: true, autoMerge: true, needsRebase: true }));
  assert.equal(closed.Approval, 'Approved');
  assert.equal(closed['Auto-merge'], '\u{1F500} Enabled');
  assert.equal(closed.Rebase, '\u26a0\ufe0f Required: behind target branch');
  const closedUnknown = facts(buildMergeRequestCard({ ...baseMr, state: 'closed', approved: null }));
  assert.equal(closedUnknown.Approval, undefined);
  assert.equal(closedUnknown.Rebase, undefined);
});

test('merge request card: Jira reference without a key uses a linked fallback label', () => {
  const card = buildMergeRequestCard({ ...baseMr, state: 'open', jira: { url: 'https://jira.example.com/browse/EX-9' } });
  assert.equal(rawFacts(card).Ticket, '[Jira issue](https://jira.example.com/browse/EX-9)');
  assert.equal(facts(buildMergeRequestCard({ ...baseMr, state: 'open', jira: { url: 'nope' } })).Ticket, undefined);
});

test('ciStatusEmoji normalizes case and knows cancelled', () => {
  assert.equal(ciStatusEmoji('FAILED'), ciStatusEmoji('failed'));
  assert.equal(ciStatusEmoji('Success'), '\u2705');
  assert.equal(ciStatusEmoji('cancelled'), ciStatusEmoji('canceled'));
  assert.equal(ciStatusInfo('CANCELLED').label, 'Canceled');
});

test('pipeline with an id but no status reads Unknown', () => {
  const card = buildMergeRequestCard({ ...baseMr, state: 'open', pipeline: { id: 9, url: 'https://gitlab.example.com/-/pipelines/9' } });
  assert.equal(rawFacts(card).Pipeline, '[Unknown (#9)](https://gitlab.example.com/-/pipelines/9)');
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

test('merge request header glyphs share the badge colours: open teal, merged light blue, closed red, draft neutral', () => {
  // Palette of a compact (PNG8) glyph as hex RGB triplets.
  const palette = (url) => {
    const png = Buffer.from(url.split(',')[1], 'base64');
    const at = png.indexOf('PLTE');
    const length = png.readUInt32BE(at - 4);
    const colours = [];
    for (let i = 0; i < length; i += 3) colours.push(png.subarray(at + 4 + i, at + 7 + i).toString('hex'));
    return colours;
  };
  assert.ok(palette(GITLAB_ICONS_SMALL['merge-request-open']).includes('17a085'), 'open is teal');
  assert.ok(palette(GITLAB_ICONS_SMALL.merge).includes('428fdc'), 'merged is light blue');
  assert.ok(palette(GITLAB_ICONS_SMALL['merge-request-close']).includes('dd2b0e'), 'closed is red');
  assert.ok(palette(GITLAB_ICONS_SMALL['merge-request']).includes('8a8a92'), 'draft is neutral');
  const open = buildMergeRequestCard({ ...baseMr, state: 'open' });
  const draft = buildMergeRequestCard({ ...baseMr, state: 'open', draft: true });
  const merged = buildMergeRequestCard({ ...baseMr, state: 'merged', draft: true });
  const closed = buildMergeRequestCard({ ...baseMr, state: 'closed', draft: true });
  assert.equal(headerGlyph(open).altText, 'Open');
  assert.equal(headerGlyph(draft).altText, 'Draft');
  assert.equal(headerGlyph(merged).altText, 'Merged', 'a draft flag never masks merged');
  assert.equal(headerGlyph(closed).altText, 'Closed', 'a draft flag never masks closed');
  const urls = new Set([open, draft, merged, closed].map((c) => headerGlyph(c).url));
  assert.equal(urls.size, 4, 'four distinct glyphs');
  assert.equal(headerGlyph(draft).url, GITLAB_ICONS_SMALL['merge-request']);
  assert.equal(facts(open).Status, 'Open');
  assert.equal(facts(draft).Status, 'Draft');
  assert.equal(facts(merged).Status, 'Merged');
  assert.equal(facts(closed).Status, 'Closed');
  assert.equal(style(draft), 'emphasis');
  assert.equal(style(merged), 'emphasis');
  assert.equal(style(closed), 'emphasis');
  for (const c of [open, draft, merged, closed]) assertValidCard(c);
});

test('a draft stays visible as a draft next to the rebase notice', () => {
  const rebase = buildMergeRequestCard({ ...baseMr, state: 'rebase', draft: true });
  assert.equal(facts(rebase).Status, 'Draft \u26a0\ufe0f Rebase required');
  assert.equal(
    facts(buildMergeRequestCard({ ...baseMr, state: 'rebase', draft: true, hasConflicts: true })).Status,
    'Draft \u26a0\ufe0f Rebase required (merge conflicts)',
  );
  assert.equal(facts(buildMergeRequestCard({ ...baseMr, state: 'rebased', draft: true })).Status, 'Draft \u2705 Rebased, up to date and conflict-free');
  // Not a draft: unchanged.
  assert.equal(facts(buildMergeRequestCard({ ...baseMr, state: 'rebase' })).Status, 'Open \u26a0\ufe0f Rebase required');
  assertValidCard(rebase);
});

test('GitLab cards carry a state icon from the GitLab icon set next to the logo; emojis and labels stay', () => {
  const dataPng = /^data:image\/png;base64,iVBOR/;
  const mrCases = [
    ['open', 'Open'],
    ['rebase', 'Open'],
    ['rebased', 'Open'],
    ['merged', 'Merged'],
    ['closed', 'Closed'],
  ];
  const glyphs = new Map();
  for (const [state, alt] of mrCases) {
    const card = buildMergeRequestCard({ ...baseMr, state });
    assertValidCard(card);
    const glyph = headerGlyph(card);
    assert.equal(glyph.type, 'Image');
    assert.equal(glyph.altText, alt);
    assert.match(glyph.url, dataPng);
    assert.ok(glyph.url.length < 10_000);
    assert.equal(glyph.width, '16px');
    glyphs.set(alt, glyph.url);
    assert.equal(headerIcon(card).altText, 'GitLab', 'the brand logo stays first');
    assert.equal(headerLabel(card), 'GitLab \u00b7 Merge request', 'the readable label stays');
  }
  assert.equal(new Set(glyphs.values()).size, 3, 'open, merged and closed look different');

  const statuses = ['success', 'failed', 'running', 'pending', 'created', 'canceled', 'skipped', 'manual', 'waiting_for_resource'];
  const seen = new Set();
  for (const status of statuses) {
    for (const card of [buildPipelineCard({ id: 9, status, project: 'group/project' }), buildJobCard({ id: 5, name: 'b', status })]) {
      const glyph = headerGlyph(card);
      assert.match(glyph.url, dataPng, status);
      assert.match(glyph.altText, /^Pipeline /);
      seen.add(glyph.url);
    }
  }
  assert.ok(seen.size >= 7);
  // The status row carries the icon image and the readable label.
  const failed = buildPipelineCard({ id: 9, status: 'failed', project: 'group/project' });
  assert.match(JSON.stringify(failed), /"Failed"/);

  // An unknown job status has no status icon (the pipeline card falls back to the pipeline icon); other services have none.
  assert.equal(headerGlyph(buildJobCard({ id: 5, name: 'b', status: 'weird' })), null);
  assert.match(headerGlyph(buildPipelineCard({ id: 9, status: 'weird' })).altText, /^Pipeline$/);
  assert.equal(headerGlyph(buildJiraIssueCard({ key: 'EX-1', summary: 'S', issueType: 'Story', status: 'Open' })), null);
});

test('header identifier slot: large bold right-aligned linked reference per entity, shown once', () => {
  const issueUrl = 'https://jira.example.com/browse/APP-123';
  const pipelineUrl = 'https://gitlab.example.com/group/project/-/pipelines/456';
  const jobUrl = 'https://gitlab.example.com/group/project/-/jobs/789';
  const cases = [
    [buildJiraIssueCard({ key: 'APP-123', summary: 'Broken thing', url: issueUrl, status: 'Open' }), 'APP-123', issueUrl, 'Broken thing'],
    [buildMergeRequestCard({ ...baseMr, iid: 123, url: 'https://gitlab.example.com/group/project/-/merge_requests/123' }), '!123', 'https://gitlab.example.com/group/project/-/merge_requests/123', 'Add example feature'],
    [buildPipelineCard({ id: 456, status: 'success', project: 'group/project', url: pipelineUrl }), '#456', pipelineUrl, 'group/project'],
    [buildJobCard({ id: 789, name: 'lint', status: 'failed', project: 'group/project', url: jobUrl }), '#789', jobUrl, 'lint'],
  ];
  for (const [card, ref, url, title] of cases) {
    assertValidCard(card);
    assert.equal(headerRef(card), `[${ref}](${url})`);
    const block = headerRefBlock(card);
    assert.equal(block.size, 'Large');
    assert.equal(block.weight, 'Bolder');
    // Responsive layout from ColumnSet widths only: a stretching label next to an auto-sized reference.
    const columns = header(card).columns;
    assert.equal(columns.at(-1).width, 'auto');
    assert.equal(columns.filter((c) => c.width === 'stretch').length, 1);
    assert.ok(columns.indexOf(columns.find((c) => c.width === 'stretch')) < columns.length - 1);
    assert.ok(!JSON.stringify(card).includes('"position"'), 'no absolute positioning');
    // The full title stays below, and the identifier is not repeated anywhere else.
    assert.equal(mainTitle(card), title);
    const rest = JSON.stringify(items(card).slice(1));
    assert.ok(!rest.includes(`"${ref}"`) && !rest.includes(`${ref} `) && !rest.includes(`in ${ref}`), rest);
  }
});

test('header identifier slot: semantic context stays when the repeated identifier subtitle goes', () => {
  const mr = buildMergeRequestCard({ ...baseMr, state: 'open', targetBranch: 'main', pipeline: { id: 7, status: 'success' } });
  assert.equal(subtitle(mr), 'group/project');
  assert.equal(facts(mr).Target, undefined);
  assert.equal(facts(mr).Pipeline, 'Passed (#7)');
  const job = buildJobCard({ id: 5, name: 'build', status: 'failed', project: 'group/project', stage: 'test', ref: 'main' });
  assert.equal(subtitle(job), 'group/project');
  assert.equal(facts(job).Stage, 'test');
  assert.equal(facts(job).Ref, 'main');
  const pipeline = buildPipelineCard({ id: 9, status: 'failed', project: 'group/project', ref: 'main' });
  assert.equal(mainTitle(pipeline), 'group/project');
  assert.equal(facts(pipeline).Ref, 'main');
});

test('header identifier slot: a missing or invalid ID leaves the slot out and never guesses', () => {
  const url = 'https://gitlab.example.com/group/project/-/merge_requests/1';
  for (const iid of [undefined, null, '', 'abc', '12x', 'gid://gitlab/MergeRequest/99', -1, 1.5]) {
    const card = buildMergeRequestCard({ title: 'T', project: 'group/project', url, iid });
    assertValidCard(card);
    assert.equal(headerRef(card), '', String(iid));
    assert.ok(header(card).columns.every((c) => c.items[0].horizontalAlignment !== 'Right'));
    // Title and its link survive.
    assert.equal(rawTitle(card), `[T](${url})`);
  }
  assert.equal(headerRef(buildJobCard({ name: 'j', status: 'failed' })), '');
  assert.equal(headerRef(buildPipelineCard({ status: 'failed', project: 'group/project' })), '');
  assert.equal(mainTitle(buildMergeRequestCard({ project: 'group/project' })), 'Merge request');
  assert.equal(mainTitle(buildPipelineCard({ status: 'failed' })), 'Pipeline');
  // Numeric strings are fine (API payloads often carry them).
  assert.match(headerRef(buildMergeRequestCard({ iid: '42', title: 'T' })), /^!42$/);
  assert.match(headerRef(buildPipelineCard({ id: '9', status: 'success' })), /^#9$/);
});

test('jira header key: missing key falls back, the issue URL stays on the title; unusable URL is plain', () => {
  const url = 'https://jira.example.com/browse/APP-123';
  const noKey = buildJiraIssueCard({ summary: 'Only a summary', url, status: 'Open' });
  assertValidCard(noKey);
  assert.equal(headerRef(noKey), '');
  assert.equal(rawTitle(noKey), `[Only a summary](${url})`);
  assert.equal(mainTitle(buildJiraIssueCard({ url })), 'Jira issue');
  // Key without a usable URL is shown as plain text, not as a broken link.
  const plainKey = buildJiraIssueCard({ key: 'APP-123', summary: 'S', url: 'javascript:alert(1)' });
  assert.equal(headerRef(plainKey), 'APP-123');
  // The key is visible once across the whole card.
  const card = buildJiraIssueCard({ key: 'APP-123', summary: 'Summary', url, status: 'Open' });
  assert.equal(visibleText(card.body[0].items).split('APP-123').length - 1, 1, 'visible once');
});

test('merge request card: the Ticket fact keeps its bold label, then the embedded Jira logo and the linked key', () => {
  const url = 'https://jira.example.com/browse/EX-123';
  const card = buildMergeRequestCard({ ...baseMr, state: 'open', targetBranch: 'main', jira: { key: 'EX-123', url } });
  assertValidCard(card);
  const row = factRows(card).find((r) => r.columns[0].items[0].text === 'Ticket');
  assert.equal(row.columns.length, 3);
  const [labelColumn, logoColumn, textColumn] = row.columns;
  assert.equal(labelColumn.items[0].weight, 'Bolder');
  assert.deepEqual(logoColumn.items[0], { type: 'Image', url: SERVICE_ICONS.jira, altText: 'Jira', width: '16px', height: '16px' });
  assert.equal(logoColumn.width, 'auto');
  assert.match(logoColumn.items[0].url, /^data:image\//);
  assert.equal(textColumn.items[0].text, `[EX-123](${url})`);
  // Every other fact is still there, none is lost to the rows.
  const f = facts(card);
  assert.equal(f.Status, 'Open');
  assert.equal(f.Target, undefined);
  // No external image URL anywhere in the card.
  const urls = [];
  JSON.stringify(card, (k, v) => (k === 'url' && typeof v === 'string' && /^https?:/.test(v) && urls.push(v), v));
  assert.ok(!urls.some((u) => /\.(png|jpe?g|svg|gif|ico)(\?|$)/i.test(u)));
});

test('merge request card: with a Ticket every fact row shares one label width, so the labels line up', () => {
  const url = 'https://jira.example.com/browse/EX-123';
  const card = buildMergeRequestCard({
    ...baseMr,
    state: 'open',
    targetBranch: 'main',
    approved: true,
    approvedBy: ['Alice Example'],
    autoMerge: true,
    autoMergeUser: 'Alice Example',
    pipeline: { id: 7, status: 'success' },
    jira: { key: 'EX-123', url },
  });
  assert.equal(items(card).filter((i) => i.type === 'FactSet').length, 0);
  const rows = factRows(card);
  assert.deepEqual(
    rows.map((r) => r.columns[0].items[0].text),
    ['Status', 'Approval', 'Pipeline', 'Auto-merge', 'Ticket']
  );
  const widths = new Set(rows.map((r) => r.columns[0].width));
  assert.equal(widths.size, 1);
  const px = Number.parseInt([...widths][0], 10);
  assert.ok(px >= 112 && px >= Math.ceil('Auto-merge'.length * 9.5), `label width ${px}px keeps Auto-merge on one line`);
  assert.ok(px <= 168, `label width ${px}px leaves the value room`);
  for (const r of rows) assert.equal(r.type, 'ColumnSet');
});

test('merge request card: without a Jira reference there is no Ticket row, the state stays a badge row', () => {
  for (const jira of [null, { url: 'nope' }]) {
    const card = buildMergeRequestCard({ ...baseMr, state: 'open', jira });
    // The state badge is an image, which a FactSet cannot hold: the facts are rows.
    assert.equal(items(card).filter((i) => i.type === 'FactSet').length, 0);
    const titles = factRows(card).map((r) => r.columns[0].items[0].text);
    assert.equal(titles[0], 'Status');
    assert.ok(!titles.includes('Ticket'));
    assert.equal(
      factRows(card).flatMap((r) => r.columns.flatMap((c) => c.items)).filter((i) => i.type === 'Image' && i.altText === 'Jira').length,
      0
    );
  }
});

test('service logos are small palette PNGs: every card header carries one and a card has a byte limit', () => {
  for (const [service, url] of Object.entries(SERVICE_ICONS)) {
    assert.match(url, /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/, service);
    const png = Buffer.from(url.split(',')[1], 'base64');
    assert.equal(png.readUInt32BE(16), 48, `${service} is 3x of the 16px slot`);
    assert.equal(png.readUInt32BE(20), 48);
    assert.equal(png[25], 3, `${service} is a palette PNG (colour type 3)`);
    assert.ok(url.length < 1000, `${service} logo is ${url.length} characters`);
  }
});

test('merge request titles are click targets, not underlined Markdown links', () => {
  const card = buildMergeRequestCard(baseMr);
  assertValidCard(card);
  const node = titleNode(card);
  assert.equal(node.type, 'Container');
  assert.deepEqual(node.selectAction, { type: 'Action.OpenUrl', url: baseMr.url });
  assert.equal(node.items.length, 1);
  assert.equal(node.items[0].type, 'TextBlock');
  // Plain text: no Markdown link for the client to underline, special characters escaped.
  assert.equal(node.items[0].text, 'Add example feature');
  assert.equal(node.items[0].weight, 'Bolder');
  assert.equal(node.items[0].size, 'Large');
  const tricky = titleNode(buildMergeRequestCard({ ...baseMr, title: 'Fix [WIP] *a* thing' }));
  assert.equal(tricky.items[0].text, 'Fix \\[WIP\\] \\*a\\* thing');
  // Without a usable URL it stays a plain text block, as before.
  const plain = titleNode(buildMergeRequestCard({ ...baseMr, url: 'javascript:alert(1)' }));
  assert.equal(plain.type, 'TextBlock');
  // The other cards keep their Markdown link titles.
  assert.equal(titleNode(buildJiraIssueCard({ key: 'EX-1', summary: 'Broken', url: 'https://jira.example.com/browse/EX-1' })).type, 'TextBlock');
});

test('merge request title is accent coloured and the project name is a click target that looks the same', () => {
  const mrUrl = 'https://gitlab.example.com/group/project/-/merge_requests/7';
  const card = buildMergeRequestCard({ ...baseMr, url: mrUrl, project: 'group/project' });
  assertValidCard(card);
  const [, title, sub] = items(card);
  assert.equal(title.items[0].color, 'Accent');
  assert.equal(title.items[0].weight, 'Bolder');
  // The project line: a container with the project page, around the unchanged subtle small block.
  assert.equal(sub.type, 'Container');
  assert.deepEqual(sub.selectAction, { type: 'Action.OpenUrl', url: 'https://gitlab.example.com/group/project' });
  assert.equal(sub.spacing, 'None', 'the container takes the spacing');
  assert.deepEqual(sub.items, [{ type: 'TextBlock', text: 'group/project', wrap: true, isSubtle: true, size: 'Small' }]);
  // Nested groups and a sub-path instance keep their full project path.
  const nested = buildMergeRequestCard({ ...baseMr, url: 'https://gitlab.example.com/gitlab/group/sub/app/-/merge_requests/3?x=1#note_2' });
  assert.equal(items(nested)[2].selectAction.url, 'https://gitlab.example.com/gitlab/group/sub/app');
  // No project URL can be derived: the subtitle stays the plain block it was.
  for (const url of [undefined, 'https://gitlab.example.com/x', 'javascript:alert(1)', 'https://gitlab.example.com/group/project/-/issues/1']) {
    const plain = items(buildMergeRequestCard({ ...baseMr, url, project: 'group/project' }))[2];
    assert.equal(plain.type, 'TextBlock', String(url));
    assert.equal(plain.spacing, 'None');
  }
  // Other cards keep their plain subtitles.
  assert.equal(items(buildJobCard({ name: 'j', status: 'failed', project: 'group/project', url: 'https://gitlab.example.com/-/jobs/5' }))[2].type, 'TextBlock');
});
