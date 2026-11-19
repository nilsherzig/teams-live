import test from 'node:test';
import assert from 'node:assert/strict';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { botSentMessageIds, recordBotMessageId } from '../src/teams.mjs';
import { withStubbedTransport } from './stub-transport.mjs';

const TEST_SELF_OID = 'f94ccd0d-d140-4d1d-9fee-b00e642b9c11';
const TEST_SELF_MRI = `8:orgid:${TEST_SELF_OID}`;

function createWatcher({
  selfOid = TEST_SELF_OID,
  selfMri = TEST_SELF_MRI,
  adminIds = [],
  messages = {},
  mrStates = {},
} = {}) {
  const approvedCalls = [];
  const noteCalls = [];
  const repliedMessages = [];

  const gitlabMock = {
    findMrLinks: (text) => {
      if (!text) return [];
      const match = text.match(/https?:\/\/[^\s/]+\/([^/\s]+\/[^/\s]+)\/-\/merge_requests\/(\d+)/);
      if (match) return [{ project: match[1], iid: match[2] }];
      return [];
    },
    getMrStatus: async (project, iid) => {
      const key = `${project}!${iid}`;
      return mrStates[key] || { status: 'pending', approved: false, title: `MR !${iid}` };
    },
    approveMr: async (project, iid) => {
      approvedCalls.push({ project, iid });
      const key = `${project}!${iid}`;
      if (mrStates[key]) {
        mrStates[key].status = 'approved';
        mrStates[key].approved = true;
      }
      return { approved: true };
    },
    addMrNote: async (project, iid, body) => {
      noteCalls.push({ project, iid, body });
      return {};
    },
    mrLink: (project, iid) => `https://gitlab.example.com/${project}/-/merge_requests/${iid}`,
  };

  const getMessageMock = async (convId, msgId) => {
    const key = `${convId}/${msgId}`;
    const msg = messages[key] || messages[msgId];
    if (!msg) return { ok: false, error: { message: 'Not found' } };
    return { ok: true, value: msg };
  };

  const watcher = new MergeRequestWatcher({
    config: {
      conversations: [{ id: '19:team@thread.v2', name: 'team' }],
      gitlab: {},
      teams: {
        admin_ids: adminIds,
      },
    },
    gitlab: gitlabMock,
    jira: null,
    opsgenie: null,
    getMessage: getMessageMock,
  });

  watcher.setSelfMri(selfMri);

  return { watcher, approvedCalls, noteCalls, repliedMessages, selfMri, selfOid };
}

