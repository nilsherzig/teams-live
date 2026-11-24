// The dashboard: one signed-in page with the open merge requests of the configured GitLab group, the active
// sprint, the open alerts with who is on call, and the next meetings.
//
// Who may see it: a GitLab user who signs in (OAuth, the same application as the approval flow) and is an
// active member of the configured group (and, when `oauth.allowed_users` is set, on that list too). The merge
// requests are read with the visitor's own token, so nobody sees a merge request GitLab would hide from them.
// Sprint, alerts and meetings come from the bot's own accounts.
//
// Data in, HTML out, plus two small GitLab reads (membership and one GraphQL query). Every value that reaches
// the HTML goes through `escapeHtml`, every link through `safeLink` (GitLab host) or `webLink` (http(s) only).

import { avatarImg, escapeHtml, safeLink } from './approve-page.mjs';

const GITLAB_TIMEOUT_MS = 20_000;
const MAX_MR_PAGES = 3;
const GUEST_ACCESS = 10;

/** http(s) links only (Jira, OpsGenie and Teams links come from the configuration, not from GitLab). */
export function webLink(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

async function gitlabRequest(host, token, path, { method = 'GET', body = null } = {}) {
  const response = await fetch(`https://${host}/api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(GITLAB_TIMEOUT_MS),
  });
  if (!response.ok) {
    const error = new Error(`GitLab returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/** Whether the user is an active member of the group (directly or through a parent group), asked with their token. */
export async function isGroupMember(host, token, group, userId) {
  if (!group || !userId) return false;
  try {
    const member = await gitlabRequest(host, token, `v4/groups/${encodeURIComponent(group)}/members/all/${encodeURIComponent(userId)}`);
    return member?.state === 'active' && Number(member?.access_level) >= GUEST_ACCESS;
  } catch {
    return false;
  }
}

const MRS_QUERY = `query($group: ID!, $after: String) {
  group(fullPath: $group) {
    mergeRequests(state: opened, includeSubgroups: true, first: 100, after: $after, sort: UPDATED_DESC) {
      pageInfo { hasNextPage endCursor }
      nodes {
        iid title webUrl draft updatedAt sourceBranch targetBranch diffHeadSha detailedMergeStatus
        approved approvalsRequired approvalsLeft
        project { fullPath }
        author { username name bot }
        reviewers { nodes { username } }
        approvedBy { nodes { username name } }
        headPipeline { status }
        userPermissions { canApprove }
      }
    }
  }
}`;

const lower = (value) => String(value ?? '').toLowerCase();

/** The open merge requests of the group as the user sees them, newest activity first. One query per 100. */
export async function fetchGroupMrs(host, token, group) {
  const mrs = [];
  let after = null;
  for (let page = 0; page < MAX_MR_PAGES; page++) {
    const answer = await gitlabRequest(host, token, 'graphql', { method: 'POST', body: { query: MRS_QUERY, variables: { group, after } } });
    if (Array.isArray(answer?.errors) && answer.errors.length) throw new Error('GitLab could not list the merge requests');
    const conn = answer?.data?.group?.mergeRequests;
    if (!conn) break;
    for (const n of conn.nodes || []) mrs.push(normalizeMr(n));
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return mrs;
}

export function normalizeMr(n) {
  return {
    project: n.project?.fullPath || '',
    iid: Number(n.iid),
    title: String(n.title || ''),
    url: n.webUrl || '',
    draft: n.draft === true,
    updatedAt: n.updatedAt || '',
    source: n.sourceBranch || '',
    target: n.targetBranch || '',
    sha: n.diffHeadSha || '',
    mergeStatus: lower(n.detailedMergeStatus),
    approved: n.approved === true,
    required: Number.isFinite(n.approvalsRequired) ? n.approvalsRequired : null,
    left: Number.isFinite(n.approvalsLeft) ? n.approvalsLeft : null,
    author: { username: n.author?.username || '', name: n.author?.name || n.author?.username || '', bot: n.author?.bot === true },
    reviewers: (n.reviewers?.nodes || []).map((r) => lower(r.username)).filter(Boolean),
    approvedBy: (n.approvedBy?.nodes || []).map((u) => ({ username: lower(u.username), name: u.name || u.username })).filter((u) => u.username),
    pipeline: lower(n.headPipeline?.status),
    canApprove: n.userPermissions?.canApprove === true,
  };
}

/** Bot-made merge requests (Renovate, service accounts, dependency updates): the same rules as `/mrs`. */
export function isBotMr(mr) {
  const username = lower(mr.author?.username);
  const name = lower(mr.author?.name);
  const title = lower(mr.title);
  return (
    mr.author?.bot === true ||
    ['renovate', 'bot', 'service'].some((w) => username.includes(w) || name.includes(w)) ||
    username.startsWith('sa_') ||
    ['chore(deps', 'update dependency', 'update module', 'pin dependency', 'lock file maintenance'].some((p) => title.startsWith(p))
  );
}

/** Which filters a merge request belongs to, for the signed-in user. */
export function mrFilters(mr, username) {
  const me = lower(username);
  const mine = lower(mr.author.username) === me;
  const approvedByMe = mr.approvedBy.some((u) => u.username === me);
  const f = [isBotMr(mr) ? 'bots' : 'human'];
  if (mine) f.push('mine');
  if (!mine && !mr.draft && !approvedByMe && mr.reviewers.includes(me)) f.push('review');
  return f;
}

/** "5 min", "3 h", "2 d": how long ago, short. */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// --- pictures (inline: the CSP allows no images from elsewhere) ---

const svg = (d, cls = 'di') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`;
export const ICONS = {
  overview: svg('<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>'),
  mrs: svg('<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="19" r="2.2"/><path d="M6 7.2v9.6M18 16.8V9a3 3 0 0 0-3-3h-4"/><path d="M13 3.8L10.8 6 13 8.2"/>'),
  sprint: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9.5 4v16M14.5 4v16"/>'),
  alerts: svg('<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>'),
  meetings: svg('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  cross: svg('<path d="M7 7l10 10M17 7L7 17"/>'),
  run: svg('<path d="M12 3a9 9 0 1 0 9 9"/>', 'di spin'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  thumb: svg('<path d="M7 11v9H4v-9zM7 11l4-8a2 2 0 0 1 2 2v4h5.5a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.3 20H7"/>'),
  video: svg('<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/>'),
  ext: svg('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  refresh: svg('<path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4"/>'),
  collapse: svg('<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M9 4v16M15.5 10l-2 2 2 2"/>'),
  signout: svg('<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>'),
  phone: svg('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z"/>'),
};

const PIPELINE = {
  success: ['ok', 'check', 'Pipeline passed'],
  failed: ['bad', 'cross', 'Pipeline failed'],
  running: ['run', 'run', 'Pipeline running'],
  pending: ['run', 'clock', 'Pipeline pending'],
  created: ['run', 'clock', 'Pipeline created'],
  preparing: ['run', 'clock', 'Pipeline preparing'],
  waiting_for_resource: ['run', 'clock', 'Pipeline waiting'],
  canceled: ['idle', 'cross', 'Pipeline canceled'],
  skipped: ['idle', 'clock', 'Pipeline skipped'],
  manual: ['idle', 'clock', 'Pipeline waits for a manual job'],
  scheduled: ['idle', 'clock', 'Pipeline scheduled'],
};

function pipelineDot(status) {
  const [tone, icon, label] = PIPELINE[status] || ['idle', 'clock', status ? `Pipeline ${status}` : 'No pipeline'];
  return `<span class="dot dot-${tone}" title="${escapeHtml(label)}" role="img" aria-label="${escapeHtml(label)}">${ICONS[icon]}</span>`;
}

// --- sections ---

const FILTERS = [
  ['review', 'Needs my review'],
  ['mine', 'Mine'],
  ['human', 'Human'],
  ['bots', 'Bots'],
];

/** The default filter: what waits for the user when anything does, else everything made by people. */
export function defaultFilter(mrs, username) {
  return mrs.some((mr) => mrFilters(mr, username).includes('review')) ? 'review' : 'human';
}

function mrRow(mr, { username, host, avatars, now }) {
  const me = lower(username);
  const filters = mrFilters(mr, username);
  const url = safeLink(mr.url, host);
  const projectUrl = url ? url.replace(/\/-\/merge_requests\/\d+.*$/, '') : '';
  const approvedByMe = mr.approvedBy.some((u) => u.username === me);
  const given = mr.approvedBy.length;
  const required = mr.required ?? 0;
  const approvals = required > 0 ? `${given}/${required}` : given > 0 ? `${given}` : '0';
  const approvalTitle = required > 0 ? `${given} of ${required} approvals` : `${given} approval(s)`;
  let action = '';
  if (approvedByMe) action = `<span class="pill pill-ok">${ICONS.check}Approved</span>`;
  else if (filters.includes('review') || (mr.canApprove && !filters.includes('mine') && !mr.draft)) {
    action =
      mr.canApprove && mr.sha && mr.pipeline !== 'failed'
        ? `<button class="btn btn-secondary btn-sm" type="button" data-approve data-project="${escapeHtml(mr.project)}" data-iid="${escapeHtml(mr.iid)}" data-sha="${escapeHtml(mr.sha)}" aria-label="Approve ${escapeHtml(mr.project)}!${escapeHtml(mr.iid)}">${ICONS.thumb}Approve</button>`
        : '';
  }
  const title = `${mr.draft ? '<span class="pill pill-draft">Draft</span> ' : ''}${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(mr.title)}</a>` : escapeHtml(mr.title)}`;
  const ref = projectUrl ? `<a class="muted-link" href="${escapeHtml(projectUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(mr.project)}</a>!${escapeHtml(mr.iid)}` : `${escapeHtml(mr.project)}!${escapeHtml(mr.iid)}`;
  return (
    `<li class="mrrow" data-f="${filters.join(' ')}">` +
    `${avatarImg(mr.author.name, avatars)}` +
    `<div class="mrmain"><span class="t">${title}</span><span class="m"><span>${ref}</span><span>· ${escapeHtml(mr.author.name)}</span><span>· ${escapeHtml(ago(mr.updatedAt, now))}</span></span></div>` +
    `<div class="mrside">${pipelineDot(mr.pipeline)}<span class="appr${mr.approved ? ' appr-ok' : ''}" title="${escapeHtml(approvalTitle)}">${ICONS.thumb}${approvals}</span>${action}</div>` +
    '</li>'
  );
}

export function mrsSection(state, ctx) {
  if (state.error) return `<p class="empty">${escapeHtml(state.error)}</p>`;
  const mrs = state.items || [];
  const counts = Object.fromEntries(FILTERS.map(([k]) => [k, mrs.filter((mr) => mrFilters(mr, ctx.username).includes(k)).length]));
  const chips = `<div class="chips" role="group" aria-label="Filter merge requests">${FILTERS.map(([k, label]) => `<button type="button" data-mrf-to="${k}">${label}<span class="n">${counts[k]}</span></button>`).join('')}</div>`;
  const rows = mrs.map((mr) => mrRow(mr, ctx)).join('');
  const empties = FILTERS.map(([k]) => `<li class="empty only-${k}">${k === 'review' ? 'Nothing waits for your review.' : k === 'mine' ? 'You have no open merge requests.' : 'No open merge requests.'}</li>`).join('');
  return `${chips}<ul class="mrlist">${rows}${empties}</ul>`;
}

const SPRINT_COLUMNS = [
  ['todo', 'To do'],
  ['inProgress', 'In progress'],
  ['inReview', 'In review'],
];

export function sprintSection(state, ctx) {
  if (state.error) return `<p class="empty">${escapeHtml(state.error)}</p>`;
  const sprint = state.data || {};
  const all = SPRINT_COLUMNS.flatMap(([k]) => sprint[k] || []);
  if (!all.length) return '<p class="empty">No open tickets in the active sprint.</p>';
  const me = lower(ctx.name);
  const counts = SPRINT_COLUMNS.map(([k]) => (sprint[k] || []).length);
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  const bar = `<div class="sbar" role="img" aria-label="${counts[2]} in review, ${counts[1]} in progress, ${counts[0]} to do"><i class="s-rev" style="width:${((100 * counts[2]) / total).toFixed(1)}%"></i><i class="s-prog" style="width:${((100 * counts[1]) / total).toFixed(1)}%"></i></div>`;
  const legend = `<p class="slegend"><span><i class="s-rev"></i>${counts[2]} in review</span><span><i class="s-prog"></i>${counts[1]} in progress</span><span><i class="s-todo"></i>${counts[0]} to do</span></p>`;
  const cols = SPRINT_COLUMNS.map(([k, label]) => {
    const tickets = (sprint[k] || []).map((t) => {
      const url = webLink(t.url);
      const mine = me && lower(t.assignee) === me;
      const key = url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t.key)}</a>` : escapeHtml(t.key);
      return `<li class="tk${mine ? ' mine' : ''}"><span class="key">${key}<span>${escapeHtml(t.status || '')}</span></span><span class="sum">${escapeHtml(t.summary)}</span><span class="who">${avatarImg(t.assignee || 'Unassigned', ctx.avatars)}${escapeHtml(t.assignee || 'Unassigned')}</span></li>`;
    });
    return `<div class="col"><h4>${label}<span>${tickets.length}</span></h4><ul>${tickets.join('') || '<li class="none">Nothing here</li>'}</ul></div>`;
  }).join('');
  return `${bar}${legend}<div class="board">${cols}</div>`;
}

const PRIORITY_ORDER = { P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 };

export function alertsSection(state, ctx) {
  if (state.error) return `<p class="empty">${escapeHtml(state.error)}</p>`;
  const data = state.data || {};
  const alerts = [...(data.alerts || [])].sort((a, b) => (PRIORITY_ORDER[a.priority] || 9) - (PRIORITY_ORDER[b.priority] || 9));
  const rows = alerts.slice(0, 12).map((a) => {
    const url = webLink(a.url);
    const prio = /^P[1-5]$/.test(a.priority) ? a.priority : 'P?';
    const msg = url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.message || 'Alert')}</a>` : escapeHtml(a.message || 'Alert');
    const acked = a.acknowledged ? ' · acknowledged' : '';
    return `<li class="al${a.acknowledged ? ' acked' : ''}"><span class="prio prio-${prio.toLowerCase()}">${prio}</span><div><b>${msg}</b><small>${escapeHtml(a.queue || '')}${a.count > 1 ? ` · ${escapeHtml(a.count)}×` : ''} · ${escapeHtml(ago(a.createdAt, ctx.now))}${acked}</small></div></li>`;
  });
  const more = alerts.length > 12 ? `<li class="none">${alerts.length - 12} more in OpsGenie</li>` : '';
  const list = rows.length ? `<ul class="alist">${rows.join('')}${more}</ul>` : `<p class="empty ok">${ICONS.check}No open alerts.</p>`;
  const duty = (data.duty || []).filter((d) => d && d.who).map((d) => `<li>${ICONS.phone}<span><b>${escapeHtml(d.who)}</b> <small>${escapeHtml(d.queue)}</small></span></li>`).join('');
  return `${list}${duty ? `<ul class="duty">${duty}</ul>` : ''}`;
}

export function meetingsSection(state, ctx) {
  if (state.error) return `<p class="empty">${escapeHtml(state.error)}</p>`;
  const meetings = (state.data || []).filter((m) => Date.parse(m.endTime) > ctx.now).slice(0, 8);
  if (!meetings.length) return '<p class="empty">No more meetings this week.</p>';
  const tz = ctx.timeZone;
  const dayKey = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: tz });
  const today = dayKey(ctx.now);
  const tomorrow = dayKey(ctx.now + 86_400_000);
  const time = (d) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  let lastDay = '';
  const rows = meetings.map((m) => {
    const day = dayKey(m.startTime);
    const label = day === today ? 'Today' : day === tomorrow ? 'Tomorrow' : new Date(m.startTime).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: tz });
    const head = day !== lastDay ? `<li class="day">${escapeHtml(label)}</li>` : '';
    lastDay = day;
    const now = Date.parse(m.startTime) <= ctx.now && Date.parse(m.endTime) > ctx.now;
    const join = webLink(m.joinUrl);
    const button = join ? `<a class="btn ${now ? '' : 'btn-secondary '}btn-sm" href="${escapeHtml(join)}" target="_blank" rel="noopener noreferrer">${ICONS.video}${now ? 'Join' : '<span class="sr">Join</span>'}</a>` : '';
    return `${head}<li class="mt${now ? ' now' : ''}"><time>${escapeHtml(time(m.startTime))}</time><div><b>${escapeHtml(m.subject || 'Meeting')}</b><small>${now ? 'Now · ' : ''}${escapeHtml(time(m.startTime))}–${escapeHtml(time(m.endTime))}${m.organizer ? ` · ${escapeHtml(m.organizer)}` : ''}</small></div>${button}</li>`;
  });
  return `<ul class="mlist">${rows.join('')}</ul>`;
}

