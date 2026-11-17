import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_CARD_CONTENT_TYPE,
  BOT_WATERMARK,
  buildQuotedReplyHtml,
  editOriginalMessage,
  isRichMessage,
  makeRichMessage,
  messageMarkdown,
  renderReplyContent,
  sendDirectMessage,
  setRichMessages,
  sendReply,
  transport,
  updateReply,
} from '../src/teams.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { stubDirectoryLookups } from './stub-transport.mjs';

// Regular mode unless a test builds a rich watcher (the switch is process-wide).
beforeEach(() => setRichMessages(false));

const CARD = { type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text: 'Example' }] };
const MARKDOWN = '💬 **Example**\n\n🎫 [EX-1](https://jira.example.com/browse/EX-1)';
const CARD_TAG = 'itemtype="http://schema.skype.com/InputExtension"';
const CONV = '19:example@thread.v2';
const ORIGINAL = { messageId: '1700000000000', from: 'Alice Example', fromMri: '8:orgid:alice', previewText: 'see EX-1' };

/** Replaces the Teams transport with a recorder; each response is `ok` unless the queue says otherwise. */
function recordTransport(responses = []) {
  const calls = [];
  const original = { ...transport };
  const next = (kind) => (...args) => {
    calls.push({ kind, args });
    const response = responses.shift();
    return Promise.resolve(response ?? { ok: true, value: { messageId: '1700000000001', timestamp: '1700000000001' } });
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

const failure = (message = 'Bad request') => ({ ok: false, error: { message } });

test('makeRichMessage returns the plain markdown when there is no card', () => {
  assert.equal(makeRichMessage(` ${MARKDOWN} `, null), MARKDOWN);
  assert.equal(makeRichMessage(MARKDOWN, undefined), MARKDOWN);
  const rich = makeRichMessage(MARKDOWN, CARD);
  assert.equal(isRichMessage(rich), true);
  assert.equal(isRichMessage(MARKDOWN), false);
  assert.equal(messageMarkdown(rich), MARKDOWN);
  assert.equal(messageMarkdown(MARKDOWN), MARKDOWN);
});

test('plain messages render exactly as before (no card reference)', () => {
  const { html, mentions, cards } = renderReplyContent('hello **world**');
  assert.equal(cards, undefined);
  assert.deepEqual(mentions, []);
  assert.ok(html.includes('<b>world</b>'));
  assert.ok(!html.includes(CARD_TAG));
  assert.ok(html.endsWith(`<span style="display:none">${BOT_WATERMARK}</span>`));
});

test('rich messages render the native card reference, the watermark and the card property', () => {
  const { html, mentions, cards } = renderReplyContent(makeRichMessage(MARKDOWN, CARD));
  assert.deepEqual(mentions, []);
  // Wire format of the Teams client: InputExtension span with a hyphen-less cardClientId.
  const match = html.match(
    /^<span itemid="([0-9a-f]{32})" itemscope="" itemtype="http:\/\/schema\.skype\.com\/InputExtension"><span itemprop="cardId"><\/span><\/span>/
  );
  assert.ok(match, html);
  const id = match[1];
  // Own-message detection relies on the watermark.
  assert.ok(html.endsWith(`<span style="display:none">${BOT_WATERMARK}</span>`));
  const parsed = JSON.parse(cards);
  assert.equal(parsed.length, 1);
  assert.deepEqual(Object.keys(parsed[0]).sort(), ['cardClientId', 'content', 'contentType']);
  assert.equal(parsed[0].cardClientId, id);
  assert.equal(parsed[0].contentType, ADAPTIVE_CARD_CONTENT_TYPE);
  assert.equal(parsed[0].content.type, 'AdaptiveCard');
  assert.equal(parsed[0].content.fallbackText, MARKDOWN);
  // The caller's card object is not mutated.
  assert.equal(CARD.fallbackText, undefined);
});

test('quoted reply keeps the quote block and adds the card for rich messages', () => {
  const { html, cards } = buildQuotedReplyHtml({
    messageId: '1700000000000',
    from: 'Alice Example',
    fromMri: '8:orgid:alice',
    previewText: 'see EX-1',
    replyMarkdown: makeRichMessage(MARKDOWN, CARD),
  });
  assert.ok(html.startsWith('<blockquote itemscope="" itemtype="http://schema.skype.com/Reply"'));
  assert.ok(html.includes(CARD_TAG));
  assert.ok(cards);
});

test('sendDirectMessage: plain message sends no cards, rich message sends the card', async () => {
  const rec = recordTransport();
  try {
    await sendDirectMessage(CONV, MARKDOWN);
    await sendDirectMessage(CONV, makeRichMessage(MARKDOWN, CARD));
  } finally {
    rec.restore();
  }
  assert.equal(rec.calls.length, 2);
  const [plain, rich] = rec.calls.map((c) => c.args);
  assert.equal(plain[2].properties.cards, '[]');
  assert.ok(!plain[1].includes(CARD_TAG));
  assert.equal(JSON.parse(rich[2].properties.cards)[0].contentType, ADAPTIVE_CARD_CONTENT_TYPE);
  assert.ok(rich[1].includes(CARD_TAG));
  assert.equal(rich[2].properties.formatVariant, 'TEAMS');
});

test('sendReply keeps chat quote-reply semantics with a card', async () => {
  const rec = recordTransport();
  try {
    const result = await sendReply(CONV, ORIGINAL, makeRichMessage(MARKDOWN, CARD));
    assert.equal(result.ok, true);
  } finally {
    rec.restore();
  }
  const [, html, options] = rec.calls[0].args;
  assert.ok(html.includes('itemtype="http://schema.skype.com/Reply"'));
  assert.ok(html.includes(CARD_TAG));
  assert.equal(options.properties.hasValidMsgReferences, true);
  assert.equal(JSON.parse(options.properties.qtdMsgs)[0].messageId, 1700000000000);
  assert.equal(JSON.parse(options.properties.cards).length, 1);
  assert.equal(options.replyToMessageId, undefined);
});

test('sendReply keeps channel thread semantics with a card', async () => {
  const rec = recordTransport();
  try {
    await sendReply('19:example@thread.tacv2', ORIGINAL, makeRichMessage(MARKDOWN, CARD));
  } finally {
    rec.restore();
  }
  const [conversation, , options] = rec.calls[0].args;
  assert.equal(conversation, '19:example@thread.tacv2');
  assert.equal(options.replyToMessageId, '1700000000000');
});

test('sendReply falls back to the regular message when the card is rejected', async () => {
  const rec = recordTransport([failure('Bad request: invalid card')]);
  const warn = console.warn;
  const error = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    const result = await sendReply(CONV, ORIGINAL, makeRichMessage(MARKDOWN, CARD));
    assert.equal(result.ok, true);
  } finally {
    console.warn = warn;
    console.error = error;
    rec.restore();
  }
  assert.equal(rec.calls.length, 2);
  assert.ok(rec.calls[0].args[1].includes(CARD_TAG));
  const [, retryHtml, retryOptions] = rec.calls[1].args;
  assert.ok(!retryHtml.includes(CARD_TAG));
  assert.ok(retryHtml.includes('EX-1'));
  assert.equal(retryOptions.properties.cards, '[]');
});

test('plain message failure is not retried (no fallback path for regular messages)', async () => {
  const rec = recordTransport([failure('Bad request')]);
  const error = console.error;
  console.error = () => {};
  try {
    const result = await sendReply(CONV, ORIGINAL, MARKDOWN);
    assert.equal(result.ok, false);
  } finally {
    console.error = error;
    rec.restore();
  }
  assert.equal(rec.calls.length, 1);
});

test('updateReply edits in place with the card, and falls back to plain text', async () => {
  const rec = recordTransport();
  try {
    await updateReply(CONV, '1700000000005', ORIGINAL, makeRichMessage(MARKDOWN, CARD));
  } finally {
    rec.restore();
  }
  assert.equal(rec.calls[0].kind, 'edit');
  const [, serverId, html, format, options] = rec.calls[0].args;
  assert.equal(serverId, '1700000000005');
  assert.equal(format, 'html');
  assert.ok(html.includes(CARD_TAG));
  assert.equal(JSON.parse(options.properties.cards).length, 1);

  const rec2 = recordTransport([failure('Bad request')]);
  const warn = console.warn;
  const error = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    const result = await updateReply(CONV, '1700000000005', ORIGINAL, makeRichMessage(MARKDOWN, CARD));
    assert.equal(result.ok, true);
  } finally {
    console.warn = warn;
    console.error = error;
    rec2.restore();
  }
  assert.equal(rec2.calls.length, 2);
  assert.ok(!rec2.calls[1].args[2].includes(CARD_TAG));
  assert.equal(rec2.calls[1].args[4].properties.cards, '[]');

  // A plain update explicitly clears a card that the message had before.
  const rec3 = recordTransport();
  try {
    await updateReply(CONV, '1700000000005', ORIGINAL, MARKDOWN);
  } finally {
    rec3.restore();
  }
  assert.equal(rec3.calls[0].args[4].properties.cards, '[]');
});