test('approves MR when self reacts with thumbs-up to bot status comment', async () => {
  const convId = '19:team@thread.v2';
  const botReplyId = '1770000000000';
  const originalMsgId = '1660000000000';

  const { watcher, approvedCalls, noteCalls } = createWatcher({
    messages: {
      [`${convId}/${botReplyId}`]: {
        id: botReplyId,
        content: '🦊 [!42 (group/app)](https://gitlab.example.com/group/app/-/merge_requests/42)\n\n⏳ **Not approved yet**',
        reactions: [
          {
            key: 'like',
            user: { mri: TEST_SELF_MRI, displayName: 'Alice Example' },
          },
        ],
      },
    },
  });

  // Watch the conversation
  watcher.watched.set(`${convId}/${originalMsgId}`, {
    conversationId: convId,
    messageId: originalMsgId,
    editedOriginal: false,
    mrs: [
      {
        project: 'group/app',
        iid: '42',
        title: 'Fix networking',
        ciMessageServerId: botReplyId,
      },
    ],
  });
  recordBotMessageId(botReplyId);

  // Incoming MessageUpdate on the bot status comment
  await watcher.handleIncomingEvent({
    kind: 'MessageUpdate',
    conversationId: convId,
    messageId: botReplyId,
  });

  assert.equal(approvedCalls.length, 1);
  assert.deepEqual(approvedCalls[0], { project: 'group/app', iid: '42' });
  assert.equal(noteCalls.length, 1, 'the approval is commented on the merge request');
  assert.match(noteCalls[0].body, /^\*\*Approved via Microsoft Teams\*\*/);
  assert.match(noteCalls[0].body, /\*\*Requested by:\*\* \[🗨️ Alice Example\]\(https:\/\/teams\.microsoft\.com\/l\/chat\/0\/0\?users=8:orgid:/);
  assert.match(noteCalls[0].body, /\*\*Trigger:\*\* 👍 reaction on \[this Teams message\]\(https:\/\/teams\.microsoft\.com\/l\/message\/19%3Ateam%40thread\.v2\/1770000000000\)/);
});

test('approves MR when self reacts with 👍 emoji key on edited original bot message', async () => {
  const convId = '19:team@thread.v2';
  const msgId = '1770000001000';

  const { watcher, approvedCalls } = createWatcher({
    messages: {
      [`${convId}/${msgId}`]: {
        id: msgId,
        content: '🦊 [!100 (group/service-a)](https://gitlab.example.com/group/service-a/-/merge_requests/100)',
        reactions: [
          {
            key: '👍',
            user: { mri: TEST_SELF_MRI, displayName: 'Alice Example' },
          },
        ],
      },
    },
  });

  watcher.watched.set(`${convId}/${msgId}`, {
    conversationId: convId,
    messageId: msgId,
    editedOriginal: true,
    mrs: [
      {
        project: 'group/service-a',
        iid: '100',
        title: 'Bump core addons',
      },
    ],
  });

  await watcher.handleIncomingEvent({
    kind: 'MessageUpdate',
    conversationId: convId,
    messageId: msgId,
  });

  assert.equal(approvedCalls.length, 1);
  assert.deepEqual(approvedCalls[0], { project: 'group/service-a', iid: '100' });
});

test('does NOT approve MR when non-self user reacts with thumbs-up', async () => {
  const convId = '19:team@thread.v2';
  const botReplyId = '1770000002000';

  const otherUserMri = '8:orgid:11111111-2222-3333-4444-555555555555';

  const { watcher, approvedCalls } = createWatcher({
    messages: {
      [`${convId}/${botReplyId}`]: {
        id: botReplyId,
        content: '🦊 [!55 (group/service-b)](https://gitlab.example.com/group/service-b/-/merge_requests/55)',
        reactions: [
          {
            key: 'like',
            user: { mri: otherUserMri, displayName: 'Other Person' },
          },
        ],
      },
    },
  });

  recordBotMessageId(botReplyId);

  await watcher.handleIncomingEvent({
    kind: 'MessageUpdate',
    conversationId: convId,
    messageId: botReplyId,
  });

  assert.equal(approvedCalls.length, 0);
});

test('does NOT approve MR when reaction is not thumbs-up (e.g. laugh, heart)', async () => {
  const convId = '19:team@thread.v2';
  const botReplyId = '1770000003000';

  const { watcher, approvedCalls } = createWatcher({
    messages: {
      [`${convId}/${botReplyId}`]: {
        id: botReplyId,
        content: '🦊 [!55 (group/service-b)](https://gitlab.example.com/group/service-b/-/merge_requests/55)',
        reactions: [
          {
            key: 'laugh',
            user: { mri: TEST_SELF_MRI, displayName: 'Alice Example' },
          },
        ],
      },
    },
  });

  recordBotMessageId(botReplyId);

  await watcher.handleIncomingEvent({
    kind: 'MessageUpdate',
    conversationId: convId,
    messageId: botReplyId,
  });

  assert.equal(approvedCalls.length, 0);
});

test('does NOT approve MR when message is not a bot message', async () => {
  const convId = '19:team@thread.v2';
  const userMsgId = '1770000004000';

  const { watcher, approvedCalls } = createWatcher({
    messages: {
      [`${convId}/${userMsgId}`]: {
        id: userMsgId,
        sender: { mri: '8:orgid:someone-else', displayName: 'Colleague' },
        content: 'Hey take a look at https://gitlab.example.com/group/service-b/-/merge_requests/55',
        reactions: [
          {
            key: 'like',
            user: { mri: TEST_SELF_MRI, displayName: 'Alice Example' },
          },
        ],
      },
    },
  });

  // Not in botSentMessageIds, not an own message, not watched bot reply
  await watcher.handleIncomingEvent({
    kind: 'MessageUpdate',
    conversationId: convId,
    messageId: userMsgId,
  });

  assert.equal(approvedCalls.length, 0);
});

test('does NOT approve MR when MR is already approved', async () => {
  const convId = '19:team@thread.v2';
  const botReplyId = '1770000005000';

  const { watcher, approvedCalls } = createWatcher({
    mrStates: {
      'group/service-b!55': { status: 'approved', approved: true },
    },
    messages: {
      [`${convId}/${botReplyId}`]: {
        id: botReplyId,
        content: '🦊 [!55 (group/service-b)](https://gitlab.example.com/group/service-b/-/merge_requests/55)',
        reactions: [
          {
            key: 'like',
            user: { mri: TEST_SELF_MRI, displayName: 'Alice Example' },
          },
        ],
      },
    },
  });

  recordBotMessageId(botReplyId);

  await watcher.handleIncomingEvent({
    kind: 'MessageUpdate',
    conversationId: convId,
    messageId: botReplyId,
  });

  assert.equal(approvedCalls.length, 0);
});

test('/rebase when MR is already up to date only sets checkmark reaction and triggers watched check without replying', async () => {
  const convId = '19:team@thread.v2';
  const cmdMsgId = '1770000006000';
  const reactions = [];
  let checkedWatched = false;

  const { watcher } = createWatcher({
    mrStates: {
      'group/service-b!55': {
        status: 'pending',
        approved: false,
        needsRebase: false,
        title: 'Already rebased MR',
      },
    },
  });

  watcher.setCommandReaction = async (cId, mId, key) => {
    reactions.push({ cId, mId, key });
  };
  watcher.checkAllWatched = async () => {
    checkedWatched = true;
  };

  await watcher.executeRebaseCommand(
    {
      conversationId: convId,
      messageId: cmdMsgId,
      from: 'Alice Example',
      fromMri: TEST_SELF_MRI,
      rawHtml: '<p>https://gitlab.example.com/group/service-b/-/merge_requests/55</p>',
    },
    []
  );

  assert.equal(reactions.length, 1);
  assert.deepEqual(reactions[0], {
    cId: convId,
    mId: cmdMsgId,
    key: '2705_whiteheavycheckmark',
  });
  assert.equal(checkedWatched, true);
});

test('the approval comment mentions the approver by GitLab username when known, with a link to the Teams message', async () => {
  const { watcher } = createWatcher();
  watcher.userDirectory.addUser({ mri: '8:orgid:00000000-0000-4000-8000-00000000000a', displayName: 'Alice Example', gitlabUsernames: ['alice'] });
  const notes = [];
  watcher.gitlab.addMrNote = async (project, iid, body) => notes.push({ project, iid, body });
  await watcher.noteTeamsApproval('group/app', 7, {
    name: 'Alice Example',
    mri: '8:orgid:00000000-0000-4000-8000-00000000000a',
    via: '/approve',
    conversationId: '19:x@thread.v2',
    messageId: '1700000000000',
  });
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /\*\*Requested by:\*\* @alice \(\[🗨️ Alice Example\]\(https:\/\/teams\.microsoft\.com\/l\/chat\/0\/0\?users=8:orgid:00000000-0000-4000-8000-00000000000a\)\)/);
  assert.match(notes[0].body, /\*\*Trigger:\*\* Command `\/approve` in \[this Teams message\]\(https:\/\/teams\.microsoft\.com\/l\/message\/19%3Ax%40thread\.v2\/1700000000000\)/);
  // A failing comment never fails the approval.
  watcher.gitlab.addMrNote = async () => {
    throw new Error('boom');
  };
  await watcher.noteTeamsApproval('group/app', 7, { name: 'Alice Example', via: '/approve' });
});

