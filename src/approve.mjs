// Capability-link web confirmation flow for approving a GitLab merge request
// from a rich card.
//
// The card carries an "👍 Approve" button (Action.OpenUrl) whose URL holds a
// random 256-bit capability token in the FRAGMENT (`https://host/approve/#<token>`).
// There are no accounts: whoever holds the link can approve, as the configured
// GitLab account, and nothing here identifies or authenticates the caller.
//
// - Fragments are never sent to a server, so the token is not in the request
//   URL, the proxy access log or a Referer. A static page (no token needed to
//   render it) reads it with a small script, clears it from the address bar
//   and exchanges it with a same-origin POST for a short-lived HttpOnly,
//   SameSite=Strict session cookie. That bootstrap changes nothing in GitLab
//   and consumes nothing, so a link scanner that only fetches or even runs the
//   page cannot burn the link.
// - Approving needs an explicit confirmation POST from the page served to that
//   session: session cookie, CSRF token bound to the session and the link,
//   and an Origin that matches the configured base_url. The GitLab account and
//   credential the page showed are carried in the form and bound into the CSRF
//   token; the POST re-reads them and sends nothing when they differ, or when
//   the account cannot be told.
// - The server stores only the SHA-256 of the token with the project, merge
//   request, exact head commit, expiry (24 h by default, hard bounded) and
//   status. A link is single-use once an approval is CONFIRMED, and is
//   invalidated when the head commit changes or the merge request is closed
//   or merged. An uncertain outcome consumes nothing.
// - The listener binds to loopback only and sits behind the reverse proxy.
//
// The same flow serves a second action, "Reopen", for CLOSED (never merged)
// merge requests: a "🔄 Reopen" button on the closed card opens a link of the
// kind `reopen`. It is separate from the approval links (its own records, never
// staled by approvals and vice versa), has no head commit to pin, and is used up
// by a confirmed reopen. Everything above (capability token, session, CSRF,
// Origin, lock) applies unchanged.
//
// A third action, "Merge", is offered on OPEN, non-draft merge requests: a
// "🔀 Merge" button opens a link of the kind `merge`. Like an approval it is
// pinned to the head commit it was minted for, and it has its own records (never
// staled by approvals or reopens and vice versa). The page re-reads the merge
// request and offers the button only while GitLab reports it mergeable at that
// head; the confirmed POST sends ONE merge request guarded by that head (`sha`)
// and nothing else: GitLab's own rules (approvals, pipeline, protected branch,
// conflicts, discussions) decide, they cannot be overridden from here, and
// auto-merge when the pipeline succeeds is never requested. The merge PUT is
// never resent. An answer that is not a plain "merged at the expected head" is
// read back, and the link is used up only when that read confirms it.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.mjs';

const FULL_WARN_INTERVAL_MS = 10 * 60 * 1000;
const log = createLogger('approve');

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ID_PATTERN = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 4096;
const DEFAULT_LINK_TTL_S = 24 * 60 * 60;
const MIN_LINK_TTL_S = 60;
const MAX_LINK_TTL_S = 7 * 24 * 60 * 60;
const SESSION_TTL_MS = 15 * 60 * 1000;
const CSRF_TTL_MS = 10 * 60 * 1000;
const MAX_RECORDS = 500;
const MAX_SESSIONS = 2000;
const MAX_BOOTSTRAP_FAILURES_PER_MINUTE = 60;
const MAX_SESSIONS_PER_LINK = 3;
const MAX_BOOTSTRAPS_PER_LINK_PER_MINUTE = 10;
const READ_CACHE_MS = 5000;
const REVALIDATE_MS = 30_000;
const APPROVED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 15_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const COOKIE_NAME = 'tl_approve';
const ACTIONS = ['approve', 'reopen', 'merge'];
const MERGE_POLL_MS = 2000;
const MERGE_POLL_ATTEMPTS = 8;

// Page copy per kind of link. `generic` is the entry page, which does not know
// the action yet (the token that says so is still in the fragment).
const COPY = {
  approve: {
    title: 'Approve merge request',
    blocked: 'Cannot approve',
    kicker: 'GitLab approval',
    footer: 'approvals are sent through the configured account.',
    question: 'Approve this merge request?',
    button: 'Approve merge request',
  },
  reopen: {
    title: 'Reopen merge request',
    blocked: 'Cannot reopen',
    kicker: 'GitLab merge request',
    footer: 'the reopen is sent through the configured account.',
    question: 'Reopen this merge request?',
    button: 'Reopen merge request',
  },
  merge: {
    title: 'Merge merge request',
    blocked: 'Cannot merge',
    kicker: 'GitLab merge',
    footer: 'the merge is sent through the configured account.',
    question: 'Merge this merge request?',
    button: 'Merge merge request',
  },
  generic: { kicker: 'GitLab', footer: 'actions are sent through the configured account.' },
};

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest();
const sha256Hex = (value) => sha256(value).toString('hex');

/** Constant-time string comparison (digests, so the length does not leak). */
function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

// Page styling: GitLab-inspired (calm neutral surfaces, rounded panels, tinted
// state pills) but its own thing, branded teams-live. The state colors match the
// badges on the Teams card.
const PAGE_CSS = [
  ':root{color-scheme:light dark;--bg:#f4f5f8;--panel:#fff;--text:#1f2430;--muted:#5d6475;--line:#dcdfe6;--accent:#3b4fd8;--code:#eef0f6;',
  '--ok:#1f7a4a;--ok-bg:#e3f4ea;--merged:#6b46c1;--merged-bg:#ece6f9;--closed:#b3261e;--closed-bg:#fbe6e3;--draft:#555a66;--draft-bg:#e9eaee;--warn:#8a5a00;--warn-bg:#fdf1d8;--btn:#1f7a4a;--btn-h:#18643b}',
  '@media (prefers-color-scheme:dark){:root{--bg:#14161c;--panel:#1d2029;--text:#e7e9ef;--muted:#a3a9b8;--line:#343845;--accent:#8c9bff;--code:#2a2e3a;',
  '--ok:#6fd49b;--ok-bg:#16352a;--merged:#b9a0f5;--merged-bg:#2c2347;--closed:#ff9b92;--closed-bg:#40201e;--draft:#b8bdc9;--draft-bg:#2b2f3a;--warn:#f0c46b;--warn-bg:#3a2e12}}',
  '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
  '.shell{max-width:36rem;margin:0 auto;padding:2rem 1rem 3rem}',
  '.brand{display:flex;align-items:center;gap:.5rem;margin:0 0 1rem;color:var(--muted);font-size:.9rem}.brand svg{flex:none}.brand .word{color:var(--text);font-weight:650;letter-spacing:.01em}',
  '.panel{background:var(--panel);border:1px solid var(--line);border-left-width:4px;border-radius:10px;padding:1.25rem 1.5rem 1.5rem;box-shadow:0 1px 2px rgba(0,0,0,.06)}',
  '.tone-ok{border-left-color:var(--ok)}.tone-warn{border-left-color:#d99a00}.tone-error{border-left-color:var(--closed)}.tone-neutral{border-left-color:var(--accent)}',
  'h1{font-size:1.35rem;line-height:1.3;margin:0 0 1rem}p{margin:.6rem 0}',
  'code{background:var(--code);padding:.05rem .35rem;border-radius:4px;font:.88em ui-monospace,SFMono-Regular,Menlo,monospace}',
  '.note{color:var(--muted);font-size:.9rem}',
  '.mr{border:1px solid var(--line);border-radius:8px;padding:.75rem 1rem;margin:0 0 1rem;background:var(--bg)}',
  '.mr-head{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin:0 0 .35rem}.mr-head .ref{color:var(--muted);font:.85rem ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}',
  '.mr p{margin:.2rem 0}',
  '.pill{display:inline-flex;align-items:center;gap:.35rem;border-radius:999px;padding:.1rem .6rem;font-size:.8rem;font-weight:600;line-height:1.5;border:1px solid currentColor}',
  '.pill i{width:.55rem;height:.55rem;border-radius:50%;background:currentColor;display:inline-block}',
  '.pill-open{color:var(--ok);background:var(--ok-bg)}.pill-merged{color:var(--merged);background:var(--merged-bg)}.pill-closed{color:var(--closed);background:var(--closed-bg)}.pill-draft{color:var(--draft);background:var(--draft-bg)}',
  '.callout{border-radius:8px;padding:.6rem .85rem;margin:.9rem 0;background:var(--warn-bg);color:var(--text);border:1px solid var(--line);font-size:.9rem}',
  '.btn{font:inherit;font-weight:600;color:#fff;background:var(--btn);border:0;border-radius:8px;padding:.6rem 1.25rem;cursor:pointer}.btn:hover{background:var(--btn-h)}',
  '.btn:focus-visible{outline:3px solid var(--accent);outline-offset:2px}',
  '.foot{margin-top:1rem;color:var(--muted);font-size:.8rem}',
  '@media (max-width:30rem){.panel{padding:1rem}.btn{width:100%}}',
].join('');

