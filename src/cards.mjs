// Adaptive Card builders for the optional rich messages (`teams.rich_messages`).
//
// Every builder takes plain data (no watcher or API objects) and returns an
// Adaptive Card object. Each card is laid out for what the entity is: a merge
// request shows approval, CI and rebase state, a Jira issue shows type,
// status, priority and assignee, and so on. The watcher always keeps the
// regular markdown text next to the card as the fallback.
//
// The merge request card keeps the status emojis of the regular messages (see
// the watcher): approval, CI, rebase, auto-merge, merged and closed. Job and
// pipeline cards use the same CI status emojis.
//
// Layout of every card: a compact header with the logo of the service and a
// label for the kind of entity (for example "GitLab - Merge request"), then the
// title, an optional one-line subtitle and a few facts. Navigation uses inline
// links (the title and the cross references), not buttons. The one exception
// is the "Approve..." button of the merge request card (`approveUrl`), which
// opens a capability-link confirmation page: it never approves by itself.

import { SERVICE_ICONS } from './card-icons.mjs';
import { GITLAB_ICONS } from './gitlab-icons.mjs';

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

/**
 * Returns the URL as a safe markdown link target, or '' when it is missing or
 * not an http(s) URL. Parentheses are percent-encoded so they cannot end the
 * link early.
 */
function safeHttpUrl(url) {
  const raw = str(url);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return parsed.href.replace(/\(/g, '%28').replace(/\)/g, '%29');
  } catch {
    return '';
  }
}

