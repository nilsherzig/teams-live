// Adaptive Card builders for the optional rich messages (`teams.rich_messages`).
//
// Every builder takes plain data (no watcher or API objects) and returns an
// Adaptive Card object. Each card is laid out for what the entity is: a merge
// request shows approval, CI and rebase state, a Jira issue shows type,
// status, priority and assignee, and so on. The watcher always keeps the
// regular markdown text next to the card as the fallback.

export const ADAPTIVE_CARD_SCHEMA = 'http://adaptivecards.io/schemas/adaptive-card.json';
export const ADAPTIVE_CARD_VERSION = '1.4';

const str = (value) => (value === undefined || value === null ? '' : String(value).trim());

function textBlock(text, extra = {}) {
  return { type: 'TextBlock', text: str(text), wrap: true, ...extra };
}

function factSet(facts) {
  const entries = facts
    .map(([title, value]) => ({ title: str(title), value: str(value) }))
    .filter((f) => f.title && f.value);
  return entries.length > 0 ? { type: 'FactSet', facts: entries, spacing: 'Small' } : null;
}

function openUrl(title, url) {
  const target = str(url);
  return target ? { type: 'Action.OpenUrl', title, url: target } : null;
}

/**
 * Wraps the entity body in a coloured container and assembles the card.
 * `style` is an Adaptive Card container style (`good`, `attention`,
 * `warning`, `accent`, `emphasis`) and conveys the state at a glance.
 */
function assembleCard({ style = 'emphasis', title, subtitle, facts = [], actions = [], fallbackText }) {
  const items = [
    textBlock(title || subtitle || 'Update', { weight: 'Bolder', size: 'Medium' }),
    subtitle && title ? textBlock(subtitle, { isSubtle: true, spacing: 'None', size: 'Small' }) : null,
    factSet(facts),
  ].filter(Boolean);

  const card = {
    $schema: ADAPTIVE_CARD_SCHEMA,
    type: 'AdaptiveCard',
    version: ADAPTIVE_CARD_VERSION,
    msteams: { width: 'Full' },
    body: [{ type: 'Container', style, bleed: false, items }],
  };
  const cardActions = actions.filter(Boolean);
  if (cardActions.length > 0) card.actions = cardActions;
  if (fallbackText) card.fallbackText = str(fallbackText);
  return card;
}

/** Maps a GitLab pipeline/job status to a label and a container style. */
export function ciStatusInfo(status) {
  switch (str(status).toLowerCase()) {
    case 'success':
    case 'passed':
      return { label: 'Passed', style: 'good' };
    case 'failed':
      return { label: 'Failed', style: 'attention' };
    case 'canceled':
    case 'cancelled':
      return { label: 'Canceled', style: 'attention' };
    case 'running':
      return { label: 'Running', style: 'accent' };
    case 'pending':
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'scheduled':
      return { label: str(status).replace(/_/g, ' '), style: 'warning' };
    case 'manual':
    case 'skipped':
      return { label: str(status), style: 'emphasis' };
    default:
      return { label: str(status) || 'Unknown', style: 'emphasis' };
  }
}

function pipelineFact(pipeline) {
  if (!pipeline) return null;
  const { label } = ciStatusInfo(pipeline.status);
  const id = pipeline.id ? ` (#${pipeline.id})` : '';
  return ['Pipeline', `${label}${id}`];
}

/**
 * GitLab merge request.
 * `state`: `open` (status update), `merged`, `closed`, `rebase` (rebase
 * required) or `rebased` (rebase resolved).
 */
export function buildMergeRequestCard(mr) {
  const state = mr.state || 'open';
  const ci = mr.pipeline ? ciStatusInfo(mr.pipeline.status) : null;

  let statusLabel = 'Open';
  let style = 'accent';
  if (state === 'merged') {
    statusLabel = 'Merged';
    style = 'good';
  } else if (state === 'closed') {
    statusLabel = 'Closed (unmerged)';
    style = 'attention';
  } else if (state === 'rebase') {
    statusLabel = mr.hasConflicts ? 'Rebase required (merge conflicts)' : 'Rebase required';
    style = 'warning';
  } else if (state === 'rebased') {
    statusLabel = 'Rebased, up to date';
    style = 'good';
  } else if (ci?.style === 'attention') {
    style = 'attention';
  } else if (mr.approved && ci?.style === 'good') {
    style = 'good';
  } else if (mr.needsRebase) {
    style = 'warning';
  }

  const open = state === 'open';
  const approvers = (mr.approvedBy || []).filter(Boolean);
  const approval = open
    ? mr.approved
      ? `Approved${approvers.length > 0 ? ` by ${approvers.join(', ')}` : ''}`
      : 'Not approved yet'
    : '';
  const rebase = open && mr.needsRebase ? (mr.hasConflicts ? 'Required (merge conflicts)' : 'Required') : '';
  const autoMerge = open && mr.autoMerge ? `Enabled${mr.autoMergeUser ? ` by ${mr.autoMergeUser}` : ''}` : '';
  const pipelineLabel = pipelineFact(mr.pipeline);

  return assembleCard({
    style,
    title: mr.title || `Merge request !${mr.iid}`,
    subtitle: `Merge request !${mr.iid}${mr.project ? ` in ${mr.project}` : ''}`,
    facts: [
      ['Status', statusLabel],
      ['Approval', approval],
      pipelineLabel,
      ['Rebase', rebase],
      ['Auto-merge', autoMerge],
      ['Target', mr.targetBranch],
      ['Jira', mr.jira?.key],
    ].filter(Boolean),
    actions: [
      openUrl('Open merge request', mr.url),
      openUrl('Open pipeline', mr.pipeline?.url),
      openUrl(mr.jira?.key ? `Open ${mr.jira.key}` : 'Open Jira issue', mr.jira?.url),
    ],
    fallbackText: mr.fallbackText,
  });
}