const BRAND_MARK =
  '<svg width="22" height="22" viewBox="0 0 22 22" role="img" aria-label="teams-live" focusable="false"><rect width="22" height="22" rx="6" fill="#3b4fd8"/><circle cx="7" cy="6.5" r="2" fill="#fff"/><circle cx="7" cy="15.5" r="2" fill="#fff"/><circle cx="15" cy="9" r="2" fill="#fff"/><path d="M7 8.5v5M15 11c0 2.2-2 3-5.5 3.6" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>';

/** Pill for the live state of a merge request. Draft wins over open, like the card. */
function stateBadge(mr) {
  if (!mr?.state) return '';
  const draft = Boolean(mr.draft || mr.work_in_progress || mr.detailed_merge_status === 'draft_status');
  const [cls, label] =
    mr.state === 'merged' ? ['merged', 'Merged'] : mr.state === 'closed' ? ['closed', 'Closed'] : mr.state === 'opened' ? (draft ? ['draft', 'Draft'] : ['open', 'Open']) : ['draft', escapeHtml(mr.state)];
  return `<span class="pill pill-${cls}"><i aria-hidden="true"></i>${label}</span>`;
}

const toneForCode = (code) => (code >= 500 ? 'error' : code >= 400 ? 'warn' : 'ok');

const keyOf = (project, iid) => `${String(project).toLowerCase()}!${iid}`;

/**
 * Server-side link records, kept in a small bounded state file. A record binds
 * the SHA-256 of a capability token to one project, merge request and head
 * commit. The token itself is never stored.
 */
export class ApprovalStore {
  constructor({ file = null, ttlMs = DEFAULT_LINK_TTL_S * 1000, max = MAX_RECORDS, now = Date.now, logger = log } = {}) {
    this.file = file;
    this.logger = logger;
    this.fullWarnedAt = -Infinity;
    this.refusedMints = 0;
    this.ttlMs = ttlMs;
    this.max = max;
    this.now = now;
    this.records = new Map();
    // Raw tokens of links minted by this process, so a card refresh shows the
    // same link again. Memory only; a restart simply mints a new link.
    this.minted = new Map();
    // `<mr>@<sha>` -> time: the configured account approved this head commit.
    // No new link is minted for it, however long the merge request waits for
    // other approvers.
    this.approvedHeads = new Map();
  }

  /** Validates one persisted record and keeps it; `action` forces the kind (the key it was stored under). */
  adopt(r, action) {
    if (
      typeof r?.id === 'string' &&
      ID_PATTERN.test(r.id) &&
      typeof r.project === 'string' &&
      r.iid !== undefined &&
      typeof r.sha === 'string' &&
      Number.isFinite(r.createdAt) &&
      Number.isFinite(r.expiresAt) &&
      ['open', 'approved', 'used', 'stale'].includes(r.status)
    ) {
      this.records.set(r.id, {
        id: r.id,
        project: r.project,
        iid: String(r.iid),
        sha: r.sha,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        status: r.status,
        action: action || (ACTIONS.includes(r.action) ? r.action : 'approve'),
      });
    }
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const r of Array.isArray(data?.records) ? data.records : []) this.adopt(r, null);
      // Merge links live under their own key: a build that predates the Merge
      // action does not read it, so a rollback cannot turn one into an approval.
      for (const r of Array.isArray(data?.mergeRecords) ? data.mergeRecords : []) this.adopt(r, 'merge');
      for (const a of Array.isArray(data?.approvedHeads) ? data.approvedHeads : []) {
        if (typeof a?.key === 'string' && Number.isFinite(a.at)) this.approvedHeads.set(a.key, a.at);
      }
    } catch (err) {
      log(`Could not read ${this.file}: ${err.message}`);
    }
    this.prune();
  }

  /**
   * Drops expired records, then (only when over the cap) used-up and superseded
   * ones, oldest first (`room` slots are kept free). A still-valid open link is never evicted: a full store
   * refuses to mint instead. Returns whether anything changed.
   */
  prune(room = 0) {
    const now = this.now();
    let changed = false;
    for (const [id, r] of this.records) {
      if (r.expiresAt <= now) {
        this.records.delete(id);
        changed = true;
      }
    }
    if (this.records.size + room > this.max) {
      const spent = [...this.records.values()].filter((r) => r.status !== 'open').sort((a, b) => a.createdAt - b.createdAt);
      for (const r of spent.slice(0, this.records.size + room - this.max)) {
        this.records.delete(r.id);
        changed = true;
      }
    }
    for (const [k, at] of this.approvedHeads) {
      if (now - at > APPROVED_KEEP_MS) {
        this.approvedHeads.delete(k);
        changed = true;
      }
    }
    if (this.approvedHeads.size > this.max) {
      const oldest = [...this.approvedHeads.entries()].sort((a, b) => a[1] - b[1]);
      for (const [k] of oldest.slice(0, this.approvedHeads.size - this.max)) this.approvedHeads.delete(k);
      changed = true;
    }
    for (const [k, m] of this.minted) {
      if (!this.records.has(m.id)) this.minted.delete(k);
    }
    return changed;
  }

  persist() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      const all = [...this.records.values()];
      // Merge records are kept apart from `records`: older builds read only that
      // key and would otherwise load a merge link as an approval link.
      const state = {
        version: 5,
        records: all.filter((r) => r.action !== 'merge'),
        mergeRecords: all.filter((r) => r.action === 'merge'),
        approvedHeads: [...this.approvedHeads].map(([key, at]) => ({ key, at })),
      };
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log(`Could not write ${this.file}: ${err.message}`);
    }
  }

  /**
   * A link for a merge request head commit: `{token, record}`. A still-open
   * link minted by this process is reused; otherwise a new random token is
   * issued. Open links of other head commits of the merge request become stale.
   */
  linkFor({ project, iid, sha, action = 'approve' }) {
    const reopen = action === 'reopen';
    if (!ACTIONS.includes(action)) return null;
    // An approval and a merge are pinned to a head commit; a reopen link has none to pin.
    if (!project || iid === undefined || iid === null || (!sha && !reopen)) return null;
    let changed = this.prune();
    const key = keyOf(project, iid);
    const cacheKey = reopen ? `${key}#reopen` : action === 'merge' ? `${key}#merge@${sha}` : `${key}@${sha}`;
    if (action === 'approve' && this.approvedHeads.has(cacheKey)) {
      if (changed) this.persist();
      return null;
    }
    for (const r of this.records.values()) {
      if (!reopen && r.action === action && keyOf(r.project, r.iid) === key && r.sha !== sha && r.status === 'open') {
        r.status = 'stale';
        changed = true;
      }
    }
    const cached = this.minted.get(cacheKey);
    const live = cached ? this.records.get(cached.id) : null;
    if (cached && live && live.status === 'open' && live.expiresAt > this.now()) {
      if (changed) this.persist();
      return { token: cached.token, record: live };
    }
    if (this.prune(1)) changed = true;
    if (this.records.size >= this.max) {
      // Never revoke a link that is still advertised on a card.
      // Every card render would repeat this, so it is logged once per interval.
      this.refusedMints++;
      const t = this.now();
      if (t - this.fullWarnedAt >= FULL_WARN_INTERVAL_MS) {
        this.logger(`Approval link store is full (${this.max} open links); no new links are created (${this.refusedMints} refused so far)`);
        this.fullWarnedAt = t;
      }
      if (changed) this.persist();
      return null;
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const now = this.now();
    const record = {
      id: sha256Hex(token),
      project: String(project),
      iid: String(iid),
      sha: sha ? String(sha) : '-',
      createdAt: now,
      expiresAt: now + this.ttlMs,
      status: 'open',
      action,
    };
    this.records.set(record.id, record);
    this.minted.set(cacheKey, { token, id: record.id });
    this.persist();
    return { token, record };
  }

  /** The record for a token, or null when it is unknown or expired. */
  byToken(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    return this.byId(sha256Hex(token));
  }

  byId(id) {
    const r = typeof id === 'string' ? this.records.get(id) : null;
    if (!r || r.expiresAt <= this.now()) return null;
    return r;
  }

  setStatus(id, status) {
    const r = this.records.get(id);
    if (!r) return;
    r.status = status;
    this.persist();
  }

  hasApprovedHead(project, iid, sha) {
    return this.approvedHeads.has(`${keyOf(project, iid)}@${sha}`);
  }

  /** The account's approval of this head is gone (revoked): links may be minted again. */
  forgetApproved(project, iid, sha) {
    if (!this.approvedHeads.delete(`${keyOf(project, iid)}@${sha}`)) return false;
    this.persist();
    return true;
  }

  /** A confirmed approval uses up every link of the merge request. */
  markApproved(project, iid, sha) {
    const key = keyOf(project, iid);
    this.approvedHeads.set(`${key}@${sha}`, this.now());
    for (const r of this.records.values()) {
      if (r.action !== 'approve' || keyOf(r.project, r.iid) !== key || r.status === 'stale') continue;
      r.status = r.sha === sha ? 'approved' : 'stale';
    }
    this.persist();
  }

  /** A confirmed reopen uses up every reopen link of the merge request. */
  markReopened(project, iid) {
    const key = keyOf(project, iid);
    for (const r of this.records.values()) {
      if (r.action === 'reopen' && keyOf(r.project, r.iid) === key && r.status === 'open') r.status = 'used';
    }
    this.persist();
  }

  /** A confirmed merge uses up every merge link of the merge request. */
  markMerged(project, iid) {
    const key = keyOf(project, iid);
    for (const r of this.records.values()) {
      if (r.action === 'merge' && keyOf(r.project, r.iid) === key && r.status === 'open') r.status = 'used';
    }
    this.persist();
  }

  /**
   * Closed, merged or changed merge request: no approval link of it works any
   * more (`action` 'reopen': the reopen links, for a merge request that is merged
   * or open again; 'merge': the merge links, for one that changed or is gone).
   */
  invalidate(project, iid, action = 'approve') {
    const key = keyOf(project, iid);
    for (const r of this.records.values()) {
      if (r.action === action && keyOf(r.project, r.iid) === key && r.status === 'open') r.status = 'stale';
    }
    this.persist();
  }
}