/** The numbers at the top: what waits for the user, their own merge requests, their sprint tickets, open alerts. */
export function statsSection(data, ctx) {
  const mrs = data.mrs.items || [];
  const review = mrs.filter((mr) => mrFilters(mr, ctx.username).includes('review')).length;
  const mine = mrs.filter((mr) => mrFilters(mr, ctx.username).includes('mine'));
  const mineReady = mine.filter((mr) => mr.mergeStatus === 'mergeable').length;
  const me = lower(ctx.name);
  const sprint = data.sprint.data || {};
  const myTickets = [...(sprint.todo || []), ...(sprint.inProgress || [])].filter((t) => me && lower(t.assignee) === me).length;
  const alerts = data.alerts.data?.alerts || [];
  const urgent = alerts.filter((a) => a.priority === 'P1' || a.priority === 'P2').length;
  const tile = (view, icon, label, value, sub, tone = '') =>
    `<button type="button" class="stat${tone ? ` stat-${tone}` : ''}" data-view-to="${view}"><span class="k">${ICONS[icon]}${label}</span><span class="v">${value}</span><span class="s">${sub}</span></button>`;
  return [
    tile('mrs', 'mrs', 'Review requested', data.mrs.error ? '–' : review, review === 1 ? 'merge request waits for you' : 'merge requests wait for you', review ? 'accent' : ''),
    tile('mrs', 'mrs', 'Your merge requests', data.mrs.error ? '–' : mine.length, `${mineReady} ready to merge`),
    tile('sprint', 'sprint', 'Your sprint tickets', data.sprint.error ? '–' : myTickets, 'to do or in progress'),
    tile('alerts', 'alerts', 'Open alerts', data.alerts.error ? '–' : alerts.length, urgent ? `${urgent} with P1 or P2` : 'none urgent', urgent ? 'bad' : ''),
  ].join('');
}

