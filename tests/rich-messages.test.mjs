import test from 'node:test';
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
  sendReply,
  transport,
  updateReply,
} from '../src/teams.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';

const CARD = { type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text: 'Example' }] };
const MARKDOWN = '💬 **Example**\n\n🎫 [EX-1](https://jira.example.com/browse/EX-1)';
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

test('plain messages render exactly as before (no card, no attachment)', () => {
  const { html, mentions, cards } = renderReplyContent('hello **world**');
  assert.equal(cards, undefined);
  assert.deepEqual(mentions, []);
  assert.ok(html.includes('<b>world</b>'));
  assert.ok(!html.includes('<attachment'));
  assert.ok(html.endsWith(`<span style="display:none">${BOT_WATERMARK}</span>`));
});

test('rich messages render an attachment tag, the watermark and the card property', () => {
  const { html, mentions, cards } = renderReplyContent(makeRichMessage(MARKDOWN, CARD));
  assert.deepEqual(mentions, []);
  const id = html.match(/^<attachment id="([0-9a-f-]{36})"><\/attachment>/)?.[1];
  assert.ok(id, html);
  // Own-message detection relies on the watermark.
  assert.ok(html.endsWith(`<span style="display:none">${BOT_WATERMARK}</span>`));
  const parsed = JSON.parse(cards);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, id);
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
  assert.ok(html.includes('<attachment id="'));
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
  assert.ok(!plain[1].includes('<attachment'));
  assert.equal(JSON.parse(rich[2].properties.cards)[0].contentType, ADAPTIVE_CARD_CONTENT_TYPE);
  assert.ok(rich[1].includes('<attachment id="'));
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
  assert.ok(html.includes('<attachment id="'));
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
  assert.ok(rec.calls[0].args[1].includes('<attachment id="'));
  const [, retryHtml, retryOptions] = rec.calls[1].args;
  assert.ok(!retryHtml.includes('<attachment'));
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
  assert.ok(html.includes('<attachment id="'));
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
  assert.ok(!rec2.calls[1].args[2].includes('<attachment'));
  assert.equal(rec2.calls[1].args[4].properties.cards, undefined);

  // Plain updates do not touch the cards property at all.
  const rec3 = recordTransport();
  try {
    await updateReply(CONV, '1700000000005', ORIGINAL, MARKDOWN);
  } finally {
    rec3.restore();
  }
  assert.equal(rec3.calls[0].args[4].properties.cards, undefined);
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
  assert.ok(!retry[2].includes('<attachment'));
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
  assert.ok(rich.html.includes('<attachment id="'));
  assert.equal(JSON.parse(rich.properties.cards).length, 1);
  assert.ok(plain.html.startsWith(`<p><a href="${url}">${url}</a></p>`));
  assert.ok(!plain.html.includes('<attachment'));
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
  return watcher;
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
    assert.equal(html.includes('<attachment id="'), expectCard);
    if (expectCard) {
      const card = JSON.parse(options.properties.cards)[0].content;
      assert.equal(card.body[0].items[0].text, 'Something is broken');
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