/**
 * CSRF tokens: HMAC over the session, the link record, an optional `bind`
 * string (the acting identity the page showed) and an expiry with a random
 * per-process key. A restart invalidates open pages (reload the page).
 */
export class CsrfTokens {
  constructor({ key = crypto.randomBytes(32), ttlMs = CSRF_TTL_MS, now = Date.now } = {}) {
    this.key = key;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  mac(session, id, exp, bind = '') {
    // The bind string goes last and is length-prefixed, so it cannot be shifted into another field.
    return crypto.createHmac('sha256', this.key).update(`csrf\n${session}\n${id}\n${exp}\n${String(bind).length}:${bind}`).digest('base64url');
  }

  issue(session, id, bind = '') {
    const exp = this.now() + this.ttlMs;
    return `${exp}.${this.mac(session, id, exp, bind)}`;
  }

  verify(token, session, id, bind = '') {
    if (typeof token !== 'string') return false;
    const [expRaw, mac, ...rest] = token.split('.');
    if (rest.length > 0 || !/^\d{1,16}$/.test(expRaw || '') || !mac) return false;
    const exp = Number(expRaw);
    if (exp <= this.now()) return false;
    return safeEqual(mac, this.mac(session, id, exp, bind));
  }
}

/**
 * The acting identity a confirmation page shows: the GitLab account id and the
 * credential index behind it. Null when the account cannot be told, in which
 * case nothing may be offered or sent.
 */
function actorOf(result) {
  const id = result?.user?.id;
  if (id === undefined || id === null || id === '') return null;
  const cred = result.tokenIndex === undefined || result.tokenIndex === null ? '' : String(result.tokenIndex);
  return { user: String(id), cred };
}

const actorBind = (actor) => `user=${actor.user};cred=${actor.cred}`;

const UNVERIFIED_ACCOUNT = 'The GitLab account that would act could not be verified. Nothing was sent. Reload the page to try again.';

const kindOf = (record) => (ACTIONS.includes(record?.action) ? record.action : 'approve');

// GitLab's `detailed_merge_status` values that say "not mergeable right now".
const MERGE_BLOCKS = {
  not_approved: 'The merge request still needs approvals.',
  ci_must_pass: 'The pipeline has to pass before this can be merged.',
  ci_still_running: 'The pipeline is still running.',
  discussions_not_resolved: 'Discussions are not resolved yet.',
  need_rebase: 'The source branch needs a rebase first.',
  conflict: 'The merge request has merge conflicts.',
  requested_changes: 'Changes were requested on this merge request.',
  blocked_status: 'Another merge request blocks this one.',
  merge_request_blocked: 'Another merge request blocks this one.',
  external_status_checks: 'External status checks have not passed.',
  jira_association_missing: 'The merge request needs an associated Jira issue.',
  locked_paths: 'Locked paths prevent the merge.',
  locked_lfs_files: 'Locked LFS files prevent the merge.',
  security_policy_violations: 'A security policy blocks the merge.',
  title_regex: 'The title does not match the required pattern.',
  checking: 'GitLab is still checking whether this can be merged. Reload the page in a moment.',
  unchecked: 'GitLab has not checked yet whether this can be merged. Reload the page in a moment.',
  preparing: 'GitLab is still preparing the merge request. Reload the page in a moment.',
  approvals_syncing: 'GitLab is still syncing the approvals. Reload the page in a moment.',
  draft_status: 'This merge request is a draft and cannot be merged.',
  not_open: 'This merge request is not open.',
};

/**
 * Why GitLab says this merge request cannot be merged right now, or null when it
 * is mergeable or GitLab does not say (older versions: the PUT then decides).
 */
export function mergeBlockReason(mr) {
  const status = typeof mr?.detailed_merge_status === 'string' ? mr.detailed_merge_status : '';
  if (status) {
    if (status === 'mergeable') return null;
    return MERGE_BLOCKS[status] || `GitLab reports this merge request as not mergeable (status: ${status}).`;
  }
  if (mr?.has_conflicts === true) return MERGE_BLOCKS.conflict;
  if (mr?.merge_status === 'cannot_be_merged') return 'GitLab reports this merge request as not mergeable.';
  return null;
}

/** HTTP status of a GitLabClient error message, or null for network failures. */
function gitlabStatus(err) {
  const m = /GitLab error \((\d{3})\)/.exec(err?.message || '');
  return m ? Number(m[1]) : null;
}

function originOf(value) {
  try {
    const u = new URL(value);
    return u.origin === 'null' ? null : u.origin;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name && !(name in out)) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

/** Link lifetime in seconds: the default for anything invalid, else clamped. */
export function normalizeLinkTtlSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LINK_TTL_S;
  return Math.min(MAX_LINK_TTL_S, Math.max(MIN_LINK_TTL_S, Math.floor(n)));
}

export class ApproveServer {
  /**
   * @param {object} opts
   * @param {object} opts.gitlab GitLabClient (getMr, approveMr, getUserApprovalState)
   * @param {string} opts.baseUrl public URL of the flow, e.g. https://host/approve
   * @param {(project, iid) => Promise<{matched:number,failed:number}>} [opts.refreshCards]
   * @param {string} [opts.stateFile] persisted link records (token hashes only)
   */
  constructor({
    gitlab,
    baseUrl,
    host = '127.0.0.1',
    port = 3006,
    linkTtlSeconds = DEFAULT_LINK_TTL_S,
    stateFile = null,
    refreshCards = null,
    now = Date.now,
    mergeEnabled = false,
    mergePollMs = MERGE_POLL_MS,
    mergePollAttempts = MERGE_POLL_ATTEMPTS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    if (!gitlab) throw new Error('approve: a GitLab client is required');
    let base;
    try {
      base = new URL(baseUrl);
    } catch {
      throw new Error('approve: base_url is missing or not a valid URL');
    }
    const localBase = LOOPBACK_HOSTS.has(base.hostname.replace(/^\[|\]$/g, ''));
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && localBase)) {
      throw new Error('approve: base_url must be an https URL (the link is a bearer credential)');
    }
    if (base.hash || base.search) throw new Error('approve: base_url must not contain a query or fragment');
    if (!LOOPBACK_HOSTS.has(host)) throw new Error(`approve: host must be a loopback address, got ${host}`);

