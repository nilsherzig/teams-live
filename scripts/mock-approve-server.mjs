#!/usr/bin/env node
// Runs the real approval flow (src/approve.mjs) against a mock GitLab with
// generic data, so the browser bootstrap and confirmation page can be tried
// without a live merge request. Nothing leaves this machine: the mock records
// the "approval" in memory only.
//
//   node scripts/mock-approve-server.mjs [--port 3016] [--out FILE]
//
// The capability URL is a bearer credential. It is written to FILE (mode 0600,
// default $XDG_RUNTIME_DIR/teams-live-mock-approve/capability-url) and never
// printed: open it from the file, e.g. `xdg-open "$(cat FILE)"`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ApproveServer } from '../src/approve.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(opt('port', 3016));
const out = opt('out', path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'teams-live-mock-approve', 'capability-url'));

const PROJECT = 'group/app';
const IID = 7;
const SHA = 'a'.repeat(40);

const approvals = [];
const state = { approved: false };
const gitlab = {
  mr: { state: 'opened', draft: false, sha: SHA, title: 'Example change' },
  async getMr() {
    return gitlab.mr;
  },
  async getUserApprovalState() {
    return { known: true, user: { id: 1, username: 'mock-user' }, hasApproved: state.approved, canApprove: true };
  },
  async approveMr(project, iid, opts) {
    approvals.push({ project, iid, sha: opts?.sha, at: new Date().toISOString() });
    state.approved = true;
    console.error(`[mock] approval recorded for ${project}!${iid} (mock only, ${approvals.length} so far)`);
    return {};
  },
};

const server = new ApproveServer({
  gitlab,
  baseUrl: `http://127.0.0.1:${port}/approve`,
  port,
  refreshCards: async () => ({ matched: 0, failed: 0 }),
});
await server.start();

const url = server.linkFor({ project: PROJECT, iid: IID, sha: SHA });
fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
fs.writeFileSync(out, `${url}\n`, { mode: 0o600 });
fs.chmodSync(out, 0o600);

console.error(`[mock] approval flow on http://127.0.0.1:${server.port}/approve/ for ${PROJECT}!${IID}`);
console.error(`[mock] capability URL (a bearer credential) is in ${out}`);
console.error('[mock] the "approval" is recorded in memory only; stop with Ctrl+C');

const stop = () => {
  fs.rmSync(out, { force: true });
  server.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
