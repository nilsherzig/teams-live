#!/usr/bin/env node
// Smoke test for regular vs. rich (Adaptive Card) messages.
//
// Sends generic fixture messages (no real data) through the same application
// code the watcher uses (src/teams.mjs + src/cards.mjs) to ONE conversation
// that you name explicitly. Point it at your own notes/self chat, never at a
// team chat. Channel conversations are refused.
//
// Usage:
//   node src/smoke-rich.mjs <conversationId> [--mode regular|rich|both] [--kind <kind>[,<kind>...]|all] [--dry-run]
//
// Kinds: mr, mr-merged, mr-rebase, job, pipeline, jira, opsgenie, confluence.
// --dry-run prints the payloads instead of sending them (no Teams session needed).
// It needs the same auth state as the daemon (HOME, XDG_STATE_HOME, ...).
import {
  makeRichMessage,
  sendDirectMessage,
  sendReply,
  updateReply,
  transport,
} from './teams.mjs';
import {
  buildConfluencePageCard,
  buildJiraIssueCard,
  buildJobCard,
  buildMergeRequestCard,
  buildOpsGenieAlertCard,
  buildPipelineCard,
} from './cards.mjs';

const BASE = 'https://example.com';

const mrBase = {
  iid: 42,
  project: 'example-group/example-project',
  title: 'Add example feature',
  url: `${BASE}/gitlab/example-group/example-project/-/merge_requests/42`,
  targetBranch: 'main',
  jira: { key: 'EX-1', url: `${BASE}/jira/browse/EX-1` },
  pipeline: { id: 7, status: 'success', url: `${BASE}/gitlab/example-group/example-project/-/pipelines/7` },
};

const FIXTURES = {
  mr: () => ({
    markdown: `**MR !42** Add example feature\nApproved by Alice Example, pipeline passed.`,
    card: buildMergeRequestCard({ ...mrBase, state: 'open', approved: true, approvedBy: ['Alice Example'], autoMerge: true, autoMergeUser: 'Bob Example' }),
  }),
  'mr-merged': () => ({
    markdown: `**MR !42** Add example feature was merged.`,
    card: buildMergeRequestCard({ ...mrBase, state: 'merged' }),
  }),
  'mr-rebase': () => ({
    markdown: `**MR !42** Add example feature needs a rebase (merge conflicts).`,
    card: buildMergeRequestCard({ ...mrBase, state: 'rebase', hasConflicts: true, pipeline: null }),
  }),
  job: () => ({
    markdown: `**Job #9** lint failed.`,
    card: buildJobCard({
      id: 9,
      name: 'lint',
      status: 'failed',
      stage: 'test',
      ref: 'feature/example',
      duration: '1m 12s',
      failureReason: 'script_failure',
      project: 'example-group/example-project',
      url: `${BASE}/gitlab/example-group/example-project/-/jobs/9`,
      pipeline: mrBase.pipeline,
      mr: { iid: 42, title: 'Add example feature', url: mrBase.url },
    }),
  }),
  pipeline: () => ({
    markdown: `**Pipeline #7** passed.`,
    card: buildPipelineCard({
      id: 7,
      status: 'success',
      ref: 'main',
      duration: '4m 3s',
      project: 'example-group/example-project',
      url: mrBase.pipeline.url,
    }),
  }),
  jira: () => ({
    markdown: `**EX-1** Something is broken (Open, High, Alice Example)`,
    card: buildJiraIssueCard({
      key: 'EX-1',
      summary: 'Something is broken',
      url: `${BASE}/jira/browse/EX-1`,
      issueType: 'Bug',
      status: 'In Progress',
      statusCategory: 'indeterminate',
      priority: 'High',
      assignee: 'Alice Example',
    }),
  }),
  opsgenie: () => ({
    markdown: `**Alert #12** Disk almost full (P2, unacknowledged)`,
    card: buildOpsGenieAlertCard({
      tinyId: '12',
      message: 'Disk almost full',
      priority: 'P2',
      status: 'open',
      acknowledged: false,
      owner: 'Example Team',
      url: `${BASE}/opsgenie/alert/detail/12`,
    }),
  }),
  confluence: () => ({
    markdown: `**Runbook** (Space OPS)`,
    card: buildConfluencePageCard({
      title: 'Runbook',
      spaceKey: 'OPS',
      spaceName: 'Operations',
      author: 'Alice Example',
      url: `${BASE}/confluence/pages/1`,
    }),
  }),
};

