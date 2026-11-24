// The look and the content of the capability-link pages (approve, reopen, merge): GitLab-inspired
// styling, the merge request with its links, and the live status that keeps an open page current.
//
// Pure functions: data in, HTML out. Nothing here talks to GitLab or reads a request. Every value that
// reaches the HTML goes through `escapeHtml`, every link through `safeLink` (http(s) on the GitLab host).

import { ciStatusIcon, ciStatusInfo } from './cards.mjs';
import { GITLAB_ICONS_SMALL } from './gitlab-icons-small.mjs';
import { fallbackAvatar } from './card-user-row.mjs';

export const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// GitLab-inspired (Pajamas: a calm neutral page, a white panel, 4px corners, blue links, green/blue/red
// state pills) but its own page, branded teams-live. The state colors match the badges on the Teams card.
export const PAGE_CSS = [
  ':root{color-scheme:light dark;--bg:#fbfafd;--panel:#fff;--text:#333238;--muted:#626168;--line:#dcdcde;--accent:#1068bf;--code:#ececef;--bar:#1f1e24;--bar-text:#ececef;',
  '--ok:#108548;--ok-bg:#ecf4ee;--merged:#1f75cb;--merged-bg:#e9f3fc;--closed:#dd2b0e;--closed-bg:#fdf1ef;--draft:#626168;--draft-bg:#ececef;--run:#1f75cb;--run-bg:#e9f3fc;--warn:#9d6e00;--warn-bg:#fdf1dd;--btn:#1f75cb;--btn-h:#1068bf}',
  '@media (prefers-color-scheme:dark){:root{--bg:#18171d;--panel:#28272d;--text:#ececef;--muted:#a4a3a8;--line:#404040;--accent:#63a6e9;--code:#333238;--bar:#101014;--bar-text:#ececef;',
  '--ok:#2da160;--ok-bg:#1d3a2a;--merged:#63a6e9;--merged-bg:#1d3047;--closed:#ec5941;--closed-bg:#40201e;--draft:#a4a3a8;--draft-bg:#333238;--run:#63a6e9;--run-bg:#1d3047;--warn:#e9be74;--warn-bg:#3a2e12;--btn:#2a6fb8;--btn-h:#1d63b0}}',
  '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans",Ubuntu,Cantarell,"Helvetica Neue",sans-serif}',
  'a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}',
  '.shell{max-width:46rem;margin:0 auto;padding:0 1rem 3rem}',
  '.brand{margin:0 0 1.5rem;padding:.6rem 1rem;background:var(--bar);color:var(--bar-text);font-size:.9rem}.brand .in{display:flex;align-items:center;gap:.5rem;margin:0 auto}',
  '.brand svg{flex:none}.brand .word{font-weight:600}.brand .sep{opacity:.5}.brand .kicker{opacity:.75}',
  '.header-account{margin-left:auto;display:inline-flex;align-items:center;gap:.5rem;color:var(--bar-text);font-weight:600}.header-account:hover{color:var(--bar-text)}.account-avatar{width:32px;height:32px;border-radius:50%;object-fit:cover;border:1px solid #777}',
  '.panel{background:var(--panel);border:1px solid var(--line);border-left-width:4px;border-radius:4px;padding:1rem 1.25rem 1.25rem}',
  '.tone-ok{border-left-color:var(--ok)}.tone-warn{border-left-color:#d99a00}.tone-error{border-left-color:var(--closed)}.tone-neutral{border-left-color:var(--accent)}',
  'h1{font-size:1.25rem;font-weight:600;line-height:1.3;margin:0 0 .9rem}p{margin:.6rem 0}',
  'code{background:var(--code);padding:.05rem .3rem;border-radius:4px;font:.9em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
  '.note{color:var(--muted);font-size:.9rem}',
  // the merge request, laid out like GitLab's merge request header
  '.mr{border:1px solid var(--line);border-radius:4px;padding:.75rem 1rem;margin:0 0 1rem;background:var(--bg)}',
  '.mr-top{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem .6rem;color:var(--muted);font-size:.9rem}.mr-top .ref{font-weight:600}',
  '.mr-title{font-size:1.1rem;font-weight:600;line-height:1.35;margin:.35rem 0 .15rem}.mr-title a{color:var(--text)}',
  '.mr-branches{margin:.15rem 0 .5rem;color:var(--muted);font-size:.9rem;overflow-wrap:anywhere}',
  '.mr-facts{display:grid;grid-template-columns:max-content 1fr;gap:.3rem 1rem;margin:.5rem 0 0;font-size:.9rem}.mr-facts dt{color:var(--muted)}.mr-facts dd{margin:0;overflow-wrap:anywhere}',
  '.batch-list{display:grid;gap:1rem;margin:1rem 0}.batch-item{border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--bg)}.batch-item .mr{border:0;margin:0;border-radius:0}.batch-status{display:flex;gap:.5rem;align-items:center;padding:.6rem 1rem;border-top:1px solid var(--line);font-weight:600}.batch-actions{padding:.65rem 1rem}.batch-actions .btn{font-size:.9rem}.btn:disabled{opacity:.55;cursor:default}.batch-status[data-status=ready],.batch-status[data-status=working]{color:var(--run);background:var(--run-bg)}.batch-status[data-status=approved],.batch-status[data-status=already]{color:var(--ok);background:var(--ok-bg)}.batch-status[data-status=failed],.batch-status[data-status=blocked],.batch-status[data-status=unavailable]{color:var(--closed);background:var(--closed-bg)}.batch-status[data-status=unknown]{color:var(--warn);background:var(--warn-bg)}.batch-progress{width:100%;accent-color:var(--accent)}.batch-progress[hidden]{display:none}',
  '.batch-message:not(:empty){padding:.65rem .85rem;border-radius:4px;font-weight:600}.batch-message[data-state=working]{background:var(--run-bg);color:var(--run)}.batch-message[data-state=ok]{background:var(--ok-bg);color:var(--ok)}.batch-message[data-state=failed]{background:var(--closed-bg);color:var(--closed)}',
  '.pill{display:inline-flex;align-items:center;gap:.35rem;border-radius:999px;padding:.05rem .55rem;font-size:.8rem;font-weight:600;line-height:1.5;border:1px solid currentColor;white-space:nowrap}',
  '.pill i{width:.5rem;height:.5rem;border-radius:50%;background:currentColor;display:inline-block}',
  // the pictures of the Teams card: GitLab icons (16px) and people (20px, round)
  '.ic{vertical-align:-3px;flex:none}.av{border-radius:50%;vertical-align:-5px;margin-right:.4rem}.pill .ic{vertical-align:-3px;margin:0 -.1rem 0 -.2rem}.mr-top .ic{vertical-align:-3px}.person{display:inline-block;margin-right:.6rem;white-space:nowrap}',
  '.pill-open,.pill-ok{color:var(--ok);background:var(--ok-bg)}.pill-merged,.pill-run{color:var(--merged);background:var(--merged-bg)}.pill-closed,.pill-bad{color:var(--closed);background:var(--closed-bg)}.pill-draft,.pill-idle{color:var(--draft);background:var(--draft-bg)}',
  '.callout{border-radius:4px;padding:.6rem .85rem;margin:.9rem 0;background:var(--warn-bg);color:var(--text);border:1px solid var(--line);font-size:.9rem}',
  '.notice{border-radius:4px;padding:.6rem .85rem;margin:.9rem 0;background:var(--merged-bg);border:1px solid var(--line);font-size:.9rem}.notice:empty{display:none}',
  '.actions{margin-top:1rem}.hidden{display:none}',
  '.btn{display:inline-block;font:inherit;font-weight:600;color:#fff;background:var(--btn);border:1px solid var(--btn);border-radius:4px;padding:.45rem .9rem;cursor:pointer}.btn:hover{background:var(--btn-h);text-decoration:none}',
  '.btn-secondary{color:var(--text);background:var(--panel);border-color:var(--line)}.btn-secondary:hover{background:var(--bg)}',
  '.btn[hidden]{display:none}.btn:focus-visible{outline:3px solid var(--accent);outline-offset:2px}',
  '.links{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0 0}',
  '.foot{margin-top:1rem;color:var(--muted);font-size:.8rem}',
  '@media (max-width:30rem){.panel{padding:.9rem}.btn{width:100%;text-align:center}.mr-facts{grid-template-columns:1fr}.mr-facts dt{margin-top:.3rem}.header-account .account-name{display:none}}',
].join('');

