import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Manages the GitLab group webhook that delivers events to this service.
 *
 * Ownership. A hook is ours only when its description carries the marker
 * `teams-live-owner:<owner uuid> gen:<generation uuid> v1`. The owner uuid is
 * created once, persisted in the state file and never shown anywhere else, so
 * nobody can claim our hooks by guessing a name. The configured URL alone never
 * adopts an existing hook, and a foreign or unmarked hook is never modified
 * or deleted. The only way to take over such a hook is the explicit
 * `adopt_hooks: [{id, url}]` setting, and even then it is re-read and must
 * still match the exact URL and carry no marker of someone else.
 *
 * Hostname changes. A hook's URL is never changed (no PUT of the URL). A new
 * URL creates a REPLACEMENT hook with its own generation; the old hook stays
 * until the replacement has proven itself by an authenticated delivery, and
 * only then it is deleted. Several hooks of this owner are therefore an
 * expected state during a migration.
 *
 * Proof. Every managed hook gets its own token, derived with an HMAC from the
 * configured secret, the owner and the generation. The receiver accepts these
 * tokens (see `acceptedTokens`) and reports which generation delivered. That
 * shows the replacement can reach this receiver with its own token; it proves
 * the generation, not the network path of any particular sender. The shared
 * secret itself is accepted only while a tracked legacy (adopted) hook exists.
 *
 * Safety. Cleanup needs a strong secret and management enabled. Any listing
 * error means no change in that run. Every deletion re-reads the replacement
 * and the stale hook and compares id, URL and marker first, a 404 counts as
 * done, at most `maxDeletes` hooks go per run, and the state file records the
 * plan before each destructive step.
 */

export const MIN_SECRET_LENGTH = 32;

const MARKER_RE = /(?:^|\s)teams-live-owner:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) gen:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) v1(?:\s|$)/;
const TOKEN_DOMAIN = 'teams-live/webhook-generation-token/v1';
const FINGERPRINT_DOMAIN = 'teams-live/webhook-secret-fingerprint/v1';
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const MAX_STALE = 20;

export function isStrongSecret(secret) {
  return typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH;
}

// Length-prefixed fields: no two different field lists serialize identically.
function canonical(fields) {
  return fields.map((f) => `${Buffer.byteLength(String(f))}:${f}`).join('|');
}

export function deriveGenerationToken(secret, ownerId, genId) {
  return crypto.createHmac('sha256', secret).update(canonical([TOKEN_DOMAIN, ownerId, genId])).digest('base64url');
}

function secretFingerprint(secret, ownerId) {
  return crypto.createHmac('sha256', secret).update(canonical([FINGERPRINT_DOMAIN, ownerId])).digest('hex').slice(0, 32);
}

export function parseMarker(hook) {
  const m = MARKER_RE.exec(String(hook?.description ?? ''));
  return m ? { ownerId: m[1], genId: m[2] } : null;
}

function markerText(ownerId, genId) {
  return `teams-live-owner:${ownerId} gen:${genId} v1`;
}

const isNotFound = (err) => /\(404\)/.test(String(err?.message || ''));

export class WebhookReconciler {
  constructor({
    gitlab,
    group = null,
    url,
    secret = null,
    stateFile,
    events = {},
    adoptHooks = [],
    acceptSharedSecret = false,
    testDelivery = true,
    maxDeletes = 3,
    intervalMs = 10 * 60 * 1000,
    log = () => {},
  } = {}) {
    this.gitlab = gitlab;
    this.group = group || gitlab?.group || null;
    this.url = String(url || '').trim();
    this.secret = secret ? String(secret).trim() : null;
    this.managed = isStrongSecret(this.secret);
    this.stateFile = stateFile;
    this.events = events;
    this.adoptHooks = Array.isArray(adoptHooks) ? adoptHooks : [];
    this.acceptSharedSecret = Boolean(acceptSharedSecret);
    this.testDelivery = testDelivery !== false;
    this.maxDeletes = Math.max(1, Number(maxDeletes) || 3);
    this.intervalMs = intervalMs;
    this.log = log;
    this.state = null;
    this.chain = Promise.resolve();
    this.timer = null;
    this.lastStatus = null;
    this.onStatus = null;
  }

  // ---------------------------------------------------------------- state

