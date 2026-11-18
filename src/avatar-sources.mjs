/**
 * Fallback profile pictures for cards: Jira and Confluence.
 *
 * Used by AvatarService (avatars.mjs) only when Teams has no picture for a
 * person. Same rules as there: identity matching is strict (an exact, unique
 * match, otherwise "no picture", never somebody else's face), the pictures are
 * fetched with the credentials teams-live already has for that service, only
 * from that service's own origin, never through a redirect, and nothing (URL,
 * token, user name) is logged. The AvatarService validates the image (type,
 * pixel size, byte cap) and caches the result.
 *
 * A source resolves to `{ kind: 'photo', bytes }` or `{ kind: 'none' }` and
 * throws an Error without URL or token (`status 503`, `network`) on failure.
 *
 *  - Jira: `user/search` by the full display name (or an e-mail address). Only
 *    an exact, unique, active user counts, and only a picture the person
 *    uploaded: users without one all share the instance's default avatar, whose
 *    URL carries no `ownerId`.
 *  - Confluence: looked up by the username of the Jira user (same directory),
 *    only when the profile picture is not the default one.
 */

import { readCapped } from './avatars.mjs';

const norm = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const SEARCH_LIMIT = 10;

/** True when `target` is on the same origin as `base`. */
function sameOrigin(base, target) {
  try {
    return new URL(target, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/**
 * Downloads one image from `url` with the bearer token. Same origin as `base`
 * only, no redirects, capped. `{ kind: 'photo', bytes }` or `{ kind: 'none' }`.
 */
async function fetchImage({ base, url, token, fetchFn, timeoutMs, maxBytes }) {
  if (!sameOrigin(base, url)) return { kind: 'none' };
  let res;
  try {
    res = await fetchFn(new URL(url, base).href, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'image/*', 'User-Agent': 'teams-live/1.0' },
      // The Authorization header must not follow a redirect to another host.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('network');
  }
  if (res.status === 404) return { kind: 'none' };
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (!type.startsWith('image/png') && !type.startsWith('image/jpeg')) return { kind: 'none' };
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return { kind: 'none' };
  let bytes;
  try {
    bytes = await readCapped(res, maxBytes);
  } catch {
    throw new Error('network');
  }
  return bytes ? { kind: 'photo', bytes } : { kind: 'none' };
}

/** GET of a JSON resource with the bearer token; `null` for 404, throws on other failures. */
async function getJson({ base, path, token, fetchFn, timeoutMs }) {
  let res;
  try {
    res = await fetchFn(`${base}/${path.replace(/^\/+/, '')}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'teams-live/1.0' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('network');
  }
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error('network');
  }
}

/**
 * Jira source. Returns `{ fetch, resolveUser }`: `fetch(person)` is the
 * AvatarService fallback, `resolveUser(person)` the strictly matched Jira user
 * (or null), shared with the Confluence source.
 */
export function createJiraAvatarSource({
  jira,
  fetchFn = (...args) => globalThis.fetch(...args),
  timeoutMs = 5000,
  maxBytes = 12 * 1024,
} = {}) {
  const base = String(jira?.baseUrl || '').replace(/\/+$/, '');
  const configured = () => Boolean(base && jira?.token);

  // The Jira and the Confluence source ask for the same person within one card:
  // share the lookup for a moment. A failed lookup is not remembered.
  const memo = new Map();
  const MEMO_MS = 60_000;

  function resolveUser(person) {
    if (!configured()) return Promise.resolve(null);
    const email = norm(person?.email);
    const name = norm(person?.name);
    // One word can be a first name or a username: never enough to pick a face.
    if (!email.includes('@') && name.split(' ').length < 2) return Promise.resolve(null);
    const query = email.includes('@') ? email : name;
    const hit = memo.get(query);
    if (hit && hit.expires > Date.now()) return hit.promise;
    const promise = lookupUser(query, email.includes('@'));
    memo.set(query, { promise, expires: Date.now() + MEMO_MS });
    promise.catch(() => memo.delete(query));
    if (memo.size > 64) memo.delete(memo.keys().next().value);
    return promise;
  }

  async function lookupUser(query, byEmail) {
    const results = await getJson({
      base,
      path: `rest/api/2/user/search?username=${encodeURIComponent(query)}&maxResults=${SEARCH_LIMIT}`,
      token: jira.token,
      fetchFn,
      timeoutMs,
    });
    if (!Array.isArray(results)) return null;
    // A full page may hide more people with this name: fail closed.
    if (results.length >= SEARCH_LIMIT) return null;
    const exact = results.filter(
      (u) =>
        u?.active !== false &&
        (byEmail ? norm(u.emailAddress) === query : norm(u.displayName) === query)
    );
    return exact.length === 1 ? exact[0] : null;
  }

  async function fetchPhoto(person) {
    const user = await resolveUser(person);
    if (!user) return { kind: 'none' };
    const url = user.avatarUrls?.['48x48'] || user.avatarUrls?.['32x32'];
    // Only a picture the person uploaded: the shared default avatar has no `ownerId`.
    if (typeof url !== 'string' || !/[?&]ownerId=/.test(url)) return { kind: 'none' };
    return fetchImage({ base, url, token: jira.token, fetchFn, timeoutMs, maxBytes });
  }

  return { fetch: fetchPhoto, resolveUser };
}

/**
 * Confluence source, matched through the Jira user's username so that the
 * identity is the same one across both services. Without a Jira source or a
 * Jira match there is nothing to look up. Pictures over `maxBytes` or the
 * AvatarService's pixel limit are not embedded (they are skipped, not resized).
 */
export function createConfluenceAvatarSource({
  confluence,
  resolveUser,
  fetchFn = (...args) => globalThis.fetch(...args),
  timeoutMs = 5000,
  maxBytes = 12 * 1024,
} = {}) {
  const base = String(confluence?.baseUrl || '').replace(/\/+$/, '');
  return async function fetchPhoto(person) {
    if (!base || !confluence?.token || typeof resolveUser !== 'function') return { kind: 'none' };
    const user = await resolveUser(person);
    const username = typeof user?.name === 'string' ? user.name.trim() : '';
    if (!username) return { kind: 'none' };
    const info = await getJson({
      base,
      path: `rest/api/user?username=${encodeURIComponent(username)}`,
      token: confluence.token,
      fetchFn,
      timeoutMs,
    });
    const picture = info?.profilePicture;
    // `isDefault: false` only: a missing flag is not proof of an uploaded picture.
    if (!picture || picture.isDefault !== false || typeof picture.path !== 'string') return { kind: 'none' };
    return fetchImage({ base, url: picture.path, token: confluence.token, fetchFn, timeoutMs, maxBytes });
  };
}

/**
 * The ordered fallback list for AvatarService from the configured clients:
 * Jira first, then Confluence (which needs the Jira user to match on). A
 * service that is not configured is simply left out.
 */
export function createAvatarFallbacks({ jira = null, confluence = null, sources = ['jira', 'confluence'], ...options } = {}) {
  const jiraSource = jira?.isConfigured?.() ? createJiraAvatarSource({ jira, ...options }) : null;
  const list = [];
  if (jiraSource && sources.includes('jira')) list.push(jiraSource.fetch);
  if (jiraSource && sources.includes('confluence') && confluence?.isConfigured?.()) {
    list.push(createConfluenceAvatarSource({ confluence, resolveUser: jiraSource.resolveUser, ...options }));
  }
  return list;
}