/** The tanuki: a simple three-color fox head, drawn inline (the CSP allows no images). */
export const TANUKI =
  '<svg width="22" height="22" viewBox="0 0 25 24" role="img" aria-label="GitLab" focusable="false"><path fill="#e24329" d="M24.507 9.5l-.034-.09L21.082.562a.896.896 0 00-1.694.091l-2.29 7.01H7.825L5.535.653a.898.898 0 00-1.694-.09L.451 9.411.416 9.5a6.297 6.297 0 002.09 7.278l.012.01.03.022 5.16 3.867 2.56 1.935 1.554 1.176a1.051 1.051 0 001.268 0l1.555-1.176 2.56-1.935 5.197-3.89.014-.01A6.297 6.297 0 0024.507 9.5z"/><path fill="#fc6d26" d="M24.507 9.5l-.034-.09a11.44 11.44 0 00-4.56 2.051l-7.447 5.632 4.742 3.584 5.197-3.89.014-.01A6.297 6.297 0 0024.507 9.5z"/><path fill="#fca326" d="M7.707 20.677l2.56 1.935 1.555 1.176a1.051 1.051 0 001.268 0l1.555-1.176 2.56-1.935-4.743-3.584-4.755 3.584z"/><path fill="#fc6d26" d="M5.01 11.461a11.43 11.43 0 00-4.56-2.05L.416 9.5a6.297 6.297 0 002.09 7.278l.012.01.03.022 5.16 3.867 4.745-3.584-7.444-5.632z"/></svg>';