/** Escapes the characters that would break a markdown link label. */
function escapeLinkLabel(text) {
  return text.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

/**
 * Markdown hyperlink for text inside a card. Without a usable http(s) URL
 * (or without text) the text is returned unchanged, so a missing URL never
 * leaves stray brackets behind.
 */
export function mdLink(text, url) {
  const label = str(text);
  const target = safeHttpUrl(url);
  if (!label || !target) return label;
  return `[${escapeLinkLabel(label)}](${target})`;
}

const SERVICES = {
  gitlab: 'GitLab',
  jira: 'Jira',
  opsgenie: 'OpsGenie',
  confluence: 'Confluence',
};

// Brands without a logo: the header shows an emoji instead (used by the
// command reply cards, which are not about one service entity).
const EMOJI_BRANDS = {
  directory: { emoji: '🪪', name: 'Directory' },
  availability: { emoji: '📍', name: 'Availability' },
  calendar: { emoji: '📅', name: 'Calendar' },
  standup: { emoji: '🌅', name: 'Standup' },
  // Replies of the bot itself: help, status, errors, acknowledgements, notices.
  bot: { emoji: '🧢', name: 'teams-live' },
};

/** Compact integration header: small service logo (or emoji) plus "Service - kind". */
function header(service, kind, glyph = null) {
  const emojiBrand = EMOJI_BRANDS[service];
  const name = emojiBrand ? emojiBrand.name : SERVICES[service];
  const lead = emojiBrand
    ? textBlock(emojiBrand.emoji, { size: 'Small' })
    : { type: 'Image', url: SERVICE_ICONS[service], altText: name, width: '16px', height: '16px' };
  const glyphColumn =
    glyph && GITLAB_ICONS[glyph.icon]
      ? [
          {
            type: 'Column',
            width: 'auto',
            verticalContentAlignment: 'Center',
            items: [{ type: 'Image', url: GITLAB_ICONS[glyph.icon], altText: glyph.label, width: '16px', height: '16px' }],
          },
        ]
      : [];
  return {
    type: 'ColumnSet',
    columns: [
      {
        type: 'Column',
        width: 'auto',
        verticalContentAlignment: 'Center',
        items: [lead],
      },
      ...glyphColumn,
      {
        type: 'Column',
        width: 'stretch',
        verticalContentAlignment: 'Center',
        items: [textBlock(kind ? `${name} · ${kind}` : name, { size: 'Small', weight: 'Bolder', isSubtle: true })],
      },
    ],
  };
}

/**
 * Wraps the entity body in a coloured container and assembles the card.
 * `titleUrl` turns the title into a hyperlink to the entity.
 * `style` is an Adaptive Card container style (`good`, `attention`,
 * `warning`, `accent`, `emphasis`) and conveys the state at a glance.
 * `badges` is a row of non-interactive status badges, `extraItems` are
 * appended after the facts. `actions` are bottom buttons (Action.OpenUrl).
 */
function assembleCard({
  service,
  kind,
  glyph = null,
  style = 'emphasis',
  title,
  titleUrl,
  subtitle,
  badges = [],
  stats = null,
  facts = [],
  extraItems = [],
  actions = [],
  fallbackText,
}) {
  const items = [
    header(service, kind, glyph),
    textBlock(mdLink(title || subtitle || 'Update', titleUrl), { weight: 'Bolder', size: 'Medium' }),
    subtitle && title ? textBlock(subtitle, { isSubtle: true, spacing: 'None', size: 'Small' }) : null,
    diffStatsRow(stats),
    badgeRow(badges),
    factSet(facts),
    ...extraItems,
  ].filter(Boolean);

  const card = {
    $schema: ADAPTIVE_CARD_SCHEMA,
    type: 'AdaptiveCard',
    version: ADAPTIVE_CARD_VERSION,
    msteams: { width: 'Full' },
    body: [{ type: 'Container', style, bleed: false, items }],
  };
  const buttons = actions
    .map((a) => ({ title: str(a?.title), url: safeHttpUrl(a?.url) }))
    .filter((a) => a.title && a.url)
    .map((a) => ({ type: 'Action.OpenUrl', title: a.title, url: a.url }));
  if (buttons.length > 0) card.actions = buttons;
  if (fallbackText) card.fallbackText = str(fallbackText);
  return card;
}

/**
 * Compact "+added -removed" line counts: adjacent coloured runs (Good and
 * Attention) that also carry a textual sign, so the meaning does not depend on
 * colour. Only exact totals are shown: null, missing or malformed counts give
 * no row at all instead of a made-up zero.
 */
function diffStatsRow(stats) {
  const isCount = (v) => Number.isInteger(v) && v >= 0;
  if (!stats || !isCount(stats.additions) || !isCount(stats.deletions)) return null;
  const run = (text, extra = {}) => ({ type: 'TextRun', text, size: 'Small', ...extra });
  return {
    type: 'RichTextBlock',
    spacing: 'None',
    inlines: [
      run(`+${stats.additions}`, { color: 'Good', weight: 'Bolder' }),
      run(' '),
      run(`\u2212${stats.deletions}`, { color: 'Attention', weight: 'Bolder' }),
      run(' lines', { isSubtle: true }),
    ],
  };
}

/**
 * Row of status badges: small coloured columns with a bold label. They show
 * state only; they are not buttons and carry no action.
 */
function badgeRow(badges) {
  const columns = badges
    .filter((b) => b && str(b.text))
    .map((b) => ({
      type: 'Column',
      width: 'auto',
      style: b.style || 'emphasis',
      bleed: false,
      items: [textBlock(b.text, { size: 'Small', weight: 'Bolder', color: b.color, spacing: 'None' })],
    }));
  if (columns.length === 0) return null;
  return { type: 'ColumnSet', spacing: 'Small', columns };
}

/**
 * Status emoji of a GitLab pipeline/job. This is the one mapping shared with
 * the regular (markdown) messages of the watcher.
 */
export function ciStatusEmoji(status) {
  switch (str(status).toLowerCase()) {
    case 'success':
    case 'passed':
      return '\u2705';
    case 'failed':
      return '\u274c';
    case 'running':
      return '\u23f3';
    case 'pending':
    case 'waiting_for_resource':
    case 'preparing':
    case 'created':
      return '\u23f1\ufe0f';
    case 'canceled':
    case 'cancelled':
      return '\u26a0\ufe0f';
    case 'skipped':
      return '\u23ed\ufe0f';
    case 'manual':
      return '\u2699\ufe0f';
    default:
      return '\ud83d\udd39';
  }
}

/** GitLab status icon (gitlab-icons.mjs) for a pipeline/job status, or null. */
export function ciStatusGlyph(status) {
  const s = str(status).toLowerCase();
  const icon = {
    success: 'status_success',
    passed: 'status_success',
    failed: 'status_failed',
    running: 'status_running',
    pending: 'status_pending',
    waiting_for_resource: 'status_pending',
    created: 'status_created',
    preparing: 'status_created',
    scheduled: 'status_created',
    canceled: 'status_canceled',
    cancelled: 'status_canceled',
    skipped: 'status_skipped',
    manual: 'status_manual',
  }[s];
  return icon ? { icon, label: `Pipeline ${s.replace(/_/g, ' ')}` } : null;
}

/** GitLab merge request state icon: open, merged or closed. */
function mrGlyph(state) {
  if (state === 'merged') return { icon: 'merge', label: 'Merged' };
  if (state === 'closed') return { icon: 'merge-request-close', label: 'Closed' };
  return { icon: 'merge-request-open', label: 'Open' };
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

/** "Status (#id)" fact for a pipeline, with the same emoji as the regular messages. */
function pipelineFact(pipeline, known) {
  if (!pipeline) {
    // No pipeline: say "none" when GitLab was asked, "unknown" when the lookup failed, nothing when not asked.
    if (known === true) return ['Pipeline', '\ud83c\udfd7\ufe0f None'];
    if (known === false) return ['Pipeline', '\u2754 Unknown (not retrieved)'];
    return null;
  }
  const status = str(pipeline.status);
  const id = pipeline.id ? `#${pipeline.id}` : '';
  if (!status) {
    // A pipeline without a known status reads "unknown", as in the regular messages.
    return ['Pipeline', `\ud83d\udd39 ${mdLink(id ? `Unknown (${id})` : 'Unknown', pipeline.url)}`];
  }
  const label = ciStatusInfo(status).label;
  const text = mdLink(id ? `${label} (${id})` : label, pipeline.url);
  return ['Pipeline', `${ciStatusEmoji(status)} ${text}`];
}

/** "!42 Title" reference to a merge request, linked when its URL is known. */
function mrReference(mr) {
  if (!mr?.iid) return '';
  return mdLink(`!${mr.iid}${mr.title ? ` ${mr.title}` : ''}`, mr.url);
}

const tri = (value) => (value === true ? true : value === false ? false : null);

/**
 * GitLab merge request.
 * `state`: `open` (status update), `merged`, `closed`, `rebase` (rebase
 * required) or `rebased` (rebase resolved).
 *
 * `approved` and `autoMerge` are tri-state: true, false, or null/undefined
 * when the value was not retrieved. An open merge request always shows both
 * (unknown reads "Unknown (not retrieved)", never "no"). `pipelineKnown`
 * (true/false/undefined) tells "no pipeline" from a failed lookup. The rebase fact
 * appears only while a rebase is required. Merged and closed merge requests
 * keep the details that are known. `approveUrl` adds an "Approve..." button
 * that opens a confirmation page (see src/approve.mjs); it never approves by
 * itself.
 */
export function buildMergeRequestCard(mr) {
  const state = mr.state || 'open';
  const live = state === 'open' || state === 'rebase' || state === 'rebased';
  const ci = mr.pipeline ? ciStatusInfo(mr.pipeline.status) : null;
  const approved = tri(mr.approved);
  const autoMerge = tri(mr.autoMerge);
  const rebaseRequired = state === 'rebase' || (state !== 'rebased' && mr.needsRebase === true);
  const reason = mr.hasConflicts ? 'merge conflicts' : 'behind target branch';

  let statusLabel = 'Open';
  let style = 'accent';
  if (state === 'merged') {
    statusLabel = '🎉 Merged';
    style = 'good';
  } else if (state === 'closed') {
    statusLabel = '🚫 Closed (unmerged)';
    style = 'attention';
  } else if (state === 'rebase') {
    statusLabel = mr.hasConflicts ? '⚠️ Rebase required (merge conflicts)' : '⚠️ Rebase required';
    style = 'warning';
  } else if (state === 'rebased') {
    statusLabel = '✅ Rebased, up to date and conflict-free';
    style = 'good';
  } else if (ci?.style === 'attention') {
    style = 'attention';
  } else if (approved === true && ci?.style === 'good') {
    style = 'good';
  } else if (rebaseRequired) {
    style = 'warning';
  }

  const approvers = (mr.approvedBy || []).filter(Boolean);
  let approval = '';
  if (approved === true) {
    approval = `👍 Approved${approvers.length > 0 ? ` by ${approvers.join(', ')}` : ''}`;
  } else if (live || (state === 'closed' && approved === false)) {
    approval = approved === false ? '⏳ Not approved yet' : '❔ Unknown (not retrieved)';
  }

  let autoMergeText = '';
  if (autoMerge === true) {
    autoMergeText = `🔀 Enabled${mr.autoMergeUser ? ` by ${mr.autoMergeUser}` : ''}`;
  } else if (live) {
    autoMergeText = autoMerge === false ? '⏸️ Disabled' : '❔ Unknown (not retrieved)';
  }

  let rebase = '';
  if (rebaseRequired && state !== 'merged') {
    rebase = `⚠️ Required: ${reason}${mr.detailedMergeStatus ? ` (status: ${mr.detailedMergeStatus})` : ''}`;
  }

  const jiraLabel = str(mr.jira?.key) || (safeHttpUrl(mr.jira?.url) ? 'Jira issue' : '');

  return assembleCard({
    service: 'gitlab',
    kind: 'Merge request',
    glyph: mrGlyph(state),
    style,
    title: mr.title || `Merge request !${mr.iid}`,
    titleUrl: mr.url,
    subtitle: `!${mr.iid}${mr.project ? ` in ${mr.project}` : ''}`,
    stats: mr.diffStats,
    facts: [
      ['Status', statusLabel],
      ['Approval', approval],
      pipelineFact(mr.pipeline, mr.pipelineKnown),
      ['Rebase', rebase],
      ['Auto-merge', autoMergeText],
      ['Target', mr.targetBranch],
      ['Jira', mdLink(jiraLabel, mr.jira?.url)],
    ].filter(Boolean),
    actions: mr.approveUrl ? [{ title: 'Approve…', url: mr.approveUrl }] : [],
    fallbackText: mr.fallbackText,
  });
}

/** GitLab CI job. */
export function buildJobCard(job) {
  const info = ciStatusInfo(job.status);
  return assembleCard({
    service: 'gitlab',
    kind: 'CI job',
    glyph: ciStatusGlyph(job.status),
    style: info.style,
    title: job.name || `Job #${job.id}`,
    titleUrl: job.url,
    subtitle: `#${job.id}${job.project ? ` in ${job.project}` : ''}`,
    facts: [
      ['Status', `${ciStatusEmoji(job.status)} ${info.label}`],
      ['Stage', job.stage],
      ['Ref', job.ref],
      ['Duration', job.duration],
      ['Failure reason', job.status === 'failed' ? job.failureReason : ''],
      pipelineFact(job.pipeline),
      ['Merge request', mrReference(job.mr)],
    ].filter(Boolean),
    fallbackText: job.fallbackText,
  });
}

/** GitLab CI pipeline. */
export function buildPipelineCard(pipeline) {
  const info = ciStatusInfo(pipeline.status);
  return assembleCard({
    service: 'gitlab',
    kind: 'Pipeline',
    glyph: ciStatusGlyph(pipeline.status) || { icon: 'pipeline', label: 'Pipeline' },
    style: info.style,
    title: `Pipeline #${pipeline.id}`,
    titleUrl: pipeline.url,
    subtitle: pipeline.project,
    facts: [
      ['Status', `${ciStatusEmoji(pipeline.status)} ${info.label}`],
      ['Ref', pipeline.ref],
      ['Duration', pipeline.duration],
      ['YAML errors', pipeline.yamlErrors],
      ['Merge request', mrReference(pipeline.mr)],
    ].filter(Boolean),
    fallbackText: pipeline.fallbackText,
  });
}

const JIRA_TYPE_ICONS = {
  bug: '🐛',
  story: '📖',
  task: '📋',
  subtask: '📄',
  spike: '⚡',
  epic: '🏔️',
  improvement: '💡',
};

/** Status icon of a Jira issue, as in the regular messages. */
function jiraStatusIcon(status, category) {
  const cat = str(category).toLowerCase();
  const name = str(status).toLowerCase();
  if (cat === 'done' || name === 'done' || name === 'closed' || name === 'resolved') return '🟢';
  if (name.includes('review')) return '🟣';
  if (cat === 'indeterminate' || name.includes('progress') || name.includes('active')) return '🟡';
  return '⚪';
}

/** Priority icon of a Jira issue, as in the regular messages. */
function jiraPriorityIcon(priority) {
  const p = str(priority).toLowerCase();
  if (p.includes('high') || p.includes('blocker') || p.includes('critical')) return '🔴';
  if (p.includes('low') || p.includes('trivial')) return '🟢';
  return '🟡';
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
  const type = issue.issueType || 'Task';
  const typeIcon = JIRA_TYPE_ICONS[str(type).toLowerCase()] || JIRA_TYPE_ICONS.task;
  const status = str(issue.status);
  const priority = issue.priority || 'None';

  return assembleCard({
    service: 'jira',
    kind: `${typeIcon} ${type}`,
    style,
    title: issue.summary || issue.key,
    titleUrl: issue.url,
    subtitle: issue.key,
    facts: [
      ['Status', status ? `${jiraStatusIcon(status, category)} ${status}` : ''],
      ['Priority', `${jiraPriorityIcon(issue.priority)} ${priority}`],
      ['Assignee', issue.assignee || 'Unassigned'],
    ],
    fallbackText: issue.fallbackText,
  });
}

// OpsGenie priority colours. Teams cards only offer a few theme colours, so
// the shades are approximated: P2 (orange) and P3 (amber) share the "warning"
// style and differ by their dot and label. Closed has precedence over the
// acknowledgement state.
const OPSGENIE_PRIORITIES = {
  P1: { dot: '🔴', style: 'attention', color: 'Attention' },
  P2: { dot: '🟠', style: 'warning', color: 'Warning' },
  P3: { dot: '🟡', style: 'warning', color: 'Warning' },
  P4: { dot: '🟢', style: 'good', color: 'Good' },
  P5: { dot: '⚪', style: 'emphasis', color: undefined },
};

const OPSGENIE_PRIORITY_ICONS = { P1: '🚨', P2: '🔥', P3: '⚠️', P4: 'ℹ️', P5: '🔹' };

/** OpsGenie priority badge: coloured dot and label (P1 red ... P5 subdued). */
export function opsGeniePriorityBadge(priority) {
  const label = str(priority) || 'P3';
  const spec = OPSGENIE_PRIORITIES[label.toUpperCase()] || { dot: '🔹', style: 'emphasis', color: undefined };
  return { text: `${spec.dot} ${label}`, style: spec.style, color: spec.color };
}

/** OpsGenie status badge: CLOSED (wins), ACK'D or OPEN. */
export function opsGenieStatusBadge(alert) {
  if (str(alert.status).toLowerCase() === 'closed') return { text: 'CLOSED', style: 'emphasis', color: undefined };
  if (alert.acknowledged) return { text: "ACK'D", style: 'warning', color: 'Warning' };
  return { text: 'OPEN', style: 'attention', color: 'Attention' };
}

/** OpsGenie alert. */
export function buildOpsGenieAlertCard(alert) {
  const closed = str(alert.status).toLowerCase() === 'closed';
  const priority = str(alert.priority) || 'P3';
  const id = str(alert.id);
  const subtitle = alert.tinyId ? `#${alert.tinyId}` : id ? `Alert ${id.slice(0, 8)}` : '';
  const statusIcon = closed ? '⚪' : '🟢';

  return assembleCard({
    service: 'opsgenie',
    kind: 'Alert',
    // The badges carry the colour: the container stays neutral so they stand out.
    style: 'emphasis',
    title: alert.message || 'Alert',
    titleUrl: alert.url,
    subtitle,
    badges: [opsGeniePriorityBadge(priority), opsGenieStatusBadge(alert)],
    facts: [
      ['Priority', `${OPSGENIE_PRIORITY_ICONS[priority.toUpperCase()] || '⚠️'} ${priority}`],
      ['Status', `${statusIcon} ${alert.status || 'open'} (${alert.acknowledged ? 'acknowledged' : 'unacknowledged'})`],
      ['Owner', alert.owner || 'Unassigned'],
    ],
    fallbackText: alert.fallbackText,
  });
}

/** Confluence page. */
export function buildConfluencePageCard(page) {
  const space = page.spaceName ? `${page.spaceName}${page.spaceKey ? ` (${page.spaceKey})` : ''}` : page.spaceKey;
  return assembleCard({
    service: 'confluence',
    kind: 'Page',
    style: 'emphasis',
    title: page.title || 'Confluence page',
    titleUrl: page.url,
    facts: [
      ['Space', space],
      ['Last edited by', page.author],
    ],
    fallbackText: page.fallbackText,
  });
}

// ---------------------------------------------------------------------------
// Command reply cards
//
// The structured replies of the commands (/mrs, /whois, /whereis, /alerts,
// /sprint, ...) are formatted as markdown by the regular formatters. The card
// is generated from that same markdown, so every field of the regular reply
// reaches the card and the regular output stays untouched.
// ---------------------------------------------------------------------------

/**
 * Largest rich message (bytes on the wire, including the fallback copy of the
 * markdown and the escaping of the `cards` property, see richMessageWireBytes);
 * a bigger one falls back to the full regular markdown.
 */
export const MAX_CARD_BYTES = 24000;

/**
 * Replaces contact mentions (`@[Name](mri)`) by the bold name, and drops a
 * mention that only repeats a bold name next to it. A card must not ping
 * people for a status reply.
 */
export function stripMentionMarkup(markdown) {
  return String(markdown ?? '')
    .replace(/(\*\*([^*]+)\*\*) \(@\[\2\]\([^)\s]+\)\)/g, '$1')
    .replace(/@\[([^\]]+)\]\((?!https?:)([^)\s]+)\)/g, '**$1**');
}