/** All sections as HTML by name: the page and its refreshes are drawn by the same code. */
export function renderSections(data, ctx) {
  return {
    stats: statsSection(data, ctx),
    mrs: mrsSection(data.mrs, ctx),
    sprint: sprintSection(data.sprint, ctx),
    alerts: alertsSection(data.alerts, ctx),
    meetings: meetingsSection(data.meetings, ctx),
  };
}

/** Counters for the navigation, by section. */
export function navCounts(data, ctx) {
  const mrs = data.mrs.items || [];
  return {
    mrs: mrs.filter((mr) => mrFilters(mr, ctx.username).includes('review')).length,
    alerts: (data.alerts.data?.alerts || []).length,
  };
}

const NAV = [
  ['overview', 'Overview', 'Overview'],
  ['mrs', 'Merge requests', 'MRs'],
  ['sprint', 'Sprint', 'Sprint'],
  ['alerts', 'Alerts', 'Alerts'],
  ['meetings', 'Meetings', 'Meetings'],
];

const SECTIONS = [
  ['mrs', 'Merge requests'],
  ['sprint', 'Active sprint'],
  ['alerts', 'Alerts and on-call'],
  ['meetings', 'Meetings'],
];

/** The body of the dashboard page (inside the common header and footer). */
export function dashboardBody({ data, ctx, csrf, filter, updated }) {
  const s = renderSections(data, ctx);
  const counts = navCounts(data, ctx);
  const badge = (k) => (counts[k] ? `<span class="badge${k === 'alerts' ? ' badge-bad' : ''}" data-count="${k}">${counts[k]}</span>` : `<span class="badge" data-count="${k}" hidden></span>`);
  const nav = (short) => NAV.map(([k, label, brief]) => `<button type="button" data-view-to="${k}"${short && brief !== label ? ` aria-label="${label}"` : ''}${short ? '' : ` title="${label}"`}>${ICONS[k]}<span>${short ? brief : label}</span>${k === 'mrs' || k === 'alerts' ? badge(k) : ''}</button>`).join('');
  const box = ([k, title]) => `<section class="box box-${k}" data-sec="${k}" aria-labelledby="h-${k}"><header><h2 id="h-${k}">${ICONS[k]}${title}</h2></header><div class="box-body" data-sec-body="${k}">${s[k]}</div></section>`;
  const main = SECTIONS.slice(0, 2).map(box).join('');
  const side = SECTIONS.slice(2).map(box).join('');
  return (
    `<div class="dash" id="dash" data-view="overview" data-mrf="${escapeHtml(filter)}">` +
    `<nav class="side" aria-label="Dashboard">${nav(false)}<button type="button" class="updated" data-refresh title="Updated ${escapeHtml(updated)}, refreshes every minute. Click to refresh now.">${ICONS.refresh}<span id="dash-updated">${escapeHtml(updated)}</span></button><button type="button" class="collapse" data-collapse aria-expanded="true" title="Collapse sidebar">${ICONS.collapse}<span>Collapse</span></button></nav>` +
    `<div class="dmain"><h1 class="sr">Dashboard</h1>` +
    `<div class="stats" data-sec-body="stats">${s.stats}</div>` +
    `<div class="grid"><div class="col-main">${main}</div><div class="col-side">${side}</div></div></div>` +
    `<nav class="tabbar" aria-label="Dashboard sections">${nav(true)}</nav>` +
    `<input type="hidden" id="dash-csrf" value="${escapeHtml(csrf)}"><div class="toasts" id="toasts" role="status" aria-live="polite"></div></div>`
  );
}


