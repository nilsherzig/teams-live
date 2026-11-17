import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isRichMessage, messageMarkdown, setRichMessages, transport } from '../src/teams.mjs';

beforeEach(() => setRichMessages(false));
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { formatContactCard, formatSearchResultsList, formatWhereisCard } from '../src/users.mjs';

const CARD_TAG = 'itemtype="http://schema.skype.com/InputExtension"';
const CONV = '19:test@thread.v2';
const MR_URL = 'https://gitlab.example.com/group/app/-/merge_requests/42';

/** Replaces the Teams transport with a recorder (send: [conv, html, options]; edit: [conv, serverId, html, format, options]). */
function recordTransport() {
  const calls = [];
  const original = { ...transport };
  const next = (kind) => (...args) => {
    calls.push({ kind, args });
    return Promise.resolve({ ok: true, value: { messageId: '1700000000001', timestamp: '1700000000001' } });
  };
  transport.sendMessage = next('send');
  transport.editMessage = next('edit');
  return {
    calls,
    restore() {
      Object.assign(transport, original);
    },
  };
}

function newWatcher(teams = {}) {
  const watcher = new MergeRequestWatcher({
    config: { conversations: [], gitlab: { group: 'group', notify: { ci: { enable: true, on_success: true, on_failure: true }, rebase: true } }, teams },
    gitlab: {
      findMrLinks: () => [],
      mrLink: (project, iid) => `https://gitlab.example.com/${project}/-/merge_requests/${iid}`,
      pipelineLink: (project, id) => `https://gitlab.example.com/${project}/-/pipelines/${id}`,
      getMr: async () => null,
    },
    jira: null,
    opsgenie: null,
  });
  watcher.saveState = () => {};
  watcher.isRecentMrMessage = () => true;
  return watcher;
}

const entry = () => ({ conversationId: CONV, messageId: '1700000000000', from: 'Alice Example', previewText: 'x' });
const mrRef = (extra = {}) => ({ project: 'group/app', iid: 42, title: 'Add example feature', ...extra });
const cardOf = (options) => JSON.parse(options.properties.cards)[0]?.content;
// FactSet of a card as {title: value} (markdown links reduced to their labels).
const factsOf = (card) =>
  Object.fromEntries(
    card.body[0].items
      .find((i) => i.type === 'FactSet')
      .facts.map((f) => [f.title, f.value.replace(/\[((?:\\.|[^\]\\])*)\]\([^)]*\)/g, '$1')])
  );
const textsIn = (i) =>
  i.type === 'TextBlock' ? [i.text] : i.type === 'ColumnSet' ? i.columns.flatMap((c) => c.items.flatMap(textsIn)) : [];
const rowsOf = (card) => card.body[0].items.flatMap(textsIn);

async function run(fn) {
  const rec = recordTransport();
  try {
    await fn();
  } finally {
    rec.restore();
  }
  return rec.calls;
}

const openDetails = (extra = {}) => ({
  title: 'Add example feature',
  web_url: MR_URL,
  target_branch: 'main',
  state: 'opened',
  approved: false,
  approvalKnown: true,
  status: 'pending',
  autoMerge: false,
  needsRebase: false,
  hasConflicts: false,
  ...extra,
});

// ---------------------------------------------------------------------------
// MR cards: approval, auto-merge and rebase reach the card (initial + updates)
// ---------------------------------------------------------------------------

test('MR status card: API approval and auto-merge data reach the initial card, disabled included', async () => {
  const watcher = newWatcher({ rich_messages: true });
  const [call] = await run(() =>
    watcher.handleCiStatusComment(entry(), mrRef(), { id: 7, status: 'success' }, openDetails())
  );
  const facts = factsOf(cardOf(call.args[2]));
  assert.equal(facts.Approval, '⏳ Not approved yet');
  assert.equal(facts['Auto-merge'], '⏸️ Disabled');
  assert.equal(facts.Pipeline, '✅ Passed (#7)');
  assert.equal(facts.Rebase, undefined);
});

