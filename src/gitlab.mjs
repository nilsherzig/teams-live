import './test-guard.mjs';
export class GitLabClient {
  constructor({ host = 'git.wiit.one', token = null, group = '', onAuthError = null, onSuccess = null } = {}) {
    this.host = (host || 'git.wiit.one').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.token = token;
    this.group = group;
    this.onAuthError = onAuthError;
    this.onSuccess = onSuccess;
    this.currentUser = null;
    this.baseUrl = `https://${this.host}/api/v4`;
    const escapedHost = this.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    this.escapedHost = escapedHost;
    this.mrUrlRegex = new RegExp(`https?:\\/\\/${escapedHost}\\/([\\w.\\/-]+?)\\/-\\/merge_requests\\/(\\d+)`, 'g');
    this.jobUrlRegex = new RegExp(`https?:\\/\\/${escapedHost}\\/([\\w.\\/-]+?)\\/-\\/jobs\\/(\\d+)`, 'g');
    this.pipelineUrlRegex = new RegExp(`https?:\\/\\/${escapedHost}\\/([\\w.\\/-]+?)\\/-\\/pipelines\\/(\\d+)`, 'g');
  }

  async getCurrentUser() {
    if (this.currentUser) return this.currentUser;
    if (!this.token) return null;
    try {
      this.currentUser = await this.request('user');
      return this.currentUser;
    } catch {
      return null;
    }
  }