function parseArgs(argv) {
  const opts = { mode: 'both', kinds: ['mr', 'jira'], dryRun: false, conversationId: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--mode') opts.mode = argv[++i];
    else if (arg === '--kind') {
      const value = argv[++i] || '';
      opts.kinds = value === 'all' ? Object.keys(FIXTURES) : value.split(',').filter(Boolean);
    } else if (!arg.startsWith('--') && !opts.conversationId) opts.conversationId = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['regular', 'rich', 'both'].includes(opts.mode)) throw new Error(`Invalid --mode: ${opts.mode}`);
  for (const kind of opts.kinds) {
    if (!FIXTURES[kind]) throw new Error(`Unknown kind: ${kind} (known: ${Object.keys(FIXTURES).join(', ')})`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.conversationId) {
    throw new Error('Usage: smoke-rich.mjs <conversationId> [--mode regular|rich|both] [--kind <kind>|all] [--dry-run]');
  }
  if (opts.conversationId.endsWith('@thread.tacv2')) {
    throw new Error('Refusing to send to a channel; use your own notes/self chat.');
  }

  if (opts.dryRun) {
    transport.sendMessage = async (conversationId, html, options) => {
      console.log(JSON.stringify({ call: 'sendMessage', conversationId, html, options }, null, 2));
      return { ok: true, value: { messageId: `${Date.now()}000000`, timestamp: String(Date.now()) } };
    };
    transport.editMessage = async (conversationId, messageId, html, format, options) => {
      console.log(JSON.stringify({ call: 'editMessage', conversationId, messageId, html, options }, null, 2));
      return { ok: true, value: { messageId, timestamp: String(Date.now()) } };
    };
  }

  const modes = opts.mode === 'both' ? ['regular', 'rich'] : [opts.mode];
  const describe = (result, ok) => (result.ok ? ok : `FAILED: ${result.error?.message || result.error}`);
  // Teams edits and quotes need the server timestamp id (as the watcher stores it);
  // `messageId` is a client-generated id that the edit endpoint rejects.
  const serverId = (result) => {
    const value = result.value;
    if (!value?.timestamp) console.warn('Send result has no timestamp; falling back to messageId (edits may fail):', Object.keys(value || {}));
    const id = value?.timestamp ?? value?.messageId;
    return id ? String(id) : null;
  };
  const asMessage = (mode, text, card) => (mode === 'rich' ? makeRichMessage(text, card) : text);

  // The last successfully sent message is the one quoted by the reply below.
  let lastSent = null;
  for (const kind of opts.kinds) {
    for (const mode of modes) {
      const { markdown, card } = FIXTURES[kind]();
      const label = `[smoke-rich ${mode}/${kind}]`;
      const result = await sendDirectMessage(opts.conversationId, asMessage(mode, `${label} ${markdown}`, card));
      const id = result.ok ? serverId(result) : null;
      console.log(label, describe(result, `sent (${id})`));
      if (id) lastSent = { messageId: id, label };
      else process.exitCode = 1;
    }
  }
  if (!lastSent) {
    console.error('Nothing was sent successfully; skipping the reply and update checks.');
    process.exit(1);
  }

  // Quote reply and in-place update of that reply, once per requested mode.
  // In rich mode the reply is finally updated back to regular text, which must clear the card.
  const { markdown, card } = FIXTURES[opts.kinds[opts.kinds.length - 1]]();
  const original = { messageId: lastSent.messageId, from: 'Smoke Test', fromMri: '', previewText: lastSent.label };
  for (const mode of modes) {
    const label = `[smoke-rich ${mode} reply]`;
    const reply = await sendReply(opts.conversationId, original, asMessage(mode, `${label} ${markdown}`, card));
    const replyId = reply.ok ? serverId(reply) : null;
    console.log(label, describe(reply, `sent (${replyId})`));
    if (!replyId) {
      process.exitCode = 1;
      continue;
    }
    const updated = await updateReply(opts.conversationId, replyId, original, asMessage(mode, `${label} updated ${markdown}`, card));
    console.log(label, describe(updated, 'updated in place'));
    if (!updated.ok) process.exitCode = 1;
    if (mode === 'rich') {
      const cleared = await updateReply(opts.conversationId, replyId, original, `${label} updated back to regular text`);
      console.log(label, describe(cleared, 'updated back to regular text (card cleared)'));
      if (!cleared.ok) process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
