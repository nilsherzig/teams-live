import test from 'node:test';
import assert from 'node:assert/strict';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { ApproveServer } from '../src/approve.mjs';
import { initialsAvatar } from '../src/initials-avatar.mjs';

// An approval made through the page is the bot account's; when the requester is known (signed in), the card shows
// them instead of the bot, with the Teams mark, exactly like an approval by `/approve`.

const SHA = 'a'.repeat(40);
const person = { displayName: 'Alice Example', mri: '8:orgid:11111111-2222-3333-4444-555555555555', explicitGitlabUsernames: new Set(['alice']) };

function watcher() {
  const w = new MergeRequestWatcher({
    config: { conversations: [], gitlab: { group: 'group' }, teams: { rich_messages: true } },
    gitlab: { mrLink: (p, i) => `https://gitlab.example.com/${p}/-/merge_requests/${i}`, findMrLinks: () => [] },
    jira: null,
    opsgenie: null,
  });
  w.saveState = () => {};
  w.botNames = new Set(['ms teams bot']);
  w.userDirectory = { findUser: (name) => (name === 'Alice Example' ? person : null), byGitlabUsername: new Map([['alice', person]]) };
  return w;
}
const card = (w) =>
  JSON.stringify(w.buildMrCard({ project: 'group/app', iid: 7, title: 'Example' }, { title: 'Example', approved: true, approvedBy: ['MS Teams bot'], approvalsGiven: 1, approvalsRequired: 1 }));

test('a signed-in approver replaces the bot on the card, marked as approved via the bot', () => {
  const w = watcher();
  assert.match(card(w), /MS Teams bot/, 'before: the bot');
  w.recordWebApprover('group/app', 7, { username: 'alice', name: 'Alice A.' });
  const after = card(w);
  assert.match(after, /Alice Example \(approved via the MS Teams bot\)/, 'the person, with the Teams mark');
  assert.equal(after.includes('"altText":"MS Teams bot"'), false);
  assert.equal(w.teamsApprovals.get('group/app!7').mri, person.mri);
});

test('without a directory match the GitLab name is shown, and a guessed user name is never trusted', () => {
  const w = watcher();
  w.recordWebApprover('group/app', 8, { username: 'zed', name: 'Zed Nobody' });
  assert.equal(w.teamsApprovals.get('group/app!8').name, 'Zed Nobody');
  assert.equal(w.teamsApprovals.get('group/app!8').mri, '');
  const guess = { displayName: 'Mallory', mri: '8:orgid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', explicitGitlabUsernames: new Set() };
  w.userDirectory = { findUser: () => null, byGitlabUsername: new Map([['mallory', guess]]) };
  w.recordWebApprover('group/app', 9, { username: 'mallory', name: 'M. Allory' });
  assert.equal(w.teamsApprovals.get('group/app!9').name, 'M. Allory', 'a derived (not configured) user name does not pick a person');
});

test('the approval page reports the signed-in approver to the watcher, and only then', async () => {
  const calls = [];
  const gitlab = {
    host: 'gitlab.example.com',
    mr: { state: 'opened', draft: false, sha: SHA, title: 'Example' },
    async getMr() { return gitlab.mr; },
    async getCurrentUser() { return { id: 1, username: 'bot' }; },
    async getUserApprovalState() { return { known: true, user: { id: 1, username: 'bot' }, hasApproved: false, canApprove: true }; },
    async approveMr() { return {}; },
  };
  const server = new ApproveServer({ gitlab, baseUrl: 'https://approve.example.com/approve', recordApprover: (...args) => calls.push(args) });
  const record = { project: 'group/app', iid: 7, sha: SHA, action: 'approve' };
  const result = { user: { id: 1, username: 'bot' }, mr: gitlab.mr };
  await server.sendApproval(record, result, { ip: '', signedIn: { username: 'alice', name: 'Alice A.' } });
  assert.deepEqual(calls, [['group/app', 7, { username: 'alice', name: 'Alice A.' }]]);
  await server.sendApproval(record, result, { ip: '203.0.113.9', signedIn: null });
  assert.equal(calls.length, 1, 'nobody signed in: nobody to show');
  void initialsAvatar;
});