test('sendReply restores the pending update id for the plain retry', async () => {
  // Rich attempt: the in-place edit and the follow-up post both fail; the plain retry edits again.
  const rec = recordTransport([failure('Bad request'), failure('Bad request')]);
  const warn = console.warn;
  const error = console.error;
  console.warn = () => {};
  console.error = () => {};
  const original = { ...ORIGINAL, replyMessageIdToUpdate: '1700000000009' };
  try {
    const result = await sendReply(CONV, original, makeRichMessage(MARKDOWN, CARD));
    assert.equal(result.ok, true);
  } finally {
    console.warn = warn;
    console.error = error;
    rec.restore();
  }
  assert.deepEqual(rec.calls.map((c) => c.kind), ['edit', 'send', 'edit']);
  const retry = rec.calls[2].args;
  assert.equal(retry[1], '1700000000009');
  assert.ok(!retry[2].includes(CARD_TAG));
});

const MENTION_MARKDOWN = 'Assigned to @[Alice Example](8:orgid:alice) in [EX-1](https://jira.example.com/browse/EX-1)';

test('a rich message whose text has mentions is still a card: names as text, no mention metadata', async () => {
  const rich = makeRichMessage(MENTION_MARKDOWN, CARD);
  const rendered = renderReplyContent(rich);
  assert.deepEqual(rendered.mentions, []);
  assert.ok(rendered.html.includes(CARD_TAG));
  assert.equal(JSON.parse(rendered.cards).length, 1);
  // The notification/preview text shows the name, not the raw mention markup.
  const fallback = JSON.parse(rendered.cards)[0].content.fallbackText;
  assert.ok(fallback.includes('**Alice Example**'));
  assert.ok(!fallback.includes('8:orgid'));

  const rec = recordTransport();
  try {
    await sendDirectMessage(CONV, rich);
    await sendReply(CONV, ORIGINAL, rich);
    await updateReply(CONV, '1700000000005', ORIGINAL, rich);
    await editOriginalMessage(CONV, '1700000000000', 'https://example.com/x', rich);
  } finally {
    rec.restore();
  }
  assert.equal(rec.calls.length, 4);
  for (const { args } of rec.calls) {
    const { html, options } = args.length === 3 ? { html: args[1], options: args[2] } : { html: args[2], options: args[4] };
    assert.ok(html.includes(CARD_TAG));
    assert.equal(JSON.parse(options.properties.cards).length, 1);
    assert.equal(options.properties.mentions, '[]');
  }
});

