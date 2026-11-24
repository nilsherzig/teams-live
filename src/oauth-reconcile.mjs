import fs from 'node:fs';
import path from 'node:path';

const APP_NAME = 'teams-live (managed)';
const MAX_PAGES = 20;

/** Register one user-owned GitLab OAuth application, preserving its one-time secret locally. */
export async function ensureOAuthApplication({ gitlab, baseUrl, stateFile }) {
  if (!gitlab?.token || !stateFile) throw new Error('OAuth automatic setup requires a GitLab token and state directory');
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
    throw new Error('OAuth automatic setup requires an HTTPS base URL');
  }
  if (base.search || base.hash) throw new Error('OAuth base URL cannot contain query or fragment');
  const redirect = `${base.href.replace(/\/$/, '')}/oauth/callback`;
  const pending = `${stateFile}.pending`;
  const load = () => {
    const stat = fs.lstatSync(stateFile);
    if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('OAuth state file must be a private regular file');
    let state;
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
    catch { throw new Error('OAuth state file cannot be read or parsed'); }
    if (state.host !== gitlab.host || state.redirect !== redirect || typeof state.clientId !== 'string' || !state.clientId ||
        typeof state.clientSecret !== 'string' || !state.clientSecret || !/^\d+$/.test(String(state.id ?? ''))) {
      throw new Error('OAuth state does not match this GitLab host and callback');
    }
    return state;
  };
  if (fs.existsSync(stateFile)) {
    const state = load();
    let app;
    try { app = await gitlab.request(`user/applications/${encodeURIComponent(state.id)}`, { fallback: false }); }
    catch { throw new Error('Could not verify the managed GitLab OAuth application'); }
    if (String(app?.id) !== String(state.id) || app.application_id !== state.clientId || app.callback_url !== redirect || app.confidential !== true) {
      throw new Error('The managed GitLab OAuth application no longer matches its saved state');
    }
    return { clientId: state.clientId, clientSecret: state.clientSecret };
  }
  // A marker survives an interrupted/ambiguous create: GitLab returns the secret only once.
  if (fs.existsSync(pending)) throw new Error('OAuth setup was interrupted; inspect the GitLab application and state before retrying');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  const lock = fs.openSync(pending, 'wx', 0o600);
  fs.closeSync(lock);
  let createStarted = false;
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const apps = await gitlab.request(`user/applications?per_page=100&page=${page}`, { fallback: false });
      if (!Array.isArray(apps)) throw new Error('GitLab returned an invalid OAuth application list');
      if (apps.some((app) => app?.application_name === APP_NAME && app?.callback_url === redirect)) {
        throw new Error('A matching GitLab OAuth application already exists; configure its credentials or resolve it manually');
      }
      if (apps.length < 100) break;
      if (page === MAX_PAGES) throw new Error('OAuth application list is too large to verify safely');
    }
    createStarted = true;
    const app = await gitlab.request('user/applications', {
      method: 'POST', fallback: false, retry: false,
      body: { name: APP_NAME, redirect_uri: redirect, scopes: 'api', confidential: true },
    });
    if (!/^\d+$/.test(String(app?.id ?? '')) || typeof app.application_id !== 'string' || !app.application_id || typeof app.secret !== 'string' || !app.secret) {
      throw new Error('GitLab did not return the new application credentials');
    }
    const state = { version: 1, host: gitlab.host, redirect, id: app.id, clientId: app.application_id, clientSecret: app.secret };
    const temporary = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, stateFile);
    fs.unlinkSync(pending);
    return { clientId: state.clientId, clientSecret: state.clientSecret };
  } catch {
    if (!createStarted) fs.unlinkSync(pending);
    // Do not include GitLab errors: API response bodies may contain credentials.
    throw new Error(createStarted ? 'OAuth creation could not be confirmed; inspect GitLab and the pending state before retrying' : 'OAuth application lookup failed or an application already exists; inspect GitLab before retrying');
  }
}
