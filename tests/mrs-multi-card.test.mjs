import test from 'node:test';
import assert from 'node:assert/strict';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { isRichMessage, messageMarkdown } from '../src/teams.mjs';

const mr = (iid, name, username = 'alice') => ({
  iid, title: `Change ${iid}`, web_url: `https://gitlab.example.com/group/app/-/merge_requests/${iid}`,
  references: { full: `group/app!${iid}` }, state: 'opened',
  author: { name, username }, head_pipeline: { status: 'success' },
  approval_summary: { known: true, approved: true, approvedBy: [] },
});
const watcher = () => {
  const w = new MergeRequestWatcher({ config: { conversations: [], gitlab: { group: 'group', notify: {} }, teams: { rich_messages: true } }, gitlab: {}, jira: null, opsgenie: null });
  w.userDirectory.formatMention = (author) => author.name;
  return w;
};

test('/mrs uses the multi-MR layout and retains the plain text fallback', () => {
  const message = watcher().formatMrsMessage([mr(1, 'Alice Example'), mr(2, 'Bob Example')]);
  assert.ok(isRichMessage(message));
  const card = JSON.stringify(message.card);
  assert.match(card, /Change 1/);
  assert.match(card, /Change 2/);
  assert.match(card, /Merge requests/);
  assert.match(messageMarkdown(message), /app!1/);
  assert.match(messageMarkdown(message), /app!2/);
});

test('/mrs keeps bot filtering and plain empty results', () => {
  const w = watcher();
  const message = w.formatMrsMessage([mr(1, 'Alice Example'), mr(2, 'Renovate Bot', 'renovate-bot')]);
  assert.match(messageMarkdown(message), /app!1/);
  assert.doesNotMatch(messageMarkdown(message), /app!2/);
  assert.match(messageMarkdown(message), /bot MRs not shown/);
  assert.match(w.formatMrsMessage([]), /No open merge requests/);
});

const parts = (message) => [message, ...(message.followUps || [])];
const walk = (value, visit) => {
  if (!value || typeof value !== 'object') return;
  visit(value);
  Object.values(value).forEach((v) => Array.isArray(v) ? v.forEach((item) => walk(item, visit)) : walk(v, visit));
};
const nodes = (message) => {
  const out = [];
  for (const part of parts(message)) walk(part.card, (node) => out.push(node));
  return out;
};

test('/mrs cards carry MR links, project, status, approval and Jira details', () => {
  const w = watcher();
  w.jira = { findAssociatedIssue: () => ({ key: 'APP-123', url: 'https://jira.example.com/browse/APP-123' }) };
  const row = { ...mr(42, 'Alice Example'), title: 'Fix *broken* [test]', draft: true,
    detailed_merge_status: 'need_rebase', auto_merge_enabled: true,
    approval_summary: { known: true, approved: true, approvedBy: ['Bob Example'] } };
  const message = w.formatMrsMessage([row]);
  const rendered = JSON.stringify(parts(message).map((part) => part.card));
  assert.match(rendered, /merge_requests\/42/);
  assert.match(rendered, /Fix \\\\\*broken/);
  for (const value of ['app', 'Alice Example', 'Bob Example', 'Draft', 'Approved', 'Passed', 'Auto-merge On', 'Rebase required', 'APP-123']) {
    assert.ok(rendered.includes(value), `missing ${value}`);
  }
  assert.ok(!rendered.includes('8:orgid'));
});

test('/mrs all keeps both sections; default and bot modes show only the selected authors', () => {
  const w = watcher();
  const rows = [mr(1, 'Alice Example'), mr(2, 'Renovate Bot', 'renovate-bot')];
  const all = w.formatMrsMessage(rows, { mode: 'all' });
  const rendered = JSON.stringify(parts(all).map((part) => part.card));
  assert.match(rendered, /Human Merge Requests/);
  assert.match(rendered, /Renovate \/ Bot Updates/);
  assert.match(messageMarkdown(all), /app!1/);
  assert.match(messageMarkdown(all), /app!2/);
  const bots = w.formatMrsMessage(rows, { mode: 'bots' });
  assert.match(messageMarkdown(bots), /app!2/);
  assert.doesNotMatch(messageMarkdown(bots), /app!1/);
});

test('/mrs splits long lists into bounded cards without losing rows or fallback text', async () => {
  const { MAX_CARD_BYTES } = await import('../src/cards.mjs');
  const { richMessageWireBytes } = await import('../src/teams.mjs');
  const w = watcher();
  const rows = Array.from({ length: 24 }, (_, i) => mr(i + 1, 'Alice Example'));
  const result = w.formatMrsMessage(rows);
  assert.ok(isRichMessage(result));
  assert.ok(parts(result).length > 1 && parts(result).length <= 10);
  for (const part of parts(result)) assert.ok(richMessageWireBytes(part) <= MAX_CARD_BYTES);
  const rendered = JSON.stringify(parts(result).map((part) => part.card));
  for (const row of rows) {
    assert.ok(rendered.includes(`/merge_requests/${row.iid}`));
    assert.ok(messageMarkdown(result).includes(`app!${row.iid}`));
  }
  const huge = w.formatMrsMessage(Array.from({ length: 900 }, (_, i) => mr(i + 1, 'Alice Example')));
  assert.equal(typeof huge, 'string');
  assert.match(huge, /app!900/);
});

test('/mrs cards do not show a person avatar for bot authors', () => {
  const w = watcher();
  const result = w.formatMrsMessage([mr(1, 'Renovate Bot', 'renovate-bot')], { mode: 'bots' });
  assert.equal(nodes(result).filter((node) => node.type === 'Image' && node.style === 'Person' && node.altText === 'Renovate Bot').length, 0);
});

test('/mrs actions use the configured batch flow with exact projects and eligible heads', () => {
  const w = watcher();
  const calls = [];
  w.approveFlow = { batchLinkFor: (rows, action) => {
    calls.push({ rows, action });
    return `https://example.com/${action}`;
  } };
  const rows = [
    { ...mr(1, 'Alice Example'), sha: 'head-1' },
    { ...mr(2, 'Bob Example'), sha: 'head-2', draft: true },
  ];
  const result = w.formatMrsMessage(rows);
  const actions = nodes(result).filter((node) => node.type === 'Action.OpenUrl');
  assert.ok(actions.some((action) => action.url === 'https://example.com/approve'));
  assert.ok(actions.some((action) => action.url === 'https://example.com/open'));
  assert.deepEqual(calls.find((call) => call.action === 'approve').rows.map(({ project, iid, sha }) => ({ project, iid, sha })), [
    { project: 'group/app', iid: 1, sha: 'head-1' },
  ]);
  assert.deepEqual(calls.find((call) => call.action === 'open').rows.map((row) => row.iid), [1, 2]);
});