// The explicit card-rejection fallback is the one place where a mention works again: plain text.
test('when Teams rejects the card, the plain retry keeps the mention', async () => {
  const rich = makeRichMessage(MENTION_MARKDOWN, CARD);
  const rec = recordTransport([failure('card rejected')]);
  const warn = console.warn;
  const error = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    await sendReply(CONV, ORIGINAL, rich);
  } finally {
    console.warn = warn;
    console.error = error;
    rec.restore();
  }
  assert.equal(rec.calls.length, 2);
  const retry = rec.calls[1].args[2];
  assert.equal(retry.properties.cards, '[]');
  assert.equal(JSON.parse(retry.properties.mentions).length, 1);
});

test('editOriginalMessage keeps the user URL and adds the card', async () => {
  const url = 'https://jira.example.com/browse/EX-1';
  const rec = recordTransport();
  try {
    await editOriginalMessage(CONV, '1700000000000', url, makeRichMessage(MARKDOWN, CARD));
    await editOriginalMessage(CONV, '1700000000000', url, MARKDOWN);
  } finally {
    rec.restore();
  }
  const [rich, plain] = rec.calls.map((c) => ({ html: c.args[2], properties: c.args[4].properties }));
  assert.ok(rich.html.startsWith(`<p><a href="${url}">${url}</a></p>`));
  assert.ok(rich.html.includes(CARD_TAG));
  assert.equal(JSON.parse(rich.properties.cards).length, 1);
  assert.ok(plain.html.startsWith(`<p><a href="${url}">${url}</a></p>`));
  assert.ok(!plain.html.includes(CARD_TAG));
  assert.equal(plain.properties.cards, '[]');
});

function newWatcher(teams) {
  const watcher = new MergeRequestWatcher({
    config: { conversations: [], gitlab: {}, teams },
    gitlab: { findMrLinks: () => [] },
    jira: null,
    opsgenie: null,
  });
  watcher.saveState = () => {};
  return stubDirectoryLookups(watcher);
}

const jiraIssue = {
  key: 'EX-1',
  summary: 'Something is broken',
  url: 'https://jira.example.com/browse/EX-1',
  issueType: 'Bug',
  status: 'Open',
  statusCategory: 'new',
  priority: 'High',
  assignee: 'Alice Example',
};

test('watcher richMessage helper: regular messages by default, card when enabled', () => {
  const off = newWatcher({});
  assert.equal(off.richMessages, false);
  assert.equal(
    off.richMessage('text', () => {
      throw new Error('card must not be built when rich messages are off');
    }),
    'text'
  );

  const on = newWatcher({ rich_messages: true });
  assert.equal(on.richMessages, true);
  const rich = on.richMessage('text', () => CARD);
  assert.equal(isRichMessage(rich), true);
  assert.equal(messageMarkdown(rich), 'text');

  const log = console.error;
  console.error = () => {};
  try {
    assert.equal(
      on.richMessage('text', () => {
        throw new Error('boom');
      }),
      'text'
    );
  } finally {
    console.error = log;
  }
});