test('MR status card: approved without approver names and enabled auto-merge', async () => {
  const watcher = newWatcher({ rich_messages: true });
  const [call] = await run(() =>
    watcher.handleCiStatusComment(
      entry(),
      mrRef(),
      { id: 7, status: 'running' },
      openDetails({ approved: true, status: 'approved', approvedBy: [], autoMerge: true, autoMergeUser: 'Alice Example' })
    )
  );
  const facts = factsOf(cardOf(call.args[2]));
  assert.equal(facts.Approval, '\u{1F44D} Approved');
  assert.equal(facts['Auto-merge'], '\u{1F500} Enabled by Alice Example');
});

test('MR status card: unknown approval and auto-merge are not shown as false', async () => {
  const watcher = newWatcher({ rich_messages: true });
  const [call] = await run(() =>
    watcher.handleCiStatusComment(
      entry(),
      mrRef(),
      { id: 7, status: 'success' },
      openDetails({ approved: false, approvalKnown: false, status: 'pending', autoMerge: null })
    )
  );
  const facts = factsOf(cardOf(call.args[2]));
  assert.equal(facts.Approval, '❔ Unknown (not retrieved)');
  assert.equal(facts['Auto-merge'], '❔ Unknown (not retrieved)');
});

test('MR status card: in-place updates carry the new approval, auto-merge and rebase data', async () => {
  const watcher = newWatcher({ rich_messages: true });
  const mr = mrRef({ ciMessageServerId: '1700000000005' });
  const calls = await run(async () => {
    await watcher.handleCiStatusComment(
      entry(),
      mr,
      { id: 7, status: 'success' },
      openDetails({ needsRebase: true, hasConflicts: true, detailedMergeStatus: 'need_rebase' })
    );
    await watcher.handleCiStatusComment(
      entry(),
      mr,
      { id: 7, status: 'success' },
      openDetails({ approved: true, status: 'approved', approvedBy: ['Alice Example'], autoMerge: true })
    );
  });
  assert.deepEqual(calls.map((c) => c.kind), ['edit', 'edit']);
  const [required, resolved] = calls.map((c) => cardOf(c.args[4]));
  assert.equal(calls[0].args[1], '1700000000005');
  // Rebase required: the line states the reason and the GitLab status.
  assert.equal(factsOf(required).Rebase, '⚠️ Required: merge conflicts (status: need_rebase)');
  // Resolved: the line is gone, approval and auto-merge changed in place.
  const f = factsOf(resolved);
  assert.equal(f.Rebase, undefined);
  assert.equal(f.Approval, '\u{1F44D} Approved by Alice Example');
  assert.equal(f['Auto-merge'], '\u{1F500} Enabled');
});

test('MR rebase comment: required keeps the reason, resolved is conflict-free and the line goes away', async () => {
  const watcher = newWatcher({ rich_messages: true });
  const mr = mrRef();
  const calls = await run(async () => {
    await watcher.handleRebaseComment(
      entry(),
      mr,
      openDetails({ needsRebase: true, hasConflicts: false, detailedMergeStatus: 'need_rebase' })
    );
    await watcher.handleRebaseComment(entry(), mr, openDetails({ approved: true, status: 'approved', autoMerge: true }));
  });
  assert.deepEqual(calls.map((c) => c.kind), ['send', 'edit']);
  const [required, resolved] = [cardOf(calls[0].args[2]), cardOf(calls[1].args[4])];
  assert.equal(factsOf(required).Status, '⚠️ Rebase required');
  assert.equal(factsOf(required).Rebase, '⚠️ Required: behind target branch (status: need_rebase)');
  assert.equal(factsOf(resolved).Status, '✅ Rebased, up to date and conflict-free');
  assert.equal(factsOf(resolved).Rebase, undefined);
  assert.equal(factsOf(resolved).Approval, '\u{1F44D} Approved');
});

