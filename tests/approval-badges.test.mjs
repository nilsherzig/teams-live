import test from 'node:test';
import assert from 'node:assert/strict';
import { APPROVAL_BADGE_IMAGES } from '../src/approval-badge-images.mjs';
import { MAX_BADGE_REQUIRED, approvalBadge, approvalBadgeText, approvalCounts } from '../src/approval-badges.mjs';
import { GitLabClient, approvalCountsOf } from '../src/gitlab.mjs';

test('the approval badge assets: a teal Approved pill, a gray pending pill and one per N of M', () => {
  const keys = Object.keys(APPROVAL_BADGE_IMAGES);
  assert.ok(keys.includes('approved') && keys.includes('pending'));
  let pairs = 0;
  for (let m = 1; m <= MAX_BADGE_REQUIRED; m++) {
    for (let n = 0; n < m; n++) {
      const badge = APPROVAL_BADGE_IMAGES[`pending-${n}-of-${m}`];
      assert.equal(badge.alt, `${n} of ${m} Approvals`);
      pairs++;
    }
  }
  assert.equal(keys.length, 2 + pairs, 'no stray images');
  for (const [key, badge] of Object.entries(APPROVAL_BADGE_IMAGES)) {
    assert.match(badge.url, /^data:image\/png;base64,iVBOR/);
    assert.ok(badge.url.length < 4_000, `${key} is ${badge.url.length} bytes`);
    assert.equal(badge.height, 22);
    assert.ok(badge.width >= 90 && badge.width <= 160, `${key} is ${badge.width}px wide`);
    const png = Buffer.from(badge.url.split(',')[1], 'base64');
    assert.equal(png.readUInt32BE(16), badge.width * 3);
    assert.equal(png.readUInt32BE(20), badge.height * 3);
  }
  assert.equal(APPROVAL_BADGE_IMAGES.approved.alt, 'Approved');
  assert.equal(APPROVAL_BADGE_IMAGES.pending.alt, 'Not approved yet');
  assert.notEqual(APPROVAL_BADGE_IMAGES.approved.url, APPROVAL_BADGE_IMAGES.pending.url);
});

test('approvalBadge: approved is teal, pending reads the real counts, unknown has no badge', () => {
  assert.equal(approvalBadge({ approved: true }), APPROVAL_BADGE_IMAGES.approved);
  assert.equal(approvalBadge({ approved: true, approvalsGiven: 1, approvalsRequired: 1 }), APPROVAL_BADGE_IMAGES.approved);
  assert.equal(approvalBadge({ approved: null }), null);
  assert.equal(approvalBadge({}), null);
  assert.equal(approvalBadge({ approved: false, approvalsGiven: 0, approvalsRequired: 1 }).alt, '0 of 1 Approvals');
  assert.equal(approvalBadge({ approved: false, approvalsGiven: 1, approvalsRequired: 3 }).alt, '1 of 3 Approvals');
  assert.equal(approvalBadge({ approved: false, approvalsGiven: 2, approvalsRequired: 3 }).alt, '2 of 3 Approvals');
  assert.equal(approvalBadge({ approved: false, approvalsGiven: 5, approvalsRequired: 6 }).alt, '5 of 6 Approvals');
});

test('approvalBadge: no usable count reads Not approved yet, nothing is invented', () => {
  for (const counts of [
    {},
    { approvalsGiven: null, approvalsRequired: null },
    // A rule that requires no approvals has no "of M".
    { approvalsGiven: 0, approvalsRequired: 0 },
    { approvalsGiven: undefined, approvalsRequired: 2 },
    { approvalsGiven: -1, approvalsRequired: 2 },
    { approvalsGiven: 1.5, approvalsRequired: 2 },
    { approvalsGiven: '1', approvalsRequired: 2 },
    // Counts that contradict "not approved" are not shown as a fraction either.
    { approvalsGiven: 2, approvalsRequired: 2 },
    { approvalsGiven: 3, approvalsRequired: 2 },
  ]) {
    assert.equal(approvalBadge({ approved: false, ...counts }), APPROVAL_BADGE_IMAGES.pending, JSON.stringify(counts));
    assert.equal(approvalBadgeText({ approved: false, ...counts }), 'Not approved yet', JSON.stringify(counts));
  }
});

test('approvalBadge: more approvals required than there are images stays honest as text only', () => {
  const counts = { approved: false, approvalsGiven: 2, approvalsRequired: MAX_BADGE_REQUIRED + 1 };
  assert.equal(approvalBadge(counts), null);
  assert.equal(approvalBadgeText(counts), `2 of ${MAX_BADGE_REQUIRED + 1} Approvals`);
});

