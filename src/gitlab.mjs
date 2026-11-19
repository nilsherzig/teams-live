import './test-guard.mjs';
/**
 * How many approvals a merge request has and needs, as `{approvalsGiven,
 * approvalsRequired}` (both null when GitLab does not require any: a rule-less
 * merge request has no "N of M"). Prefers GitLab's own `approvals_left`.
 */
export function approvalCountsOf(approvals, approverCount = 0) {
  const required = typeof approvals?.approvals_required === 'number' && approvals.approvals_required > 0 ? approvals.approvals_required : null;
  if (required === null) return { approvalsGiven: null, approvalsRequired: null };
  const given =
    typeof approvals.approvals_left === 'number' ? Math.max(0, required - approvals.approvals_left) : approverCount;
  return { approvalsGiven: given, approvalsRequired: required };
}

/** Most path segments tried as the ref of a blob link (branch names may contain slashes). */
const BLOB_MAX_REF_SEGMENTS = 6;
/** A code preview shows at least this many lines when the file (and max_lines) allow it. */
export const MIN_PREVIEW_LINES = 5;

/** Paths whose content is likely a credential: never previewed. */
const SENSITIVE_PATH_RE =
  /(^|\/)(\.env(\..*)?|\.netrc|\.npmrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)|kubeconfig|[^/]*\.(pem|key|p12|pfx|jks|kdbx|gpg|asc|tfstate)|[^/]*(secret|credential|password|passwd|private[-_.]?key)[^/]*)$/i;

export function isSensitivePath(filePath) {
  return SENSITIVE_PATH_RE.test(String(filePath || ''));
}

export class GitLabClient {
  constructor({ host = 'git.wiit.one', token = null, fallback_tokens = [], group = '', onAuthError = null, onSuccess = null } = {}) {
    this.host = (host || 'git.wiit.one').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.token = token;
    this.fallbackTokens = fallback_tokens.filter((value) => typeof value === 'string' && value && value !== token);
    this.group = group;
    this.onAuthError = onAuthError;
    this.onSuccess = onSuccess;
    // Identity and token metadata belong to ONE credential: they are cached per
    // credential index and never shared between credentials.
    this.userCache = new Map();
    this.tokenInfoCache = new Map();
    this.baseUrl = `https://${this.host}/api/v4`;
    const escapedHost = this.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    this.escapedHost = escapedHost;
    this.mrUrlRegex = new RegExp(`https?:\\/\\/${escapedHost}\\/([\\w.\\/-]+?)\\/-\\/merge_requests\\/(\\d+)`, 'g');
    this.jobUrlRegex = new RegExp(`https?:\\/\\/${escapedHost}\\/([\\w.\\/-]+?)\\/-\\/jobs\\/(\\d+)`, 'g');
    this.pipelineUrlRegex = new RegExp(`https?:\\/\\/${escapedHost}\\/([\\w.\\/-]+?)\\/-\\/pipelines\\/(\\d+)`, 'g');
  }

  /** Number of configured credentials: the primary one (index 0) and the fallbacks. */
  get tokenCount() {
    return 1 + this.fallbackTokens.length;
  }