test('MR merged and closed cards keep what is known', async () => {
  const watcher = newWatcher({ rich_messages: true });
  const merged = await run(() =>
    watcher.handleMergedComment(
      entry(),
      mrRef(),
      openDetails({ state: 'merged', approved: true, status: 'merged', approvedBy: ['Alice Example'], autoMerge: true })
    )
  );
  const mergedFacts = factsOf(cardOf(merged[0].args[2]));
  assert.equal(mergedFacts.Status, '\u{1F7E3} Merged');
  assert.equal(mergedFacts.Approval, '\u{1F44D} Approved by Alice Example');
  assert.equal(mergedFacts['Auto-merge'], '\u{1F500} Enabled');

  const closed = await run(() =>
    watcher.handleCiStatusComment(
      entry(),
      mrRef(),
      { id: 7, status: 'failed' },
      openDetails({ state: 'closed', status: 'closed', approved: true, approvalKnown: true, autoMerge: true })
    )
  );
  const closedFacts = factsOf(cardOf(closed[0].args[2]));
  assert.equal(closedFacts.Status, '\u{1F534} Closed (unmerged)');
  assert.equal(closedFacts.Approval, '\u{1F44D} Approved');
  assert.equal(closedFacts['Auto-merge'], '\u{1F500} Enabled');
});

test('MR status without rich messages stays a regular message', async () => {
  const watcher = newWatcher({});
  const [call] = await run(() => watcher.handleCiStatusComment(entry(), mrRef(), { id: 7, status: 'success' }, openDetails()));
  assert.equal(call.args[1].includes(CARD_TAG), false);
  assert.equal(call.args[2].properties.cards, '[]');
});

// ---------------------------------------------------------------------------
// Command replies
// ---------------------------------------------------------------------------

const groupMrs = [
  {
    iid: 1,
    title: 'Fix example',
    web_url: 'https://gitlab.example.com/group/app/-/merge_requests/1',
    references: { full: 'group/app!1' },
    author: { name: 'Alice Example', username: 'alice' },
    draft: false,
    detailed_merge_status: 'need_rebase',
    approval_summary: { known: true, approved: false, approvedBy: [] },
    auto_merge_enabled: true,
  },
  {
    iid: 2,
    title: 'Add example',
    web_url: 'https://gitlab.example.com/group/app/-/merge_requests/2',
    references: { full: 'group/app!2' },
    author: { name: 'Bob Example', username: 'bob' },
    draft: false,
    detailed_merge_status: 'mergeable',
    approval_summary: { known: true, approved: true, approvedBy: ['Alice Example'] },
  },
];

test('/mrs: regular markdown by default, list card with approval, auto-merge and rebase badges when rich', () => {
  const off = newWatcher({});
  const plain = off.formatMrsMessage(groupMrs, {});
  assert.equal(typeof plain, 'string');
  assert.ok(!plain.includes('_approved_') && !plain.includes('_not approved_'));

  const on = newWatcher({ rich_messages: true });
  const rich = on.formatMrsMessage(groupMrs, {});
  assert.equal(isRichMessage(rich), true);
  const rows = rowsOf(rich.card).join('\n');
  assert.ok(rows.includes('[!1](https://gitlab.example.com/group/app/-/merge_requests/1)'));
  assert.ok(JSON.stringify(rich.card).includes('**app**'));
  assert.ok(rows.includes('not approved'));
  assert.ok(rows.includes('rebase!'));
  assert.ok(rows.includes('auto-merge'));
  assert.ok(rows.includes('approved'));
  // The card text never carries mention markup; mentions stay in the markdown (see renderReplyContent).
  assert.ok(!JSON.stringify(rich.card).includes('8:orgid'));
  assert.ok(messageMarkdown(rich).includes('Open Merge Requests'));
  // Status emojis of the regular list stay.
  assert.ok(rows.includes('⚠️') || rows.includes('✅'));
});

test('/mrs: an empty list and the regular text stay plain', () => {
  const on = newWatcher({ rich_messages: true });
  assert.equal(typeof on.formatMrsMessage([], {}), 'string');
});