test('approvalBadgeText mirrors the image alt text', () => {
  assert.equal(approvalBadgeText({ approved: true }), 'Approved');
  assert.equal(approvalBadgeText({ approved: false, approvalsGiven: 0, approvalsRequired: 2 }), '0 of 2 Approvals');
  assert.equal(approvalBadgeText({ approved: false }), 'Not approved yet');
  for (const [given, required] of [[0, 1], [1, 2], [3, 4], [5, 6]]) {
    const input = { approved: false, approvalsGiven: given, approvalsRequired: required };
    assert.equal(approvalBadge(input).alt, approvalBadgeText(input));
  }
  assert.deepEqual(approvalCounts({ approvalsGiven: 1, approvalsRequired: 3 }), { given: 1, required: 3 });
  assert.equal(approvalCounts({ approvalsGiven: 3, approvalsRequired: 3 }), null);
});

test('GitLab approvals: the counts come from approvals_required and approvals_left', () => {
  assert.deepEqual(approvalCountsOf({ approvals_required: 2, approvals_left: 2 }, 0), { approvalsGiven: 0, approvalsRequired: 2 });
  assert.deepEqual(approvalCountsOf({ approvals_required: 3, approvals_left: 1 }, 2), { approvalsGiven: 2, approvalsRequired: 3 });
  // Without approvals_left the approvers are the count.
  assert.deepEqual(approvalCountsOf({ approvals_required: 2 }, 1), { approvalsGiven: 1, approvalsRequired: 2 });
  // More approvers than required (left floors at 0): all required are given.
  assert.deepEqual(approvalCountsOf({ approvals_required: 1, approvals_left: 0 }, 2), { approvalsGiven: 1, approvalsRequired: 1 });
  // No required approvals (or no data): no counts, the "required=0" semantics stay with the caller.
  assert.deepEqual(approvalCountsOf({ approvals_required: 0, approvals_left: 0 }, 1), { approvalsGiven: null, approvalsRequired: null });
  assert.deepEqual(approvalCountsOf({}, 0), { approvalsGiven: null, approvalsRequired: null });
  assert.deepEqual(approvalCountsOf(null, 0), { approvalsGiven: null, approvalsRequired: null });
});

test('getApprovalSummary: counts next to the approvers, unknown when the lookup fails, required=0 semantics kept', async () => {
  const client = new GitLabClient({ host: 'git.example.com', token: 't' });
  client.getApprovals = async () => ({
    approved: false,
    approvals_required: 2,
    approvals_left: 1,
    approved_by: [{ user: { name: 'Alice Example' } }],
  });
  assert.deepEqual(await client.getApprovalSummary('g/p', 1), {
    known: true,
    approved: false,
    approvedBy: ['Alice Example'],
    approvalsGiven: 1,
    approvalsRequired: 2,
  });

  // required=0: approved means somebody approved; no counts.
  client.getApprovals = async () => ({ approved: false, approvals_required: 0, approved_by: [{ user: { name: 'Bob Example' } }] });
  const none = await client.getApprovalSummary('g/p', 1);
  assert.equal(none.approved, true);
  assert.equal(none.approvalsRequired, null);

  client.getApprovals = async () => {
    throw new Error('boom');
  };
  assert.deepEqual(await client.getApprovalSummary('g/p', 1), {
    known: false,
    approved: false,
    approvedBy: [],
    approvalsGiven: null,
    approvalsRequired: null,
  });
});

test('APPROVAL_BADGES and pendingApprovalBadge give the {url, alt, width, height} descriptors', async () => {
  const { APPROVAL_BADGES, pendingApprovalBadge } = await import('../src/approval-badges.mjs');
  assert.equal(APPROVAL_BADGES.approved.alt, 'Approved');
  assert.equal(APPROVAL_BADGES.pending.alt, 'Not approved yet');
  assert.equal(pendingApprovalBadge({ given: 0, required: 1 }).alt, '0 of 1 Approvals');
  assert.equal(pendingApprovalBadge({ given: 2, required: 3 }).alt, '2 of 3 Approvals');
  assert.equal(pendingApprovalBadge({}), APPROVAL_BADGES.pending);
  // No image for a count beyond the pre-rendered range: the generic pill, never null.
  assert.equal(pendingApprovalBadge({ given: 0, required: 9 }), APPROVAL_BADGES.pending);
  for (const b of [APPROVAL_BADGES.approved, pendingApprovalBadge({ given: 1, required: 2 })]) {
    assert.deepEqual(Object.keys(b).sort(), ['alt', 'height', 'url', 'width']);
  }
});