    this.gitlab = gitlab;
    this.host = host;
    this.port = Number(port);
    this.origin = base.origin;
    this.secure = base.protocol === 'https:';
    this.basePath = base.pathname.replace(/\/+$/, '');
    this.refreshCards = refreshCards;
    this.now = now;
    // Off unless asked for: merging from a card is a deliberate, separate opt-in.
    this.mergeEnabled = mergeEnabled === true;
    this.mergePollMs = mergePollMs;
    this.mergePollAttempts = Math.max(1, Number(mergePollAttempts) || 1);
    this.sleep = sleep;
    this.store = new ApprovalStore({ file: stateFile, ttlMs: normalizeLinkTtlSeconds(linkTtlSeconds) * 1000, now });
    this.store.load();
    this.csrf = new CsrfTokens({ now });
    this.sessions = new Map();
    this.failures = { windowStart: 0, count: 0 };
    this.locks = new Map();
    this.bootstraps = new Map();
    this.readCache = new Map();
    this.revalidations = new Map();
    this.server = null;
    this.script = this.bootstrapScript();
    this.scriptHash = `sha256-${crypto.createHash('sha256').update(this.script).digest('base64')}`;
  }

  /**
   * URL of the confirmation entry page, or null: for an approval of a merge
   * request head commit, (`action: 'merge'`) for merging it, or
   * (`action: 'reopen'`) for reopening a closed one.
   */
  linkFor({ project, iid, sha, action = 'approve' }) {
    // No merge link is minted (so no button is shown) while merging is switched off.
    if (action === 'merge' && !this.mergeEnabled) return null;
    try {
      if (action === 'approve' && this.store.hasApprovedHead(project, iid, sha)) this.revalidateApproved(project, iid, sha);
      const link = this.store.linkFor({ project, iid, sha, action });
      return link ? `${this.origin}${this.basePath}/#${link.token}` : null;
    } catch (err) {
      log(`Could not create an approval link: ${err.message}`);
      return null;
    }
  }

  /**
   * The remembered "the account approved this head" is only a hint: the approval
   * can be revoked in GitLab. Re-check it (at most once per interval and head);
   * when it is gone, forget the hint and refresh the cards so the button returns.
   * An unknown answer keeps the hint.
   */
  revalidateApproved(project, iid, sha) {
    const key = `${project}!${iid}@${sha}`;
    const now = this.now();
    const last = this.revalidations.get(key);
    if (last !== undefined && now - last < REVALIDATE_MS) return;
    for (const [k, at] of this.revalidations) {
      if (now - at >= REVALIDATE_MS) this.revalidations.delete(k);
    }
    this.revalidations.set(key, now);
    Promise.resolve()
      .then(() => this.gitlab.getUserApprovalState(project, iid))
      .then(async (state) => {
        if (!state?.known || state.hasApproved) return;
        if (!this.store.forgetApproved(project, iid, sha)) return;
        this.revalidations.delete(key);
        log(`Approval of ${project}!${iid} was revoked; links are offered again`);
        if (this.refreshCards) await this.refreshCards(project, iid);
      })
      .catch((err) => log(`Approval re-check failed for ${project}!${iid}: ${err.message}`));
  }