export const DASHBOARD_CSS = [
  '.shell.dashboard{max-width:none;padding:0}body:has(.dash) .brand{margin-bottom:0}',
  '.dash{display:grid;grid-template-columns:13.5rem minmax(0,1fr);gap:0;min-height:70vh;transition:grid-template-columns .3s var(--ease)}',
  '.side span{white-space:nowrap;overflow:hidden;transition:opacity .2s}.side button{position:relative;min-height:36px}.collapse{color:var(--muted);font-size:.85rem}.collapse .di{transition:transform .3s var(--ease)}',
  '.dash.collapsed{grid-template-columns:3.75rem minmax(0,1fr)}.dash.collapsed .side span{opacity:0;width:0}.dash.collapsed .side button{justify-content:center;gap:0;padding-inline:0}.dash.collapsed .collapse .di{transform:rotate(180deg)}',
  '.dash.collapsed .side .badge{position:absolute;top:1px;right:2px;margin:0;font-size:.6rem;padding:0 .3rem;opacity:1;width:auto}',
  '.dash .di{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}.dash .di.spin{animation:tl-spin 1.6s linear infinite}',
  '.side{position:sticky;top:49px;align-self:start;height:calc(100vh - 49px);overflow-y:auto;display:flex;flex-direction:column;gap:.15rem;padding:.75rem .6rem 1rem max(.6rem,env(safe-area-inset-left,0px));background:var(--subtle);border-right:1px solid var(--line)}.side .updated{margin-top:auto!important}',
  '.side button,.tabbar button{display:flex;align-items:center;gap:.6rem;border:0;background:none;font:inherit;color:var(--text);padding:.45rem .6rem;border-radius:6px;cursor:pointer;text-align:left;transition:background .15s}',
  '.side button:hover{background:var(--subtle)}.side button[aria-current=true]{background:var(--panel);box-shadow:inset 0 0 0 1px var(--line);font-weight:600}',
  '.badge{margin-left:auto;background:var(--run-bg);color:var(--run);border-radius:999px;font-size:.72rem;padding:0 .45rem;font-weight:700;font-variant-numeric:tabular-nums}.badge-bad{background:var(--closed-bg);color:var(--closed)}.badge[hidden]{display:none}',
  '.updated{margin-top:1rem;border-top:1px solid var(--line)!important;border-radius:0!important;padding-top:.6rem!important;color:var(--muted);font-size:.8rem;font-variant-numeric:tabular-nums}.updated.busy .di{animation:tl-spin .8s linear infinite}.updated+.collapse{margin-top:0;border-top:0!important;padding-top:.45rem!important}',
  '.collapse{margin-top:1rem;border-top:1px solid var(--line)!important;border-radius:0 0 6px 6px!important;padding-top:.6rem!important}',
  '.dmain{padding:1.25rem max(1.5rem,env(safe-area-inset-right,0px)) 2rem 1.5rem;display:grid;gap:1.1rem;align-content:start;min-width:0}',
    '.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.75rem}',
  '.stat{font:inherit;color:inherit;text-align:left;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:.8rem .95rem;display:grid;gap:.1rem;cursor:pointer;transition:transform .15s,box-shadow .15s,border-color .15s;animation:tl-rise .4s var(--ease) both}',
  '.stat:nth-child(2){animation-delay:.05s}.stat:nth-child(3){animation-delay:.1s}.stat:nth-child(4){animation-delay:.15s}',
  '.stat:hover{transform:translateY(-2px);box-shadow:var(--shadow);border-color:var(--line-strong)}.stat .k{font-size:.78rem;color:var(--muted);display:flex;gap:.4rem;align-items:center}',
  '.stat .v{font-size:1.7rem;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums}.stat .s{font-size:.78rem;color:var(--muted)}.stat-accent .v{color:var(--run)}.stat-bad .v{color:var(--closed)}',
  '.grid{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:1.1rem;align-items:start}.col-main,.col-side{display:grid;gap:1.1rem;min-width:0}',
  '.box{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden;animation:tl-rise .45s var(--ease) both}.col-side .box{animation-delay:.1s}',
  '.box>header{display:flex;flex-wrap:wrap;gap:.25rem .75rem;align-items:baseline;padding:.7rem 1rem;border-bottom:1px solid var(--line)}.box>header h2{margin:0;font-size:.98rem;display:flex;gap:.45rem;align-items:center;flex:1}.box>header small{color:var(--muted);font-size:.75rem}',
  '.box-body.tl-changed{animation:tl-flash 1.2s var(--ease)}',
  '.empty{color:var(--muted);padding:1.25rem 1rem;margin:0;text-align:center}.empty.ok{display:flex;gap:.5rem;align-items:center;justify-content:center;color:var(--ok)}',
  '.chips{display:flex;gap:.3rem;flex-wrap:wrap;padding:.6rem 1rem;border-bottom:1px solid var(--line);background:var(--subtle)}',
  '.chips button{font:inherit;font-size:.8rem;border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:999px;padding:.15rem .65rem;cursor:pointer;display:inline-flex;gap:.35rem;align-items:center;transition:background .15s,color .15s,border-color .15s}',
  '.chips .n{font-variant-numeric:tabular-nums;color:var(--muted);font-weight:600}.chips button[aria-pressed=true]{background:var(--text);color:var(--panel);border-color:var(--text)}.chips button[aria-pressed=true] .n{color:inherit;opacity:.75}',
  '.mrlist,.alist,.mlist,.duty,.board ul{list-style:none;margin:0;padding:0}',
  '.mrrow{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:.7rem;align-items:center;padding:.65rem 1rem;border-top:1px solid var(--line);transition:background .15s;animation:tl-rise .3s var(--ease) both}.mrrow:first-child{border-top:0}.mrrow:hover{background:var(--subtle)}',
  '.mrrow .av{margin:0;width:28px;height:28px}.mrmain{min-width:0}.mrmain .t{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mrmain .t a{color:var(--text)}.mrmain .m{font-size:.8rem;color:var(--muted);display:flex;flex-wrap:wrap;gap:.1rem .4rem}',
  '.muted-link{color:var(--muted)}.mrside{display:flex;gap:.6rem;align-items:center}',
  '.dot{width:20px;height:20px;border-radius:50%;display:grid;place-items:center}.dot .di{width:12px;height:12px;stroke-width:2.6}.dot-ok{background:var(--ok-bg);color:var(--ok)}.dot-bad{background:var(--closed-bg);color:var(--closed)}.dot-run{background:var(--run-bg);color:var(--run)}.dot-idle{background:var(--draft-bg);color:var(--draft)}',
  '.appr{display:inline-flex;gap:.25rem;align-items:center;font-size:.8rem;color:var(--muted);font-variant-numeric:tabular-nums}.appr .di{width:14px;height:14px}.appr-ok{color:var(--ok)}',
  '.btn-sm{padding:.2rem .6rem;font-size:.82rem;width:auto}.btn-sm .di{width:14px;height:14px}.btn-sm[data-busy]::before{content:"";width:12px;height:12px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:tl-spin .7s linear infinite}.btn-sm[data-busy] .di{display:none}',
  '.mrlist .empty{display:none}',
  '.dash[data-mrf=review] .mrrow:not([data-f~=review]),.dash[data-mrf=mine] .mrrow:not([data-f~=mine]),.dash[data-mrf=human] .mrrow:not([data-f~=human]),.dash[data-mrf=bots] .mrrow:not([data-f~=bots]){display:none}',
  '.dash[data-mrf=review] .mrlist:not(:has([data-f~=review])) .only-review,.dash[data-mrf=mine] .mrlist:not(:has([data-f~=mine])) .only-mine,.dash[data-mrf=human] .mrlist:not(:has([data-f~=human])) .only-human,.dash[data-mrf=bots] .mrlist:not(:has([data-f~=bots])) .only-bots{display:block}',
  '.sbar{display:flex;height:6px;margin:.85rem 1rem 0;border-radius:3px;background:var(--line);overflow:hidden}.sbar i{display:block;height:100%;transition:width .6s var(--ease)}.s-rev{background:var(--ok)}.s-prog{background:var(--run)}.s-todo{background:var(--line-strong)}',
  '.slegend{display:flex;flex-wrap:wrap;gap:.2rem 1rem;margin:.4rem 1rem 0;font-size:.78rem;color:var(--muted)}.slegend span{display:inline-flex;gap:.35rem;align-items:center}.slegend i{width:8px;height:8px;border-radius:2px;display:inline-block}',
  '.board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.6rem;padding:.75rem 1rem 1rem}.col{background:var(--subtle);border-radius:8px;padding:.5rem;min-width:0}',
  '.col h4{margin:0 0 .45rem;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);display:flex;justify-content:space-between;padding:.1rem .2rem}.col ul{display:grid;gap:.4rem}',
  '.tk{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:.5rem .55rem;font-size:.82rem;display:grid;gap:.25rem;transition:transform .15s,box-shadow .15s}.tk:hover{transform:translateY(-1px);box-shadow:var(--shadow)}.tk.mine{box-shadow:inset 3px 0 0 var(--run)}',
  '.tk .key{font:.72rem var(--mono);color:var(--muted);display:flex;justify-content:space-between;gap:.4rem}.tk .key a{white-space:nowrap;flex:none}.tk .key span{font-family:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.tk .sum{overflow-wrap:anywhere}.tk .who{display:flex;align-items:center;gap:.1rem;color:var(--muted);font-size:.75rem}.tk .who .av{width:16px;height:16px}',
  '.none{color:var(--muted);font-size:.8rem;padding:.3rem .2rem}',
  '.al{display:grid;grid-template-columns:auto minmax(0,1fr);gap:.6rem;align-items:center;padding:.6rem 1rem;border-top:1px solid var(--line)}.al:first-child{border-top:0}.al b{display:block;font-size:.86rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.al b a{color:var(--text)}.al small{color:var(--muted)}.al.acked{opacity:.6}',
  '.prio{font:700 .72rem var(--mono);border-radius:4px;padding:.05rem .35rem;background:var(--draft-bg);color:var(--draft)}.prio-p1,.prio-p2{background:var(--closed-bg);color:var(--closed)}.prio-p3{background:var(--warn-bg);color:var(--warn)}',
  '.duty{border-top:1px solid var(--line);background:var(--subtle);padding:.4rem 0}.duty li{display:flex;gap:.55rem;align-items:center;padding:.3rem 1rem;font-size:.86rem}.duty small{color:var(--muted)}',
  '.mlist .day{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:.6rem 1rem .2rem}',
  '.mt{display:grid;grid-template-columns:3.2rem minmax(0,1fr) auto;gap:.6rem;align-items:center;padding:.5rem 1rem}.mt time{font:.8rem var(--mono);color:var(--muted);font-variant-numeric:tabular-nums}.mt b{display:block;font-size:.86rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mt small{color:var(--muted)}',
  '.mt.now{background:var(--run-bg)}.mt.now time{color:var(--run);font-weight:700}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}',
  '.tabbar{display:none}',
  '.toasts{position:fixed;z-index:30;right:max(1rem,env(safe-area-inset-right,0px));bottom:calc(1rem + env(safe-area-inset-bottom,0px));display:grid;gap:.5rem;justify-items:end;pointer-events:none}',
  '.toast{pointer-events:auto;background:var(--bar);color:var(--bar-text);padding:.6rem .85rem;border-radius:8px;box-shadow:var(--shadow-lg);font-weight:500;max-width:min(360px,calc(100vw - 2rem));animation:tl-toast .4s var(--spring)}.toast.out{opacity:0;transform:translateX(24px);transition:opacity .3s,transform .3s}',
  '@keyframes tl-toast{from{opacity:0;transform:translateY(12px) scale(.96)}to{opacity:1;transform:none}}',
  // one section at a time when a section is picked; everything on the overview
  '.dash:not([data-view=overview]) .stats{display:none}.dash[data-view=mrs] .box:not([data-sec=mrs]),.dash[data-view=sprint] .box:not([data-sec=sprint]),.dash[data-view=alerts] .box:not([data-sec=alerts]),.dash[data-view=meetings] .box:not([data-sec=meetings]){display:none}',
  '.dash:not([data-view=overview]) .grid{grid-template-columns:1fr}.dash[data-view=mrs] .col-side,.dash[data-view=sprint] .col-side,.dash[data-view=alerts] .col-main,.dash[data-view=meetings] .col-main{display:none}',
  '@media (min-width:110rem){.dash[data-view=overview] .grid{grid-template-columns:minmax(0,1.25fr) minmax(0,1.2fr) minmax(0,.9fr)}.dash[data-view=overview] .col-main{display:contents}}',
  '@media (max-width:68rem){.grid{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}}',
  '@media (max-width:48rem){.dash,.dash.collapsed{grid-template-columns:1fr}.side{display:none}.dmain{padding:1rem max(1rem,env(safe-area-inset-right,0px)) 5.5rem max(1rem,env(safe-area-inset-left,0px))}',
  '.board{grid-template-columns:repeat(3,minmax(11rem,1fr));overflow-x:auto;scroll-snap-type:x mandatory}.col{scroll-snap-align:start}.mrside .appr{display:none}',
  '.tabbar{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:20;background:var(--panel);border-top:1px solid var(--line);padding:.3rem max(.25rem,env(safe-area-inset-right,0px)) calc(.3rem + env(safe-area-inset-bottom,0px)) max(.25rem,env(safe-area-inset-left,0px))}',
  '.tabbar button{flex:1;flex-direction:column;gap:.1rem;font-size:.68rem;color:var(--muted);padding:.3rem 0;position:relative;text-align:center;justify-content:center}.tabbar button[aria-current=true]{color:var(--accent)}.tabbar .di{width:20px;height:20px}',
  '.tabbar .badge{position:absolute;top:0;left:calc(50% + 4px);margin:0;font-size:.6rem;padding:0 .3rem}.toasts{bottom:calc(4.75rem + env(safe-area-inset-bottom,0px))}}',
  '@media (max-width:30rem){.stats{gap:.5rem}.stat{padding:.65rem .75rem}.stat .v{font-size:1.4rem}}',
].join('');

