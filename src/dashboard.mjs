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
import { approvalBadge } from './approval-badges.mjs';
import { ciStatusIcon, ciStatusInfo } from './cards.mjs';

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
  if (mr.draft) f.push('draft');
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
  ticket: svg('<path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  hide: svg('<path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 8.5 4.4 9.5 6-.5.8-1.4 2-2.7 3.2M6.6 6.6C4.6 7.9 3.2 9.8 2.5 12c1 1.6 4.5 6 9.5 6 1.6 0 3-.4 4.3-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  grip: svg('<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>'),
  refresh: svg('<path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4"/>'),
  collapse: svg('<path d="M11 7l-5 5 5 5M18 7l-5 5 5 5"/>'),
  signout: svg('<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>'),
  phone: svg('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z"/>'),
};


/** An embedded picture descriptor (`{url}`) as an <img>, or ''. Only data: images (the CSP allows nothing else). */
function img(desc, label, height, cls) {
  const url = desc?.url;
  if (typeof url !== 'string' || !/^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(url)) return '';
  const width = desc.width && desc.height ? Math.round((desc.width * height) / desc.height) : height;
  return `<img class="${cls}" src="${escapeHtml(url)}" width="${width}" height="${height}" alt="${escapeHtml(label)}" title="${escapeHtml(label)}">`;
}

/** The pipeline as GitLab's own status icon (the one on the Teams card), with its state as the tooltip. */
function pipelineIcon(status) {
  if (!status) return '<span class="ci-none" title="No pipeline"></span>';
  return img(ciStatusIcon(status), `Pipeline: ${ciStatusInfo(status).label}`, 16, 'ci-ic') || `<span class="ci-none" title="Pipeline: ${escapeHtml(status)}"></span>`;
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
  // The approval badge of the Teams card ("Approved", "1 of 2 Approvals", "Not approved yet"); who approved in its tooltip.
  const names = mr.approvedBy.map((u) => (u.username === me ? 'you' : u.name));
  const state = mr.approved || (required > 0 && given >= required) ? true : false;
  const badgeLabel = `${state ? 'Approved' : required > 0 ? `${given} of ${required} approvals` : 'Not approved yet'}${names.length ? ` (by ${names.join(', ')})` : ''}`;
  const badge = img(approvalBadge({ approved: state, approvalsGiven: given, approvalsRequired: required }), badgeLabel, 18, 'appr-badge');
  let action = '';
  if (!approvedByMe && (filters.includes('review') || (mr.canApprove && !filters.includes('mine') && !mr.draft))) {
    action =
      mr.canApprove && mr.sha && mr.pipeline !== 'failed'
        ? `<button class="btn btn-secondary btn-sm" type="button" data-approve data-project="${escapeHtml(mr.project)}" data-iid="${escapeHtml(mr.iid)}" data-sha="${escapeHtml(mr.sha)}" aria-label="Approve ${escapeHtml(mr.project)}!${escapeHtml(mr.iid)}">${ICONS.thumb}Approve</button>`
        : '';
  }
  const title = `${mr.draft ? '<span class="pill pill-draft">Draft</span> ' : ''}${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(mr.title)}</a>` : escapeHtml(mr.title)}`;
  const ref = projectUrl ? `<a class="muted-link" href="${escapeHtml(projectUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(mr.project)}</a>!${escapeHtml(mr.iid)}` : `${escapeHtml(mr.project)}!${escapeHtml(mr.iid)}`;
  return (
    `<li class="mrrow" data-f="${filters.join(' ')}" data-key="${escapeHtml(`${mr.project}!${mr.iid}`)}">` +
    `${avatarImg(mr.author.name, avatars)}` +
    `<div class="mrmain"><span class="t">${title}</span><span class="m">${(mr.issues || []).map((k) => `<button type="button" class="tchip" data-issue="${escapeHtml(k)}" title="Preview ${escapeHtml(k)}">${ICONS.ticket}${escapeHtml(k)}</button>`).join('')}<span>${ref}</span><span>· ${escapeHtml(mr.author.name)}</span><span>· ${escapeHtml(ago(mr.updatedAt, now))}</span></span></div>` +
    `<div class="mrside">${pipelineIcon(mr.pipeline)}${badge}${action}</div>` +
    '</li>'
  );
}

export function mrsSection(state, ctx) {
  if (state.error) return `<p class="empty">${escapeHtml(state.error)}</p>`;
  const mrs = state.items || [];
  const counts = Object.fromEntries(FILTERS.map(([k]) => [k, mrs.filter((mr) => mrFilters(mr, ctx.username).includes(k)).length]));
  const drafts = mrs.filter((mr) => mr.draft).length;
  const chips = `<div class="chips" role="group" aria-label="Filter merge requests">${FILTERS.map(([k, label]) => `<button type="button" data-mrf-to="${k}">${label}<span class="n">${counts[k]}</span></button>`).join('')}<span class="chips-sep"></span><button type="button" class="toggle" data-nodraft-toggle aria-pressed="false" title="Hide draft merge requests">Hide drafts<span class="n">${drafts}</span></button></div>`;
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
      const key = escapeHtml(t.key);
      return `<li class="tk${mine ? ' mine' : ''}" data-key="${escapeHtml(t.key)}" data-issue="${escapeHtml(t.key)}" draggable="true" role="button" tabindex="0" aria-label="${escapeHtml(`${t.key}: ${t.summary}`)}"><span class="key">${key}<span>${escapeHtml(t.status || '')}</span></span><span class="sum">${escapeHtml(t.summary)}</span><span class="who">${avatarImg(t.assignee || 'Unassigned', ctx.avatars)}${escapeHtml(t.assignee || 'Unassigned')}</span></li>`;
    });
    return `<div class="col" data-col="${k}"><h4>${label}<span data-col-count>${tickets.length}</span></h4><ul>${tickets.join('') || '<li class="none">Nothing here</li>'}</ul></div>`;
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
    const msg = escapeHtml(a.message || 'Alert');
    const acked = a.acknowledged ? ' · acknowledged' : '';
    const open = /^[A-Za-z0-9-]{1,80}$/.test(String(a.id || '')) ? ` data-alert="${escapeHtml(a.id)}" role="button" tabindex="0" aria-label="${escapeHtml(`${prio} alert: ${a.message || ''}`)}"` : '';
    return `<li class="al${a.acknowledged ? ' acked' : ''}" data-key="${escapeHtml(a.tinyId || a.id || a.message || '')}"${open}><span class="prio prio-${prio.toLowerCase()}">${prio}</span><div><b>${msg}</b><small>${escapeHtml(a.queue || '')}${a.count > 1 ? ` · ${escapeHtml(a.count)}×` : ''} · ${escapeHtml(ago(a.createdAt, ctx.now))}${acked}</small></div></li>`;
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
    return `${head}<li class="mt${now ? ' now' : ''}" data-key="${escapeHtml(`${m.subject}@${m.startTime}`)}"><time>${escapeHtml(time(m.startTime))}</time><div><b>${escapeHtml(m.subject || 'Meeting')}</b><small>${now ? 'Now · ' : ''}${escapeHtml(time(m.startTime))}–${escapeHtml(time(m.endTime))}${m.organizer ? ` · ${escapeHtml(m.organizer)}` : ''}</small></div>${button}</li>`;
  });
  return `<ul class="mlist">${rows.join('')}</ul>`;
}

