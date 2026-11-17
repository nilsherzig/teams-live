// Authenticated web confirmation flow for approving a GitLab merge request
// from a rich card.
//
// The card carries an "Approve..." button (Action.OpenUrl) that opens a page
// served by this module. Opening it never changes anything: only an explicit,
// CSRF-protected POST from that page approves.
//
// Trust model:
// - The listener is separate from the webhook server and binds to loopback
//   only. It is meant to sit behind a reverse proxy that authenticates the
//   user and injects (a) the authenticated user name header and (b) a shared
//   secret header. A request without the secret is rejected, so the user
//   header is never trusted from anywhere else.
// - Only the configured owner users are allowed. The approval itself is made
//   with the daemon's GitLab token (the owner's identity); other people are
//   never authorized by this flow.
// - URLs carry an opaque random id only. Everything it stands for (project,
//   merge request, head commit, expiry) is stored on the server, so the URL
//   authorizes nothing and holds no credential.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const log = (...args) => console.error(new Date().toISOString(), '[approve]', ...args);

const ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const MAX_BODY_BYTES = 4096;
const DEFAULT_LINK_TTL_MS = 24 * 60 * 60 * 1000;
const CSRF_TTL_MS = 10 * 60 * 1000;
const MAX_RECORDS = 500;
const REFRESH_TIMEOUT_MS = 15_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest();

/** Constant-time string comparison (digests, so the length does not leak). */
function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

const keyOf = (project, iid) => `${String(project).toLowerCase()}!${iid}`;

/**
 * Server-authoritative approval links, kept in a small bounded state file.
 * A record binds an opaque id to one project, merge request and head commit.
 */
export class ApprovalStore {
  constructor({ file = null, ttlMs = DEFAULT_LINK_TTL_MS, max = MAX_RECORDS, now = Date.now } = {}) {
    this.file = file;
    this.ttlMs = ttlMs;
    this.max = max;
    this.now = now;
    this.records = new Map();
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
  }

  persist() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, records: [...this.records.values()] }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log(`Could not write ${this.file}: ${err.message}`);
    }
  }

  /**
   * Link record for a merge request head commit. A live record for the same
   * project, merge request and commit is reused; records for other commits of
   * the same merge request become stale.
   */
  linkFor({ project, iid, sha }) {
    if (!project || iid === undefined || iid === null || !sha) return null;
    this.prune();
    const key = keyOf(project, iid);
    let reuse = null;
    for (const r of this.records.values()) {
      if (keyOf(r.project, r.iid) !== key) continue;
      if (r.sha === sha && r.status !== 'stale') reuse = r;
      else if (r.status === 'open') r.status = 'stale';
    }
    if (reuse) {
      this.persist();
      return reuse;
    }
    const now = this.now();
    const record = {
      id: crypto.randomBytes(24).toString('base64url'),
      project: String(project),
      iid: String(iid),
      sha: String(sha),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      status: 'open',
    };
    this.records.set(record.id, record);
    this.prune();
    this.persist();
    return record;
  }

  /** The record for an id, or null when it is unknown or expired. */
  get(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
    const r = this.records.get(id);
    if (!r || r.expiresAt <= this.now()) return null;
    return r;
  }

  setStatus(id, status) {
    const r = this.records.get(id);
    if (!r) return;
    r.status = status;
    this.persist();
  }
}

/**
 * CSRF tokens: HMAC over the owner, the link record and an expiry with a
 * random per-process key. A restart invalidates open pages (reload the page).
 */