test('/unapprove (and its aliases) withdraws the approval and comments who asked, with a link to the Teams message', async () => {
  for (const command of ['/unapprove', '/revoke', '/disapprove']) {
    const { watcher } = createWatcher();
    const unapproved = [];
    const notes = [];
    watcher.gitlab.unapproveMr = async (project, iid) => unapproved.push({ project, iid });
    watcher.gitlab.addMrNote = async (project, iid, body) => notes.push({ project, iid, body });
    watcher.gitlab.getUserApprovalState = async () => ({ known: true, hasApproved: true, tokenIndex: 0 });
    watcher.gitlab.getMrStatus = async () => ({ status: 'approved', approved: true, title: 'Fix networking' });
    watcher.findTargetMrsForCommand = async () => [{ project: 'group/app', iid: '42' }];
    watcher.checkAllWatched = async () => {};
    await withStubbedTransport(() =>
      watcher.executeUnapproveCommand(
        { conversationId: '19:team@thread.v2', messageId: '1770000000000', from: 'Alice Example', fromMri: '8:orgid:x' },
        [],
        command
      )
    );
    assert.deepEqual(unapproved, [{ project: 'group/app', iid: '42' }], command);
    assert.equal(notes.length, 1);
    assert.match(notes[0].body, /^\*\*Approval revoked via Microsoft Teams\*\*/);
    assert.ok(notes[0].body.includes(`Command \`${command}\``), command);
  }
});

test('/unapprove says so when the bot has no approval to withdraw', async () => {
  const { watcher } = createWatcher();
  let revoked = false;
  watcher.gitlab.unapproveMr = async () => {
    revoked = true;
  };
  watcher.gitlab.getUserApprovalState = async () => ({ known: true, hasApproved: false, tokenIndex: 0 });
  watcher.gitlab.getMrStatus = async () => ({ status: 'approved', approved: true });
  watcher.findTargetMrsForCommand = async () => [{ project: 'group/app', iid: '42' }];
  await withStubbedTransport(() => watcher.executeUnapproveCommand({ conversationId: '19:t@thread.v2', messageId: '1', from: 'Alice Example' }, []));
  assert.equal(revoked, false);
});