/** GitLab CI job. */
export function buildJobCard(job) {
  const info = ciStatusInfo(job.status);
  return assembleCard({
    style: info.style,
    title: job.name || `Job #${job.id}`,
    subtitle: `CI job #${job.id}${job.project ? ` in ${job.project}` : ''}`,
    facts: [
      ['Status', info.label],
      ['Stage', job.stage],
      ['Ref', job.ref],
      ['Duration', job.duration],
      ['Failure reason', job.status === 'failed' ? job.failureReason : ''],
      pipelineFact(job.pipeline),
      ['Merge request', job.mr?.iid ? `!${job.mr.iid}${job.mr.title ? ` ${job.mr.title}` : ''}` : ''],
    ].filter(Boolean),
    actions: [
      openUrl('Open job', job.url),
      openUrl('Open pipeline', job.pipeline?.url),
      openUrl('Open merge request', job.mr?.url),
    ],
    fallbackText: job.fallbackText,
  });
}

/** GitLab CI pipeline. */
export function buildPipelineCard(pipeline) {
  const info = ciStatusInfo(pipeline.status);
  return assembleCard({
    style: info.style,
    title: `Pipeline #${pipeline.id}`,
    subtitle: pipeline.project ? `CI pipeline in ${pipeline.project}` : 'CI pipeline',
    facts: [
      ['Status', info.label],
      ['Ref', pipeline.ref],
      ['Duration', pipeline.duration],
      ['YAML errors', pipeline.yamlErrors],
      ['Merge request', pipeline.mr?.iid ? `!${pipeline.mr.iid}${pipeline.mr.title ? ` ${pipeline.mr.title}` : ''}` : ''],
    ].filter(Boolean),
    actions: [openUrl('Open pipeline', pipeline.url), openUrl('Open merge request', pipeline.mr?.url)],
    fallbackText: pipeline.fallbackText,
  });
}

/** Jira issue. */
export function buildJiraIssueCard(issue) {
  const category = str(issue.statusCategory).toLowerCase();
  const name = str(issue.status).toLowerCase();
  let style = 'emphasis';
  if (category === 'done' || ['done', 'closed', 'resolved'].includes(name)) {
    style = 'good';
  } else if (category === 'indeterminate' || name.includes('progress') || name.includes('review') || name.includes('active')) {
    style = 'accent';
  }

  return assembleCard({
    style,
    title: issue.summary || issue.key,
    subtitle: `${issue.issueType || 'Issue'} ${issue.key}`,
    facts: [
      ['Status', issue.status],
      ['Priority', issue.priority || 'None'],
      ['Assignee', issue.assignee || 'Unassigned'],
    ],
    actions: [openUrl(`Open ${issue.key}`, issue.url)],
    fallbackText: issue.fallbackText,
  });
}

/** OpsGenie alert. */
export function buildOpsGenieAlertCard(alert) {
  const closed = alert.status === 'closed';
  const priority = str(alert.priority) || 'P3';
  let style = 'warning';
  if (closed) style = 'emphasis';
  else if (alert.acknowledged) style = 'accent';
  else if (priority === 'P1' || priority === 'P2') style = 'attention';

  return assembleCard({
    style,
    title: alert.message || 'Alert',
    subtitle: alert.tinyId ? `OpsGenie alert #${alert.tinyId}` : 'OpsGenie alert',
    facts: [
      ['Priority', priority],
      ['Status', `${alert.status || 'open'}, ${alert.acknowledged ? 'acknowledged' : 'unacknowledged'}`],
      ['Owner', alert.owner || 'Unassigned'],
    ],
    actions: [openUrl('Open alert', alert.url)],
    fallbackText: alert.fallbackText,
  });
}

/** Confluence page. */
export function buildConfluencePageCard(page) {
  const space = page.spaceName ? `${page.spaceName}${page.spaceKey ? ` (${page.spaceKey})` : ''}` : page.spaceKey;
  return assembleCard({
    style: 'emphasis',
    title: page.title || 'Confluence page',
    subtitle: 'Confluence page',
    facts: [
      ['Space', space],
      ['Last edited by', page.author],
    ],
    actions: [openUrl('Open page', page.url)],
    fallbackText: page.fallbackText,
  });
}