export class CsrfTokens {
  constructor({ key = crypto.randomBytes(32), ttlMs = CSRF_TTL_MS, now = Date.now } = {}) {
    this.key = key;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  mac(owner, id, exp) {
    return crypto.createHmac('sha256', this.key).update(`csrf\n${owner}\n${id}\n${exp}`).digest('base64url');
  }

  issue(owner, id) {
    const exp = this.now() + this.ttlMs;
    return `${exp}.${this.mac(owner, id, exp)}`;
  }

  verify(token, owner, id) {
    if (typeof token !== 'string') return false;
    const [expRaw, mac, ...rest] = token.split('.');
    if (rest.length > 0 || !/^\d{1,16}$/.test(expRaw || '') || !mac) return false;
    const exp = Number(expRaw);
    if (exp <= this.now()) return false;
    return safeEqual(mac, this.mac(owner, id, exp));
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

/** Normalizes the configured owner users (array or comma/newline separated text). */
export function normalizeOwnerUsers(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : [];
  return [...new Set(list.map((u) => String(u ?? '').trim().toLowerCase()).filter(Boolean))];
}

export class ApproveServer {
  /**
   * @param {object} opts
   * @param {object} opts.gitlab GitLabClient (getMr, approveMr, getUserApprovalState)
   * @param {string} opts.baseUrl public URL of the flow, e.g. https://host/approve
   * @param {string[]} opts.ownerUsers authenticated user names allowed to approve
   * @param {string} opts.proxySecret shared secret the reverse proxy injects
   * @param {(project, iid) => Promise<{matched:number,failed:number}>} [opts.refreshCards]
   * @param {string} [opts.stateFile] persisted link records
   */
  constructor({
    gitlab,
    baseUrl,
    ownerUsers,
    proxySecret,
    host = '127.0.0.1',
    port = 3006,
    userHeader = 'Remote-User',
    proxySecretHeader = 'X-Teams-Live-Proxy-Secret',
    linkTtlSeconds = DEFAULT_LINK_TTL_MS / 1000,
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
    if (base.protocol !== 'https:' && base.protocol !== 'http:') {
      throw new Error('approve: base_url must be an http(s) URL');
    }
    this.owners = new Set(normalizeOwnerUsers(ownerUsers));
    if (this.owners.size === 0) throw new Error('approve: owner_users is empty (refusing to start)');
    if (!proxySecret || !String(proxySecret).trim()) {
      throw new Error('approve: the proxy secret is missing (refusing to start)');
    }
    if (!LOOPBACK_HOSTS.has(host)) throw new Error(`approve: host must be a loopback address, got ${host}`);

    this.gitlab = gitlab;
    this.host = host;
    this.port = Number(port);
    this.origin = base.origin;
    this.basePath = base.pathname.replace(/\/+$/, '');
    this.proxySecret = String(proxySecret).trim();
    this.userHeader = String(userHeader || 'Remote-User').toLowerCase();
    this.proxySecretHeader = String(proxySecretHeader || 'X-Teams-Live-Proxy-Secret').toLowerCase();
    this.refreshCards = refreshCards;
    this.now = now;
    this.store = new ApprovalStore({ file: stateFile, ttlMs: Number(linkTtlSeconds) * 1000, now });
    this.store.load();
    this.csrf = new CsrfTokens({ now });
    this.locks = new Map();
    this.server = null;
  }

  /** URL of the confirmation page for a merge request head commit, or null. */
  linkFor({ project, iid, sha }) {
    try {
      const record = this.store.linkFor({ project, iid, sha });
      return record ? `${this.origin}${this.basePath}/${record.id}` : null;
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

  headers(extra = {}) {
    return {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action ${this.origin}; frame-ancestors 'none'; base-uri 'none'`,
      ...extra,
    };
  }

  send(res, status, html, { head = false, extra = {} } = {}) {
    const body = head ? '' : html;
    res.writeHead(status, this.headers({ 'Content-Length': Buffer.byteLength(html), ...extra }));
    res.end(body);
  }

  page(title, body) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.5}code{background:#8882;padding:0 .25rem;border-radius:3px}button{font:inherit;padding:.5rem 1rem;cursor:pointer}.note{opacity:.75;font-size:.9em}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
  }

  /** Authenticates the proxy and the user. Returns `{user}` or `{status}`. */
  authenticate(req) {
    const secret = req.headers[this.proxySecretHeader];
    if (typeof secret !== 'string' || !safeEqual(secret, this.proxySecret)) return { status: 401 };
    const raw = req.headers[this.userHeader];
    // Duplicated headers arrive joined with a comma and never match a user.
    if (typeof raw !== 'string' || !raw.trim() || raw.includes(',')) return { status: 401 };
    const user = raw.trim().toLowerCase();
    if (!this.owners.has(user)) return { status: 403 };
    return { user };
  }

  idFromUrl(req) {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return null;
    }
    if (this.basePath && pathname.startsWith(`${this.basePath}/`)) pathname = pathname.slice(this.basePath.length);
    const m = /^\/([^/]+)\/?$/.exec(pathname);
    return m && ID_PATTERN.test(m[1]) ? m[1] : null;
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

  // --- request handling ---

  async handle(req, res) {
    const auth = this.authenticate(req);
    if (!auth.user) {
      this.send(res, auth.status, this.page('Not allowed', '<p>You are not allowed to use this page.</p>'));
      return;
    }
    const method = req.method;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      this.send(res, 405, this.page('Not allowed', '<p>Method not allowed.</p>'), { extra: { Allow: 'GET, HEAD, POST' } });
      return;
    }
    const id = this.idFromUrl(req);
    const record = id ? this.store.get(id) : null;
    if (!record) {
      this.send(res, 404, this.page('Link not found', '<p>This approval link is unknown or has expired. Use the button on the current Teams card.</p>'), {
        head: method === 'HEAD',
      });
      return;
    }
    if (method === 'HEAD') {
      this.send(res, 200, '', { head: true });
      return;
    }
    if (method === 'GET') {
      await this.showConfirmation(res, auth.user, record);
      return;
    }
    await this.approve(req, res, auth.user, record);
  }

  /**
   * Reads the live merge request and decides what the page may offer:
   * `ready`, `already` (the token user approved) or `blocked` with a reason.
   */
  async evaluate(record) {
    let mr;
    try {
      mr = await this.gitlab.getMr(record.project, record.iid);
    } catch {
      return { status: 'blocked', reason: 'GitLab could not be reached to read the merge request. Nothing was approved. Try again later.' };
    }
    if (mr?.state !== 'opened') {
      return { status: 'blocked', mr, reason: `This merge request is ${mr?.state === 'merged' ? 'merged' : 'no longer open'}. Nothing to approve.` };
    }
    const draft = Boolean(mr.draft || mr.work_in_progress || mr.detailed_merge_status === 'draft_status');
    if (draft) return { status: 'blocked', mr, reason: 'This merge request is a draft and cannot be approved.' };
    const head = mr.sha || mr.diff_refs?.head_sha || null;
    if (!head) return { status: 'blocked', mr, reason: 'The head commit of the merge request is unknown. Nothing was approved.' };
    if (head !== record.sha) {
      this.store.setStatus(record.id, 'stale');
      return { status: 'blocked', mr, reason: 'The merge request changed after this card was posted (new commits). Review it again and use the button on the updated card.' };
    }
    const state = await this.gitlab.getUserApprovalState(record.project, record.iid);
    if (!state.known) {
      return { status: 'blocked', mr, reason: 'Your identity or the current approvals could not be verified in GitLab. Nothing was approved. Try again later.' };
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
    if (user) lines.push(`<p class="note">The approval is made as GitLab user <code>${escapeHtml(user.username || user.name || user.id)}</code>.</p>`);
    return lines.join('');
  }

  async showConfirmation(res, owner, record) {
    const result = await this.evaluate(record);
    if (result.status === 'blocked') {
      this.send(res, 409, this.page('Cannot approve', `${this.summary(record, result.mr, result.user)}<p>${escapeHtml(result.reason)}</p>`));
      return;
    }
    if (result.status === 'already') {
      this.send(res, 200, this.page('Already approved', `${this.summary(record, result.mr, result.user)}<p>This merge request is already approved by this account in GitLab. Nothing to do.</p>`));
      return;
    }
    const token = this.csrf.issue(owner, record.id);
    const form = `<form method="post" action="${escapeHtml(`${this.origin}${this.basePath}/${record.id}`)}"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><p>Approve this merge request?</p><button type="submit">Approve merge request</button></form>`;
    this.send(res, 200, this.page('Approve merge request', `${this.summary(record, result.mr, result.user)}${form}`));
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

  async approve(req, res, owner, record) {
    if (!this.originAllowed(req)) {
      this.send(res, 403, this.page('Not allowed', '<p>The request did not come from the approval page. Nothing was approved.</p>'));
      return;
    }
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/x-www-form-urlencoded') {
      this.send(res, 415, this.page('Not allowed', '<p>Unsupported request. Nothing was approved.</p>'));
      return;
    }
    let form;
    try {
      form = await this.readForm(req);
    } catch (err) {
      this.send(res, err.status || 400, this.page('Not allowed', '<p>The request was rejected. Nothing was approved.</p>'));
      return;
    }
    if (!this.csrf.verify(form.get('csrf'), owner, record.id)) {
      this.send(res, 403, this.page('Page expired', '<p>This page expired. Reload the link and confirm again. Nothing was approved.</p>'));
      return;
    }

    const outcome = await this.withLock(keyOf(record.project, record.iid), async () => {
      const current = this.store.get(record.id);
      if (!current) return { code: 410, title: 'Link expired', body: '<p>This approval link expired. Nothing was approved.</p>' };
      if (current.status === 'approved') {
        return { code: 200, title: 'Already approved', body: `${this.summary(current, null, null)}<p>This merge request was already approved through this link. Nothing more was sent.</p>` };
      }
      const result = await this.evaluate(current);
      if (result.status === 'blocked') {
        return { code: 409, title: 'Cannot approve', body: `${this.summary(current, result.mr, result.user)}<p>${escapeHtml(result.reason)}</p>` };
      }
      if (result.status === 'already') {
        this.store.setStatus(current.id, 'approved');
        return { code: 200, title: 'Already approved', body: `${this.summary(current, result.mr, result.user)}<p>This merge request is already approved by this account in GitLab. Nothing was sent.</p>` };
      }
      return this.sendApproval(current, result);
    });
    this.send(res, outcome.code, this.page(outcome.title, outcome.body));
  }

  async sendApproval(record, result) {
    const summary = this.summary(record, result.mr, result.user);
    let approved = false;
    try {
      await this.gitlab.approveMr(record.project, record.iid, { sha: record.sha });
      approved = true;
    } catch (err) {
      const status = gitlabStatus(err);
      log(`Approval of ${record.project}!${record.iid} failed${status ? ` (HTTP ${status})` : ' (no response)'}`);
      if (status === null || status >= 500) {
        // The outcome is uncertain: look before saying anything.
        const state = await this.gitlab.getUserApprovalState(record.project, record.iid).catch(() => ({ known: false }));
        if (state.known && state.hasApproved) {
          approved = true;
        } else if (state.known) {
          return { code: 502, title: 'Approval failed', body: `${summary}<p>GitLab did not confirm the request and no approval is recorded. Nothing was approved. Reload the link to try again.</p>` };
        } else {
          return { code: 502, title: 'Outcome unknown', body: `${summary}<p>GitLab did not answer and the result could not be checked. The merge request may or may not be approved: check it in GitLab before retrying.</p>` };
        }
      } else if (status === 401 || status === 403) {
        return { code: 403, title: 'Approval refused', body: `${summary}<p>GitLab refused the approval (the account may not be allowed to approve this merge request). Nothing was approved.</p>` };
      } else if (status === 404) {
        return { code: 404, title: 'Approval failed', body: `${summary}<p>GitLab could not find the merge request. Nothing was approved.</p>` };
      } else {
        return { code: 409, title: 'Approval failed', body: `${summary}<p>GitLab rejected the approval (HTTP ${status}), for example because the merge request changed. Nothing was approved. Reload the link to review it again.</p>` };
      }
    }

    this.store.setStatus(record.id, 'approved');
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