  /** The credential at `index` (0 is the primary token); undefined when there is none. */
  tokenAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.tokenCount) return undefined;
    return index === 0 ? this.token : this.fallbackTokens[index - 1];
  }

  /** `[0, 1, ...]` of the credentials to try, in order (a missing primary token still counts as index 0). */
  tokenIndices() {
    return Array.from({ length: this.tokenCount }, (_, index) => index);
  }

  /**
   * Account behind one credential (the primary one by default), or null when it
   * cannot be told. Never answered from another credential's identity.
   */
  async getCurrentUser({ tokenIndex = 0 } = {}) {
    if (!this.tokenAt(tokenIndex)) return null;
    const cached = this.userCache.get(tokenIndex);
    if (cached) return cached;
    try {
      const user = await this.request('user', { tokenIndex });
      this.userCache.set(tokenIndex, user);
      return user;
    } catch {
      return null;
    }
  }

  async verifyAuth(token = this.token) {
    if (!token) return false;
    try {
      const url = `${this.baseUrl}/user`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'teams-live/1.0',
          'PRIVATE-TOKEN': token,
        },
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return true;
    }
  }

  /** Metadata of one credential (the primary one by default). Never falls back to another credential. */
  async getTokenInfo({ tokenIndex = 0 } = {}) {
    if (!this.tokenAt(tokenIndex)) return null;
    const cached = this.tokenInfoCache.get(tokenIndex);
    if (cached && Date.now() - cached.at < 60_000) return cached.info;
    try {
      const info = await this.request('personal_access_tokens/self', { tokenIndex });
      this.tokenInfoCache.set(tokenIndex, { info, at: Date.now() });
      return info;
    } catch {
      return null;
    }
  }

  /**
   * Rotates one credential (the primary one by default) with that credential
   * itself. Sent once, never to another credential. Only the matching in-memory
   * token is replaced; persisting it is the caller's job.
   */
  async rotateToken({ tokenIndex = 0, expiresAt = null } = {}) {
    if (!this.tokenAt(tokenIndex)) throw new Error('Cannot rotate token: no token configured');
    const body = {};
    if (expiresAt) body.expires_at = expiresAt;
    const res = await this.request('personal_access_tokens/self/rotate', {
      method: 'POST',
      body: Object.keys(body).length > 0 ? body : null,
      tokenIndex,
    });
    if (res?.token) {
      if (tokenIndex === 0) this.token = res.token;
      else this.fallbackTokens[tokenIndex - 1] = res.token;
      this.tokenInfoCache.set(tokenIndex, { info: res, at: Date.now() });
      this.userCache.delete(tokenIndex);
    }
    return res;
  }

  /**
   * Sends a request. Which credential is used:
   * - `tokenIndex` set: exactly that credential, never another one (the caller
   *   has decided who acts, e.g. after showing that account to a person).
   * - the token's own endpoints (`user`, `personal_access_tokens/self*`): the
   *   primary credential only.
   * - otherwise the credentials are tried in order, moving on to the next one
   *   ONLY after a definite 404 (the answer of a credential that cannot see the
   *   resource; nothing was done). Any other outcome, a lost answer included,
   *   ends the attempt, so a write is never repeated under another identity.
   *   `fallback: false` pins a call to the primary credential.
   */
  async request(path, options = {}) {
    const { tokenIndex = null, fallback = true, ...rest } = options;
    if (tokenIndex !== null && tokenIndex !== undefined) {
      const token = this.tokenAt(tokenIndex);
      if (token === undefined) throw new Error(`GitLab credential ${tokenIndex} is not configured`);
      return await this.requestWithToken(path, { ...rest, token });
    }
    const cleanPath = path.replace(/^\/+/, '');
    const identityScoped = cleanPath === 'user' || cleanPath.startsWith('user?') || cleanPath.startsWith('personal_access_tokens/self');
    const indices = identityScoped || !fallback ? [0] : this.tokenIndices();
    for (let i = 0; i < indices.length; i++) {
      try {
        return await this.requestWithToken(path, { ...rest, token: this.tokenAt(indices[i]) });
      } catch (error) {
        if (error.status !== 404 || i === indices.length - 1) throw error;
      }
    }
  }

  async requestWithToken(path, { method = 'GET', body = null, timeoutMs = 30_000, retry = true, token = this.token } = {}) {
    const url = `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
    const headers = {
      'User-Agent': 'teams-live/1.0',
    };
    if (token) {
      headers['PRIVATE-TOKEN'] = token;
    }
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const makeFetch = () =>
      fetch(url, {
        method,
        headers,
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });

    let res;
    try {
      res = await makeFetch();
    } catch (err) {
      // A mutation that may already have landed must not be sent twice blindly.
      if (!retry || (method !== 'GET' && path !== '../graphql')) throw new Error(`GitLab request failed (${err.cause?.message || err.message})`);
      try {
        await new Promise((r) => setTimeout(r, 1000));
        res = await makeFetch();
      } catch (retryErr) {
        throw new Error(`GitLab request failed (${retryErr.cause?.message || retryErr.message})`);
      }
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let msg = errText;
      try {
        const parsed = JSON.parse(errText);
        msg = parsed.message || parsed.error || errText;
      } catch {
        // use raw text
      }
      const errStr = `GitLab error (${res.status}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`;
      if (res.status === 401 || res.status === 403) {
        const cleanPath = path.replace(/^\/+/, '');
        const isAuthProbe = cleanPath === 'user' || cleanPath.startsWith('user?') || cleanPath.startsWith('personal_access_tokens/self');
        if (isAuthProbe) {
          this.onAuthError?.(errStr);
        } else {
          // Double check token validity before raising an auth alarm.
          // Actions like author self-approval or forbidden endpoints return 401/403 even when the token is valid.
          const isStillValid = await this.verifyAuth(token).catch(() => true);
          if (!isStillValid) {
            this.onAuthError?.(errStr);
          }
        }
      }
      const error = new Error(errStr);
      error.status = res.status;
      throw error;
    }
    this.onSuccess?.('GitLab');
    if (res.status === 204) {
      return {};
    }
    return await res.json();
  }

  findMrLinks(text, { allowQuotes = false } = {}) {
    const results = [];
    if (!text) return results;

    const textToSearch = allowQuotes
      ? text
      : text
          .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
          .replace(/<div[^>]*itemtype="http:\/\/schema\.skype\.com\/Reply"[\s\S]*?<\/div>/gi, '');

    const seen = new Set();
    const seenBasenames = new Map();

    // 1. Full URLs (e.g. https://git.wiit.one/kubernetes/workload-clusters/-/merge_requests/596)
    for (const match of textToSearch.matchAll(this.mrUrlRegex)) {
      const project = match[1];
      const iid = match[2];
      const key = `${project}!${iid}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        const basename = project.split('/').pop().toLowerCase();
        if (!seenBasenames.has(basename)) seenBasenames.set(basename, new Set());
        seenBasenames.get(basename).add(String(iid));
        results.push({
          project,
          iid,
          url: match[0],
        });
      }
    }

    // 2. Shorthand references (e.g. workload-clusters!596, kubernetes/workload-clusters!596)
    const shorthandRegex = /(?:^|[^\w/.-])([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*)!(\d+)(?=[^\w]|$)/g;
    for (const match of textToSearch.matchAll(shorthandRegex)) {
      let project = match[1];
      const iid = match[2];
      const basename = project.split('/').pop().toLowerCase();

      // If a full URL for this repository basename and iid was already found, skip this shorthand duplicate
      if (seenBasenames.get(basename)?.has(String(iid))) {
        continue;
      }

      if (!project.includes('/') && this.group) {
        project = `${this.group}/${project}`;
      }
      const key = `${project}!${iid}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        if (!seenBasenames.has(basename)) seenBasenames.set(basename, new Set());
        seenBasenames.get(basename).add(String(iid));
        results.push({
          project,
          iid,
          url: this.mrLink(project, iid),
        });
      }
    }

    return results;
  }

  findJobLinks(text, { allowQuotes = false } = {}) {
    const results = [];
    if (!text) return results;

    const textToSearch = allowQuotes
      ? text
      : text
          .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
          .replace(/<div[^>]*itemtype="http:\/\/schema\.skype\.com\/Reply"[\s\S]*?<\/div>/gi, '');

    const seen = new Set();
    const regex = new RegExp(`https?:\\/\\/${this.escapedHost}\\/([\\w.\\/-]+?)\\/-\\/jobs\\/(\\d+)`, 'g');
    for (const match of textToSearch.matchAll(regex)) {
      const project = match[1];
      const jobId = match[2];
      const key = `${project}#job-${jobId}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          project,
          jobId,
          url: match[0],
        });
      }
    }
    return results;
  }

  findPipelineLinks(text, { allowQuotes = false } = {}) {
    const results = [];
    if (!text) return results;

    const textToSearch = allowQuotes
      ? text
      : text
          .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
          .replace(/<div[^>]*itemtype="http:\/\/schema\.skype\.com\/Reply"[\s\S]*?<\/div>/gi, '');

    const seen = new Set();
    const regex = new RegExp(`https?:\\/\\/${this.escapedHost}\\/([\\w.\\/-]+?)\\/-\\/pipelines\\/(\\d+)`, 'g');
    for (const match of textToSearch.matchAll(regex)) {
      const project = match[1];
      const pipelineId = match[2];
      const key = `${project}#pipeline-${pipelineId}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          project,
          pipelineId,
          url: match[0],
        });
      }
    }
    return results;
  }

  /**
   * Finds links to a line or a line range of a file (`.../-/blob/<ref>/<path>#L10`,
   * `#L10-20`, `#L10-L20`; also `<project>.git//blob/<ref>/<path>#L10`) on the configured GitLab host. A link without a line
   * anchor is not a code reference and is left out. The ref and the path cannot
   * be told apart from the URL alone (a branch name may contain slashes), so the
   * link carries them together as `refPath`; see getBlobPreview.
   */
  findBlobLinks(text, { allowQuotes = false } = {}) {
    const results = [];
    if (!text) return results;

    const textToSearch = allowQuotes
      ? text
      : text
          .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
          .replace(/<div[^>]*itemtype="http:\/\/schema\.skype\.com\/Reply"[\s\S]*?<\/div>/gi, '');

    const seen = new Set();
    const regex = new RegExp(
      `https?:\\/\\/${this.escapedHost}\\/([\\w.\\/-]+?)(?:\\/-)?\\/{1,2}blob\\/([^\\s"'<>#?]+)(?:\\?[^\\s"'<>#]*)?#L(\\d+)(?:-L?(\\d+))?(?!\\d)`,
      'g'
    );
    for (const match of textToSearch.matchAll(regex)) {
      const first = Number(match[3]);
      const last = match[4] === undefined ? first : Number(match[4]);
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < 1) continue;
      const startLine = Math.min(first, last);
      const endLine = Math.max(first, last);
      // `<project>.git//blob/...` (a trailing `.git` and a doubled slash) is accepted
      // next to the canonical `<project>/-/blob/...`; the API wants the bare project path.
      const project = match[1].replace(/\/+$/, '').replace(/\.git$/i, '');
      const refPath = match[2];
      if (!project) continue;
      const key = `${project}:${refPath}#L${startLine}-${endLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ project, refPath, startLine, endLine, key, url: match[0] });
    }
    return results;
  }

  /**
   * Reads a line range of a repository file through the configured GitLab API
   * (never by fetching the link itself). Returns null when there is nothing to
   * show: `restrictToGroup` is set and the project is outside the configured
   * group (off by default: the group scopes MR monitoring, and the token's own
   * permissions decide what can be read), the path looks like it holds credentials, the file or ref does not exist, or the file is binary or
   * too large. Other failures (network, auth) are thrown, so the caller may retry.
   *
   * `startLine`/`endLine` of the result are the requested lines that are shown
   * (capped by `maxLines`, clamped to the file); `lines` also holds the context
   * around them (see MIN_PREVIEW_LINES), each line flagged `requested`.
   */
  async getBlobPreview(link, { maxLines = 30, maxFileBytes = 1_000_000, restrictToGroup = false, onUnavailable = () => {} } = {}) {
    const unavailable = (reason) => {
      onUnavailable(reason);
      return null;
    };
    if (!link?.project || !link?.refPath) return unavailable('invalid project or file path');
    if (restrictToGroup && this.group) {
      const prefix = `${this.group.replace(/^\/+|\/+$/g, '')}/`.toLowerCase();
      if (!link.project.toLowerCase().startsWith(prefix)) return unavailable('project outside configured group');
    }

    let segments;
    try {
      segments = link.refPath.split('/').map((s) => decodeURIComponent(s));
    } catch {
      return unavailable('invalid URL encoding');
    }
    if (segments.some((s) => !s || s === '.' || s === '..' || s.includes('\0'))) return unavailable('invalid ref or file path');

    // The ref is the first segment, or the first few when the branch name has slashes.
    let file = null;
    let refName = null;
    let filePath = null;
    for (let i = 1; i < segments.length && i <= BLOB_MAX_REF_SEGMENTS; i++) {
      refName = segments.slice(0, i).join('/');
      filePath = segments.slice(i).join('/');
      if (isSensitivePath(filePath)) return unavailable('sensitive file path');
      try {
        file = await this.request(
          `projects/${encodeURIComponent(link.project)}/repository/files/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(refName)}`,
          { timeoutMs: 15_000 }
        );
        break;
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
    if (!file) return unavailable('GitLab returned 404 for all ref and file combinations; check access, ref, and path');
    if (typeof file.content !== 'string') return unavailable('GitLab response has no file content');
    if (file.encoding && file.encoding !== 'base64') return unavailable('unsupported file encoding');
    if (Number(file.size) > maxFileBytes) return unavailable('file exceeds size limit');

    const buffer = Buffer.from(file.content, 'base64');
    if (buffer.length > maxFileBytes) return unavailable('file exceeds size limit');
    if (buffer.includes(0)) return unavailable('binary file');
    const allLines = buffer.toString('utf8').replace(/\r\n?/g, '\n').split('\n');
    if (allLines.length > 0 && allLines.at(-1) === '') allLines.pop();

    const totalLines = allLines.length;
    if (link.startLine > totalLines) return unavailable(`requested line exceeds file length (${totalLines} lines)`);
    const cap = Math.max(1, Math.floor(maxLines));
    const startLine = link.startLine;
    const requestedEnd = Math.min(link.endLine, totalLines);
    const endLine = Math.min(requestedEnd, startLine + cap - 1);

    // A short range gets surrounding context up to MIN_PREVIEW_LINES (never more
    // than max_lines or the file has), split evenly before and after; a side
    // that hits the start or end of the file hands its share to the other one.
    const target = Math.min(MIN_PREVIEW_LINES, cap, totalLines);
    const extra = Math.max(0, target - (endLine - startLine + 1));
    const availBefore = startLine - 1;
    const availAfter = totalLines - endLine;
    let before = Math.min(Math.floor(extra / 2), availBefore);
    const after = Math.min(extra - before, availAfter);
    before = Math.min(extra - after, availBefore);

    const lines = [];
    for (let n = startLine - before; n <= endLine + after; n++) {
      lines.push({ n, text: allLines[n - 1], requested: n >= startLine && n <= endLine });
    }

    // The link of the preview is pinned to the commit the content was read from, so
    // it keeps showing these lines when the branch moves. Without a usable commit id
    // the original link is kept as is.
    const permalink = this.blobPermalink(link, filePath, file.commit_id);

    return {
      project: link.project,
      ref: refName,
      path: filePath,
      startLine,
      endLine,
      requestedEndLine: requestedEnd,
      totalLines,
      truncated: endLine < requestedEnd,
      contextBefore: before,
      contextAfter: after,
      lines,
      url: permalink ?? link.url,
      originalUrl: link.url,
      commitId: permalink ? file.commit_id : null,
    };
  }

  /**
   * Immutable `<project>/-/blob/<commit>/<path>#L<start>[-<end>]` link, or null when
   * `commitId` is not a full commit SHA. `commitId` must be the file API's `commit_id`
   * (the commit the requested ref resolved to when the content was served), not
   * `last_commit_id` (the last commit that touched the file, which is not the revision
   * that was read). The requested line range is kept, not the clamped or capped one.
   */
  blobPermalink(link, filePath, commitId) {
    if (typeof commitId !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commitId)) return null;
    const encode = (path) =>
      path
        .split('/')
        .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
        .join('/');
    const anchor = link.startLine === link.endLine ? `L${link.startLine}` : `L${link.startLine}-${link.endLine}`;
    return `https://${this.host}/${encode(link.project)}/-/blob/${commitId.toLowerCase()}/${encode(filePath)}#${anchor}`;
  }

  mrLink(project, iid) {
    return `https://${this.host}/${project}/-/merge_requests/${iid}`;
  }

  jobLink(project, jobId) {
    return `https://${this.host}/${project}/-/jobs/${jobId}`;
  }

  pipelineLink(project, pipelineId) {
    return `https://${this.host}/${project}/-/pipelines/${pipelineId}`;
  }

  async resolveProjectPath(projectOrName) {
    if (!projectOrName) return projectOrName;
    const parts = projectOrName.split('/');
    if (parts.length > 2) {
      return projectOrName;
    }
    const basename = parts.pop();
    const lower = basename.toLowerCase();

    if (!this.projectPathCache) this.projectPathCache = new Map();
    if (this.projectPathCache.has(lower)) {
      return this.projectPathCache.get(lower);
    }

    if (!this.group) return projectOrName;

    try {
      const res = await this.request(
        `groups/${encodeURIComponent(this.group)}/projects?include_subgroups=true&search=${encodeURIComponent(basename)}`
      );
      if (Array.isArray(res)) {
        const exact = res.find(
          (p) => p.path?.toLowerCase() === lower || p.name?.toLowerCase() === lower
        );
        if (exact) {
          const resolved = exact.path_with_namespace;
          this.projectPathCache.set(lower, resolved);
          return resolved;
        }
      }
    } catch {
      // fallback
    }

    return projectOrName.includes('/') ? projectOrName : `${this.group}/${projectOrName}`;
  }

  async getMr(project, iid, { tokenIndex = null } = {}) {
    return await this.request(
      `projects/${encodeURIComponent(project)}/merge_requests/${iid}?include_diverged_commits_count=true&include_rebase_in_progress=true`,
      { tokenIndex }
    );
  }

  /**
   * Reads a merge request and decides WHO acts on it: the first credential (in
   * order) that can see it, moving on only after a definite 404. Returns
   * `{mr, tokenIndex, user}`, `user` being the account behind exactly that
   * credential (null when it could not be told). Pass `tokenIndex` (and
   * `expectUserId`) to the write calls so the account that was shown is the one
   * that acts. Any error other than a 404 is thrown: it is not a reason to try
   * another identity.
   */
  async locateMr(project, iid) {
    const indices = this.tokenIndices();
    for (let i = 0; i < indices.length; i++) {
      let mr;
      try {
        mr = await this.getMr(project, iid, { tokenIndex: indices[i] });
      } catch (error) {
        if (error.status === 404 && i < indices.length - 1) continue;
        throw error;
      }
      const user = await this.getCurrentUser({ tokenIndex: indices[i] });
      return { mr, tokenIndex: indices[i], user: user?.id ? user : null };
    }
    return null;
  }

  /**
   * A write as one chosen credential. With `tokenIndex` the request goes out
   * under that credential only (never another), after checking that it still is
   * the account the caller showed (`expectUserId`): otherwise nothing is sent and
   * the error carries `identityMismatch`. Without `tokenIndex` the credentials
   * are tried in order after a definite 404 only (see `request`).
   */
  async writeAs(path, options, { tokenIndex = null, expectUserId = null } = {}) {
    if (tokenIndex === null || tokenIndex === undefined) return await this.request(path, options);
    if (expectUserId !== null && expectUserId !== undefined) {
      const user = await this.getCurrentUser({ tokenIndex });
      if (!user || String(user.id) !== String(expectUserId)) {
        const error = new Error('The GitLab account is not the one that was shown; nothing was sent');
        error.identityMismatch = true;
        throw error;
      }
    }
    return await this.request(path, { ...options, tokenIndex });
  }

  async approveMr(project, iid, { sha = null, tokenIndex = null, expectUserId = null } = {}) {
    const body = sha ? { sha } : {};
    return await this.writeAs(
      `projects/${encodeURIComponent(project)}/merge_requests/${iid}/approve`,
      { method: 'POST', body, retry: false },
      { tokenIndex, expectUserId }
    );
  }

  /**
   * The GitLab username of a person, found by their exact display name (accents and case ignored).
   * Only a single active match counts: a guess could mention a stranger. Cached; '' when unknown.
   */
  async findUsernameByName(name) {
    const norm = (v) => String(v ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const wanted = norm(name);
    if (!wanted) return '';
    this.usernameCache ??= new Map();
    const hit = this.usernameCache.get(wanted);
    if (hit && Date.now() - hit.at < (hit.username ? 3600_000 : 300_000)) return hit.username;
    let username = '';
    try {
      const users = await this.request(`users?search=${encodeURIComponent(String(name).trim())}&per_page=20`);
      const matches = (Array.isArray(users) ? users : []).filter((u) => u?.state === 'active' && norm(u.name) === wanted);
      if (matches.length === 1 && /^[A-Za-z0-9_.-]+$/.test(matches[0].username || '')) username = matches[0].username;
    } catch {
      return ''; // not cached: the next approval tries again
    }
    this.usernameCache.set(wanted, { username, at: Date.now() });
    return username;
  }

  /** Withdraws the approval of the account the bot approves as. Approvals of other people stay. */
  async unapproveMr(project, iid, { tokenIndex = null } = {}) {
    return await this.writeAs(
      `projects/${encodeURIComponent(project)}/merge_requests/${iid}/unapprove`,
      { method: 'POST', body: {}, retry: false },
      { tokenIndex }
    );
  }

  /** A comment on a merge request. Sent once (no retry): a duplicate comment is worse than a missing one. */
  async addMrNote(project, iid, body, { tokenIndex = null } = {}) {
    return await this.writeAs(
      `projects/${encodeURIComponent(project)}/merge_requests/${iid}/notes`,
      { method: 'POST', body: { body }, retry: false },
      { tokenIndex }
    );
  }

  async mergeMr(project, iid, {
    shouldRemoveSourceBranch = true,
    mergeWhenPipelineSucceeds = true,
    squash = null,
    sha = null,
  } = {}) {
    const body = {};
    if (shouldRemoveSourceBranch !== null) {
      body.should_remove_source_branch = shouldRemoveSourceBranch;
    }
    if (mergeWhenPipelineSucceeds !== null) {
      body.merge_when_pipeline_succeeds = mergeWhenPipelineSucceeds;
    }
    if (squash !== null) {
      body.squash = squash;
    }
    if (sha) {
      body.sha = sha;
    }
    return await this.request(
      `projects/${encodeURIComponent(project)}/merge_requests/${iid}/merge`,
      { method: 'PUT', body }
    );
  }

  /**
   * The merge behind the web "Merge" action: an immediate merge guarded by the
   * head commit and nothing else. Source-branch removal and squash are left to
   * the merge request's own settings (no parameter is sent), and auto-merge when
   * the pipeline succeeds is never requested: a merge that GitLab's rules do not
   * allow right now (approvals, pipeline, protected branch, conflicts, discussions)
   * is refused, there is no way to override them from here. Sent once, never
   * resent: a first attempt that landed must not be followed by a blind second
   * one, so an unanswered request is read back by the caller instead.
   */
  async mergeMrOnce(project, iid, { sha, tokenIndex = null, expectUserId = null }) {
    if (!sha) throw new Error('mergeMrOnce: the expected head commit (sha) is required');
    return await this.writeAs(
      `projects/${encodeURIComponent(project)}/merge_requests/${iid}/merge`,
      { method: 'PUT', body: { sha }, retry: false },
      { tokenIndex, expectUserId }
    );
  }

  async rebaseMr(project, iid, { skipCi = false } = {}) {
    return await this.request(
      `projects/${encodeURIComponent(project)}/merge_requests/${iid}/rebase`,
      { method: 'PUT', body: { skip_ci: skipCi } }
    );
  }

  async updateMr(project, iid, params = {}, { retry = true, tokenIndex = null, expectUserId = null } = {}) {
    return await this.writeAs(
      `projects/${encodeURIComponent(project)}/merge_requests/${iid}`,
      { method: 'PUT', body: params, retry },
      { tokenIndex, expectUserId }
    );
  }

  async closeMr(project, iid) {
    return await this.updateMr(project, iid, { state_event: 'close' });
  }

  async reopenMr(project, iid, { tokenIndex = null, expectUserId = null } = {}) {
    // Sent once: a first attempt that landed must not be followed by a blind
    // second one (its answer would be misread as a failure).
    return await this.updateMr(project, iid, { state_event: 'reopen' }, { retry: false, tokenIndex, expectUserId });
  }

  /**
   * Asks GitLab to rebase the source branch onto the target branch. Sent once and never retried: GitLab
   * answers 202 and rebases in the background (`rebase_in_progress`), so read the result back with getMr.
   */
  async rebaseMr(project, iid, { tokenIndex = null, expectUserId = null } = {}) {
    return await this.writeAs(
      `projects/${encodeURIComponent(project)}/merge_requests/${iid}/rebase`,
      { method: 'PUT', retry: false },
      { tokenIndex, expectUserId }
    );
  }

  async getApprovals(project, iid, { tokenIndex = null } = {}) {
    return await this.request(`projects/${encodeURIComponent(project)}/merge_requests/${iid}/approvals`, { tokenIndex });
  }

  /**
   * Approval state of the account an approval is made as:
   * `{known, user, hasApproved, canApprove, tokenIndex}`. The overall `approved`
   * flag is deliberately not used. `known` is false when the identity or the
   * approvals could not be retrieved. `canApprove` is null when GitLab does not
   * say. With `tokenIndex` only that credential is asked. Without, the
   * credentials are tried in order after a definite 404; identity and approvals
   * always come from the SAME credential, reported as `tokenIndex`.
   */
  async getUserApprovalState(project, iid, { tokenIndex = null } = {}) {
    const pinned = tokenIndex !== null && tokenIndex !== undefined;
    const indices = pinned ? [tokenIndex] : this.tokenIndices();
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i];
      const user = await this.getCurrentUser({ tokenIndex: index });
      if (!user?.id) return { known: false, user: null, hasApproved: false, canApprove: null, tokenIndex: index };
      let approvals;
      try {
        approvals = await this.getApprovals(project, iid, { tokenIndex: index });
      } catch (error) {
        if (error.status === 404 && i < indices.length - 1) continue;
        return { known: false, user, hasApproved: false, canApprove: null, tokenIndex: index };
      }
      if (!Array.isArray(approvals?.approved_by)) {
        return { known: false, user, hasApproved: false, canApprove: null, tokenIndex: index };
      }
      const ids = approvals.approved_by.map((a) => a.user?.id ?? a.id).filter((v) => v !== undefined && v !== null);
      const hasApproved = approvals.user_has_approved === true || ids.some((id) => String(id) === String(user.id));
      const canApprove = typeof approvals.user_can_approve === 'boolean' ? approvals.user_can_approve : null;
      return { known: true, user, hasApproved, canApprove, tokenIndex: index };
    }
    return { known: false, user: null, hasApproved: false, canApprove: null, tokenIndex: null };
  }

  /**
   * Approval state of a merge request as `{known, approved, approvedBy}`.
   * `known` is false when the approvals could not be retrieved, so callers can
   * tell "not approved" from "unknown".
   */
  async getApprovalSummary(project, iid) {
    try {
      const approvals = await this.getApprovals(project, iid);
      const approvedBy = Array.isArray(approvals?.approved_by)
        ? approvals.approved_by
            .map((a) => a.user?.name || a.user?.username || a.name || a.username)
            .filter(Boolean)
        : [];
      const required = typeof approvals?.approvals_required === 'number' ? approvals.approvals_required : 0;
      const approved = required > 0 ? Boolean(approvals.approved) : approvedBy.length > 0;
      return { known: true, approved, approvedBy, ...approvalCountsOf(approvals, approvedBy.length) };
    } catch {
      return { known: false, approved: false, approvedBy: [], approvalsGiven: null, approvalsRequired: null };
    }
  }

  /**
   * Open merge requests of the group. `enrich` adds pipeline and rebase data;
   * `approvals` additionally fetches the approval state of every merge request
   * (one request each) into `approval_summary`.
   */
  async getGroupMrs(group = null, { enrich = true, approvals = false } = {}) {
    const targetGroup = group || this.group;
    if (!targetGroup) {
      throw new Error('No GitLab group configured');
    }
    const endpoint = `groups/${encodeURIComponent(targetGroup)}/merge_requests?state=opened&wip=no&per_page=50&order_by=updated_at&sort=desc`;
    const mrs = await this.request(endpoint);
    if (!Array.isArray(mrs)) return [];
    const filtered = mrs.filter(
      (m) => !m.draft && !m.work_in_progress && !m.title.startsWith('Draft:') && !m.title.startsWith('WIP:')
    );

    if (!enrich || filtered.length === 0) {
      return filtered;
    }

    const enriched = await Promise.all(
      filtered.map(async (mr) => {
        let result = mr;
        try {
          const details = await this.getMr(mr.project_id, mr.iid);
          result = {
            ...mr,
            head_pipeline: details.head_pipeline || mr.head_pipeline || null,
            diverged_commits_count: details.diverged_commits_count ?? mr.diverged_commits_count ?? null,
            rebase_in_progress: details.rebase_in_progress ?? mr.rebase_in_progress ?? false,
            has_conflicts: details.has_conflicts ?? mr.has_conflicts ?? false,
            detailed_merge_status: details.detailed_merge_status || mr.detailed_merge_status,
            auto_merge_enabled: details.auto_merge_enabled ?? mr.auto_merge_enabled,
            merge_when_pipeline_succeeds:
              details.merge_when_pipeline_succeeds ?? mr.merge_when_pipeline_succeeds,
          };
        } catch {
          // keep the list data
        }
        if (approvals) {
          result = { ...result, approval_summary: await this.getApprovalSummary(mr.project_id, mr.iid) };
        }
        return result;
      })
    );

    return enriched;
  }

  async getPipelines(project, iid) {
    return await this.request(`projects/${encodeURIComponent(project)}/merge_requests/${iid}/pipelines?per_page=1`);
  }

  async getLatestPipeline(project, iid) {
    const pipelines = await this.getPipelines(project, iid);
    if (Array.isArray(pipelines) && pipelines.length > 0) {
      return pipelines[0];
    }
    return null;
  }

  async getPipeline(project, pipelineId) {
    return await this.request(`projects/${encodeURIComponent(project)}/pipelines/${pipelineId}`);
  }

  async getCommitMrs(project, sha) {
    if (!sha) return [];
    try {
      const res = await this.request(`projects/${encodeURIComponent(project)}/repository/commits/${sha}/merge_requests`);
      return Array.isArray(res) ? res : [];
    } catch {
      return [];
    }
  }

  async getMrForPipeline(project, pipeline) {
    if (!pipeline) return null;
    if (pipeline.sha) {
      const mrs = await this.getCommitMrs(project, pipeline.sha);
      if (mrs && mrs.length > 0) return mrs[0];
    }
    if (pipeline.ref) {
      try {
        const mrs = await this.request(
          `projects/${encodeURIComponent(project)}/merge_requests?source_branch=${encodeURIComponent(pipeline.ref)}&state=opened`
        );
        if (Array.isArray(mrs) && mrs.length > 0) return mrs[0];
      } catch {
        return null;
      }
    }
    return null;
  }

  async getJob(project, jobId) {
    return await this.request(`projects/${encodeURIComponent(project)}/jobs/${jobId}`);
  }

  async getMrForJob(project, jobData) {
    if (!jobData) return null;
    const sha = jobData.commit?.id || jobData.pipeline?.sha;
    if (sha) {
      const mrs = await this.getCommitMrs(project, sha);
      if (mrs && mrs.length > 0) return mrs[0];
    }
    if (jobData.ref) {
      try {
        const mrs = await this.request(
          `projects/${encodeURIComponent(project)}/merge_requests?source_branch=${encodeURIComponent(jobData.ref)}&state=opened`
        );
        if (Array.isArray(mrs) && mrs.length > 0) return mrs[0];
      } catch {
        return null;
      }
    }
    return null;
  }

  async getPipelineJobs(project, pipelineId) {
    return await this.request(`projects/${encodeURIComponent(project)}/pipelines/${pipelineId}/jobs?per_page=100`);
  }

  async retryPipeline(project, pipelineId) {
    return await this.request(
      `projects/${encodeURIComponent(project)}/pipelines/${pipelineId}/retry`,
      { method: 'POST' }
    );
  }

  /**
   * Retrieves combined MR status, rebase/conflict status, and latest pipeline state.
   */
  /**
   * Exact line totals of a merge request: `{additions, deletions, files}`, or
   * null when GitLab does not report them. The REST merge request has no line
   * totals (`changes_count` counts files), so this asks the GraphQL
   * `diffStatsSummary`, which is the `git diff --numstat` total of the whole
   * merge request. Anything that is not a pair of non-negative integers
   * (an error, a missing field, an older GitLab) is unknown: a total is never
   * guessed or summed from partial diffs. Results are cached per head commit
   * and base; failures are remembered briefly so a poll does not retry them.
   */
  async getMrDiffStats(project, iid, { sha = null, baseSha = null } = {}) {
    const key = `${String(project).toLowerCase()}!${iid}@${sha || ''}@${baseSha || ''}`;
    const cache = (this.diffStatsCache ??= new Map());
    const hit = cache.get(key);
    if (hit && (hit.stats || hit.until > Date.now())) return hit.stats;
    // One lookup per head commit at a time: concurrent card builds share it.
    const inflight = (this.diffStatsInflight ??= new Map());
    if (inflight.has(key)) return inflight.get(key);

    const lookup = (async () => {
      let stats = null;
      try {
        const res = await this.request('../graphql', {
          method: 'POST',
          timeoutMs: 8000,
          body: {
            query:
              'query($path: ID!, $iid: String!) { project(fullPath: $path) { mergeRequest(iid: $iid) { diffStatsSummary { additions deletions fileCount } } } }',
            variables: { path: String(project), iid: String(iid) },
          },
        });
        const summary = res?.data?.project?.mergeRequest?.diffStatsSummary;
        const isCount = (v) => Number.isInteger(v) && v >= 0;
        if (!res?.errors?.length && summary && isCount(summary.additions) && isCount(summary.deletions)) {
          stats = {
            additions: summary.additions,
            deletions: summary.deletions,
            files: isCount(summary.fileCount) ? summary.fileCount : null,
          };
        }
      } catch {
        stats = null;
      }
      if (cache.size >= 200) cache.delete(cache.keys().next().value);
      cache.set(key, { stats, until: Date.now() + 10 * 60 * 1000 });
      return stats;
    })().finally(() => inflight.delete(key));
    inflight.set(key, lookup);
    return lookup;
  }

  async getMrStatus(project, iid) {
    const mr = await this.getMr(project, iid);
    const state = mr.state; // 'opened' | 'merged' | 'closed'

    let approved = false;
    let approvedBy = [];
    let status = state;
    // true only when the approvals were retrieved; a failed lookup is unknown, not "not approved".
    // GitLab keeps answering for merged and closed merge requests, so their approvers are fetched too
    // (a card for an already merged merge request would otherwise never show who approved it).
    let approvalKnown = false;
    let approvalCounts = { approvalsGiven: null, approvalsRequired: null };
    const finished = state === 'merged' || state === 'closed';

    {
      try {
        const approvals = await this.getApprovals(project, iid);
        if (Array.isArray(approvals.approved_by)) {
          approvedBy = approvals.approved_by
            .map((a) => a.user?.name || a.user?.username || a.name || a.username)
            .filter(Boolean);
        }
        const approvalsRequired =
          typeof approvals.approvals_required === 'number' ? approvals.approvals_required : 0;
        approved = approvalsRequired > 0 ? Boolean(approvals.approved) : approvedBy.length > 0;
        if (!finished) status = approved ? 'approved' : 'pending';
        approvalKnown = true;
        approvalCounts = approvalCountsOf(approvals, approvedBy.length);
      } catch {
        if (!finished) status = 'pending';
      }
    }

    const detailedMergeStatus = mr.detailed_merge_status || mr.merge_status;
    const hasConflicts = mr.has_conflicts === true || detailedMergeStatus === 'conflict';
    const diverged = typeof mr.diverged_commits_count === 'number' && mr.diverged_commits_count > 0;
    const needsRebase =
      state === 'opened' &&
      (detailedMergeStatus === 'need_rebase' || hasConflicts || mr.should_be_rebased === true || diverged);

    const isDraft = Boolean(
      mr.draft ||
      mr.work_in_progress ||
      mr.title?.startsWith('Draft:') ||
      mr.title?.startsWith('WIP:') ||
      detailedMergeStatus === 'draft_status'
    );

    let latestPipeline = null;
    // true when the pipelines were retrieved (an empty list means "none"), false when the lookup failed.
    let pipelineKnown = false;
    try {
      const pipelines = await this.getPipelines(project, iid);
      pipelineKnown = Array.isArray(pipelines);
      if (Array.isArray(pipelines) && pipelines.length > 0) {
        latestPipeline = {
          id: pipelines[0].id,
          status: pipelines[0].status,
          web_url: pipelines[0].web_url,
          ref: pipelines[0].ref,
          sha: pipelines[0].sha,
        };
      }
    } catch {
      // Pipelines retrieval optional
    }

    return {
      project,
      iid,
      title: mr.title,
      // Display name of the author (the username when GitLab has no name).
      author: mr.author?.name || mr.author?.username || null,
      description: mr.description,
      source_branch: mr.source_branch,
      // Head commit of the merge request (what an approval is bound to).
      sha: mr.sha || mr.diff_refs?.head_sha || null,
      diffStats: await this.getMrDiffStats(project, iid, {
        sha: mr.sha || mr.diff_refs?.head_sha || null,
        baseSha: mr.diff_refs?.base_sha || null,
      }),
      draft: isDraft,
      web_url: mr.web_url,
      target_branch: mr.target_branch,
      state,
      approved,
      approvedBy,
      ...approvalCounts,
      approvalKnown,
      status, // 'pending' | 'approved' | 'merged' | 'closed'
      detailedMergeStatus,
      hasConflicts,
      needsRebase,
      pipeline: latestPipeline,
      pipelineKnown,
      // `merge_when_pipeline_succeeds` is deprecated in favour of
      // `auto_merge_enabled`; null when GitLab reports neither.
      autoMerge:
        typeof mr.auto_merge_enabled === 'boolean'
          ? mr.auto_merge_enabled
          : typeof mr.merge_when_pipeline_succeeds === 'boolean'
            ? mr.merge_when_pipeline_succeeds
            : null,
      autoMergeUser: mr.merge_user ? (mr.merge_user.name || mr.merge_user.username) : null,
      autoMergeStrategy: mr.auto_merge_strategy || null,
    };
  }

  /**
   * Every hook of the group. Pages of 100 until a short page; any failed page
   * throws, so a caller never acts on a partial list.
   */
  async listGroupHooks(group = null) {
    const targetGroup = group || this.group;
    if (!targetGroup) throw new Error('No GitLab group configured');
    const all = [];
    for (let page = 1; page <= 50; page++) {
      const batch = await this.request(`groups/${encodeURIComponent(targetGroup)}/hooks?per_page=100&page=${page}`, { fallback: false });
      if (!Array.isArray(batch)) throw new Error('GitLab returned an unexpected hook list');
      all.push(...batch);
      if (batch.length < 100) return all;
    }
    throw new Error('Too many group hook pages');
  }

  /** One hook, or null when it does not exist. */
  async getGroupHook(group = null, hookId) {
    const targetGroup = group || this.group;
    if (!targetGroup) throw new Error('No GitLab group configured');
    try {
      return await this.request(`groups/${encodeURIComponent(targetGroup)}/hooks/${hookId}`, { fallback: false });
    } catch (err) {
      if (/\(404\)/.test(err.message)) return null;
      throw err;
    }
  }

  /** Asks GitLab to send a sample delivery to the hook (not available everywhere). */
  async testGroupHook(group = null, hookId, trigger = 'merge_requests_events') {
    const targetGroup = group || this.group;
    if (!targetGroup) throw new Error('No GitLab group configured');
    return await this.request(`groups/${encodeURIComponent(targetGroup)}/hooks/${hookId}/test/${trigger}`, {
      method: 'POST',
      fallback: false,
    });
  }

  async addGroupHook(group = null, hookData) {
    const targetGroup = group || this.group;
    if (!targetGroup) throw new Error('No GitLab group configured');
    return await this.request(`groups/${encodeURIComponent(targetGroup)}/hooks`, {
      method: 'POST',
      body: hookData,
      fallback: false,
    });
  }

  async editGroupHook(group = null, hookId, hookData) {
    const targetGroup = group || this.group;
    if (!targetGroup) throw new Error('No GitLab group configured');
    return await this.request(`groups/${encodeURIComponent(targetGroup)}/hooks/${hookId}`, {
      method: 'PUT',
      body: hookData,
      fallback: false,
    });
  }

  async deleteGroupHook(group = null, hookId) {
    const targetGroup = group || this.group;
    if (!targetGroup) throw new Error('No GitLab group configured');
    return await this.request(`groups/${encodeURIComponent(targetGroup)}/hooks/${hookId}`, {
      method: 'DELETE',
      fallback: false,
    });
  }

  async getAwardEmojis(project, mrIid) {
    return await this.request(
      `projects/${encodeURIComponent(project)}/merge_requests/${mrIid}/award_emoji?per_page=100`,
      { fallback: false }
    );
  }

  async awardEmoji(project, mrIid, name) {
    return await this.request(
      `projects/${encodeURIComponent(project)}/merge_requests/${mrIid}/award_emoji`,
      {
        method: 'POST',
        body: { name },
        fallback: false,
      }
    );
  }

  async deleteAwardEmoji(project, mrIid, awardId) {
    return await this.request(
      `projects/${encodeURIComponent(project)}/merge_requests/${mrIid}/award_emoji/${awardId}`,
      { method: 'DELETE', fallback: false }
    );
  }
}

export function formatTokenExpiry(tokenData) {
  if (!tokenData) return null;
  if (!tokenData.expires_at) {
    return 'No expiration configured';
  }

  const expireDate = new Date(`${tokenData.expires_at}T23:59:59Z`);
  const now = new Date();
  const diffMs = expireDate.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    const daysAgo = Math.abs(diffDays);
    return `⚠️ Expired on ${tokenData.expires_at} (${daysAgo} day${daysAgo === 1 ? '' : 's'} ago)`;
  }
  if (diffDays === 0) {
    return `⚠️ Expires today (${tokenData.expires_at})`;
  }
  if (diffDays === 1) {
    return `⚠️ Expires tomorrow (${tokenData.expires_at})`;
  }
  if (diffDays <= 7) {
    return `⚠️ Expires in ${diffDays} days (${tokenData.expires_at})`;
  }
  return `Expires in ${diffDays} days (${tokenData.expires_at})`;
}