/** A small embedded picture (a data URI from the card icons or a profile picture), or '' for anything else. */
function picture(src, alt, cls = 'ic', px = 16) {
  return /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(String(src ?? '')) ? `<img class="${cls}" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="${px}" height="${px}">` : '';
}

/** A person's picture: their photo when the card service has it, else their initials (as on the cards). */
export function avatarImg(name, avatars = {}) {
  return picture(avatars?.[name] || fallbackAvatar(name), name, 'av', 20);
}

/** A session-local account link for the common page header. */
export function headerAccount(user, host, avatar = '') {
  if (!user?.username) return '';
  const name = user.name || user.username;
  const photo = picture(avatar || fallbackAvatar(name), '', 'account-avatar', 32);
  const url = safeLink(`https://${host}/${encodeURIComponent(user.username)}`, host);
  const content = `<span class="account-name">${escapeHtml(user.username)}</span>${photo}`;
  return url ? `<a class="header-account" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" aria-label="GitLab account ${escapeHtml(user.username)}">${content}</a>` : `<span class="header-account">${content}</span>`;
}

/** http(s) link on the GitLab host only: anything else (another host, a javascript: URL) yields ''. */
export function safeLink(value, host) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    if (host && url.hostname.toLowerCase() !== String(host).toLowerCase()) return '';
    return host ? url.href : '';
  } catch {
    return '';
  }
}

const anchor = (href, html) => (href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${html}</a>` : html);

/** Pill for the live state of a merge request. Draft wins over open, like the card. */
export function stateBadge(mr) {
  if (!mr?.state) return '';
  const draft = Boolean(mr.draft || mr.work_in_progress || mr.detailed_merge_status === 'draft_status');
  const [cls, label] =
    mr.state === 'merged' ? ['merged', 'Merged'] : mr.state === 'closed' ? ['closed', 'Closed'] : mr.state === 'opened' ? (draft ? ['draft', 'Draft'] : ['open', 'Open']) : ['draft', escapeHtml(mr.state)];
  const glyph = mr.state === 'merged' ? 'merge' : mr.state === 'closed' ? 'merge-request-close' : draft ? 'merge-request' : 'merge-request-open';
  return `<span class="pill pill-${cls}">${picture(GITLAB_ICONS_SMALL[glyph], '') || '<i aria-hidden="true"></i>'}${label}</span>`;
}

const PIPELINE_CLASS = { success: 'ok', success_with_warnings: 'ok', failed: 'bad', canceled: 'idle', cancelled: 'idle', skipped: 'idle', running: 'run', pending: 'run', created: 'run', preparing: 'run', waiting_for_resource: 'run', scheduled: 'idle', manual: 'idle' };

/** The pipeline as a pill linked to it, or a dash. */
export function pipelineHtml(pipeline, host) {
  if (!pipeline?.status) return '<span class="note">No pipeline</span>';
  const cls = PIPELINE_CLASS[String(pipeline.status).toLowerCase()] || 'idle';
  const label = escapeHtml(ciStatusInfo(pipeline.status).label);
  const id = pipeline.id ? ` #${escapeHtml(pipeline.id)}` : '';
  const status = picture(ciStatusIcon(pipeline.status)?.url, '') || '<i aria-hidden="true"></i>';
  return anchor(safeLink(pipeline.web_url, host), `<span class="pill pill-${cls}">${status}${label}${id}</span>`);
}