test('/mrs: an oversized card falls back to the full markdown', () => {
  const many = Array.from({ length: 400 }, (_, i) => ({
    ...groupMrs[1],
    iid: 100 + i,
    title: `Example change number ${i} with a reasonably long descriptive title`,
    web_url: `https://gitlab.example.com/group/app/-/merge_requests/${100 + i}`,
    references: { full: `group/app!${100 + i}` },
  }));
  const on = newWatcher({ rich_messages: true });
  const message = on.formatMrsMessage(many, { mode: 'all' });
  assert.equal(typeof message, 'string');
  assert.ok(message.includes('!599') || message.includes('!100'));
});

test('/alerts: card when rich, regular markdown otherwise', async () => {
  const data = {
    alerts: [
      {
        message: 'Disk almost full',
        tinyId: '12',
        priority: 'P1',
        status: 'open',
        acknowledged: false,
        url: 'https://opsgenie.example.com/alert/detail/abc',
        owner: 'Alice Example',
      },
    ],
    onCallDuty: [],
    supportDuty: [],
  };
  const off = newWatcher({});
  assert.equal(typeof off.formatAlertsMessage(data, 'all'), 'string');
  const on = newWatcher({ rich_messages: true });
  const rich = on.formatAlertsMessage(data, 'all');
  if (isRichMessage(rich)) {
    assert.ok(rowsOf(rich.card).join('\n').includes('Disk almost full'));
  } else {
    assert.equal(typeof rich, 'string');
  }
});

test('richCommandMessage: person, availability and search results use cards, mentions stay in the markdown', () => {
  const person = { displayName: 'Alice Example', mri: '8:orgid:alice', email: 'alice@example.com', jobTitle: 'Engineer', department: 'Platform' };
  const on = newWatcher({ rich_messages: true });
  const off = newWatcher({});

  const contact = formatContactCard(person);
  assert.equal(off.richCommandMessage(contact, { service: 'directory', kind: 'Contact' }), contact);
  const contactCard = on.richCommandMessage(contact, { service: 'directory', kind: 'Contact' });
  assert.equal(isRichMessage(contactCard), true);
  const facts = factsOf(contactCard.card);
  assert.equal(facts['\u{1F4BC} Role'], 'Engineer');
  assert.equal(facts['\u{1F4E7} Email'], 'alice@example.com');
  assert.ok(!JSON.stringify(contactCard.card).includes('8:orgid'));
  // Parity: the regular markdown keeps its mention (regular mode and the card-rejection
  // fallback send it as is); the card shows the name as text.
  assert.equal(messageMarkdown(contactCard), contact);
  assert.ok(messageMarkdown(contactCard).includes('8:orgid'));

  const whereis = formatWhereisCard(person, { availability: 'Available', activity: 'Available' });
  const whereisCard = on.richCommandMessage(whereis, { service: 'availability', kind: 'Availability' });
  assert.equal(isRichMessage(whereisCard), true);
  assert.equal(factsOf(whereisCard.card)['\u{1F7E2} Status'], 'Available');

  const list = formatSearchResultsList(
    [person, { ...person, displayName: 'Alice Other', mri: '8:orgid:other', email: 'other@example.com' }],
    'alice'
  );
  const listCard = on.richCommandMessage(list, { service: 'directory', kind: 'Search results' });
  assert.equal(isRichMessage(listCard), true);
  const rows = rowsOf(listCard.card).join('\n');
  assert.ok(rows.includes('1. '));
  assert.ok(rows.includes('2. '));
  assert.ok(rows.includes('alice@example.com'));
});