  loadState() {
    if (this.state) return this.state;
    let state = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (parsed && parsed.version === 1 && typeof parsed.ownerId === 'string') state = parsed;
    } catch {
      state = null;
    }
    this.state = {
      version: 1,
      ownerId: state?.ownerId || crypto.randomUUID(),
      secretFp: state?.secretFp ?? null,
      current: state?.current ?? null,
      replacement: state?.replacement ?? null,
      stale: Array.isArray(state?.stale) ? state.stale : [],
    };
    if (!state) this.saveState();
    return this.state;
  }

  saveState() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
    try {
      fs.chmodSync(this.stateFile, 0o600);
    } catch {
      // best effort
    }
  }

  // ------------------------------------------------------------- receiver

  /**
   * Tokens the receiver accepts, each with the generation it proves (or null).
   * Evaluated per request, so a change of the state is effective at once.
   */
  acceptedTokens() {
    const out = [];
    if (!this.secret) return out;
    const state = this.state || this.loadState();
    if (this.managed) {
      const gens = [state.current, state.replacement, ...state.stale].filter((h) => h && h.genId && !h.legacy);
      for (const h of gens) out.push({ token: deriveGenerationToken(this.secret, state.ownerId, h.genId), genId: h.genId });
    }
    const legacy = Boolean(state.current?.legacy) || state.stale.some((h) => h.legacy);
    if (!this.managed || legacy || this.acceptSharedSecret) out.push({ token: this.secret, genId: null });
    return out;
  }

  /** The receiver saw an authenticated delivery of this generation. */
  noteDelivery(genId) {
    const state = this.state;
    if (!genId || !state?.replacement || state.replacement.genId !== genId || state.replacement.verifiedAt) return;
    state.replacement.verifiedAt = Date.now();
    this.saveState();
    this.log('A replacement webhook delivered an authenticated event; cleaning up superseded hooks');
    setTimeout(() => this.reconcile().catch(() => {}), 1000).unref?.();
  }

  // ----------------------------------------------------------------- run

  async start() {
    const status = await this.reconcile();
    if (this.intervalMs > 0) {
      this.timer = setInterval(() => this.reconcile().catch(() => {}), this.intervalMs);
      this.timer.unref?.();
    }
    return status;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  reconcile() {
    const run = this.chain.then(() => this.#reconcile());
    this.chain = run.catch(() => {});
    return run.then((status) => {
      this.lastStatus = status;
      try {
        this.onStatus?.(status);
      } catch {
        // status display only
      }
      return status;
    });
  }

  #status(fields) {
    const state = this.state;
    const trackedStale = state?.stale?.length ?? 0;
    return {
      ok: true,
      action: 'unchanged',
      hook: null,
      url: this.url,
      group: this.group,
      managed: this.managed,
      pendingCleanup: trackedStale,
      awaitingDelivery: Boolean(state?.replacement && !state.replacement.verifiedAt && trackedStale > 0),
      ...fields,
    };
  }

  #fail(message) {
    return this.#status({ ok: false, action: 'error', error: message });
  }

  async #reconcile() {
    if (!this.url || !this.group || !this.gitlab?.token) return this.#fail('webhook URL, group or token missing');
    let state;
    try {
      state = this.loadState();
    } catch (err) {
      return this.#fail(`state file unusable: ${err.message}`);
    }

    // Rotation of the source secret: every derived token is void, so the
    // generations tracked so far are superseded like after a hostname change.
    if (this.managed) {
      const fp = secretFingerprint(this.secret, state.ownerId);
      if (state.secretFp && state.secretFp !== fp) {
        this.#supersede(state.current, 'secret-rotated', true);
        this.#supersede(state.replacement, 'secret-rotated', true);
        state.current = null;
        state.replacement = null;
        this.log('The webhook secret changed; the managed hook is replaced by a new generation');
      }
      if (state.secretFp !== fp) {
        state.secretFp = fp;
        this.saveState();
      }
    }

    let hooks;
    try {
      hooks = await this.gitlab.listGroupHooks(this.group);
    } catch (err) {
      return this.#fail(`could not list group hooks, nothing changed: ${err.message}`);
    }
    const live = new Map(hooks.map((h) => [h.id, h]));
    const ours = (hook, genId) => {
      const marker = parseMarker(hook);
      return Boolean(marker && marker.ownerId === state.ownerId && (genId === undefined || marker.genId === genId));
    };

    try {
      await this.#adopt(live);

      // A crash between "persist the generation" and "persist the id".
      const rep = state.replacement;
      if (rep && rep.id == null) {
        const found = hooks.find((h) => ours(h, rep.genId));
        if (found) {
          rep.id = found.id;
          this.saveState();
        }
      }

      // Tracked hooks must still be what we recorded.
      for (const slot of ['current', 'replacement']) {
        const entry = state[slot];
        if (!entry || entry.id == null) continue;
        const hook = live.get(entry.id);
        if (!hook) {
          this.log(`The tracked webhook ${entry.id} no longer exists`);
          state[slot] = null;
          this.saveState();
          continue;
        }
        if (hook.url !== entry.url) return this.#fail(`webhook ${entry.id} was changed outside of teams-live (URL differs); not touching anything`);
        if (!entry.legacy && !ours(hook, entry.genId)) return this.#fail(`webhook ${entry.id} lost its ownership marker; not touching anything`);
        if (entry.legacy && parseMarker(hook) && !ours(hook)) return this.#fail(`adopted webhook ${entry.id} now belongs to someone else; not touching anything`);
      }
      state.stale = state.stale.filter((s) => live.has(s.id));

      // Every hook of ours on the configured URL must be one we track.
      const tracked = [state.current, state.replacement, ...state.stale].filter(Boolean);
      const unexplained = hooks.filter((h) => {
        const marker = h.url === this.url ? parseMarker(h) : null;
        return marker && marker.ownerId === state.ownerId && !tracked.some((t) => t.id === h.id && t.genId === marker.genId);
      });
      if (unexplained.length > 0) return this.#fail('an unexplained hook of this installation uses the configured URL; resolve by hand');

      let action = 'unchanged';
      let hook = this.#tracked(live);

      if (!state.current || state.current.url !== this.url) {
        if (state.replacement && state.replacement.url !== this.url) {
          this.#supersede(state.replacement, 'superseded', this.managed);
          state.replacement = null;
        }
        if (state.current && state.current.url !== this.url) {
          this.#supersede(state.current, 'url-changed', this.managed);
          state.current = null;
        }
        this.saveState();
        if (!state.replacement || state.replacement.id == null) {
          hook = await this.#createReplacement(hooks);
          action = 'created';
        }
      } else if (this.#settingsDiffer(hook)) {
        hook = await this.#updateSettings(state.current.id, hook);
        action = 'updated';
      }

      if (this.managed) await this.#cleanup();
      this.#promote();
      return this.#status({ action, hook: hook ? { id: hook.id } : this.#trackedRef() });
    } catch (err) {
      this.log(`GitLab group webhook reconciliation failed: ${err.message}`);
      return this.#fail(err.message);
    }
  }

  #trackedRef() {
    const entry = this.state.replacement?.id != null ? this.state.replacement : this.state.current;
    return entry?.id != null ? { id: entry.id } : null;
  }

  #tracked(live) {
    const entry = this.state.current?.url === this.url ? this.state.current : this.state.replacement;
    return entry?.id != null ? live.get(entry.id) || null : null;
  }

  #supersede(entry, reason, track) {
    if (!entry || entry.id == null || !track) return;
    if (this.state.stale.some((s) => s.id === entry.id)) return;
    this.state.stale.push({ id: entry.id, url: entry.url, genId: entry.genId ?? null, legacy: Boolean(entry.legacy), reason });
    if (this.state.stale.length > MAX_STALE) this.state.stale.splice(0, this.state.stale.length - MAX_STALE);
  }

  #promote() {
    const state = this.state;
    const rep = state.replacement;
    if (!rep || rep.id == null || rep.url !== this.url) return;
    // Nothing to wait for when nothing is superseded; otherwise the proof and
    // the cleanup come first.
    if (state.stale.length === 0 && (rep.verifiedAt || !state.current)) {
      state.current = { id: rep.id, url: rep.url, genId: rep.genId, legacy: false };
      state.replacement = null;
      this.saveState();
    }
  }

  async #adopt(live) {
    const state = this.state;
    for (const entry of this.adoptHooks) {
      const tracked = [state.current, state.replacement, ...state.stale].some((h) => h && h.id === entry.id);
      if (tracked) continue;
      let hook = live.get(entry.id);
      if (!hook) {
        this.log(`adopt_hooks: hook ${entry.id} not found`);
        continue;
      }
      // The listing could be stale by now: read it again before trusting it.
      hook = await this.gitlab.getGroupHook(this.group, entry.id);
      if (!hook || hook.url !== entry.url) {
        this.log(`adopt_hooks: hook ${entry.id} does not have the expected URL; not adopting it`);
        continue;
      }
      if (parseMarker(hook)) {
        this.log(`adopt_hooks: hook ${entry.id} carries an ownership marker; not adopting it`);
        continue;
      }
      if (entry.url === this.url && !state.current) {
        state.current = { id: entry.id, url: entry.url, genId: null, legacy: true };
        this.log(`Adopted webhook ${entry.id} (shared secret)`);
      } else if (entry.url !== this.url) {
        state.stale.push({ id: entry.id, url: entry.url, genId: null, legacy: true, reason: 'adopted' });
        this.log(`Tracking webhook ${entry.id} for removal once its replacement delivers`);
      } else {
        continue;
      }
      this.saveState();
    }
  }

  #hookBody(token, marker = null) {
    const body = {
      url: this.url,
      merge_requests_events: this.events.merge_requests ?? true,
      pipeline_events: this.events.pipeline ?? true,
      job_events: this.events.job ?? false,
      note_events: this.events.note ?? false,
      enable_ssl_verification: this.events.enable_ssl_verification ?? true,
    };
    if (token) body.token = token;
    if (marker) {
      body.name = marker.name;
      body.description = marker.description;
    }
    return body;
  }

  #settingsDiffer(hook) {
    if (!hook) return false;
    const want = this.#hookBody(null);
    return ['merge_requests_events', 'pipeline_events', 'enable_ssl_verification'].some((k) => hook[k] !== want[k]);
  }

  // Only the event flags change; the URL and the token stay as they are.
  async #updateSettings(id, hook) {
    const want = this.#hookBody(null);
    const body = {
      url: hook.url,
      merge_requests_events: want.merge_requests_events,
      pipeline_events: want.pipeline_events,
      enable_ssl_verification: want.enable_ssl_verification,
    };
    return await this.gitlab.editGroupHook(this.group, id, body);
  }

  async #createReplacement(hooks) {
    const state = this.state;
    if (hooks.some((h) => h.url === this.url && !parseMarker(h) && !state.current)) {
      this.log('A hook without an ownership marker already uses the configured URL; it is left alone and a separate hook is created (list it in adopt_hooks to take it over)');
    }
    const genId = state.replacement?.genId || crypto.randomUUID();
    // The generation is persisted, and so known to the receiver, before the
    // hook exists: its first delivery cannot be rejected.
    state.replacement = { id: null, url: this.url, genId, verifiedAt: null, createdAt: Date.now() };
    this.saveState();

    const token = this.managed ? deriveGenerationToken(this.secret, state.ownerId, genId) : this.secret;
    const description = markerText(state.ownerId, genId);
    const created = await this.gitlab.addGroupHook(this.group, this.#hookBody(token, { name: `teams-live ${genId.slice(0, 8)}`, description }));
    if (!created || !Number.isInteger(created.id)) throw new Error('GitLab did not return the id of the new hook');
    state.replacement.id = created.id;
    this.saveState();
    if (parseMarker(created)?.genId !== genId) {
      throw new Error('GitLab did not keep the ownership marker of the new hook; automatic cleanup is off for it');
    }
    this.log(`Created webhook ${created.id} for ${this.url}`);
    if (this.managed && this.testDelivery) {
      // Best effort: older GitLab versions have no test endpoint.
      await this.gitlab.testGroupHook(this.group, created.id).catch(() => {});
    }
    return created;
  }

  async #cleanup() {
    const state = this.state;
    const rep = state.replacement;
    if (!state.stale.length || !rep || !rep.verifiedAt || rep.id == null || rep.url !== this.url) return;
    let deleted = 0;
    for (const stale of [...state.stale]) {
      if (deleted >= this.maxDeletes) {
        this.log(`Cleanup limit reached (${this.maxDeletes} per run); ${state.stale.length} superseded hook(s) remain`);
        break;
      }
      // The replacement must still be the verified one.
      const replacement = await this.gitlab.getGroupHook(this.group, rep.id);
      const marker = replacement ? parseMarker(replacement) : null;
      if (!replacement || replacement.url !== this.url || !marker || marker.ownerId !== state.ownerId || marker.genId !== rep.genId) {
        this.log('The replacement webhook is no longer as verified; superseded hooks are kept');
        return;
      }
      const hook = await this.gitlab.getGroupHook(this.group, stale.id);
      if (!hook) {
        state.stale = state.stale.filter((s) => s.id !== stale.id);
        this.saveState();
        continue;
      }
      const m = parseMarker(hook);
      const matches = stale.legacy
        ? hook.url === stale.url && !m
        : hook.url === stale.url && m && m.ownerId === state.ownerId && m.genId === stale.genId;
      if (!matches || hook.id === rep.id) {
        this.log(`Superseded webhook ${stale.id} changed since it was recorded; not deleting it`);
        state.stale = state.stale.filter((s) => s.id !== stale.id);
        this.saveState();
        continue;
      }
      try {
        await this.gitlab.deleteGroupHook(this.group, stale.id);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      state.stale = state.stale.filter((s) => s.id !== stale.id);
      this.saveState();
      deleted++;
      this.log(`Deleted superseded webhook ${stale.id} (${stale.reason})`);
    }
  }
}