/** The approvals as text: how many of how many, or that GitLab asks for none. */
export function approvalsHtml(approvals, avatars = {}) {
  if (!approvals || approvals.known === false) return '<span class="note">Unknown</span>';
  const given = approvals.approvalsGiven;
  const required = approvals.approvalsRequired;
  const people = (Array.isArray(approvals.approvedBy) ? approvals.approvedBy : []).filter(Boolean);
  const by = people.length > 0 ? ` by ${people.map((name) => `<span class="person">${avatarImg(name, avatars)}${escapeHtml(name)}</span>`).join('')}` : '';
  if (typeof given === 'number' && typeof required === 'number' && required > 0) return `${given} of ${required} required${by}`;
  return approvals.approved ? `Approved${by}` : 'Not approved yet';
}

const MERGE_STATUS = {
  mergeable: 'Ready to merge',
  not_approved: 'Approval required',
  ci_still_running: 'Pipeline running',
  ci_must_pass: 'Pipeline must succeed',
  conflict: 'Has merge conflicts',
  need_rebase: 'Needs a rebase',
  draft_status: 'Draft',
  discussions_not_resolved: 'Unresolved discussions',
  checking: 'Checking',
  not_open: 'Not open',
};

export const mergeStatusText = (status) => {
  const key = String(status || '').toLowerCase();
  if (!key) return '';
  return MERGE_STATUS[key] || key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
};

/** What a finished merge request means for the page: whether the action is still possible, and a notice. */
export function liveState(kind, mr) {
  const state = mr?.state;
  const actionable = kind === 'reopen' ? state === 'closed' : state === 'opened';
  let notice = '';
  if (state === 'merged') notice = 'This merge request has been merged.';
  else if (state === 'closed' && kind !== 'reopen') notice = 'This merge request has been closed.';
  else if (state === 'opened' && kind === 'reopen') notice = 'This merge request is open again.';
  return { actionable, notice };
}

/**
 * The pieces of the page that change while it is open, as HTML, by slot name. The same function renders
 * the first page and the live updates, so they can never disagree.
 */
export function autoMergeHtml(mr) {
  const on = mr?.auto_merge_enabled ?? mr?.merge_when_pipeline_succeeds;
  if (typeof on !== 'boolean') return '<span class="note">Unknown</span>';
  return `${picture(GITLAB_ICONS_SMALL[on ? 'clock' : 'status_pending'], '')} Auto-merge ${on ? 'on' : 'off'}`;
}

export function liveSlots({ kind, mr, approvals, host, avatars = {} }) {
  const slots = { state: stateBadge(mr) };
  if (kind !== 'reopen') {
    slots.pipeline = pipelineHtml(mr?.head_pipeline, host);
    slots.approvals = approvalsHtml(approvals, avatars);
    slots.automerge = autoMergeHtml(mr);
    slots.merge = escapeHtml(mergeStatusText(mr?.detailed_merge_status)) || '<span class="note">Unknown</span>';
  }
  slots.notice = escapeHtml(liveState(kind, mr).notice);
  return slots;
}

/**
 * The merge request as GitLab shows its header: state, reference, title, branches, author, pipeline,
 * approvals and head commit, each linked to GitLab where a link is known.
 */
