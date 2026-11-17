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
      return { ok: true, value: { messageId: String(Date.now()), timestamp: String(Date.now()) } };
    };
    transport.editMessage = async (conversationId, messageId, html, format, options) => {
      console.log(JSON.stringify({ call: 'editMessage', conversationId, messageId, html, options }, null, 2));
      return { ok: true, value: { messageId, timestamp: String(Date.now()) } };
    };
  }

  const modes = opts.mode === 'both' ? ['regular', 'rich'] : [opts.mode];
  for (const kind of opts.kinds) {
    for (const mode of modes) {
      const { markdown, card } = FIXTURES[kind]();
      const label = `[smoke-rich ${mode}/${kind}]`;
      const text = `${label} ${markdown}`;
      const body = mode === 'rich' ? makeRichMessage(text, card) : text;
      const result = await sendDirectMessage(opts.conversationId, body);
      console.log(label, result.ok ? `sent (${result.value?.messageId})` : `FAILED: ${result.error?.message || result.error}`);
      if (!result.ok) process.exitCode = 1;
    }
  }

  // Reply (quote) and in-place update paths with a card, on the last sent message.
  const { markdown, card } = FIXTURES[opts.kinds[0]]();
  const original = { messageId: String(Date.now()), from: 'Smoke Test', fromMri: '', previewText: 'smoke test message' };
  const reply = await sendReply(opts.conversationId, original, makeRichMessage(`${markdown} (quote reply)`, card));
  console.log('[smoke-rich reply]', reply.ok ? `sent (${reply.value?.messageId})` : `FAILED: ${reply.error?.message || reply.error}`);
  if (reply.ok && reply.value?.messageId) {
    const updated = await updateReply(opts.conversationId, reply.value.messageId, original, makeRichMessage(`${markdown} (updated)`, card));
    console.log('[smoke-rich update]', updated.ok ? 'updated in place' : `FAILED: ${updated.error?.message || updated.error}`);
    if (!updated.ok) process.exitCode = 1;
  } else {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