/**
 * The page script: switches sections and merge request filters, refreshes the sections every minute while the
 * page is visible, and sends an inline approval as ONE background POST (never repeated; a lost answer is reported
 * as such). It only puts the server's escaped HTML into the page.
 */
export function dashboardScript(dashPath) {
  const B = JSON.stringify(dashPath);
  return `(function(){var B=${B},d=document.getElementById('dash');if(!d)return;var csrf=document.getElementById('dash-csrf'),busy=0;
function mark(){var v=d.getAttribute('data-view'),f=d.getAttribute('data-mrf');document.querySelectorAll('[data-view-to]').forEach(function(b){if(b.closest('.side,.tabbar'))b.setAttribute('aria-current',String(b.getAttribute('data-view-to')===v))});document.querySelectorAll('[data-mrf-to]').forEach(function(b){b.setAttribute('aria-pressed',String(b.getAttribute('data-mrf-to')===f))})}
function toast(t){var r=document.getElementById('toasts');if(!r||!t)return;var e=document.createElement('div');e.className='toast';e.textContent=t;r.appendChild(e);setTimeout(function(){e.classList.add('out');setTimeout(function(){e.remove()},320)},3600)}
function view(v){d.setAttribute('data-view',v);mark();try{sessionStorage.setItem('tl-view',v)}catch(e){}window.scrollTo({top:0,behavior:'smooth'})}
function collapse(on){d.classList.toggle('collapsed',on);var c=document.querySelector('[data-collapse]');if(c){c.setAttribute('aria-expanded',String(!on));c.title=on?'Expand sidebar':'Collapse sidebar'}try{localStorage.setItem('tl-side',on?'1':'0')}catch(e){}}
try{if(localStorage.getItem('tl-side')==='1'){d.style.transition='none';collapse(true);requestAnimationFrame(function(){requestAnimationFrame(function(){d.style.transition=''})})}}catch(e){}
try{var sv=sessionStorage.getItem('tl-view'),sf=sessionStorage.getItem('tl-mrf');if(sv)d.setAttribute('data-view',sv);if(sf)d.setAttribute('data-mrf',sf)}catch(e){}if(location.hash==='#overview'){d.setAttribute('data-view','overview');try{history.replaceState(null,'',location.pathname)}catch(e){}}mark();
document.addEventListener('click',function(e){document.querySelectorAll('[data-account-menu][open]').forEach(function(m){if(!m.contains(e.target))m.removeAttribute('open')})});document.addEventListener('keydown',function(e){if(e.key==='Escape')document.querySelectorAll('[data-account-menu][open]').forEach(function(m){m.removeAttribute('open')})});
document.addEventListener('click',function(e){var h=e.target.closest('[data-home]');if(h){e.preventDefault();view('overview');return}var rf=e.target.closest('[data-refresh]');if(rf){refresh();return}var t=e.target.closest('[data-collapse]');if(t){collapse(!d.classList.contains('collapsed'));return}var v=e.target.closest('[data-view-to]');if(v){view(v.getAttribute('data-view-to'));return}var f=e.target.closest('[data-mrf-to]');if(f){d.setAttribute('data-mrf',f.getAttribute('data-mrf-to'));mark();try{sessionStorage.setItem('tl-mrf',f.getAttribute('data-mrf-to'))}catch(e){}return}var a=e.target.closest('[data-approve]');if(a)approve(a)});
function pill(cls,text,title){var s=document.createElement('span');s.className='pill '+cls;s.textContent=text;if(title)s.title=title;return s}
function approve(b){if(b.disabled)return;b.disabled=true;b.setAttribute('data-busy','');busy++;var body=new URLSearchParams();body.set('csrf',csrf.value);body.set('project',b.getAttribute('data-project'));body.set('iid',b.getAttribute('data-iid'));body.set('sha',b.getAttribute('data-sha'));
fetch(B+'/approve',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:body.toString()}).then(function(r){return r.json().catch(function(){return {status:'unknown',text:'The answer could not be read. Check the merge request in GitLab.'}})}).then(function(r){var ok=r.status==='approved'||r.status==='already';b.replaceWith(ok?pill('pill-ok','Approved',r.text):r.status==='unknown'?pill('pill-idle','Check GitLab',r.text):pill('pill-bad','Not approved',r.text));toast(r.text)}).catch(function(){b.replaceWith(pill('pill-idle','Check GitLab'));toast('The connection was lost. Nothing is repeated automatically: check the merge request in GitLab.')}).then(function(){busy--;setTimeout(refresh,1500)})}
function refresh(){if(document.hidden||busy)return;var rb=document.querySelector('[data-refresh]');if(rb)rb.classList.add('busy');fetch(B+'/data',{credentials:'same-origin',cache:'no-store'}).then(function(r){if(r.status===401){var u=document.getElementById('dash-updated');if(u)u.textContent='Signed out';if(rb)rb.title='Signed out. Reload the page to sign in again.';return null}return r.ok?r.json():null}).then(function(x){if(!x||busy)return;var s=x.sections||{};for(var k in s){var e=document.querySelector('[data-sec-body="'+k+'"]');if(e&&e.innerHTML!==s[k]){e.innerHTML=s[k];if(k!=='stats'){e.classList.remove('tl-changed');void e.offsetWidth;e.classList.add('tl-changed')}}}var c=x.counts||{};for(var n in c){document.querySelectorAll('[data-count="'+n+'"]').forEach(function(el){el.textContent=c[n];el.hidden=!c[n]})}if(x.csrf){csrf.value=x.csrf;document.querySelectorAll('[data-csrf]').forEach(function(i){i.value=x.csrf})}var u=document.getElementById('dash-updated');if(u&&x.updated){u.textContent=x.updated;if(rb)rb.title='Updated '+x.updated+', refreshes every minute. Click to refresh now.'}mark()}).catch(function(){}).then(function(){if(rb)rb.classList.remove('busy')})}
setInterval(refresh,60000);document.addEventListener('visibilitychange',function(){if(!document.hidden)refresh()})})();`;
}
