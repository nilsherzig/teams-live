// Capability-link web confirmation flow for approving a GitLab merge request
// from a rich card.
//
// The card carries an "Approve..." button (Action.OpenUrl) whose URL holds a
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
//   and an Origin that matches the configured base_url.
// - The server stores only the SHA-256 of the token with the project, merge
//   request, exact head commit, expiry (24 h by default, hard bounded) and
//   status. A link is single-use once an approval is CONFIRMED, and is
//   invalidated when the head commit changes or the merge request is closed
//   or merged. An uncertain outcome consumes nothing.
// - The listener binds to loopback only and sits behind the reverse proxy.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const log = (...args) => console.error(new Date().toISOString(), '[approve]', ...args);

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
const REFRESH_TIMEOUT_MS = 15_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const COOKIE_NAME = 'tl_approve';

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest();
const sha256Hex = (value) => sha256(value).toString('hex');

/** Constant-time string comparison (digests, so the length does not leak). */
function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

const keyOf = (project, iid) => `${String(project).toLowerCase()}!${iid}`;

/**
 * Server-side link records, kept in a small bounded state file. A record binds
 * the SHA-256 of a capability token to one project, merge request and head
 * commit. The token itself is never stored.
 */
export class ApprovalStore {
  constructor({ file = null, ttlMs = DEFAULT_LINK_TTL_S * 1000, max = MAX_RECORDS, now = Date.now } = {}) {
    this.file = file;
    this.ttlMs = ttlMs;
    this.max = max;
    this.now = now;
    this.records = new Map();
    // Raw tokens of links minted by this process, so a card refresh shows the
    // same link again. Memory only; a restart simply mints a new link.
    this.minted = new Map();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const r of Array.isArray(data?.records) ? data.records : []) {
        if (
          typeof r?.id === 'string' &&
          ID_PATTERN.test(r.id) &&
          typeof r.project === 'string' &&
          r.iid !== undefined &&
          typeof r.sha === 'string' &&
          Number.isFinite(r.createdAt) &&
          Number.isFinite(r.expiresAt) &&
          ['open', 'approved', 'stale'].includes(r.status)
        ) {
          this.records.set(r.id, {
            id: r.id,
            project: r.project,
            iid: String(r.iid),
            sha: r.sha,
            createdAt: r.createdAt,
            expiresAt: r.expiresAt,
            status: r.status,
          });
        }
      }
    } catch (err) {
      log(`Could not read ${this.file}: ${err.message}`);
    }
    this.prune();
  }

  prune() {
    const now = this.now();
    for (const [id, r] of this.records) {
      if (r.expiresAt <= now) this.records.delete(id);
    }
    if (this.records.size > this.max) {
      const oldestFirst = [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt);
      for (const r of oldestFirst.slice(0, this.records.size - this.max)) this.records.delete(r.id);
    }
    for (const [k, m] of this.minted) {
      if (!this.records.has(m.id)) this.minted.delete(k);
    }
  }

  persist() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 2, records: [...this.records.values()] }), { mode: 0o600 });
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
  linkFor({ project, iid, sha }) {
    if (!project || iid === undefined || iid === null || !sha) return null;
    this.prune();
    const key = keyOf(project, iid);
    for (const r of this.records.values()) {
      if (keyOf(r.project, r.iid) === key && r.sha !== sha && r.status === 'open') r.status = 'stale';
    }
    const cacheKey = `${key}@${sha}`;
    const cached = this.minted.get(cacheKey);
    const live = cached ? this.records.get(cached.id) : null;
    if (cached && live && live.status === 'open' && live.expiresAt > this.now()) {
      this.persist();
      return { token: cached.token, record: live };
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const now = this.now();
    const record = {
      id: sha256Hex(token),
      project: String(project),
      iid: String(iid),
      sha: String(sha),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      status: 'open',
    };
    this.records.set(record.id, record);
    this.minted.set(cacheKey, { token, id: record.id });
    this.prune();
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

  /** A confirmed approval uses up every link of the merge request. */
  markApproved(project, iid, sha) {
    const key = keyOf(project, iid);
    for (const r of this.records.values()) {
      if (keyOf(r.project, r.iid) !== key || r.status === 'stale') continue;
      r.status = r.sha === sha ? 'approved' : 'stale';
    }
    this.persist();
  }

  /** Closed, merged or changed merge request: no link of it works any more. */
  invalidate(project, iid) {
    const key = keyOf(project, iid);
    for (const r of this.records.values()) {
      if (keyOf(r.project, r.iid) === key && r.status === 'open') r.status = 'stale';
    }
    this.persist();
  }
}

/**
 * CSRF tokens: HMAC over the session, the link record and an expiry with a
 * random per-process key. A restart invalidates open pages (reload the page).
 */
export class CsrfTokens {
  constructor({ key = crypto.randomBytes(32), ttlMs = CSRF_TTL_MS, now = Date.now } = {}) {
    this.key = key;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  mac(session, id, exp) {
    return crypto.createHmac('sha256', this.key).update(`csrf\n${session}\n${id}\n${exp}`).digest('base64url');
  }

  issue(session, id) {
    const exp = this.now() + this.ttlMs;
    return `${exp}.${this.mac(session, id, exp)}`;
  }

  verify(token, session, id) {
    if (typeof token !== 'string') return false;
    const [expRaw, mac, ...rest] = token.split('.');
    if (rest.length > 0 || !/^\d{1,16}$/.test(expRaw || '') || !mac) return false;
    const exp = Number(expRaw);
    if (exp <= this.now()) return false;
    return safeEqual(mac, this.mac(session, id, exp));
  }
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
    this.store = new ApprovalStore({ file: stateFile, ttlMs: normalizeLinkTtlSeconds(linkTtlSeconds) * 1000, now });
    this.store.load();
    this.csrf = new CsrfTokens({ now });
    this.sessions = new Map();
    this.failures = { windowStart: 0, count: 0 };
    this.locks = new Map();
    this.server = null;
    this.script = this.bootstrapScript();
    this.scriptHash = `sha256-${crypto.createHash('sha256').update(this.script).digest('base64')}`;
  }

  /** URL of the confirmation entry page for a merge request head commit, or null. */
  linkFor({ project, iid, sha }) {
    try {
      const link = this.store.linkFor({ project, iid, sha });
      return link ? `${this.origin}${this.basePath}/#${link.token}` : null;
    } catch (err) {
      log(`Could not create an approval link: ${err.message}`);
      return null;
    }
  }

  start() {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          log(`Unhandled error: ${err.message}`);
          if (!res.headersSent) this.send(res, 500, this.page('Error', '<p>Something went wrong. Nothing was approved.</p>'));
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

  page(title, body, { script = '' } = {}) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="same-origin"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.5}code{background:#8882;padding:0 .25rem;border-radius:3px}button{font:inherit;padding:.5rem 1rem;cursor:pointer}.note{opacity:.75;font-size:.9em}</style></head><body><h1>${escapeHtml(title)}</h1>${body}${script}</body></html>`;
  }

  /** The static script that exchanges the fragment token for a session. */
  bootstrapScript() {
    const base = JSON.stringify(`${this.basePath}`);
    return `(function(){var B=${base},m=document.getElementById('msg');function say(t){m.textContent=t}var h=location.hash.replace(/^#/,'');try{history.replaceState(null,'',location.pathname+location.search)}catch(e){}if(!/^[A-Za-z0-9_-]{43}$/.test(h)){say('This approval link is incomplete. Use the button on the Teams card.');return}fetch(B+'/session',{method:'POST',credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'token='+h}).then(function(r){if(r.ok){location.replace(B+'/confirm');return}if(r.status===410){say('This approval link was already used or the merge request changed. Use the button on the current Teams card.')}else if(r.status===429){say('Too many attempts. Try again in a minute.')}else if(r.status===404){say('This approval link is unknown or has expired. Use the button on the current Teams card.')}else{say('The link could not be opened. Nothing was approved.')}}).catch(function(){say('The link could not be opened. Nothing was approved.')})})();`;
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
    while (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value);
    const sid = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Math.min(now + SESSION_TTL_MS, record.expiresAt);
    this.sessions.set(sha256Hex(sid), { recordId: record.id, expiresAt });
    return { sid, maxAge: Math.max(1, Math.floor((expiresAt - now) / 1000)) };
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
      this.send(res, 405, this.page('Not allowed', '<p>Method not allowed.</p>'), { extra: { Allow: 'GET, HEAD, POST' } });
      return;
    }
    const route = this.route(req);
    if (!route) {
      this.send(res, 404, this.page('Not found', '<p>Nothing here.</p>'), { head: method === 'HEAD' });
      return;
    }
    const head = method === 'HEAD';
    if (route === '/') {
      if (method === 'POST') return this.send(res, 405, this.page('Not allowed', '<p>Method not allowed.</p>'), { extra: { Allow: 'GET, HEAD' } });
      const body = this.page(
        'Approve merge request',
        '<p id="msg">Opening the approval link…</p><noscript><p>JavaScript is required to open an approval link.</p></noscript>',
        { script: `<script>${this.script}</script>` },
      );
      return this.send(res, 200, body, { head, script: true });
    }
    if (route === '/session') {
      if (method !== 'POST') return this.send(res, 405, this.page('Not allowed', '<p>Method not allowed.</p>'), { extra: { Allow: 'POST' } });
      return this.bootstrap(req, res);
    }
    // /confirm
    if (method === 'HEAD') return this.send(res, 200, '', { head: true });
    const session = this.sessionOf(req);
    if (!session) {
      return this.send(res, 401, this.page('Link not opened', '<p>Open the approval link from the Teams card again. Nothing was approved.</p>'));
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
    if (this.throttled()) return reply(429, 'too many attempts', { 'Retry-After': '60' });
    const parsed = await this.postForm(req);
    if (!parsed.form) return reply(parsed.status, 'rejected');
    const record = this.store.byToken(parsed.form.get('token'));
    if (!record) {
      this.noteFailure();
      return reply(404, 'unknown or expired');
    }
    if (record.status !== 'open') return reply(410, 'used or superseded');
    const { sid, maxAge } = this.openSession(record);
    return reply(200, 'ok', { 'Set-Cookie': this.cookie(sid, maxAge) });
  }

  /**
   * Reads the live merge request and decides what the page may offer:
   * `ready`, `already` (the configured account approved) or `blocked`.
   */
  async evaluate(record) {
    if (record.status === 'approved') return { status: 'used' };
    if (record.status === 'stale') return { status: 'blocked', reason: 'This link was superseded because the merge request changed. Use the button on the current Teams card.' };
    let mr;
    try {
      mr = await this.gitlab.getMr(record.project, record.iid);
    } catch {
      return { status: 'blocked', reason: 'GitLab could not be reached to read the merge request. Nothing was approved. Try again later.' };
    }
    if (mr?.state !== 'opened') {
      this.store.invalidate(record.project, record.iid);
      return { status: 'blocked', mr, reason: `This merge request is ${mr?.state === 'merged' ? 'merged' : 'no longer open'}. Nothing to approve.` };
    }
    const draft = Boolean(mr.draft || mr.work_in_progress || mr.detailed_merge_status === 'draft_status');
    if (draft) return { status: 'blocked', mr, reason: 'This merge request is a draft and cannot be approved.' };
    const head = mr.sha || mr.diff_refs?.head_sha || null;
    if (!head) return { status: 'blocked', mr, reason: 'The head commit of the merge request is unknown. Nothing was approved.' };
    if (head !== record.sha) {
      this.store.invalidate(record.project, record.iid);
      return { status: 'blocked', mr, reason: 'The merge request changed after this card was posted (new commits). Review it again and use the button on the updated card.' };
    }
    const state = await this.gitlab.getUserApprovalState(record.project, record.iid);
    if (!state.known) {
      return { status: 'blocked', mr, reason: 'The configured GitLab account or the current approvals could not be verified. Nothing was approved. Try again later.' };
    }
    if (state.hasApproved) return { status: 'already', mr, user: state.user };
    if (state.canApprove === false) {
      return { status: 'blocked', mr, user: state.user, reason: 'GitLab does not allow the configured account to approve this merge request (for example as its author).' };
    }
    return { status: 'ready', mr, user: state.user };
  }

  summary(record, mr, user) {
    const lines = [
      `<p><strong>${escapeHtml(mr?.title || `Merge request !${record.iid}`)}</strong><br>${escapeHtml(record.project)}!${escapeHtml(record.iid)}</p>`,
      `<p class="note">Head commit <code>${escapeHtml(record.sha.slice(0, 12))}</code></p>`,
    ];
    if (user) {
      lines.push(
        `<p class="note">The approval is made with the configured GitLab account <code>${escapeHtml(user.username || user.name || user.id)}</code>, not as you personally. Anyone with this link can approve.</p>`,
      );
    }
    return lines.join('');
  }

  usedPage(record) {
    return { code: 410, title: 'Link already used', body: `${this.summary(record, null, null)}<p>This link was already used to approve the merge request. Nothing more was sent.</p>` };
  }

  async showConfirmation(res, { sid, record }) {
    const result = await this.evaluate(record);
    if (result.status === 'used') {
      const u = this.usedPage(record);
      return this.send(res, u.code, this.page(u.title, u.body));
    }
    if (result.status === 'blocked') {
      return this.send(res, 409, this.page('Cannot approve', `${this.summary(record, result.mr, result.user)}<p>${escapeHtml(result.reason)}</p>`));
    }
    if (result.status === 'already') {
      return this.send(res, 200, this.page('Already approved', `${this.summary(record, result.mr, result.user)}<p>This merge request is already approved by the configured account in GitLab. Nothing to do.</p>`));
    }
    const token = this.csrf.issue(sid, record.id);
    const form = `<form method="post" action="${escapeHtml(`${this.origin}${this.basePath}/confirm`)}"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><p>Approve this merge request?</p><button type="submit">Approve merge request</button></form>`;
    return this.send(res, 200, this.page('Approve merge request', `${this.summary(record, result.mr, result.user)}${form}`));
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
    if (!this.originAllowed(req)) {
      this.send(res, 403, this.page('Not allowed', '<p>The request did not come from the approval page. Nothing was approved.</p>'));
      return;
    }
    const parsed = await this.postForm(req);
    if (!parsed.form) {
      const msg = parsed.status === 415 ? 'Unsupported request.' : 'The request was rejected.';
      this.send(res, parsed.status, this.page('Not allowed', `<p>${msg} Nothing was approved.</p>`));
      return;
    }
    if (!this.csrf.verify(parsed.form.get('csrf'), sid, record.id)) {
      this.send(res, 403, this.page('Page expired', '<p>This page expired. Open the link again and confirm. Nothing was approved.</p>'));
      return;
    }

    const outcome = await this.withLock(keyOf(record.project, record.iid), async () => {
      const current = this.store.byId(record.id);
      if (!current) return { code: 410, title: 'Link expired', body: '<p>This approval link expired. Nothing was approved.</p>' };
      const result = await this.evaluate(current);
      if (result.status === 'used') return this.usedPage(current);
      if (result.status === 'blocked') {
        return { code: 409, title: 'Cannot approve', body: `${this.summary(current, result.mr, result.user)}<p>${escapeHtml(result.reason)}</p>` };
      }
      if (result.status === 'already') {
        this.store.markApproved(current.project, current.iid, current.sha);
        return { code: 200, title: 'Already approved', body: `${this.summary(current, result.mr, result.user)}<p>This merge request is already approved by the configured account in GitLab. Nothing was sent.</p>` };
      }
      return this.sendApproval(current, result);
    });
    this.send(res, outcome.code, this.page(outcome.title, outcome.body));
  }

  async sendApproval(record, result) {
    const summary = this.summary(record, result.mr, result.user);
    try {
      await this.gitlab.approveMr(record.project, record.iid, { sha: record.sha });
    } catch (err) {
      const status = gitlabStatus(err);
      log(`Approval of ${record.project}!${record.iid} failed${status ? ` (HTTP ${status})` : ' (no response)'}`);
      if (status === null || status >= 500) {
        // The outcome is uncertain: look before saying anything. Nothing is
        // consumed unless an approval is confirmed.
        const state = await this.gitlab.getUserApprovalState(record.project, record.iid).catch(() => ({ known: false }));
        if (state.known && state.hasApproved) {
          return this.approved(record, summary);
        }
        if (state.known) {
          return { code: 502, title: 'Approval failed', body: `${summary}<p>GitLab did not confirm the request and no approval is recorded. Nothing was approved. Reload the page to try again.</p>` };
        }
        return { code: 502, title: 'Outcome unknown', body: `${summary}<p>GitLab did not answer and the result could not be checked. The merge request may or may not be approved: check it in GitLab before retrying.</p>` };
      }
      if (status === 401 || status === 403) {
        return { code: 403, title: 'Approval refused', body: `${summary}<p>GitLab refused the approval (the configured account may not be allowed to approve this merge request). Nothing was approved.</p>` };
      }
      if (status === 404) {
        return { code: 404, title: 'Approval failed', body: `${summary}<p>GitLab could not find the merge request. Nothing was approved.</p>` };
      }
      return { code: 409, title: 'Approval failed', body: `${summary}<p>GitLab rejected the approval (HTTP ${status}), for example because the merge request changed. Nothing was approved. Reload the page to review it again.</p>` };
    }
    return this.approved(record, summary);
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