  start() {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          log(`Unhandled error: ${err.message}`);
          if (!res.headersSent) this.send(res, 500, this.page('Error', '<p>Something went wrong. Nothing was approved.</p>', { tone: 'error' }));
          else res.end();
        });
      });
      srv.once('error', reject);
      srv.listen(this.port, this.host, () => {
        this.server = srv;
        this.port = srv.address().port;
        log(`Approval flow listening on http://${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    if (!this.server) return Promise.resolve();
    return new Promise((resolve) => {
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  // --- HTTP helpers ---

  headers(extra = {}, { script = false } = {}) {
    // Referrer-Policy same-origin (not no-referrer): with no-referrer browsers
    // send `Origin: null` on the confirmation form, which the Origin check must
    // reject. Nothing secret is in any URL the page is served from.
    return {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; ${script ? `script-src '${this.scriptHash}'; connect-src 'self'; ` : ''}form-action ${this.origin}; frame-ancestors 'none'; base-uri 'none'`,
      ...extra,
    };
  }

  send(res, status, html, { head = false, extra = {}, script = false } = {}) {
    const body = head ? '' : html;
    res.writeHead(status, this.headers({ 'Content-Length': Buffer.byteLength(html), ...extra }, { script }));
    res.end(body);
  }

  /**
   * One HTML shell for every page. Self-contained on purpose: inline CSS and an
   * inline SVG only (the CSP allows nothing else), no external fonts or images.
   * `tone` colors the panel edge: neutral, ok, warn or error.
   */
  page(title, body, { script = '', tone = 'neutral', kind = 'approve' } = {}) {
    const safeTone = ['neutral', 'ok', 'warn', 'error'].includes(tone) ? tone : 'neutral';
    const copy = COPY[kind] || COPY.approve;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><meta name="referrer" content="same-origin"><title>${escapeHtml(title)} · teams-live</title><style>${PAGE_CSS}</style></head><body><div class="shell"><header class="brand">${BRAND_MARK}<span class="word">teams-live</span><span class="sep" aria-hidden="true">·</span><span class="kicker">${copy.kicker}</span></header><main class="panel tone-${safeTone}"><h1>${escapeHtml(title)}</h1>${body}${script}</main><footer class="foot">Served by your teams-live instance. Nothing here is GitLab itself; ${copy.footer}</footer></div></body></html>`;
  }

  /** The static script that exchanges the fragment token for a session. */
  bootstrapScript() {
    const base = JSON.stringify(`${this.basePath}`);
    return `(function(){var B=${base},m=document.getElementById('msg');function say(t){m.textContent=t}var h=location.hash.replace(/^#/,'');try{history.replaceState(null,'',location.pathname+location.search)}catch(e){}if(!/^[A-Za-z0-9_-]{43}$/.test(h)){say('This link is incomplete. Use the button on the Teams card.');return}fetch(B+'/session',{method:'POST',credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'token='+h}).then(function(r){if(r.ok){location.replace(B+'/confirm');return}if(r.status===410){say('This link was already used or the merge request changed. Use the button on the current Teams card.')}else if(r.status===429){say('Too many attempts. Try again in a minute.')}else if(r.status===404){say('This link is unknown or has expired. Use the button on the current Teams card.')}else{say('The link could not be opened. Nothing was changed.')}}).catch(function(){say('The link could not be opened. Nothing was changed.')})})();`;
  }

  /** Route below the base path ("/", "/session", "/confirm") or null. */
  route(req) {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return null;
    }
    if (this.basePath && (pathname === this.basePath || pathname.startsWith(`${this.basePath}/`))) {
      pathname = pathname.slice(this.basePath.length) || '/';
    }
    return ['/', '/session', '/confirm'].includes(pathname) ? pathname : null;
  }

  readForm(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(Object.assign(new Error('too large'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
      req.on('error', reject);
    });
  }

  /** The configured origin must match the request's Origin (or Referer). Fails closed. */
  originAllowed(req) {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin) return origin === this.origin;
    const referer = req.headers.referer;
    if (typeof referer === 'string' && referer) return originOf(referer) === this.origin;
    return false;
  }

  /** Checks POST content type and reads the urlencoded form. Returns `{form}` or `{status}`. */
  async postForm(req) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/x-www-form-urlencoded') return { status: 415 };
    try {
      return { form: await this.readForm(req) };
    } catch (err) {
      return { status: err.status || 400 };
    }
  }

  // --- sessions ---

  openSession(record) {
    const now = this.now();
    for (const [h, s] of this.sessions) {
      if (s.expiresAt <= now) this.sessions.delete(h);
    }
    // A link holds only a few sessions at a time: opening more replaces its own
    // oldest ones, so one holder cannot push out the sessions of other links.
    const own = [...this.sessions.entries()].filter(([, s]) => s.recordId === record.id);
    for (const [h] of own.slice(0, Math.max(0, own.length - (MAX_SESSIONS_PER_LINK - 1)))) this.sessions.delete(h);
    while (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value);
    const sid = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Math.min(now + SESSION_TTL_MS, record.expiresAt);
    this.sessions.set(sha256Hex(sid), { recordId: record.id, expiresAt });
    return { sid, maxAge: Math.max(1, Math.floor((expiresAt - now) / 1000)) };
  }

  /** At most a handful of successful bootstraps per link and minute. */
  allowBootstrap(record) {
    const now = this.now();
    for (const [id, w] of this.bootstraps) {
      if (now - w.start > 60_000 || !this.store.records.has(id)) this.bootstraps.delete(id);
    }
    const w = this.bootstraps.get(record.id) || { start: now, count: 0 };
    w.count++;
    this.bootstraps.set(record.id, w);
    return w.count <= MAX_BOOTSTRAPS_PER_LINK_PER_MINUTE;
  }

  /** The session of a request: `{sid, record}` or null. The record may be used up. */
  sessionOf(req) {
    const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (typeof sid !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sid)) return null;
    const s = this.sessions.get(sha256Hex(sid));
    if (!s || s.expiresAt <= this.now()) return null;
    const record = this.store.byId(s.recordId);
    return record ? { sid, record } : null;
  }

  cookie(value, maxAge) {
    return `${COOKIE_NAME}=${value}; Path=${this.basePath || '/'}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${this.secure ? '; Secure' : ''}`;
  }

  noteFailure() {
    const now = this.now();
    if (now - this.failures.windowStart > 60_000) this.failures = { windowStart: now, count: 0 };
    this.failures.count++;
  }

  throttled() {
    const now = this.now();
    return now - this.failures.windowStart <= 60_000 && this.failures.count >= MAX_BOOTSTRAP_FAILURES_PER_MINUTE;
  }

  // --- request handling ---

  async handle(req, res) {
    const method = req.method;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      this.send(res, 405, this.page('Not allowed', '<p>Method not allowed.</p>', { tone: 'warn' }), { extra: { Allow: 'GET, HEAD, POST' } });
      return;
    }
    const route = this.route(req);
    if (!route) {
      this.send(res, 404, this.page('Not found', '<p>Nothing here.</p>', { tone: 'warn' }), { head: method === 'HEAD' });
      return;
    }
    const head = method === 'HEAD';
    if (route === '/') {
      if (method === 'POST') return this.send(res, 405, this.page('Not allowed', '<p>Method not allowed.</p>', { tone: 'warn' }), { extra: { Allow: 'GET, HEAD' } });
      const body = this.page(
        'Opening link',
        '<p id="msg">Opening the link…</p><noscript><p>JavaScript is required to open this link.</p></noscript>',
        { script: `<script>${this.script}</script>`, kind: 'generic' },
      );
      return this.send(res, 200, body, { head, script: true });
    }
    if (route === '/session') {
      if (method !== 'POST') return this.send(res, 405, this.page('Not allowed', '<p>Method not allowed.</p>', { tone: 'warn' }), { extra: { Allow: 'POST' } });
      return this.bootstrap(req, res);
    }
    // /confirm
    if (method === 'HEAD') return this.send(res, 200, '', { head: true });
    const session = this.sessionOf(req);
    if (!session) {
      return this.send(res, 401, this.page('Link not opened', '<p>Open the link from the Teams card again. Nothing was changed.</p>', { tone: 'warn' }));
    }
    if (method === 'GET') return this.showConfirmation(res, session);
    return this.approve(req, res, session);
  }

  /** Exchanges the fragment token for a session cookie. Never approves or consumes anything. */
  async bootstrap(req, res) {
    const reply = (status, text, extra = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
      res.end(text);
    };
    if (!this.originAllowed(req)) return reply(403, 'forbidden');
    const parsed = await this.postForm(req);
    if (!parsed.form) return reply(parsed.status, 'rejected');
    // Look the token up first: the counter of unknown tokens only slows down
    // guessing and must never lock out a valid link.
    const record = this.store.byToken(parsed.form.get('token'));
    if (!record) {
      if (this.throttled()) return reply(429, 'too many attempts', { 'Retry-After': '60' });
      this.noteFailure();
      return reply(404, 'unknown or expired');
    }
    if (record.status !== 'open') return reply(410, 'used or superseded');
    if (!this.allowBootstrap(record)) return reply(429, 'too many attempts', { 'Retry-After': '60' });
    const { sid, maxAge } = this.openSession(record);
    return reply(200, 'ok', { 'Set-Cookie': this.cookie(sid, maxAge) });
  }

  /**
   * Reads the live merge request and decides what the page may offer:
   * `ready`, `already` (the configured account approved) or `blocked`.
   */
  async evaluate(record) {
    if (record.action === 'reopen') return this.evaluateReopen(record);
    if (record.action === 'merge') {
      // A link minted while merging was on stops working when it is switched off.
      if (!this.mergeEnabled) return { status: 'blocked', reason: 'Merging from cards is turned off. Nothing was merged.' };
      return this.evaluateMerge(record);
    }
    if (record.status === 'approved') return { status: 'used' };
    if (record.status === 'stale') return { status: 'blocked', reason: 'This link was superseded because the merge request changed. Use the button on the current Teams card.' };
    let mr;
    let tokenIndex;
    try {
      ({ mr, tokenIndex } = await this.readMr(record));
    } catch {
      return { status: 'blocked', reason: 'GitLab could not be reached to read the merge request. Nothing was approved. Try again later.' };
    }
    if (mr?.state !== 'opened') {
      this.store.invalidate(record.project, record.iid);
      return { status: 'blocked', mr, tokenIndex, reason: `This merge request is ${mr?.state === 'merged' ? 'merged' : 'no longer open'}. Nothing to approve.` };
    }
    const draft = Boolean(mr.draft || mr.work_in_progress || mr.detailed_merge_status === 'draft_status');
    if (draft) return { status: 'blocked', mr, reason: 'This merge request is a draft and cannot be approved.' };
    const head = mr.sha || mr.diff_refs?.head_sha || null;
    if (!head) return { status: 'blocked', mr, reason: 'The head commit of the merge request is unknown. Nothing was approved.' };
    if (head !== record.sha) {
      this.store.invalidate(record.project, record.iid);
      return { status: 'blocked', mr, reason: 'The merge request changed after this card was posted (new commits). Review it again and use the button on the updated card.' };
    }
    // Identity and approvals come from the credential that can see the merge
    // request, and the approval is sent under that same one.
    const state = await this.gitlab.getUserApprovalState(record.project, record.iid, this.asToken(tokenIndex));
    if (tokenIndex !== undefined && state.tokenIndex !== undefined && state.tokenIndex !== tokenIndex) {
      return { status: 'blocked', mr, reason: 'The GitLab account could not be verified consistently. Nothing was approved. Try again later.' };
    }
    if (!state.known) {
      return { status: 'blocked', mr, reason: 'The configured GitLab account or the current approvals could not be verified. Nothing was approved. Try again later.' };
    }
    if (state.hasApproved) return { status: 'already', mr, user: state.user, tokenIndex };
    if (state.canApprove === false) {
      return { status: 'blocked', mr, user: state.user, tokenIndex, reason: 'GitLab does not allow the configured account to approve this merge request (for example as its author).' };
    }
    return { status: 'ready', mr, user: state.user, tokenIndex };
  }

  /**
   * Reads the merge request and, with the real client, WHO acts: the first
   * credential that can see it (`tokenIndex`). Stand-ins without `locateMr` read
   * it the plain way and leave the credential undecided.
   */
  async readMr(record) {
    if (typeof this.gitlab.locateMr === 'function') {
      const found = await this.gitlab.locateMr(record.project, record.iid);
      return { mr: found.mr, tokenIndex: found.tokenIndex, user: found.user };
    }
    return { mr: await this.gitlab.getMr(record.project, record.iid), tokenIndex: undefined, user: null };
  }

  /** Option object that pins a read to the credential chosen by the preflight (empty when none was). */
  asToken(tokenIndex) {
    return tokenIndex === undefined ? undefined : { tokenIndex };
  }

  /**
   * Options for a write: the credential the preflight chose, and the account
   * that was shown, which the client re-checks before it sends anything. Empty
   * when the flow runs on a stand-in client.
   */
  asActor(result) {
    if (result?.tokenIndex === undefined) return {};
    return { tokenIndex: result.tokenIndex, ...(result.user?.id ? { expectUserId: result.user.id } : {}) };
  }

  /**
   * Reopen: only a closed merge request that was not merged can be reopened.
   * `ready`, `already` (it is open again) or `blocked`. The head commit plays
   * no role; the account is not verified beforehand, GitLab decides on the PUT.
   */
  async evaluateReopen(record) {
    if (record.status === 'used') return { status: 'used' };
    if (record.status === 'stale') return { status: 'blocked', reason: 'This link is no longer valid because the merge request changed. Use the button on the current Teams card.' };
    let mr;
    let tokenIndex;
    let located = null;
    try {
      ({ mr, tokenIndex, user: located } = await this.readMr(record));
    } catch {
      return { status: 'blocked', reason: 'GitLab could not be reached to read the merge request. Nothing was reopened. Try again later.' };
    }
    if (mr?.state === 'opened') {
      this.store.invalidate(record.project, record.iid, 'reopen');
      return { status: 'already', mr, tokenIndex };
    }
    if (mr?.state === 'merged') {
      this.store.invalidate(record.project, record.iid, 'reopen');
      return { status: 'blocked', mr, reason: 'This merge request is merged and cannot be reopened.' };
    }
    if (mr?.state !== 'closed') {
      return { status: 'blocked', mr, reason: 'The state of the merge request is unknown. Nothing was reopened.' };
    }
    const user = await this.actingUser(tokenIndex, located);
    return { status: 'ready', mr, user, tokenIndex };
  }

  /**
   * Merge: only an open, non-draft merge request whose head commit is still the
   * one the link was made for, and that GitLab reports as mergeable. `ready`,
   * `already` (merged at that head) or `blocked`. GitLab decides again on the
   * PUT; this read only keeps the page from offering what cannot work. The
   * account is not verified beforehand either.
   */
  async evaluateMerge(record) {
    if (record.status === 'used') return { status: 'used' };
    if (record.status === 'stale') return { status: 'blocked', reason: 'This link was superseded because the merge request changed. Use the button on the current Teams card.' };
    let mr;
    let tokenIndex;
    let located = null;
    try {
      ({ mr, tokenIndex, user: located } = await this.readMr(record));
    } catch {
      return { status: 'blocked', reason: 'GitLab could not be reached to read the merge request. Nothing was merged. Try again later.' };
    }
    const head = mr?.sha || mr?.diff_refs?.head_sha || null;
    if (mr?.state === 'merged') {
      if (head && head === record.sha) return { status: 'already', mr };
      this.store.invalidate(record.project, record.iid, 'merge');
      return { status: 'blocked', mr, reason: 'This merge request is merged, but not at the head commit this link was made for. Nothing was merged by this link.' };
    }
    if (mr?.state === 'locked') {
      return { status: 'blocked', mr, reason: 'GitLab is merging this merge request right now. Reload the page in a moment.' };
    }
    if (mr?.state !== 'opened') {
      this.store.invalidate(record.project, record.iid, 'merge');
      return { status: 'blocked', mr, reason: `This merge request is ${mr?.state === 'closed' ? 'closed' : 'no longer open'}. Nothing to merge.` };
    }
    const draft = Boolean(mr.draft || mr.work_in_progress || mr.detailed_merge_status === 'draft_status');
    if (draft) return { status: 'blocked', mr, reason: 'This merge request is a draft and cannot be merged.' };
    if (!head) return { status: 'blocked', mr, reason: 'The head commit of the merge request is unknown. Nothing was merged.' };
    if (head !== record.sha) {
      this.store.invalidate(record.project, record.iid, 'merge');
      return { status: 'blocked', mr, reason: 'The merge request changed after this card was posted (new commits). Review it again and use the button on the updated card.' };
    }
    const reason = mergeBlockReason(mr);
    if (reason) return { status: 'blocked', mr, reason };
    const user = await this.actingUser(tokenIndex, located);
    return { status: 'ready', mr, user, tokenIndex };
  }

  /** The account behind the credential that will act, or null when it cannot be told (never another credential's). */
  async actingUser(tokenIndex, located) {
    if (located?.id) return located;
    if (typeof this.gitlab.getCurrentUser !== 'function') return null;
    const user = await this.gitlab.getCurrentUser(this.asToken(tokenIndex)).catch(() => null);
    return user?.id ? user : null;
  }

  summary(record, mr, user) {
    const reopen = record.action === 'reopen';
    const lines = [
      `<div class="mr"><div class="mr-head">${stateBadge(mr)}<span class="ref">${escapeHtml(record.project)}!${escapeHtml(record.iid)}</span></div><p><strong>${escapeHtml(mr?.title || `Merge request !${record.iid}`)}</strong></p>`,
      reopen ? '</div>' : `<p class="note">Head commit <code>${escapeHtml(record.sha.slice(0, 12))}</code></p></div>`,
    ];
    if (user) {
      const who = escapeHtml(user.username || user.name || user.id);
      lines.push(
        record.action === 'reopen'
          ? `<p class="callout">The merge request is reopened with the configured GitLab account <code>${who}</code>, not as you personally. Anyone with this link can reopen it.</p>`
          : record.action === 'merge'
            ? `<p class="callout">The merge is made with the configured GitLab account <code>${who}</code>, not as you personally. Anyone with this link can merge. GitLab's own rules (approvals, pipeline, protected branch) still apply and are not bypassed.</p>`
            : `<p class="callout">The approval is made with the configured GitLab account <code>${who}</code>, not as you personally. Anyone with this link can approve.</p>`,
      );
    }
    return lines.join('');
  }

  usedPage(record) {
    const text = { reopen: 'reopen the merge request', merge: 'merge the merge request' }[record.action] || 'approve the merge request';
    return { code: 410, title: 'Link already used', body: `${this.summary(record, null, null)}<p>This link was already used to ${text}. Nothing more was sent.</p>` };
  }

  /** Short-lived, coalesced read for the confirmation page (never used to approve). */
  evaluateCached(record) {
    // The off switch is never served from the cache.
    if (record.action === 'merge' && !this.mergeEnabled) return this.evaluate(record);
    const now = this.now();
    for (const [id, c] of this.readCache) {
      if (now - c.at > READ_CACHE_MS || !this.store.records.has(id)) this.readCache.delete(id);
    }
    const hit = this.readCache.get(record.id);
    if (hit && hit.status === record.status) return hit.promise;
    const promise = this.evaluate(record);
    const entry = { at: now, status: record.status, promise };
    this.readCache.set(record.id, entry);
    promise.catch(() => {
      if (this.readCache.get(record.id) === entry) this.readCache.delete(record.id);
    });
    return promise;
  }

  async showConfirmation(res, { sid, record }) {
    const result = await this.evaluateCached(record);
    if (result.status === 'used') {
      const u = this.usedPage(record);
      return this.send(res, u.code, this.page(u.title, u.body, { tone: toneForCode(u.code) }));
    }
    const kind = kindOf(record);
    const copy = COPY[kind];
    if (result.status === 'blocked') {
      return this.send(res, 409, this.page(copy.blocked, `${this.summary(record, result.mr, result.user)}<p>${escapeHtml(result.reason)}</p>`, { tone: 'warn', kind }));
    }
    if (result.status === 'already') {
      return this.send(res, 200, this.page(...this.alreadyPage(record, result), { tone: 'ok', kind }));
    }
    const actor = actorOf(result);
    if (!actor) {
      return this.send(res, 409, this.page(copy.blocked, `${this.summary(record, result.mr, null)}<p>${escapeHtml(UNVERIFIED_ACCOUNT)}</p>`, { tone: 'warn', kind }));
    }
    // The shown account and credential travel with the form and are bound into the CSRF token.
    const token = this.csrf.issue(sid, record.id, actorBind(actor));
    const form = `<form method="post" action="${escapeHtml(`${this.origin}${this.basePath}/confirm`)}"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><input type="hidden" name="user" value="${escapeHtml(actor.user)}"><input type="hidden" name="cred" value="${escapeHtml(actor.cred)}"><p>${copy.question}</p>${kind === 'merge' ? `<p class="note">Merges exactly the head commit above. Source-branch removal and squash follow the merge request's own settings. This sends one request to GitLab; it is never repeated automatically.</p>` : ''}<button class="btn" type="submit">${copy.button}</button></form>`;
    return this.send(res, 200, this.page(copy.title, `${this.summary(record, result.mr, result.user)}${form}`, { tone: 'neutral', kind }));
  }

  /** `[title, body]` for a merge request that is already in the wanted state. */
  alreadyPage(record, result, sent = false) {
    const summary = this.summary(record, result.mr, result.user);
    if (record.action === 'merge') {
      return ['Already merged', `${summary}<p>This merge request is already merged in GitLab. ${sent ? 'Nothing was sent.' : 'Nothing to do.'}</p>`];
    }
    if (record.action === 'reopen') {
      return ['Already open', `${summary}<p>This merge request is already open in GitLab. ${sent ? 'Nothing was sent.' : 'Nothing to do.'}</p>`];
    }
    return ['Already approved', `${summary}<p>This merge request is already approved by the configured account in GitLab. ${sent ? 'Nothing was sent.' : 'Nothing to do.'}</p>`];
  }

  async withLock(key, fn) {
    const prev = this.locks.get(key) || Promise.resolve();
    let release;
    const next = new Promise((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => next);
    this.locks.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  async approve(req, res, { sid, record }) {
    const kind = kindOf(record);
    const nothing = { reopen: 'Nothing was reopened.', merge: 'Nothing was merged.', approve: 'Nothing was approved.' }[kind];
    if (!this.originAllowed(req)) {
      this.send(res, 403, this.page('Not allowed', `<p>The request did not come from the confirmation page. ${nothing}</p>`, { tone: 'warn', kind }));
      return;
    }
    const parsed = await this.postForm(req);
    if (!parsed.form) {
      const msg = parsed.status === 415 ? 'Unsupported request.' : 'The request was rejected.';
      this.send(res, parsed.status, this.page('Not allowed', `<p>${msg} ${nothing}</p>`, { tone: 'warn', kind }));
      return;
    }
    const shown = { user: parsed.form.get('user') ?? '', cred: parsed.form.get('cred') ?? '' };
    if (!this.csrf.verify(parsed.form.get('csrf'), sid, record.id, actorBind(shown))) {
      this.send(res, 403, this.page('Page expired', `<p>This page expired. Open the link again and confirm. ${nothing}</p>`, { tone: 'warn', kind }));
      return;
    }

    const outcome = await this.withLock(keyOf(record.project, record.iid), async () => {
      this.readCache.delete(record.id);
      const current = this.store.byId(record.id);
      if (!current) return { code: 410, title: 'Link expired', body: `<p>This link expired. ${nothing}</p>` };
      const result = await this.evaluate(current);
      if (result.status === 'used') return this.usedPage(current);
      if (result.status === 'blocked') {
        return { code: 409, title: COPY[kind].blocked, body: `${this.summary(current, result.mr, result.user)}<p>${escapeHtml(result.reason)}</p>` };
      }
      if (result.status === 'already') {
        if (kind === 'reopen') this.store.markReopened(current.project, current.iid);
        else if (kind === 'merge') this.store.markMerged(current.project, current.iid);
        else this.store.markApproved(current.project, current.iid, current.sha);
        const [title, body] = this.alreadyPage(current, result, true);
        return { code: 200, title, body };
      }
      // Only the account and credential the page showed may act.
      const actor = actorOf(result);
      if (!actor) {
        return { code: 409, title: COPY[kind].blocked, body: `${this.summary(current, result.mr, null)}<p>${escapeHtml(UNVERIFIED_ACCOUNT)}</p>` };
      }
      if (actor.user !== shown.user || actor.cred !== shown.cred) {
        return this.identityChanged(this.summary(current, result.mr, result.user), { reopen: 'reopened', merge: 'merged', approve: 'approved' }[kind]);
      }
      if (kind === 'reopen') return this.sendReopen(current, result);
      return kind === 'merge' ? this.sendMerge(current, result) : this.sendApproval(current, result);
    });
    this.send(res, outcome.code, this.page(outcome.title, outcome.body, { tone: outcome.tone || toneForCode(outcome.code), kind }));
  }

  /**
   * Reopens the merge request. The outcome of a failed or unanswered request is
   * looked up before anything is said: nothing is used up unless it is open.
   */
  async sendReopen(record, result) {
    const summary = this.summary(record, result.mr, result.user);
    let response;
    try {
      response = await this.gitlab.reopenMr(record.project, record.iid, this.asActor(result));
    } catch (err) {
      if (err?.identityMismatch) return this.identityChanged(summary, 'reopened');
      const status = gitlabStatus(err);
      log(`Reopen of ${record.project}!${record.iid} failed${status ? ` (HTTP ${status})` : ' (no response)'}`);
      if (status === null || status >= 500) {
        return this.confirmReopen(record, summary, result);
      }
      if (status === 401 || status === 403) {
        return { code: 403, title: 'Reopen refused', body: `${summary}<p>GitLab refused the request (the configured account may not be allowed to reopen this merge request). Nothing was reopened.</p>` };
      }
      if (status === 404) {
        return { code: 404, title: 'Reopen failed', body: `${summary}<p>GitLab could not find the merge request. Nothing was reopened.</p>` };
      }
      return { code: 409, title: 'Reopen failed', body: `${summary}<p>GitLab rejected the request (HTTP ${status}), for example because the merge request cannot be reopened. Nothing was reopened. Reload the page to review it again.</p>` };
    }
    // Only an answer that says "opened" counts. Anything else (closed, merged,
    // an empty or odd body) is looked up again before a word is said.
    if (response?.state === 'opened') return this.reopened(record, summary);
    log(`Reopen of ${record.project}!${record.iid} answered with state ${JSON.stringify(response?.state ?? null)}`);
    return this.confirmReopen(record, summary, result);
  }

  /**
   * Reads the merge request back after a failed, unanswered or inconclusive
   * reopen. Only a confirmed "opened" uses the link up and refreshes the card.
   */
  async confirmReopen(record, summary, result = null) {
    const mr = await this.gitlab.getMr(record.project, record.iid, this.asToken(result?.tokenIndex)).catch(() => null);
    if (mr?.state === 'opened') return this.reopened(record, summary);
    if (mr?.state === 'merged') {
      this.store.invalidate(record.project, record.iid, 'reopen');
      return { code: 409, title: 'Reopen failed', body: `${summary}<p>This merge request is merged and cannot be reopened. Nothing was reopened.</p>` };
    }
    if (mr?.state === 'closed') {
      return { code: 502, title: 'Reopen failed', body: `${summary}<p>GitLab did not confirm the request and the merge request is still closed. Nothing was reopened. Reload the page to try again.</p>` };
    }
    if (mr) {
      return { code: 502, title: 'Outcome unknown', body: `${summary}<p>GitLab reported an unexpected state for the merge request. It may or may not be open again: check it in GitLab before retrying.</p>` };
    }
    return { code: 502, title: 'Outcome unknown', body: `${summary}<p>GitLab did not give a clear answer and the result could not be checked. The merge request may or may not be open again: check it in GitLab before retrying.</p>` };
  }

  async reopened(record, summary) {
    this.store.markReopened(record.project, record.iid);
    const refresh = await this.refresh(record);
    return { code: 200, title: 'Reopened', body: `${summary}<p>Reopened in GitLab.</p><p class="note">${escapeHtml(refresh)}</p>` };
  }

  /**
   * Merges the merge request: ONE request guarded by the head commit, never
   * resent. GitLab enforces its own rules and answers with a rejection when they
   * are not met. Nothing is claimed from the answer alone: every answer that is
   * not a plain "merged" at the expected head, a rejection included, is checked
   * by reading the merge request back before the page says what happened.
   */
  async sendMerge(record, result) {
    const summary = this.summary(record, result.mr, result.user);
    let response;
    try {
      response = await this.gitlab.mergeMrOnce(record.project, record.iid, { sha: record.sha, ...this.asActor(result) });
    } catch (err) {
      if (err?.identityMismatch) return this.identityChanged(summary, 'merged');
      const status = gitlabStatus(err);
      log(`Merge of ${record.project}!${record.iid} failed${status ? ` (HTTP ${status})` : ' (no response)'}`);
      return this.confirmMerge(record, summary, { status, result });
    }
    const head = response?.sha || response?.diff_refs?.head_sha || null;
    if (response?.state === 'merged' && head === record.sha) return this.merged(record, summary);
    log(`Merge of ${record.project}!${record.iid} answered with state ${JSON.stringify(response?.state ?? null)}`);
    return this.confirmMerge(record, summary, { accepted: true, result });
  }

  /**
   * Reads the merge request back after a rejected, failed, unanswered or
   * inconclusive merge. A merge may be queued and finish a moment later, so an
   * unclear outcome (timeout, 5xx, an answer that is not "merged") is read a few
   * times, spaced out; a plain 4xx rejection is read once. The merge itself is
   * never sent again. Only a confirmed "merged" at the expected head uses the
   * link up and refreshes the card, and "not merged" is only said where a read
   * shows the merge request open (or closed).
   */
  async confirmMerge(record, summary, { status = null, accepted = false, result = null } = {}) {
    const rejected = !accepted && status !== null && status < 500;
    const attempts = rejected ? 1 : this.mergePollAttempts;
    let mr = null;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await this.sleep(this.mergePollMs);
      mr = await this.gitlab.getMr(record.project, record.iid, this.asToken(result?.tokenIndex)).catch(() => null);
      if (mr?.state === 'merged') break;
      if (mr && mr.state !== 'opened' && mr.state !== 'locked') break;
    }
    if (mr?.state === 'merged') {
      const head = mr.sha || mr.diff_refs?.head_sha || null;
      if (head && head === record.sha) return this.merged(record, summary);
      this.store.invalidate(record.project, record.iid, 'merge');
      return { code: 409, title: 'Merge not confirmed', body: `${summary}<p>The merge request is merged, but not at the head commit this link was made for. It was not recorded as merged by this link: check it in GitLab.</p>` };
    }
    if (mr?.state === 'closed') {
      this.store.invalidate(record.project, record.iid, 'merge');
      return { code: 409, title: 'Merge failed', body: `${summary}<p>The merge request is closed, so it was not merged.</p>` };
    }
    if (mr?.state === 'locked') {
      return { code: 502, title: 'Merge in progress', body: `${summary}<p>GitLab is still merging this merge request and has not confirmed the result yet. It was not recorded as merged. Check it in GitLab, then reload the page.</p>` };
    }
    const answer = rejected ? `GitLab rejected the merge (HTTP ${status})` : status !== null ? `GitLab answered with an error (HTTP ${status})` : accepted ? 'GitLab accepted the request but did not report the merge request as merged' : 'GitLab did not answer the merge request';
    if (mr?.state === 'opened') {
      if (rejected) {
        const why = this.mergeRejectionHint(status);
        return { code: status === 401 || status === 403 ? 403 : status === 404 ? 404 : 409, title: status === 401 || status === 403 ? 'Merge refused' : 'Merge failed', body: `${summary}<p>${answer}${why}. The merge request is still open in GitLab, so it was not merged. Reload the page to review it again.</p>` };
      }
      const waited = Math.round(((attempts - 1) * this.mergePollMs) / 1000);
      return { code: 502, title: 'Merge not confirmed', body: `${summary}<p>${answer}${waited > 0 ? `. It still shows as open after ${waited} seconds` : '. It still shows as open'}, but a merge that GitLab queued can finish later. It was not recorded as merged. Check it in GitLab before trying again.</p>` };
    }
    if (mr) {
      return { code: 502, title: 'Outcome unknown', body: `${summary}<p>${answer}, and the merge request is in an unexpected state. It may or may not be merged: check it in GitLab before retrying.</p>` };
    }
    return { code: 502, title: 'Outcome unknown', body: `${summary}<p>${answer}, and the merge request could not be read back. It may or may not be merged: check it in GitLab before retrying.</p>` };
  }

  /** A short reason for a GitLab rejection of the merge, as a clause (leading text included) or empty. */
  mergeRejectionHint(status) {
    if (status === 401 || status === 403) return ' (the configured account may not be allowed to merge this merge request)';
    if (status === 404) return ' (it could not find the merge request or the merge endpoint)';
    if (status === 405 || status === 406) return ' (the merge request cannot be merged right now, for example because of conflicts or a failed rule)';
    if (status === 409) return ' (the head commit changed or a rule is not met)';
    return ' (its rules for this merge request are not met right now, or the merge request changed)';
  }

  async merged(record, summary) {
    this.store.markMerged(record.project, record.iid);
    // The merge request is gone from the approvable states for good.
    this.store.invalidate(record.project, record.iid, 'approve');
    const refresh = await this.refresh(record);
    return { code: 200, title: 'Merged', body: `${summary}<p>Merged in GitLab.</p><p class="note">${escapeHtml(refresh)}</p>` };
  }

  async sendApproval(record, result) {
    const summary = this.summary(record, result.mr, result.user);
    try {
      await this.gitlab.approveMr(record.project, record.iid, { sha: record.sha, ...this.asActor(result) });
    } catch (err) {
      if (err?.identityMismatch) return this.identityChanged(summary, 'approved');
      const status = gitlabStatus(err);
      log(`Approval of ${record.project}!${record.iid} failed${status ? ` (HTTP ${status})` : ' (no response)'}`);
      if (status === null || status >= 500 || status === 401 || status === 403) {
        // The outcome is uncertain (a first attempt may have landed before a
        // later answer): look before saying anything. Nothing is consumed
        // unless an approval is confirmed.
        // Asked as the very account the approval was sent as, never another one.
        const state = await this.gitlab.getUserApprovalState(record.project, record.iid, this.asToken(result.tokenIndex)).catch(() => ({ known: false }));
        if (state.known && state.hasApproved) {
          return this.approved(record, summary);
        }
        if (state.known && (status === 401 || status === 403)) {
          return { code: 403, title: 'Approval refused', body: `${summary}<p>GitLab refused the approval (the configured account may not be allowed to approve this merge request) and no approval is recorded. Nothing was approved.</p>` };
        }
        if (state.known) {
          return { code: 502, title: 'Approval failed', body: `${summary}<p>GitLab did not confirm the request and no approval is recorded. Nothing was approved. Reload the page to try again.</p>` };
        }
        return { code: 502, title: 'Outcome unknown', body: `${summary}<p>GitLab did not give a clear answer and the result could not be checked. The merge request may or may not be approved: check it in GitLab before retrying.</p>` };
      }
      if (status === 404) {
        return { code: 404, title: 'Approval failed', body: `${summary}<p>GitLab could not find the merge request. Nothing was approved.</p>` };
      }
      return { code: 409, title: 'Approval failed', body: `${summary}<p>GitLab rejected the approval (HTTP ${status}), for example because the merge request changed. Nothing was approved. Reload the page to review it again.</p>` };
    }
    return this.approved(record, summary);
  }

  /** The account that was shown is no longer the one that would act: nothing was sent. */
  identityChanged(summary, verb) {
    return { code: 409, title: 'Account changed', body: `${summary}<p>The GitLab account that would act is no longer the one shown above, so nothing was sent. Nothing was ${verb}. Reload the page to review it again.</p>` };
  }

  async approved(record, summary) {
    this.store.markApproved(record.project, record.iid, record.sha);
    const refresh = await this.refresh(record);
    return { code: 200, title: 'Approved', body: `${summary}<p>Approved in GitLab.</p><p class="note">${escapeHtml(refresh)}</p>` };
  }

  /** Runs the card refresh. The text says only what is known. */
  async refresh(record) {
    if (!this.refreshCards) return 'The Teams card is not refreshed by this service.';
    try {
      const result = await Promise.race([
        this.refreshCards(record.project, record.iid),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout')), REFRESH_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      if (!result || result.failed > 0) return 'The Teams card could not be refreshed yet. It updates at the next check.';
      if (result.matched === 0) return 'No watched Teams card needed a refresh.';
      return 'The Teams card refresh was run.';
    } catch {
      return 'The Teams card could not be refreshed yet. It updates at the next check.';
    }
  }
}
