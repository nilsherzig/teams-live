// Approval badges for the merge request card: a teal "Approved" pill and a muted
// gray pill for a merge request that still waits for approvals, as the image
// descriptors `{url, alt, width, height}` (the same shape as MR_BADGES) that a
// card row shows next to the approvers.
//
// The pending pill reads "N of M Approvals" from the counts GitLab reports
// (approved so far, approvals required) and never from a guess: without a
// usable count it reads "Not approved yet". The text is part of the image, so
// every badge has a plain text twin (`approvalBadgeText`) for the readable
// fallback, and for counts that have no image (more than MAX_BADGE_REQUIRED
// approvals required).

import { APPROVAL_BADGE_IMAGES } from './approval-badge-images.mjs';

/** The highest "of M" with a pre-rendered image (see scripts/gen-approval-badges.sh). */
export const MAX_BADGE_REQUIRED = 6;

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/**
 * The counts of a pending merge request as `{given, required}`, or null when
 * GitLab did not say how many approvals are required (nothing is invented:
 * a rule with no required approvals has no "N of M").
 */
export function approvalCounts({ approvalsGiven, approvalsRequired } = {}) {
  const required = count(approvalsRequired);
  const given = count(approvalsGiven);
  if (!required || given === null || given >= required) return null;
  return { given, required };
}

/** The text of an approval badge: "Approved", "N of M Approvals" or "Not approved yet". */
export function approvalBadgeText({ approved, approvalsGiven, approvalsRequired } = {}) {
  if (approved === true) return 'Approved';
  const counts = approvalCounts({ approvalsGiven, approvalsRequired });
  return counts ? `${counts.given} of ${counts.required} Approvals` : 'Not approved yet';
}

/**
 * The badge image of an approval state, or null: `approved` true gives the
 * teal pill, false the gray one (with the counts when they are known and
 * pre-rendered), and unknown (null/undefined) has no badge.
 */
export function approvalBadge({ approved, approvalsGiven, approvalsRequired } = {}) {
  if (approved === true) return APPROVAL_BADGE_IMAGES.approved;
  if (approved !== false) return null;
  const counts = approvalCounts({ approvalsGiven, approvalsRequired });
  if (!counts) return APPROVAL_BADGE_IMAGES.pending;
  return APPROVAL_BADGE_IMAGES[`pending-${counts.given}-of-${counts.required}`] || null;
}

/** The two fixed badges: the teal "Approved" pill and the generic gray pending pill. */
export const APPROVAL_BADGES = {
  approved: APPROVAL_BADGE_IMAGES.approved,
  pending: APPROVAL_BADGE_IMAGES.pending,
};

/**
 * The gray pending pill for real counts: "N of M Approvals" when both are
 * known (and an image exists), otherwise the generic "Not approved yet" pill.
 * Always a `{url, alt, width, height}` descriptor, never null.
 */
export function pendingApprovalBadge({ given, required } = {}) {
  return approvalBadge({ approved: false, approvalsGiven: given, approvalsRequired: required }) || APPROVAL_BADGES.pending;
}