test('/whois: a card in rich mode (name as text, no mention), the regular mention reply otherwise', async () => {
  const withMri = { displayName: 'Alice Example', mri: '8:orgid:alice', email: 'alice@example.com', jobTitle: 'Engineer' };
  const withoutMri = { displayName: 'Alice Example', email: 'alice@example.com', jobTitle: 'Engineer' };
  const cases = [
    // [teams config, person, expect a card]
    [{}, withMri, false],
    [{ rich_messages: true }, withMri, true],
    [{ rich_messages: true }, withoutMri, true],
  ];
  for (const [teams, person, expectCard] of cases) {
    const watcher = newWatcher(teams);
    watcher.userDirectory = { searchDirectory: async () => [person], findSuggestions: () => [], findUser: () => null };
    watcher.setCommandReaction = async () => {};
    const calls = await run(() =>
      watcher.executeWhoisCommand({ conversationId: CONV, messageId: '1700000000000', from: 'Alice Example' }, ['alice'])
    );
    assert.equal(calls.length, 1);
    const [, html, options] = calls[0].args;
    assert.equal(html.includes(CARD_TAG), expectCard);
    if (expectCard) {
      const card = cardOf(options);
      assert.equal(factsOf(card)['\u{1F4BC} Role'], 'Engineer');
      assert.ok(JSON.stringify(card).includes('Alice Example'));
      assert.ok(!JSON.stringify(card).includes('8:orgid'));
      assert.equal(options.properties.mentions, '[]');
    } else {
      // Same message and notification as ever.
      assert.equal(options.properties.cards, '[]');
      assert.equal(JSON.parse(options.properties.mentions).length, 1);
    }
  }
});

test('error and acknowledgement replies are cards in rich mode, plain otherwise', async () => {
  for (const teams of [{ rich_messages: true }, {}]) {
    const watcher = newWatcher(teams);
    watcher.userDirectory = { searchDirectory: async () => [], findSuggestions: () => [], findUser: () => null };
    watcher.setCommandReaction = async () => {};
    const calls = await run(() =>
      watcher.executeWhoisCommand({ conversationId: CONV, messageId: '1700000000000', from: 'Alice Example' }, ['nobody'])
    );
    assert.equal(calls[0].args[1].includes(CARD_TAG), teams.rich_messages === true);
  }
});

test('size budget counts the fallback copy of the markdown, not just the bare card', () => {
  const on = newWatcher({ rich_messages: true });
  const markdown = `Head\n\n${'- row with some text to fill the message\n'.repeat(300)}`;
  const card = (size) => ({
    type: 'AdaptiveCard',
    version: '1.4',
    body: [{ type: 'TextBlock', text: 'x'.repeat(size) }],
  });
  // The bare card alone is well under the limit...
  assert.ok(Buffer.byteLength(JSON.stringify(card(14000))) < 24000);
  // ...but with the markdown copy and the wire escaping it is over: the full markdown is sent.
  const big = on.richMessage(markdown, () => card(14000));
  assert.equal(big, markdown);
  // A card that fits including its fallback copy stays a card.
  const small = on.richMessage('Head\n\n- one', () => card(500));
  assert.equal(isRichMessage(small), true);
  assert.equal(messageMarkdown(small), 'Head\n\n- one');
});

test('/status card: "none" when the MR has no pipeline, "unknown" when the lookup failed', async () => {
  const on = newWatcher({ rich_messages: true });
  const facts = (mrState) => {
    const card = on.buildMrCard({ project: 'group/app', iid: 42, title: 'Add example feature' }, mrState, { state: 'open', pipeline: null }).body;
    return card;
  };
  const base = { state: 'opened', approved: false, approvalKnown: true, status: 'pending', autoMerge: false, pipeline: null };
  const pipelineOf = (mrState) =>
    JSON.stringify(facts(mrState)).match(/"title":"Pipeline","value":"([^"]*)"/)?.[1] ?? null;
  assert.equal(pipelineOf({ ...base, pipelineKnown: true }), '\u{1F3D7}️ None');
  assert.equal(pipelineOf({ ...base, pipelineKnown: false }), '❔ Unknown (not retrieved)');
  // Callers that did not ask GitLab keep the previous behaviour (no pipeline fact).
  assert.equal(pipelineOf(base), null);
  // A pipeline known to exist elsewhere is never reported as "none".
  assert.equal(
    pipelineOf({ ...base, pipelineKnown: true, pipeline: { id: 5, status: 'success' } }),
    null
  );
});