export function renderSummary({ record, mr, approvals = null, host = '', kind = 'approve', avatars = {}, live = true }) {
  const ref = `!${escapeHtml(record.iid)}`;
  const mrUrl = safeLink(mr?.web_url, host);
  const projectUrl = mrUrl ? mrUrl.replace(/\/-\/merge_requests\/\d+.*$/, '') : '';
  const slots = liveSlots({ kind, mr, approvals, host, avatars });
  const title = escapeHtml(mr?.title || `Merge request !${record.iid}`);
  const branch = (name) => (name ? anchor(projectUrl ? `${projectUrl}/-/tree/${encodeURIComponent(name)}` : '', `<code>${escapeHtml(name)}</code>`) : '');
  const branches = mr?.source_branch && mr?.target_branch ? `<p class="mr-branches">${branch(mr.source_branch)} → ${branch(mr.target_branch)}</p>` : '';
  const author = mr?.author?.name || mr?.author?.username;
  const authorHtml = author ? `${avatarImg(author, avatars)}${anchor(safeLink(mr.author.web_url, host), escapeHtml(author))}` : '';
  const facts = [];
  if (authorHtml) facts.push(['Author', authorHtml]);
  if (kind !== 'reopen' && mr) {
    facts.push(['Pipeline', `<span data-live="pipeline">${slots.pipeline}</span>`]);
    facts.push(['Approvals', `<span data-live="approvals">${slots.approvals}</span>`]);
    facts.push(['Auto-merge', `<span data-live="automerge">${slots.automerge}</span>`]);
    facts.push(['Merge status', `<span data-live="merge">${slots.merge}</span>`]);
    if (record.sha) {
      const commit = anchor(projectUrl ? `${projectUrl}/-/commit/${encodeURIComponent(record.sha)}` : '', `<code>${escapeHtml(record.sha.slice(0, 12))}</code>`);
      facts.push(['Head commit', commit]);
    }
  }
  const dl = facts.length ? `<dl class="mr-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : '';
  return (
    `<div class="mr"${live ? ' data-live-root' : ''}>` +
    `<div class="mr-top"><span data-live="state">${slots.state}</span>${anchor(projectUrl, picture(GITLAB_ICONS_SMALL.repository, 'Repository'))}${anchor(mrUrl, `<span class="ref">${escapeHtml(record.project)}${ref}</span>`)}</div>` +
    `<h2 class="mr-title">${anchor(mrUrl, title)}</h2>${branches}${dl}` +
    `<div class="notice" data-live="notice">${slots.notice}</div></div>`
  );
}

/**
 * The script that keeps an open page current, and that sends the action forms (`data-act`) in the background: the
 * button shows what is going on, the answer replaces the page content in place, and a lost connection is reported,
 * never answered with a second request. Without the script the forms are ordinary posts. The page is kept
 * current by asking the same-origin state endpoint every few seconds
 * while the page is visible and puts the server's (escaped) HTML into the matching `data-live` slots. It
 * hides the action when the merge request can no longer take it. No slot names or text of its own: it only
 * does what the server's answer says.
 */
export function liveScript(stateUrl) {
  const url = JSON.stringify(stateUrl);
  return `(function(){var U=${url},n=0,t;function go(d){var s=d.slots||{};for(var k in s){var e=document.querySelector('[data-live="'+k+'"]');if(e&&e.innerHTML!==s[k])e.innerHTML=s[k]}var a=document.querySelectorAll('[data-live-action]');for(var i=0;i<a.length;i++)a[i].classList.toggle('hidden',!d.actionable)}function tick(){if(document.hidden||++n>360)return;fetch(U,{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(d){if(d)go(d)}).catch(function(){})}t=setInterval(tick,5000);setTimeout(tick,800);document.addEventListener('visibilitychange',function(){if(!document.hidden)tick()});document.addEventListener('submit',function(ev){var f=ev.target;if(!f||!f.hasAttribute||!f.hasAttribute('data-act'))return;ev.preventDefault();if(f.getAttribute('data-sent')==='1')return;f.setAttribute('data-sent','1');var b=f.querySelector('button[type=submit]');if(b){b.disabled=true;b.textContent=b.getAttribute('data-busy')||'Working\u2026'}var m=document.querySelector('main');function say(t){if(m){var p=document.createElement('p');p.className='note';p.textContent=t;f.replaceWith(p)}}fetch(f.action,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(new FormData(f)).toString()}).then(function(r){return r.text()}).then(function(h){var d=new DOMParser().parseFromString(h,'text/html'),n=d.querySelector('main');if(n&&m){m.className=n.className;m.innerHTML=n.innerHTML;document.title=d.title;window.scrollTo(0,0)}else say('The answer could not be shown. Reload the page to see what happened.')}).catch(function(){say('The connection was lost. Nothing is repeated automatically: reload the page to see what happened.')})})})();`;
}