test('the approver is mentioned only when the GitLab username is certain: mapping, else one exact-name match, never a derived guess', async () => {
  const { watcher } = createWatcher();
  const mri = '8:orgid:00000000-0000-4000-8000-00000000000b';
  // Known from Teams only: the directory derives "alice" from the name, but that is a guess.
  watcher.userDirectory.addUser({ mri, displayName: 'Alice Example' });
  assert.equal((await watcher.approvalRequester({ name: 'Alice Example', mri })).gitlabUser, '');
  // GitLab knows exactly one active account with that name: that username, whatever the guess was.
  watcher.gitlab.findUsernameByName = async (name) => (name === 'Alice Example' ? 'a.example' : '');
  assert.equal((await watcher.approvalRequester({ name: 'Alice Example', mri })).gitlabUser, 'a.example');
  // An explicit mapping wins over the lookup.
  watcher.userDirectory.addUser({ displayName: 'Alice Example', gitlabUsernames: ['mapped'] });
  assert.equal((await watcher.approvalRequester({ name: 'Alice Example' })).gitlabUser, 'mapped');
});

test('findUsernameByName takes a single exact, active match only and caches it', async () => {
  const { GitLabClient } = await import('../src/gitlab.mjs');
  const client = Object.create(GitLabClient.prototype);
  let calls = 0;
  let answer = [];
  client.request = async () => {
    calls++;
    return answer;
  };
  answer = [{ username: 'a.example', name: 'Álice Example', state: 'active' }, { username: 'alice2', name: 'Alice Example Jr', state: 'active' }];
  assert.equal(await client.findUsernameByName('Alice Example'), 'a.example');
  assert.equal(await client.findUsernameByName('alice  example'), 'a.example');
  assert.equal(calls, 1, 'cached');
  answer = [{ username: 'x', name: 'Bob Example', state: 'active' }, { username: 'y', name: 'Bob Example', state: 'active' }];
  assert.equal(await client.findUsernameByName('Bob Example'), '', 'two matches: not certain');
  answer = [{ username: 'z', name: 'Carol Example', state: 'blocked' }];
  assert.equal(await client.findUsernameByName('Carol Example'), '', 'inactive accounts do not count');
});

test('an approval from Teams is remembered, so the MR card shows the requester instead of the bot', async () => {
  const { watcher } = createWatcher();
  watcher.botNames = new Set(['ms teams bot', 'sa_teams_live']);
  // Nothing known yet: the card is unchanged.
  assert.deepEqual(watcher.resolveApprovers('group/app', 42, ['MS Teams bot']), { approvedBy: ['MS Teams bot'], approvedVia: [] });
  await watcher.noteTeamsApproval('group/app', 42, { name: 'Alice Example', mri: '8:orgid:x', via: '👍 reaction' });
  // The bot's entry becomes the requester, marked; other approvers stay as they are.
  assert.deepEqual(watcher.resolveApprovers('group/app', 42, ['MS Teams bot']), { approvedBy: ['Alice Example'], approvedVia: ['Alice Example'] });
  assert.deepEqual(watcher.resolveApprovers('group/app', 42, ['Bob Example', 'MS Teams bot']), { approvedBy: ['Bob Example', 'Alice Example'], approvedVia: ['Alice Example'] });
  assert.deepEqual(watcher.resolveApprovers('group/app', 42, ['Bob Example']), { approvedBy: ['Bob Example'], approvedVia: [] }, 'the bot did not approve: nothing to replace');
  assert.deepEqual(watcher.resolveApprovers('group/other', 7, ['MS Teams bot']), { approvedBy: ['MS Teams bot'], approvedVia: [] }, 'another MR');
  // Without the bot's account names there is nothing to recognise: unchanged.
  watcher.botNames = new Set();
  assert.deepEqual(watcher.resolveApprovers('group/app', 42, ['MS Teams bot']), { approvedBy: ['MS Teams bot'], approvedVia: [] });
  // A revoke forgets it.
  watcher.botNames = new Set(['ms teams bot']);
  await watcher.noteTeamsApproval('group/app', 42, { name: 'Alice Example', via: '/revoke', action: 'revoked' });
  assert.deepEqual(watcher.resolveApprovers('group/app', 42, ['MS Teams bot']), { approvedBy: ['MS Teams bot'], approvedVia: [] });
});