/** HTML entities the regular formatters escape for Teams HTML (`escapeHtml`); a card shows text as is. */
function unescapeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Card text: mention markup removed, code spans shown as plain text (cards do not render them). */
function cardText(markdown) {
  return unescapeEntities(stripMentionMarkup(markdown).replace(/`([^`\n]*)`/g, '$1'));
}

const BULLET_RE = /^(\s*)(?:([-•*])|(\d+)\.)\s+(.*)$/;
const FACT_RE = /^(?:([^\s[\]*_`A-Za-z0-9]+)\s+)?\*\*([^*]+)\*\*:\s*(.*)$/;
const LEADING_EMOJI_RE = /^[\p{Extended_Pictographic}[]/u;

/**
 * A nested row: a fixed-width spacer column next to the content, so the
 * hierarchy does not depend on leading spaces (which Teams collapses). The
 * explicit sub-bullet marker keeps it readable even without the spacer.
 */
function indentedRow(block, indent) {
  const level = Math.min(3, Math.max(1, Math.round(indent / 2)));
  return {
    type: 'ColumnSet',
    spacing: 'None',
    columns: [
      { type: 'Column', width: `${level * 16}px`, items: [{ type: 'TextBlock', text: '\u00a0', size: 'Small', spacing: 'None' }] },
      { type: 'Column', width: 'stretch', items: [block] },
    ],
  };
}

function parseBullet(line) {
  const m = BULLET_RE.exec(line);
  if (!m) return null;
  return { indent: m[1].replace(/\t/g, '  ').length, ordered: m[3] !== undefined, number: m[3], body: m[4].trim() };
}

/**
 * Builds a card from a markdown reply made of a head line, optional
 * paragraphs and bullet lists. Returns null when there is nothing list-like to
 * show (the caller then sends the plain markdown).
 *
 * - The first line becomes the title (inline links kept).
 * - A run of `- icon **Label**: value` bullets becomes a fact set.
 * - Any other bullet becomes one compact row (links and status emojis kept);
 *   indented bullets become indented rows below their parent.
 * - Paragraphs stay paragraphs, `_notes_` become small subtle notes.
 */
export function buildMarkdownCard(markdown, { service, kind, style = 'emphasis', fallbackText } = {}) {
  const lines = String(markdown ?? '').split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return null;

  const title = cardText(lines[first])
    .replace(/\*\*/g, '')
    .replace(/^[^\p{L}\p{N}[(#@!]+/u, '')
    .replace(/:\s*$/, '')
    .trim();
  if (!title) return null;

  const { items, bullets } = markdownBodyItems(lines, first + 1);
  if (bullets === 0) return null;
  return assembleCard({ service, kind, style, title, extraItems: items, fallbackText });
}

/** Escapes what a TextBlock would interpret as markdown, for verbatim (code) lines. */
function verbatimText(line) {
  const escaped = line.replace(/([\\*_[\]`])/g, '\\$1');
  const indent = /^ */.exec(escaped)[0].length;
  return `${' '.repeat(indent)}${escaped.slice(indent)}` || ' ';
}

/**
 * A fenced code block: one monospace line per row, so the layout (indentation,
 * grids, command output) survives; cards do not render markdown fences.
 */
function codeBlock(codeLines) {
  return {
    type: 'Container',
    spacing: 'Small',
    items: codeLines.map((line) => ({
      type: 'TextBlock',
      text: verbatimText(line),
      wrap: true,
      fontType: 'Monospace',
      size: 'Small',
      spacing: 'None',
    })),
  };
}

/**
 * Card items for the markdown lines from `from` on (see buildMarkdownCard for
 * the rules), plus fenced code blocks and `#` headings. `bullets` counts the
 * list rows, which is what makes a text "list-like".
 */
function markdownBodyItems(lines, from) {
  const nextNonEmpty = (start) => {
    for (let k = start; k < lines.length; k += 1) if (lines[k].trim()) return lines[k];
    return null;
  };

  const items = [];
  let bullets = 0;
  let i = from;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const code = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence (or the end of an unterminated block)
      if (code.length > 0) items.push(codeBlock(code));
      continue;
    }
    const bullet = parseBullet(line);
    if (!bullet) {
      const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
      const text = heading ? `**${cardText(heading[1]).replace(/\*\*/g, '')}**` : cardText(line.trim());
      const upcoming = nextNonEmpty(i + 1);
      if (/^_[^_].*_$/.test(text) || /^\*[^*].*\*$/.test(text)) {
        items.push(textBlock(text, { isSubtle: true, size: 'Small', spacing: 'Small' }));
      } else {
        items.push(textBlock(text, { spacing: upcoming && parseBullet(upcoming) ? 'Medium' : 'Small' }));
      }
      i += 1;
      continue;
    }

    // A run of top-level unordered bullets, possibly all facts.
    if (bullet.indent === 0 && !bullet.ordered) {
      const run = [];
      let j = i;
      while (j < lines.length) {
        const b = parseBullet(lines[j]);
        if (!b || b.indent !== 0 || b.ordered) break;
        run.push(b);
        j += 1;
      }
      const facts = run.map((b) => FACT_RE.exec(b.body));
      if (facts.every(Boolean)) {
        const set = factSet(
          facts.map((m) => [`${m[1] ? `${m[1]} ` : ''}${m[2]}`, cardText(m[3]).replace(/\*\*/g, '')])
        );
        if (set) items.push(set);
        bullets += run.length;
        i = j;
        continue;
      }
    }

    const body = cardText(bullet.body);
    let text;
    if (bullet.ordered) text = `${bullet.number}. ${body}`;
    else if (bullet.indent > 0) text = LEADING_EMOJI_RE.test(body) ? body : `◦ ${body}`;
    else text = LEADING_EMOJI_RE.test(body) ? body : `• ${body}`;
    if (bullet.indent > 0) {
      items.push(indentedRow(textBlock(text, { size: 'Small', spacing: 'None' }), bullet.indent));
    } else {
      items.push(textBlock(text, { spacing: 'Small' }));
    }
    bullets += 1;
    i += 1;
  }
  return { items, bullets };
}

// Kind label and container colour of a generic reply, from its leading emoji.
const REPLY_TONES = [
  [/^(?:❌|⛔|🚫|🚨)/u, { kind: 'Error', style: 'attention' }],
  [/^(?:⚠️?)/u, { kind: 'Warning', style: 'warning' }],
  [/^(?:✅|✔️?)/u, { kind: 'Done', style: 'good' }],
];

/**
 * Card for any reply of the bot (help, status, errors, acknowledgements,
 * admin notices, command output): the markdown is shown in full, nothing is
 * left out. Text with a head line and a list gets the head line as the title
 * (same layout as the command cards); everything else is a header plus the
 * paragraphs, lists and code blocks of the text. The container colour follows
 * a leading status emoji (error, warning, done).
 *
 * `part` is `[index, total]` for one card of a text that had to be split.
 * Never returns null for non-empty text.
 */
export function buildReplyCard(markdown, { part = null, fallbackText } = {}) {
  const text = String(markdown ?? '').trim();
  if (!text) return null;
  const tone = REPLY_TONES.find(([re]) => re.test(text))?.[1] || {};
  const kind = part && part[1] > 1 ? `${part[0]}/${part[1]}` : tone.kind;
  const style = tone.style || 'emphasis';

  if (!part || part[0] === 1) {
    const listCard = buildMarkdownCard(text, { service: 'bot', kind, style, fallbackText });
    if (listCard) return listCard;
  }
  const { items } = markdownBodyItems(text.split('\n'), 0);
  return assembleCard({
    service: 'bot',
    kind,
    style,
    title: items.length === 0 ? cardText(text) : '',
    extraItems: items,
    fallbackText,
  });
}

/**
 * Splits a markdown text into parts that each fit a card, in order, losing
 * nothing. `fits(partMarkdown)` tells whether one part still fits (the caller
 * measures the card on the wire). Lines are packed greedily; a part ends at a
 * blank line when one is close, a code block cut in two is closed and reopened
 * so each part stays well-formed, and a single line too long for a card is cut
 * into pieces. At most `maxParts` parts are returned: the rest is dropped with
 * a note on the last part (the one case where text is not shown in full).
 */
export function splitMarkdownForCards(markdown, fits, { maxParts = 10 } = {}) {
  const queue = String(markdown ?? '').trim().split('\n');
  const parts = [];
  let cur = [];
  let fenced = false; // a code block is open at the end of `cur`
  const render = (lines, open) => (open ? [...lines, '```'] : lines).join('\n');
  const isFence = (line) => /^\s*```/.test(line);

  while (queue.length > 0) {
    const line = queue.shift();
    const nextFenced = isFence(line) ? !fenced : fenced;
    const candidate = [...cur, line];
    if (fits(render(candidate, nextFenced))) {
      cur = candidate;
      fenced = nextFenced;
      continue;
    }
    const hasContent = cur.some((l) => l.trim() && l !== '```');
    if (!hasContent) {
      // The line alone is too long: keep the largest head that fits, queue the rest.
      let n = line.length;
      while (n > 1 && !fits(render([...cur, line.slice(0, n)], fenced))) n = Math.floor(n / 2);
      parts.push(render([...cur, line.slice(0, n)], fenced));
      cur = fenced ? ['```'] : [];
      if (line.length > n) queue.unshift(line.slice(n));
      continue;
    }
    let cut = cur.length;
    if (!fenced) {
      for (let k = cur.length - 1; k >= Math.max(1, cur.length - 8); k -= 1) {
        if (!cur[k].trim()) {
          cut = k;
          break;
        }
      }
    }
    parts.push(render(cur.slice(0, cut), fenced));
    const carry = cur.slice(cut).filter((l, idx) => idx > 0 || l.trim());
    cur = fenced ? ['```', ...carry] : carry;
    queue.unshift(line);
  }
  if (cur.some((l) => l.trim() && l !== '```')) parts.push(render(cur, fenced));

  if (parts.length > maxParts) {
    const dropped = parts.length - maxParts;
    const kept = parts.slice(0, maxParts);
    kept[maxParts - 1] += `\n\n_Output truncated: ${dropped} more part${dropped === 1 ? '' : 's'} not shown._`;
    return kept;
  }
  return parts;
}