const clip = (text, max) => {
  const t = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
};
const when = (iso, ctx) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return `${new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: ctx.timeZone })} (${ago(iso, ctx.now)})`;
};
const facts = (rows) => `<dl class="dfacts">${rows.filter(([, v]) => v).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

/** A Jira ticket for the preview drawer: `{title, html}`, everything escaped, the link to Jira at the end. */
export function issueDetail(i, ctx) {
  const url = webLink(i.url);
  const html =
    facts([
      ['Status', `<span class="pill pill-${i.statusCategory === 'done' ? 'ok' : i.statusCategory === 'indeterminate' ? 'run' : 'idle'}">${escapeHtml(i.status)}</span>`],
      ['Type', escapeHtml(i.issueType)],
      ['Priority', escapeHtml(i.priority)],
      ['Assignee', `${avatarImg(i.assignee || 'Unassigned', ctx.avatars)}${escapeHtml(i.assignee || 'Unassigned')}`],
      ['Reporter', i.reporter ? `${avatarImg(i.reporter, ctx.avatars)}${escapeHtml(i.reporter)}` : ''],
      ['Labels', (i.labels || []).map((l) => `<span class="lbl">${escapeHtml(l)}</span>`).join(' ')],
      ['Created', escapeHtml(when(i.created, ctx))],
      ['Updated', escapeHtml(when(i.updated, ctx))],
    ]) +
    (i.description ? `<div class="dtext">${escapeHtml(clip(i.description, 4000))}</div>` : '<p class="note">No description.</p>') +
    (url ? `<p class="links"><a class="btn btn-secondary" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open in Jira ${ICONS.ext}</a></p>` : '');
  return { title: `${i.key} · ${i.summary}`, html };
}

/** An OpsGenie alert for the drawer: `{title, html}`. */
export function alertDetail(a, ctx) {
  const url = webLink(a.url);
  const prio = /^P[1-5]$/.test(a.priority) ? a.priority : 'P?';
  const details = a.details && typeof a.details === 'object' ? Object.entries(a.details).slice(0, 24) : [];
  const html =
    facts([
      ['Priority', `<span class="prio prio-${prio.toLowerCase()}">${prio}</span>`],
      ['Status', escapeHtml(`${a.status || 'open'}${a.acknowledged ? ', acknowledged' : ''}${a.snoozed ? ', snoozed' : ''}`)],
      ['Owner', escapeHtml(a.owner || '')],
      ['Count', a.count > 1 ? escapeHtml(`${a.count}×`) : ''],
      ['Source', escapeHtml(a.source || '')],
      ['Entity', escapeHtml(a.entity || '')],
      ['Created', escapeHtml(when(a.createdAt, ctx))],
      ['Last seen', escapeHtml(when(a.lastOccurredAt || a.updatedAt, ctx))],
      ['Tags', (a.tags || []).slice(0, 30).map((t) => `<span class="lbl">${escapeHtml(t)}</span>`).join(' ')],
    ]) +
    (a.description ? `<div class="dtext">${escapeHtml(clip(a.description, 4000))}</div>` : '') +
    (details.length ? `<h3 class="dsub">Details</h3>${facts(details.map(([k, v]) => [k, escapeHtml(clip(typeof v === 'string' ? v : JSON.stringify(v), 400))]))}` : '') +
    (url ? `<p class="links"><a class="btn btn-secondary" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open in OpsGenie ${ICONS.ext}</a></p>` : '');
  return { title: a.message || 'Alert', html };
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

// The cards in their default order, with their default width in columns of a 12-column grid. Each visitor can
// move and resize them; the layout is kept in their browser (localStorage), never on the server.
const SECTIONS = [
  ['mrs', 'Merge requests', 8],
  ['alerts', 'Alerts and on-call', 4],
  ['sprint', 'Active sprint', 8],
  ['meetings', 'Meetings', 4],
];

/** The body of the dashboard page (inside the common header and footer). */
export function dashboardBody({ data, ctx, csrf, filter, updated }) {
  const s = renderSections(data, ctx);
  const counts = navCounts(data, ctx);
  const badge = (k) => (counts[k] ? `<span class="badge${k === 'alerts' ? ' badge-bad' : ''}" data-count="${k}">${counts[k]}</span>` : `<span class="badge" data-count="${k}" hidden></span>`);
  const nav = (short) => NAV.map(([k, label, brief]) => `<button type="button" data-view-to="${k}"${short && brief !== label ? ` aria-label="${label}"` : ''}${short ? '' : ` title="${label}"`}>${ICONS[k]}<span>${short ? brief : label}</span>${k === 'mrs' || k === 'alerts' ? badge(k) : ''}</button>`).join('');
  const box = ([k, title, span]) =>
    `<section class="box box-${k}" data-sec="${k}" data-span="${span}" style="--span:${span}" aria-labelledby="h-${k}">` +
    `<header><h2 id="h-${k}">${ICONS[k]}${title}</h2><span class="tools"><button type="button" class="tool" data-hide title="Hide this card" aria-label="Hide ${title}">${ICONS.hide}</button><button type="button" class="tool grip" data-grip title="Move with the arrow keys" aria-label="Move ${title}: arrow keys">${ICONS.grip}</button></span></header>` +
    `<div class="box-body" data-sec-body="${k}">${s[k]}</div><span class="rs" data-resize title="Drag to resize, double-click to reset" aria-hidden="true"></span></section>`;
  const cards = SECTIONS.map(box).join('');
  return (
    `<div class="dash" id="dash" data-view="overview" data-mrf="${escapeHtml(filter)}">` +
    `<nav class="side" aria-label="Dashboard">${nav(false)}<div class="side-foot"><button type="button" class="sync" data-refresh title="Updated ${escapeHtml(updated)}, refreshes every minute. Click to refresh now.">${ICONS.refresh}<span id="dash-updated">${escapeHtml(updated)}</span></button><button type="button" class="side-toggle" data-collapse aria-expanded="true" title="Collapse sidebar" aria-label="Collapse sidebar">${ICONS.collapse}</button></div></nav>` +
    `<div class="dmain"><h1 class="sr">Dashboard</h1>` +
    `<div class="stats" data-sec-body="stats">${s.stats}</div>` +
    `<div class="editbar" data-editbar><span class="hint">${ICONS.edit}Drag a card by its header to move it, drag its corner to resize it.</span><span class="hidden-bar" data-hidden-bar hidden></span><span class="sp"></span><button type="button" class="btn btn-secondary btn-sm" data-layout-reset disabled>Reset layout</button><button type="button" class="btn btn-sm" data-edit-done>Done</button></div>` +
    `<div class="grid" data-grid>${cards}</div></div>` +
    `<nav class="tabbar" aria-label="Dashboard sections">${nav(true)}</nav>` +
    `<div class="drawer" data-drawer hidden><div class="drawer-bg" data-drawer-close></div><aside class="drawer-panel" role="dialog" aria-modal="true" aria-labelledby="drawer-title"><header><h2 id="drawer-title"></h2><button type="button" class="tool" data-drawer-close aria-label="Close">${ICONS.close}</button></header><div class="drawer-body" data-drawer-body></div></aside></div>` +
    `<input type="hidden" id="dash-csrf" value="${escapeHtml(csrf)}"><div class="toasts" id="toasts" role="status" aria-live="polite"></div></div>`
  );
}


/** The page action in the top bar, next to the account: switches the layout edit mode. */
export const CUSTOMIZE_BUTTON = `<button type="button" class="hdr-btn" data-edit-toggle aria-pressed="false" title="Customize the dashboard: move, resize and hide cards" aria-label="Customize the dashboard">${ICONS.edit}</button>`;

export const DASHBOARD_CSS = [
  '.hdr-btn{margin-left:auto;display:grid;place-items:center;width:32px;height:32px;border:0;border-radius:6px;background:none;color:var(--bar-text);opacity:.8;cursor:pointer;transition:background .15s,opacity .15s}.hdr-btn:hover{background:rgba(255,255,255,.1);opacity:1}.hdr-btn[aria-pressed=true]{background:var(--btn);opacity:1}.hdr-btn .di{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}.hdr-btn+.header-account{margin-left:.5rem}',
  '.shell.dashboard{max-width:none;padding:0}body:has(.dash) .brand{margin-bottom:0}',
  '.dash{display:grid;grid-template-columns:13.5rem minmax(0,1fr);gap:0;min-height:70vh;transition:grid-template-columns .3s var(--ease)}',
  '.side span{white-space:nowrap;overflow:hidden;transition:opacity .2s}.side button{position:relative;min-height:36px}',
  '.dash.collapsed{grid-template-columns:3.75rem minmax(0,1fr)}.dash.collapsed .side span{opacity:0;width:0}.dash.collapsed .side button{justify-content:center;gap:0;padding-inline:0}',
  '.side-foot{margin-top:auto;display:flex;align-items:center;gap:.25rem;padding-top:.5rem;border-top:1px solid var(--line)}',
  '.side .side-foot button{min-height:30px;border-radius:6px;color:var(--muted)}.side .sync{flex:1;gap:.4rem;padding:.25rem .5rem;font-size:.75rem;font-variant-numeric:tabular-nums}.side .sync .di{width:13px;height:13px}.side .sync.busy .di{animation:tl-spin .8s linear infinite}',
  '.side .side-toggle{flex:none;width:30px;justify-content:center;padding:0}.side .side-foot button:hover{background:var(--panel);color:var(--text)}.side-toggle .di{transition:transform .3s var(--ease)}',
  '.dash.collapsed .side-foot{flex-direction:column;align-items:stretch}.dash.collapsed .side .sync{flex:none;padding:.25rem 0}.dash.collapsed .side-toggle{width:auto}.dash.collapsed .side-toggle .di{transform:rotate(180deg)}',
  '.dash.collapsed .side .badge{position:absolute;top:1px;right:2px;margin:0;font-size:.6rem;padding:0 .3rem;opacity:1;width:auto}',
  '.dash .di{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}.dash .di.spin{animation:tl-spin 1.6s linear infinite}',
  '.side{position:sticky;top:49px;align-self:start;height:calc(100vh - 49px);overflow-y:auto;display:flex;flex-direction:column;gap:.15rem;padding:.75rem .6rem 1rem max(.6rem,env(safe-area-inset-left,0px));background:var(--subtle);border-right:1px solid var(--line)}',
  '.side button,.tabbar button{display:flex;align-items:center;gap:.6rem;border:0;background:none;font:inherit;color:var(--text);padding:.45rem .6rem;border-radius:6px;cursor:pointer;text-align:left;transition:background .15s}',
  '.side button:hover{background:var(--subtle)}.side button[aria-current=true]{background:var(--panel);box-shadow:inset 0 0 0 1px var(--line);font-weight:600}',
  '.badge{margin-left:auto;background:var(--run-bg);color:var(--run);border-radius:999px;font-size:.72rem;padding:0 .45rem;font-weight:700;font-variant-numeric:tabular-nums}.badge-bad{background:var(--closed-bg);color:var(--closed)}.badge[hidden]{display:none}',
    '.dmain{padding:1.25rem max(1.5rem,env(safe-area-inset-right,0px)) 2rem 1.5rem;display:grid;gap:1.1rem;align-content:start;min-width:0}',
    '.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.75rem}',
  '.stat{font:inherit;color:inherit;text-align:left;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:.8rem .95rem;display:grid;gap:.1rem;cursor:pointer;transition:transform .15s,box-shadow .15s,border-color .15s;animation:tl-rise .4s var(--ease) both}',
  '.stat:nth-child(2){animation-delay:.05s}.stat:nth-child(3){animation-delay:.1s}.stat:nth-child(4){animation-delay:.15s}',
  '.stat:hover{transform:translateY(-2px);box-shadow:var(--shadow);border-color:var(--line-strong)}.stat .k{font-size:.78rem;color:var(--muted);display:flex;gap:.4rem;align-items:center}',
  '.stat .v{font-size:1.7rem;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums}.stat .s{font-size:.78rem;color:var(--muted)}.stat-accent .v{color:var(--run)}.stat-bad .v{color:var(--closed)}',
  '.grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:1.1rem;align-items:stretch;grid-auto-flow:row dense}',
  '.box{grid-column:span var(--span,12);display:flex;flex-direction:column;position:relative;min-width:0;transition:box-shadow .2s,opacity .2s,transform .2s}.box-body{flex:1;min-height:0;overflow:auto}',
  '.box>header .tools{margin-left:auto;display:flex;gap:.1rem}.dash:not(.editing) .tools,.dash:not(.editing) .rs,.dash:not(.editing) .editbar{display:none}',
  '.dash.editing .box{outline:1.5px dashed var(--line-strong);outline-offset:3px}.dash.editing .box>header{cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none}.dash.editing .box-body{pointer-events:none}.dash.editing .rs{opacity:1}',
  '.box.lifted{position:fixed;z-index:35;margin:0;pointer-events:none;box-shadow:var(--shadow-lg);transform:rotate(.6deg) scale(1.015);outline-color:var(--btn)!important;animation:none!important}.box.lifted>header{cursor:grabbing}',
  '.box-ph{grid-column:span var(--span,12);border:2px dashed var(--btn);border-radius:8px;background:var(--run-bg);opacity:.55}',
  '.editbar{display:flex;flex-wrap:wrap;gap:.5rem .75rem;align-items:center;padding:.55rem .75rem;border:1px solid var(--line);border-radius:8px;background:var(--subtle);font-size:.85rem;animation:tl-rise .25s var(--ease)}.editbar .hint{display:inline-flex;gap:.4rem;align-items:center;color:var(--muted)}.editbar .sp{flex:1}.editbar .hidden-bar{margin:0}',
  '.tool{border:0;background:none;color:var(--muted);cursor:pointer;padding:.2rem;border-radius:4px;display:grid;place-items:center;transition:background .15s,color .15s}.tool:hover{background:var(--subtle);color:var(--text)}.grip{cursor:grab}.grip:active{cursor:grabbing}',
  '.dash[data-view=overview] .box.is-hidden{display:none}.dash:not([data-view=overview]) .hidden-bar{display:none}',
  '.hidden-bar{display:flex;flex-wrap:wrap;gap:.35rem;align-items:center;font-size:.78rem;color:var(--muted);margin-bottom:-.35rem}.hidden-bar[hidden]{display:none}.hidden-bar button{font:inherit;color:var(--muted);background:none;border:1px dashed var(--line-strong);border-radius:999px;padding:.05rem .6rem;cursor:pointer;transition:color .15s,border-color .15s}.hidden-bar button:hover{color:var(--text);border-color:var(--text)}',
  '.box.moving{opacity:.45;transform:scale(.98)}.box.drop-before{box-shadow:-4px 0 0 0 var(--btn)}.box.drop-after{box-shadow:4px 0 0 0 var(--btn)}',
  '.rs{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;opacity:0;transition:opacity .15s;background:linear-gradient(135deg,transparent 0 55%,var(--line-strong) 55% 62%,transparent 62% 72%,var(--line-strong) 72% 79%,transparent 79%)}.box:hover .rs,.box.resizing .rs{opacity:1}',
  '.box.resizing{box-shadow:0 0 0 2px var(--btn);transition:none}.dash.layouting{user-select:none;-webkit-user-select:none}',
  '.box{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden;animation:tl-rise .45s var(--ease) both}.box:nth-child(2){animation-delay:.05s}.box:nth-child(n+3){animation-delay:.1s}',
  '.box>header{display:flex;flex-wrap:wrap;gap:.25rem .75rem;align-items:baseline;padding:.7rem 1rem;border-bottom:1px solid var(--line)}.box>header h2{margin:0;font-size:.98rem;display:flex;gap:.45rem;align-items:center;flex:1}.box>header small{color:var(--muted);font-size:.75rem}',
  
  '.empty{color:var(--muted);padding:1.25rem 1rem;margin:0;text-align:center}.empty.ok{display:flex;gap:.5rem;align-items:center;justify-content:center;color:var(--ok)}',
  '.chips{display:flex;gap:.3rem;flex-wrap:wrap;padding:.6rem 1rem;border-bottom:1px solid var(--line);background:var(--subtle)}',
  '.chips button{font:inherit;font-size:.8rem;border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:999px;padding:.15rem .65rem;cursor:pointer;display:inline-flex;gap:.35rem;align-items:center;transition:background .15s,color .15s,border-color .15s}',
  '.chips .n{font-variant-numeric:tabular-nums;color:var(--muted);font-weight:600}.chips button[aria-pressed=true]{background:var(--text);color:var(--panel);border-color:var(--text)}.chips button[aria-pressed=true] .n{color:inherit;opacity:.75}',
  '.mrlist,.alist,.mlist,.duty,.board ul{list-style:none;margin:0;padding:0}',
  '.mrrow{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:.7rem;align-items:center;padding:.65rem 1rem;border-top:1px solid var(--line);transition:background .15s;animation:tl-rise .3s var(--ease) both}.mrrow:first-child{border-top:0}.mrrow:hover{background:var(--subtle)}',
  '.mrrow .av{margin:0;width:28px;height:28px}.mrmain{min-width:0}.mrmain .t{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mrmain .t a{color:var(--text)}.mrmain .m{font-size:.8rem;color:var(--muted);display:flex;flex-wrap:wrap;gap:.1rem .4rem}',
  '.muted-link{color:var(--muted)}.mrside{display:flex;gap:.6rem;align-items:center}',
  '.dot{width:20px;height:20px;border-radius:50%;display:grid;place-items:center}.dot .di{width:12px;height:12px;stroke-width:2.6}.dot-ok{background:var(--ok-bg);color:var(--ok)}.dot-bad{background:var(--closed-bg);color:var(--closed)}.dot-run{background:var(--run-bg);color:var(--run)}.dot-idle{background:var(--draft-bg);color:var(--draft)}',
  '.ci-ic{display:block;flex:none}.ci-none{width:16px;height:16px;border-radius:50%;border:1.5px dashed var(--line-strong);flex:none}.appr-badge{display:block;flex:none;height:18px;width:auto}.side [hidden]{display:none!important}',
  '.col.drop-here{background:var(--run-bg);box-shadow:inset 0 0 0 2px var(--btn)}.tk.dragging{opacity:.4}.tk[draggable=true]{cursor:grab}.tk[draggable=true]:active{cursor:grabbing}.tk.moved{animation:tl-new 1.6s var(--ease)}',
  '.tk[data-issue],.al[data-alert]{cursor:pointer}.tk[data-issue]:focus-visible,.al[data-alert]:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}.al[data-alert]{transition:background .15s}.al[data-alert]:hover{background:var(--subtle)}',
  '.tchip{display:inline-flex;align-items:center;gap:.25rem;font:600 .72rem var(--mono);color:var(--run);background:var(--run-bg);border:0;border-radius:4px;padding:.05rem .35rem;cursor:pointer;transition:filter .15s}.tchip:hover{filter:brightness(1.15)}.tchip .di{width:12px;height:12px}',
  '.drawer{position:fixed;inset:0;z-index:40}.drawer[hidden]{display:none}.drawer-bg{position:absolute;inset:0;background:rgba(0,0,0,.35);animation:tl-fade .2s var(--ease)}@keyframes tl-fade{from{opacity:0}}',
  '.drawer-panel{position:absolute;top:0;right:0;bottom:0;width:min(36rem,100vw);background:var(--panel);border-left:1px solid var(--line);box-shadow:var(--shadow-lg);display:flex;flex-direction:column;animation:tl-slide .28s var(--ease);padding-bottom:env(safe-area-inset-bottom,0px)}@keyframes tl-slide{from{transform:translateX(100%)}}',
  '.drawer-panel>header{display:flex;gap:.75rem;align-items:flex-start;padding:1rem 1.1rem .85rem;border-bottom:1px solid var(--line)}.drawer-panel h2{margin:0;font-size:1.05rem;line-height:1.35;flex:1;overflow-wrap:anywhere}',
  '.drawer-body{padding:1rem 1.1rem 1.5rem;overflow:auto;flex:1}.dfacts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:.45rem 1rem;margin:0 0 1rem;font-size:.88rem}.dfacts dt{color:var(--muted)}.dfacts dd{margin:0;overflow-wrap:anywhere}.dfacts .av{width:18px;height:18px}',
  '.dtext{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.88rem;line-height:1.55;background:var(--subtle);border:1px solid var(--line);border-radius:6px;padding:.75rem .85rem;max-height:50vh;overflow:auto}.dsub{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:1.1rem 0 .5rem}',
  '.lbl{display:inline-block;font-size:.75rem;background:var(--subtle);border:1px solid var(--line);border-radius:999px;padding:0 .5rem;margin:0 .2rem .2rem 0}.drawer .sk{height:12px;border-radius:4px;background:var(--subtle);margin:.6rem 0}',
  '.tl-new{animation:tl-new 1.6s var(--ease)}@keyframes tl-new{0%,30%{background:var(--run-bg)}100%{background:transparent}}',
  '.btn-sm{padding:.2rem .6rem;font-size:.82rem;width:auto}.btn-sm .di{width:14px;height:14px}.btn-sm[data-busy]::before{content:"";width:12px;height:12px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:tl-spin .7s linear infinite}.btn-sm[data-busy] .di{display:none}',
  '.mrlist .empty{display:none}.dash[data-nodraft="1"] .mrrow[data-f~=draft]{display:none}.chips-sep{flex:1}',
  '.chips .toggle[aria-pressed=true]{background:var(--run-bg);color:var(--run);border-color:var(--run)}',
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
  '.dash:not([data-view=overview]) .box{grid-column:1/-1;height:auto!important}.dash:not([data-view=overview]) .tools,.dash:not([data-view=overview]) .rs{display:none}',
    '@media (max-width:68rem){.grid .box{grid-column:1/-1;height:auto!important}.tools .grip,.rs{display:none!important}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}}',
  '@media (max-width:48rem){.dash,.dash.collapsed{grid-template-columns:1fr}.side{display:none}.dmain{padding:1rem max(1rem,env(safe-area-inset-right,0px)) 5.5rem max(1rem,env(safe-area-inset-left,0px))}',
  '.board{grid-template-columns:repeat(3,minmax(11rem,1fr));overflow-x:auto;scroll-snap-type:x mandatory}.col{scroll-snap-align:start}.mrside .appr-badge{display:none}',
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
function nodraft(on){d.setAttribute('data-nodraft',on?'1':'0');try{localStorage.setItem('tl-nodraft',on?'1':'0')}catch(e){}mark()}
function mark(){document.querySelectorAll('[data-nodraft-toggle]').forEach(function(b){b.setAttribute('aria-pressed',String(d.getAttribute('data-nodraft')==='1'))});var v=d.getAttribute('data-view'),f=d.getAttribute('data-mrf');document.querySelectorAll('[data-view-to]').forEach(function(b){if(b.closest('.side,.tabbar'))b.setAttribute('aria-current',String(b.getAttribute('data-view-to')===v))});document.querySelectorAll('[data-mrf-to]').forEach(function(b){b.setAttribute('aria-pressed',String(b.getAttribute('data-mrf-to')===f))})}
function toast(t){var r=document.getElementById('toasts');if(!r||!t)return;var e=document.createElement('div');e.className='toast';e.textContent=t;r.appendChild(e);setTimeout(function(){e.classList.add('out');setTimeout(function(){e.remove()},320)},3600)}
function view(v){d.setAttribute('data-view',v);mark();try{sessionStorage.setItem('tl-view',v)}catch(e){}window.scrollTo({top:0,behavior:'smooth'})}
var tdrag=null,tfrom=null,tnext=null;
function colCount(c){var n=c.querySelectorAll('.tk').length,s=c.querySelector('[data-col-count]');if(s)s.textContent=n;var ul=c.querySelector('ul'),none=ul&&ul.querySelector('.none');if(n&&none)none.remove()}
d.addEventListener('dragstart',function(e){var t=e.target.closest&&e.target.closest('.tk[data-issue]');if(!t)return;tdrag=t;tfrom=t.parentNode;tnext=t.nextSibling;t.classList.add('dragging');try{e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',t.getAttribute('data-issue'))}catch(x){}});
d.addEventListener('dragover',function(e){if(!tdrag)return;var c=e.target.closest&&e.target.closest('[data-col]');d.querySelectorAll('.col.drop-here').forEach(function(x){if(x!==c)x.classList.remove('drop-here')});if(!c||c.contains(tdrag))return;e.preventDefault();c.classList.add('drop-here')});
d.addEventListener('drop',function(e){if(!tdrag)return;var c=e.target.closest&&e.target.closest('[data-col]');if(!c||c.contains(tdrag))return;e.preventDefault();var t=tdrag,from=tfrom,next=tnext,src=from.closest('[data-col]');c.querySelector('ul').prepend(t);colCount(c);colCount(src);busy++;var body=new URLSearchParams();body.set('csrf',csrf.value);body.set('key',t.getAttribute('data-issue'));body.set('to',c.getAttribute('data-col'));
fetch(B+'/move',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:body.toString()}).then(function(r){return r.json().catch(function(){return {status:'failed',text:'The answer could not be read. Reload the board.'}})}).then(function(r){if(r.status==='moved'){t.classList.add('moved')}else{from.insertBefore(t,next);colCount(c);colCount(src)}toast(r.text)}).catch(function(){from.insertBefore(t,next);colCount(c);colCount(src);toast('The connection was lost. Reload the board to see where the ticket is now.')}).then(function(){busy--;setTimeout(refresh,800)})});
d.addEventListener('dragend',function(){if(tdrag)tdrag.classList.remove('dragging');tdrag=null;d.querySelectorAll('.col.drop-here').forEach(function(x){x.classList.remove('drop-here')})});
var dr=d.querySelector('[data-drawer]'),dlast=null,dreq=0;
function closeDetail(){if(!dr||dr.hidden)return;dr.hidden=true;document.body.style.overflow='';if(dlast&&dlast.focus)dlast.focus()}
function openDetail(el){if(!dr)return;var issue=el.getAttribute('data-issue'),alertId=el.getAttribute('data-alert'),n=++dreq;dlast=el;var t=dr.querySelector('#drawer-title'),body=dr.querySelector('[data-drawer-body]');t.textContent=issue||'Alert';body.innerHTML='<div class="sk" style="width:60%"></div><div class="sk" style="width:85%"></div><div class="sk" style="width:40%"></div><div class="sk" style="height:120px"></div>';dr.hidden=false;document.body.style.overflow='hidden';var c=dr.querySelector('.drawer-panel [data-drawer-close]');if(c)c.focus();
fetch(B+(issue?'/issue?key='+encodeURIComponent(issue):'/alert?id='+encodeURIComponent(alertId)),{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(x){if(n!==dreq)return;if(!x){body.innerHTML='';var p=document.createElement('p');p.className='note';p.textContent='Could not load the details right now.';body.appendChild(p);return}t.textContent=x.title||'';body.innerHTML=x.html||''}).catch(function(){if(n===dreq)body.textContent='Could not load the details right now.'})}
d.addEventListener('keydown',function(e){if(e.key==='Escape'&&dr&&!dr.hidden){closeDetail();return}if(e.key==='Escape'&&editing()&&!mv&&!rz){setEdit(false);return}var el=e.target;if((e.key==='Enter'||e.key===' ')&&el&&el.matches&&el.matches('[role=button][data-issue],[role=button][data-alert]')){e.preventDefault();openDetail(el)}});
function collapse(on){d.classList.toggle('collapsed',on);var c=document.querySelector('[data-collapse]');if(c){c.setAttribute('aria-expanded',String(!on));c.title=on?'Expand sidebar':'Collapse sidebar'}try{localStorage.setItem('tl-side',on?'1':'0')}catch(e){}}
try{if(localStorage.getItem('tl-side')==='1'){d.style.transition='none';collapse(true);requestAnimationFrame(function(){requestAnimationFrame(function(){d.style.transition=''})})}}catch(e){}
var G=d.querySelector('[data-grid]'),LK='tl-layout',DEF={};if(G)G.querySelectorAll('[data-sec]').forEach(function(b){DEF[b.getAttribute('data-sec')]=+b.getAttribute('data-span')});
function boxes(){return G?Array.prototype.slice.call(G.querySelectorAll('[data-sec]')):[]}
function readL(){try{var l=JSON.parse(localStorage.getItem(LK)||'null');return l&&typeof l==='object'?l:null}catch(e){return null}}
function hbar(){var bar=d.querySelector('[data-hidden-bar]');if(!bar)return;var hs=boxes().filter(function(b){return b.classList.contains('is-hidden')});bar.textContent='';if(!hs.length){bar.hidden=true;return}bar.hidden=false;var lab=document.createElement('span');lab.textContent='Hidden:';bar.appendChild(lab);hs.forEach(function(b){var t=document.createElement('button');t.type='button';t.setAttribute('data-unhide',b.getAttribute('data-sec'));t.title='Show this card again';var h=b.querySelector('h2');t.textContent=h?h.textContent:b.getAttribute('data-sec');bar.appendChild(t)})}
function saveL(){var l={order:boxes().map(function(b){return b.getAttribute('data-sec')}),span:{},height:{},hidden:boxes().filter(function(b){return b.classList.contains('is-hidden')}).map(function(b){return b.getAttribute('data-sec')})};boxes().forEach(function(b){var k=b.getAttribute('data-sec'),sp=+b.style.getPropertyValue('--span');if(sp&&sp!==DEF[k])l.span[k]=sp;if(b.style.height)l.height[k]=parseInt(b.style.height,10)});var custom=l.order.join()!==Object.keys(DEF).join()||Object.keys(l.span).length||Object.keys(l.height).length||l.hidden.length;hbar();try{if(custom)localStorage.setItem(LK,JSON.stringify(l));else localStorage.removeItem(LK)}catch(e){}var r=document.querySelector('[data-layout-reset]');if(r)r.disabled=!custom}
function applyL(l){if(!G)return;var by={};boxes().forEach(function(b){by[b.getAttribute('data-sec')]=b});var order=(l&&Array.isArray(l.order)?l.order:[]).filter(function(k){return by[k]});Object.keys(by).forEach(function(k){if(order.indexOf(k)<0)order.push(k)});order.forEach(function(k){G.appendChild(by[k])});boxes().forEach(function(b){var k=b.getAttribute('data-sec'),sp=l&&l.span&&+l.span[k],h=l&&l.height&&+l.height[k];b.style.setProperty('--span',String(sp>=3&&sp<=12?sp:DEF[k]));b.style.height=h>=120&&h<=4000?h+'px':'';b.classList.toggle('is-hidden',!!(l&&Array.isArray(l.hidden)&&l.hidden.indexOf(k)>=0))});hbar();var r=document.querySelector('[data-layout-reset]');if(r)r.disabled=!l}
applyL(readL());
function wide(){return window.matchMedia('(min-width:68.01rem)').matches&&d.getAttribute('data-view')==='overview'}
function editing(){return d.classList.contains('editing')}
function setEdit(on){d.classList.toggle('editing',on);document.querySelectorAll('[data-edit-toggle]').forEach(function(t){t.setAttribute('aria-pressed',String(on))});if(on&&d.getAttribute('data-view')!=='overview')view('overview')}
function nxt(n){n=n.nextSibling;while(n&&n.classList&&n.classList.contains('lifted'))n=n.nextSibling;return n}
function flip(fn){var bs=boxes().filter(function(b){return !b.classList.contains('lifted')}),r={};bs.forEach(function(b){r[b.getAttribute('data-sec')]=b.getBoundingClientRect()});fn();bs.forEach(function(b){var o=r[b.getAttribute('data-sec')],n=b.getBoundingClientRect();if(!o||!n.width)return;var dx=o.left-n.left,dy=o.top-n.top;if(!dx&&!dy)return;b.style.transition='none';b.style.transform='translate('+dx+'px,'+dy+'px)';requestAnimationFrame(function(){requestAnimationFrame(function(){b.style.transition='transform .25s var(--ease)';b.style.transform='';setTimeout(function(){b.style.transition=''},270)})})})}
var mv=null;
d.addEventListener('pointerdown',function(e){if(!editing()||!wide()||e.button>0||mv)return;var hd=e.target.closest&&e.target.closest('.box>header');if(!hd||e.target.closest('[data-hide]'))return;var b=hd.closest('[data-sec]');e.preventDefault();var r=b.getBoundingClientRect(),ph=document.createElement('div');ph.className='box-ph';ph.style.setProperty('--span',b.style.getPropertyValue('--span')||b.getAttribute('data-span'));ph.style.height=r.height+'px';G.insertBefore(ph,b);mv={b:b,ph:ph,dx:e.clientX-r.left,dy:e.clientY-r.top,h0:b.style.height};b.style.width=r.width+'px';b.style.height=r.height+'px';b.style.left=r.left+'px';b.style.top=r.top+'px';b.classList.add('lifted');d.classList.add('layouting');try{hd.setPointerCapture(e.pointerId)}catch(x){}});
d.addEventListener('pointermove',function(e){if(!mv)return;mv.b.style.left=(e.clientX-mv.dx)+'px';mv.b.style.top=(e.clientY-mv.dy)+'px';var t=null;boxes().forEach(function(x){if(x===mv.b||x.classList.contains('is-hidden'))return;var r=x.getBoundingClientRect();if(e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom)t=x});if(!t)return;var r=t.getBoundingClientRect(),after=e.clientX>r.left+r.width/2,ref=after?nxt(t):t;if(ref===mv.ph||nxt(mv.ph)===ref)return;flip(function(){G.insertBefore(mv.ph,ref)})});
function drop(){if(!mv)return;var m=mv;mv=null;var pr=m.ph.getBoundingClientRect();m.b.style.transition='left .18s var(--ease),top .18s var(--ease)';m.b.style.left=pr.left+'px';m.b.style.top=pr.top+'px';setTimeout(function(){G.insertBefore(m.b,m.ph);m.ph.remove();m.b.classList.remove('lifted');['transition','left','top','width'].forEach(function(p){m.b.style[p]=''});m.b.style.height=m.h0;d.classList.remove('layouting');saveL()},190)}
d.addEventListener('pointerup',drop);d.addEventListener('pointercancel',drop);
d.addEventListener('keydown',function(e){var g=e.target.closest&&e.target.closest('[data-grip]');if(!g||!wide()||!editing())return;var b=g.closest('[data-sec]'),all=boxes(),i=all.indexOf(b);if(e.key==='ArrowLeft'||e.key==='ArrowUp'){if(i>0)flip(function(){G.insertBefore(b,all[i-1])})}else if(e.key==='ArrowRight'||e.key==='ArrowDown'){if(i<all.length-1)flip(function(){G.insertBefore(b,all[i+1].nextSibling)})}else return;e.preventDefault();g.focus();saveL()});
var rz=null;
d.addEventListener('pointerdown',function(e){var h=e.target.closest&&e.target.closest('[data-resize]');if(!h||!wide()||!editing()||e.button>0)return;e.preventDefault();e.stopPropagation();var b=h.closest('[data-sec]'),gr=G.getBoundingClientRect(),gap=parseFloat(getComputedStyle(G).columnGap)||0;rz={b:b,top:b.getBoundingClientRect().top,left:b.getBoundingClientRect().left,col:(gr.width+gap)/12,gap:gap};b.classList.add('resizing');d.classList.add('layouting');try{h.setPointerCapture(e.pointerId)}catch(x){}},true);
d.addEventListener('pointermove',function(e){if(!rz)return;var sp=Math.max(3,Math.min(12,Math.round((e.clientX-rz.left+rz.gap)/rz.col)));rz.b.style.setProperty('--span',String(sp));rz.b.style.height=Math.max(120,Math.round(e.clientY-rz.top))+'px'});
function endRz(){if(!rz)return;rz.b.classList.remove('resizing');d.classList.remove('layouting');rz=null;saveL()}
d.addEventListener('pointerup',endRz);d.addEventListener('pointercancel',endRz);
d.addEventListener('dblclick',function(e){var h=e.target.closest&&e.target.closest('[data-resize]');if(!h||!editing())return;var b=h.closest('[data-sec]');b.style.setProperty('--span',String(DEF[b.getAttribute('data-sec')]));b.style.height='';saveL()});
try{if(localStorage.getItem('tl-nodraft')==='1')d.setAttribute('data-nodraft','1')}catch(e){}
try{var sv=sessionStorage.getItem('tl-view'),sf=sessionStorage.getItem('tl-mrf');if(sv)d.setAttribute('data-view',sv);if(sf)d.setAttribute('data-mrf',sf)}catch(e){}if(location.hash==='#overview'){d.setAttribute('data-view','overview');try{history.replaceState(null,'',location.pathname)}catch(e){}}mark();
document.addEventListener('click',function(e){document.querySelectorAll('[data-account-menu][open]').forEach(function(m){if(!m.contains(e.target))m.removeAttribute('open')})});document.addEventListener('keydown',function(e){if(e.key==='Escape')document.querySelectorAll('[data-account-menu][open]').forEach(function(m){m.removeAttribute('open')})});
document.addEventListener('click',function(e){var h=e.target.closest('[data-home]');if(h){e.preventDefault();view('overview');return}var rf=e.target.closest('[data-refresh]');if(rf){refresh();return}var di=e.target.closest('[data-issue],[data-alert]');if(di&&!e.target.closest('a')){e.preventDefault();openDetail(di);return}if(e.target.closest('[data-drawer-close]')){closeDetail();return}if(e.target.closest('[data-nodraft-toggle]')){nodraft(d.getAttribute('data-nodraft')!=='1');return}if(e.target.closest('[data-edit-toggle]')){setEdit(!editing());return}if(e.target.closest('[data-edit-done]')){setEdit(false);return}var hd=e.target.closest('[data-hide]');if(hd){var hb=hd.closest('[data-sec]');hb.classList.add('is-hidden');saveL();toast('Card hidden. Show it again from the toolbar above the cards.');return}var uh=e.target.closest('[data-unhide]');if(uh){var ub=d.querySelector('[data-sec="'+uh.getAttribute('data-unhide')+'"]');if(ub)ub.classList.remove('is-hidden');saveL();return}var lr=e.target.closest('[data-layout-reset]');if(lr){try{localStorage.removeItem(LK)}catch(x){}applyL(null);toast('Layout reset');return}var t=e.target.closest('[data-collapse]');if(t){collapse(!d.classList.contains('collapsed'));return}var v=e.target.closest('[data-view-to]');if(v){view(v.getAttribute('data-view-to'));return}var f=e.target.closest('[data-mrf-to]');if(f){d.setAttribute('data-mrf',f.getAttribute('data-mrf-to'));mark();try{sessionStorage.setItem('tl-mrf',f.getAttribute('data-mrf-to'))}catch(e){}return}var a=e.target.closest('[data-approve]');if(a)approve(a)});
function pill(cls,text,title){var s=document.createElement('span');s.className='pill '+cls;s.textContent=text;if(title)s.title=title;return s}
function approve(b){if(b.disabled)return;b.disabled=true;b.setAttribute('data-busy','');busy++;var body=new URLSearchParams();body.set('csrf',csrf.value);body.set('project',b.getAttribute('data-project'));body.set('iid',b.getAttribute('data-iid'));body.set('sha',b.getAttribute('data-sha'));
fetch(B+'/approve',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:body.toString()}).then(function(r){return r.json().catch(function(){return {status:'unknown',text:'The answer could not be read. Check the merge request in GitLab.'}})}).then(function(r){var ok=r.status==='approved'||r.status==='already';b.replaceWith(ok?pill('pill-ok','Approved',r.text):r.status==='unknown'?pill('pill-idle','Check GitLab',r.text):pill('pill-bad','Not approved',r.text));toast(r.text)}).catch(function(){b.replaceWith(pill('pill-idle','Check GitLab'));toast('The connection was lost. Nothing is repeated automatically: check the merge request in GitLab.')}).then(function(){busy--;setTimeout(refresh,1500)})}
function refresh(){if(document.hidden||busy)return;var rb=document.querySelector('[data-refresh]');if(rb)rb.classList.add('busy');fetch(B+'/data',{credentials:'same-origin',cache:'no-store'}).then(function(r){if(r.status===401){var u=document.getElementById('dash-updated');if(u)u.textContent='Signed out';if(rb)rb.title='Signed out. Reload the page to sign in again.';return null}return r.ok?r.json():null}).then(function(x){if(!x||busy)return;var s=x.sections||{};for(var k in s){var e=document.querySelector('[data-sec-body="'+k+'"]');if(!e||e.innerHTML===s[k])continue;var old={};e.querySelectorAll('[data-key]').forEach(function(n){old[n.getAttribute('data-key')]=1});var had=Object.keys(old).length;e.innerHTML=s[k];if(had)e.querySelectorAll('[data-key]').forEach(function(n){if(!old[n.getAttribute('data-key')])n.classList.add('tl-new')})}var c=x.counts||{};for(var n in c){document.querySelectorAll('[data-count="'+n+'"]').forEach(function(el){el.textContent=c[n];el.hidden=!c[n]})}if(x.csrf){csrf.value=x.csrf;document.querySelectorAll('[data-csrf]').forEach(function(i){i.value=x.csrf})}var u=document.getElementById('dash-updated');if(u&&x.updated){u.textContent=x.updated;if(rb)rb.title='Updated '+x.updated+', refreshes every minute. Click to refresh now.'}mark()}).catch(function(){}).then(function(){if(rb)rb.classList.remove('busy')})}
setInterval(refresh,60000);document.addEventListener('visibilitychange',function(){if(!document.hidden)refresh()})})();`;
}