  async verifyAuth() {
    if (!this.token) return false;
    try {
      const url = `${this.baseUrl}/user`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'teams-live/1.0',
          'PRIVATE-TOKEN': this.token,
        },
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return true;
    }
  }

  async getTokenInfo() {
    if (!this.token) return null;
    if (this._tokenInfo && Date.now() - (this._tokenInfoFetchedAt || 0) < 60_000) {
      return this._tokenInfo;
    }
    try {
      const info = await this.request('personal_access_tokens/self');
      this._tokenInfo = info;
      this._tokenInfoFetchedAt = Date.now();
      return info;
    } catch {
      return null;
    }
  }

  async rotateToken({ expiresAt = null } = {}) {
    if (!this.token) throw new Error('Cannot rotate token: no token configured');
    const body = {};
    if (expiresAt) body.expires_at = expiresAt;
    const res = await this.request('personal_access_tokens/self/rotate', {
      method: 'POST',
      body: Object.keys(body).length > 0 ? body : null,
    });
    if (res?.token) {
      this.token = res.token;
      this._tokenInfo = res;
      this._tokenInfoFetchedAt = Date.now();
      this.currentUser = null;
    }
    return res;
  }

  async request(path, { method = 'GET', body = null, timeoutMs = 30_000, retry = true } = {}) {
    const url = `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
    const headers = {
      'User-Agent': 'teams-live/1.0',
    };
    if (this.token) {
      headers['PRIVATE-TOKEN'] = this.token;
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
      if (!retry) throw new Error(`GitLab request failed (${err.cause?.message || err.message})`);
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
          const isStillValid = await this.verifyAuth().catch(() => true);
          if (!isStillValid) {
            this.onAuthError?.(errStr);
          }
        }
      }
      throw new Error(errStr);
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

  async getMr(project, iid) {
    return await this.request(
      `projects/${encodeURIComponent(project)}/merge_requests/${iid}?include_diverged_commits_count=true&include_rebase_in_progress=true`
    );
  }

  async approveMr(project, iid, { sha = null } = {}) {
    const body = sha ? { sha } : {};
    return await this.request(
      `projects/${encodeURIComponent(project)}/merge_requests/${iid}/approve`,
      { method: 'POST', body, retry: false }
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

  async rebaseMr(project, iid, { skipCi = false } = {}) {
    return await this.request(
      `projects/${encodeURIComponent(project)}/merge_requests/${iid}/rebase`,
      { method: 'PUT', body: { skip_ci: skipCi } }
    );
  }

  async updateMr(project, iid, params = {}) {
    return await this.request(
      `projects/${encodeURIComponent(project)}/merge_requests/${iid}`,
      { method: 'PUT', body: params }
    );
  }

  async closeMr(project, iid) {
    return await this.updateMr(project, iid, { state_event: 'close' });
  }

  async reopenMr(project, iid) {
    return await this.updateMr(project, iid, { state_event: 'reopen' });
  }

  async getApprovals(project, iid) {
    return await this.request(`projects/${encodeURIComponent(project)}/merge_requests/${iid}/approvals`);
  }

  /**
   * Approval state of the token user (the identity an approval is made as):
   * `{known, user, hasApproved, canApprove}`. The overall `approved` flag is
   * deliberately not used. `known` is false when the identity or the approvals
   * could not be retrieved. `canApprove` is null when GitLab does not say.
   */
  async getUserApprovalState(project, iid) {
    const user = await this.getCurrentUser();
    if (!user?.id) return { known: false, user: null, hasApproved: false, canApprove: null };
    let approvals;
    try {
      approvals = await this.getApprovals(project, iid);
    } catch {
      return { known: false, user, hasApproved: false, canApprove: null };
    }
    if (!Array.isArray(approvals?.approved_by)) {
      return { known: false, user, hasApproved: false, canApprove: null };
    }
    const ids = approvals.approved_by.map((a) => a.user?.id ?? a.id).filter((v) => v !== undefined && v !== null);
    const hasApproved = approvals.user_has_approved === true || ids.some((id) => String(id) === String(user.id));
    const canApprove = typeof approvals.user_can_approve === 'boolean' ? approvals.user_can_approve : null;
    return { known: true, user, hasApproved, canApprove };
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
      return { known: true, approved, approvedBy };
    } catch {
      return { known: false, approved: false, approvedBy: [] };
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
    // true only when the approvals were retrieved; merged/closed merge requests
    // and failed lookups are unknown, not "not approved".
    let approvalKnown = false;

    if (state !== 'merged' && state !== 'closed') {
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
        status = approved ? 'approved' : 'pending';
        approvalKnown = true;
      } catch {
        status = 'pending';
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
      const batch = await this.request(`groups/${encodeURIComponent(targetGroup)}/hooks?per_page=100&page=${page}`);
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
      return await this.request(`groups/${encodeURIComponent(targetGroup)}/hooks/${hookId}`);
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
    });
  }

  async addGroupHook(group = null, hookData) {
    const targetGroup = group || this.group;
    if (!targetGroup) throw new Error('No GitLab group configured');
    return await this.request(`groups/${encodeURIComponent(targetGroup)}/hooks`, {
      method: 'POST',
      body: hookData,
    });
  }

  async editGroupHook(group = null, hookId, hookData) {
    const targetGroup = group || this.group;
    if (!targetGroup) throw new Error('No GitLab group configured');
    return await this.request(`groups/${encodeURIComponent(targetGroup)}/hooks/${hookId}`, {
      method: 'PUT',
      body: hookData,
    });
  }

  async deleteGroupHook(group = null, hookId) {
    const targetGroup = group || this.group;
    if (!targetGroup) throw new Error('No GitLab group configured');
    return await this.request(`groups/${encodeURIComponent(targetGroup)}/hooks/${hookId}`, {
      method: 'DELETE',
    });
  }

  async getAwardEmojis(project, mrIid) {
    return await this.request(
      `projects/${encodeURIComponent(project)}/merge_requests/${mrIid}/award_emoji?per_page=100`
    );
  }

  async awardEmoji(project, mrIid, name) {
    return await this.request(
      `projects/${encodeURIComponent(project)}/merge_requests/${mrIid}/award_emoji`,
      {
        method: 'POST',
        body: { name },
      }
    );
  }

  async deleteAwardEmoji(project, mrIid, awardId) {
    return await this.request(
      `projects/${encodeURIComponent(project)}/merge_requests/${mrIid}/award_emoji/${awardId}`,
      { method: 'DELETE' }
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