test('Jira handler sends a regular reply by default and a card with rich_messages', async () => {
  for (const [teams, expectCard] of [
    [{}, false],
    [{ rich_messages: false }, false],
    [{ rich_messages: true }, true],
  ]) {
    const watcher = newWatcher(teams);
    const entry = { conversationId: CONV, messageId: '1700000000000', from: 'Alice Example', previewText: 'x' };
    const issue = { key: 'EX-1', url: jiraIssue.url };
    const rec = recordTransport();
    try {
      await watcher.handleJiraIssueComment(entry, issue, jiraIssue);
    } finally {
      rec.restore();
    }
    const [, html, options] = rec.calls[0].args;
    assert.equal(html.includes(CARD_TAG), expectCard);
    if (expectCard) {
      const card = JSON.parse(options.properties.cards)[0].content;
      // The title links to the issue.
      assert.equal(card.body[0].items[1].text.replace(/^\[(.*)\]\(.*\)$/, '$1'), 'Something is broken');
      // The regular text is kept as the card's fallback.
      assert.ok(card.fallbackText.includes('EX-1'));
    } else {
      assert.equal(options.properties.cards, '[]');
      assert.ok(html.includes('Something is broken'));
    }
    assert.equal(issue.messageServerId, '1700000000001');
  }
});

test('every integration handler produces a card when rich_messages is on', async () => {
  const watcher = newWatcher({ rich_messages: true });
  watcher.gitlab = {
    findMrLinks: () => [],
    mrLink: (project, iid) => `https://gitlab.example.com/${project}/-/merge_requests/${iid}`,
    jobLink: (project, id) => `https://gitlab.example.com/${project}/-/jobs/${id}`,
    pipelineLink: (project, id) => `https://gitlab.example.com/${project}/-/pipelines/${id}`,
    getMrForJob: async () => null,
    getMrForPipeline: async () => null,
    getMr: async () => null,
  };
  watcher.isRecentMrMessage = () => true;
  watcher.config.gitlab = { notify: { ci: { enable: true, on_success: true, on_failure: true }, rebase: true } };

  const base = () => ({ conversationId: CONV, messageId: '1700000000000', from: 'Alice Example', previewText: 'x' });
  const mr = () => ({ project: 'group/project', iid: 42, title: 'Add example feature' });
  const details = { title: 'Add example feature', approved: true, approvedBy: ['Alice Example'] };

  const scenarios = {
    'CI status': () => watcher.handleCiStatusComment(base(), mr(), { id: 7, status: 'success' }, details),
    rebase: () => watcher.handleRebaseComment(base(), mr(), { ...details, needsRebase: true, hasConflicts: true, detailedMergeStatus: 'need_rebase' }),
    merged: () => watcher.handleMergedComment(base(), mr(), details),
    closed: () => watcher.handleClosedComment(base(), mr(), details),
    job: () =>
      watcher.handleJobStatusComment(base(), { project: 'group/project', jobId: 9, mr: null }, { id: 9, name: 'lint', status: 'success' }),
    pipeline: () =>
      watcher.handlePipelineStatusComment(base(), { project: 'group/project', pipelineId: 7, mr: null }, { id: 7, status: 'failed' }),
    jira: () => watcher.handleJiraIssueComment(base(), { key: 'EX-1' }, jiraIssue),
    opsgenie: () =>
      watcher.handleOpsGenieAlertComment(base(), { id: 'abcdef123456' }, {
        id: 'abcdef123456',
        message: 'Disk almost full',
        tinyId: '12',
        url: 'https://opsgenie.example.com/alert/detail/abcdef123456',
        priority: 'P2',
        status: 'open',
        acknowledged: false,
      }),
    confluence: () =>
      watcher.handleConfluencePageComment(base(), { key: 'page-1' }, {
        title: 'Runbook',
        spaceKey: 'OPS',
        url: 'https://confluence.example.com/pages/1',
      }),
  };

  for (const [name, run] of Object.entries(scenarios)) {
    const rec = recordTransport();
    try {
      await run();
    } finally {
      rec.restore();
    }
    assert.equal(rec.calls.length, 1, `${name}: expected exactly one send`);
    const options = rec.calls[0].args[2];
    const cards = JSON.parse(options.properties.cards);
    assert.equal(cards.length, 1, `${name}: expected a card`);
    assert.equal(cards[0].contentType, ADAPTIVE_CARD_CONTENT_TYPE, name);
    assert.equal(cards[0].content.type, 'AdaptiveCard', name);
  }
});
