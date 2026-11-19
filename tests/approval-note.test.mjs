import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApprovalNote, teamsUserLink } from '../src/approval-note.mjs';

const MRI = '8:orgid:00000000-0000-4000-8000-00000000000a';
const message = { conversationId: '19:x@thread.v2', messageId: '1700000000000' };

test('approved from a reaction: title, requester with GitLab mention and Teams chat link, trigger, footer', () => {
  const note = buildApprovalNote({ requester: { name: 'Alice Example', gitlabUser: 'alice', mri: MRI }, trigger: '👍 reaction', message });
  assert.equal(
    note,
    [
      '**Approved via Microsoft Teams**',
      '',
      `- **Requested by:** @alice ([🗨️ Alice Example](https://teams.microsoft.com/l/chat/0/0?users=${MRI}))`,
      '- **Trigger:** 👍 reaction on [this Teams message](https://teams.microsoft.com/l/message/19%3Ax%40thread.v2/1700000000000)',
      '',
      "_The approval was submitted by the MS Teams bot on the requester's behalf._",
    ].join('\n')
  );
});

test('a command, a revoke and the card button read as their own', () => {
  assert.match(buildApprovalNote({ requester: { name: 'Alice Example' }, trigger: '/approve', message }), /Command `\/approve` in \[this Teams message\]/);
  const revoked = buildApprovalNote({ action: 'revoked', requester: { name: 'Alice Example' }, trigger: '/revoke', message });
  assert.match(revoked, /^\*\*Approval revoked via Microsoft Teams\*\*/);
  assert.match(revoked, /approval was withdrawn/);
  const button = buildApprovalNote({ trigger: 'button', requesterNote: "someone with the card's Approve link (confirmed as @bot)" });
  assert.match(button, /Approve button on a Teams card/);
  assert.match(button, /someone with the card's Approve link \(confirmed as @bot\)/);
});

test('no GitLab user: the name alone, linked to Teams when the MRI is known; nothing unsafe is interpolated', () => {
  assert.match(buildApprovalNote({ requester: { name: 'Alice Example', mri: `https://x/contacts/${MRI}` }, trigger: '/approve' }), /Requested by:\*\* \[🗨️ Alice Example\]\(https:\/\/teams\.microsoft\.com\/l\/chat\/0\/0\?users=8:orgid:/);
  assert.match(buildApprovalNote({ requester: { name: 'Alice Example' }, trigger: '/approve' }), /Requested by:\*\* \*\*Alice Example\*\*/);
  const hostile = buildApprovalNote({ requester: { name: '@all `x` [y](z)', gitlabUser: 'bad name!' }, trigger: '/approve' });
  assert.ok(!hostile.includes('@all') && !hostile.includes('@bad'), 'no stray mention');
  assert.equal(teamsUserLink('nonsense'), '');
});

test('the Approve button comment links the Teams card and names the address the request came from', () => {
  const note = buildApprovalNote({
    trigger: 'button',
    requesterNote: "someone with the card's Approve link (confirmed as @bot)",
    message: { conversationId: '19:x@thread.v2', messageId: '1700000000000' },
    ip: '203.0.113.7',
  });
  assert.match(note, /\*\*Trigger:\*\* Approve button on \[this Teams card\]\(https:\/\/teams\.microsoft\.com\/l\/message\/19%3Ax%40thread\.v2\/1700000000000\)/);
  assert.match(note, /\*\*IP address:\*\* `203\.0\.113\.7`/);
  // Only a real address is ever written: anything else (a spoofed header value) is left out.
  assert.ok(!buildApprovalNote({ trigger: 'button', ip: 'not an ip; [x](y)' }).includes('IP address'));
  assert.match(buildApprovalNote({ trigger: 'button', ip: '2001:db8::1' }), /`2001:db8::1`/);
  assert.match(buildApprovalNote({ trigger: 'button' }), /Approve button on a Teams card$/m);
});

test('the comment says where the address is when that is known', () => {
  const note = buildApprovalNote({ trigger: 'button', ip: '203.0.113.7', place: 'Berlin, \u{1F1E9}\u{1F1EA} Germany' });
  assert.match(note, /\*\*IP address:\*\* `203\.0\.113\.7` · Berlin, \u{1F1E9}\u{1F1EA} Germany/u);
  assert.match(buildApprovalNote({ trigger: 'button', ip: '203.0.113.7' }), /\*\*IP address:\*\* `203\.0\.113\.7`$/m);
  assert.ok(!buildApprovalNote({ trigger: 'button', place: 'Berlin' }).includes('Berlin'), 'a place without an address is not shown');
  assert.ok(!buildApprovalNote({ trigger: 'button', ip: '203.0.113.7', place: '[x](http://evil)' }).includes('[x]'), 'markup in the place is neutralised');
});
