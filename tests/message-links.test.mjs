import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  buildMessageSearchText,
  collectMessageUrls,
  decodeHtmlEntities,
  extractHrefs,
  stripTruncatedUrlText,
} from '../src/message-links.mjs';
import { TrouterClient } from '../src/trouter.mjs';
import { extractCandidateUrls, isMessageOnlyUrl, MergeRequestWatcher } from '../src/watcher.mjs';

const FULL = 'https://docs.example.com/guides/deployment/rollout-strategies/canary-releases?section=metrics&view=full';
const SHORT = 'https://docs.example.com/guides/deployment/rollout-str…';
const MR = 'https://gitlab.example.com/group/project/-/merge_requests/1234';
const MR_SHORT = 'https://gitlab.example.com/group/project/-/merge_requests/12…';

// What Teams sends live: the anchor carries the full href, its text is cut off.
const liveHtml = (href, quote = '"') => `<p><a href=${quote}${href}${quote}>${SHORT}</a></p>`;

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
});

class FakeWebSocket extends EventTarget {
  constructor() {
    super();
    this.readyState = 1;
    FakeWebSocket.last = this;
  }
  send() {}
  receive(frame) {
    const ev = new Event('message');
    ev.data = frame;
    this.dispatchEvent(ev);
  }
  close() {
    this.readyState = 3;
  }
}

test('decodeHtmlEntities handles named, decimal and hex entities', () => {
  assert.equal(decodeHtmlEntities('a=1&amp;b=2&#38;c=3&#x26;d=4&lt;&gt;&quot;&#39;&apos;&nbsp;x'), `a=1&b=2&c=3&d=4<>"'' x`);
  assert.equal(decodeHtmlEntities('&unknown; &#99999999999;'), '&unknown; &#99999999999;');
});

test('extractHrefs reads double, single and unquoted hrefs and decodes entities', () => {
  const html =
    '<a href="https://a.example.com/x?p=1&amp;q=2">a</a>' +
    "<a class='c' href='https://b.example.com/y?p=1&#38;q=2'>b</a>" +
    '<a href=https://c.example.com/z>c</a>' +
    '<abbr title="not a link" href="https://nope.example.com/">x</abbr>';
  assert.deepEqual(extractHrefs(html), [
    'https://a.example.com/x?p=1&q=2',
    'https://b.example.com/y?p=1&q=2',
    'https://c.example.com/z',
  ]);
});

test('live event: trouter keeps the full href for double and single quoted anchors', async () => {
  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/v4/a')) {
      return new Response(JSON.stringify({ socketio: 'https://trouter.example/', surl: 'https://s/', connectparams: {} }));
    }
    if (u.includes('socket.io/1/?')) return new Response('sid:60:60:websocket');
    return new Response('', { status: 202 });
  };
  const events = [];
  const client = new TrouterClient({ onEvent: (e) => events.push(e) });
  const done = client.connect({ skypeToken: 's', authToken: 'a', userMri: '8:orgid:me' });
  await new Promise((r) => setTimeout(r, 20));
  FakeWebSocket.last.receive('1::');
  await new Promise((r) => setTimeout(r, 20));

  const send = (id, content) => {
    const body = JSON.stringify({
      type: 'EventMessage',
      resourceType: 'NewMessage',
      resource: { messagetype: 'RichText/Html', content, id, to: '19:thread@thread.v2' },
    });
    FakeWebSocket.last.receive(`3:::${JSON.stringify({ id, url: 'https://x/messaging', body })}`);
  };
  send('1', liveHtml(FULL.replaceAll('&', '&amp;')));
  send('2', liveHtml(FULL, "'"));
  send(
    '3',
    `<blockquote itemtype="http://schema.skype.com/Reply"><a href="https://quoted.example.com/q">q</a></blockquote>${liveHtml(FULL)}`
  );

  assert.equal(events.length, 3);
  for (const e of events) assert.deepEqual(e.links, [FULL]);
  assert.ok(events[0].content.includes('…'), 'visible text stays truncated');

  client.reconnect('test');
  await done;
});

test('live event: only the full href is a candidate, the truncated display is not', () => {
  const rawHtml = liveHtml(FULL);
  const content = SHORT;
  assert.deepEqual(extractCandidateUrls(content, rawHtml, [FULL]), [FULL]);
  // The links field is optional: the anchor in the HTML is enough.
  assert.deepEqual(extractCandidateUrls(content, rawHtml), [FULL]);
});

test('history message: links as { url, text } replace the truncated visible text', () => {
  const links = [{ url: FULL, text: SHORT }];
  assert.deepEqual(extractCandidateUrls(SHORT, SHORT, links), [FULL]);
  assert.deepEqual(extractCandidateUrls(`Please look at ${SHORT} today`, '', links), [FULL]);
  // Three dots instead of the ellipsis character.
  const dots = [{ url: FULL, text: 'https://docs.example.com/guides/deployment/rollout-str...' }];
  assert.deepEqual(extractCandidateUrls(dots[0].text, '', dots), [FULL]);
});

test('truncated text without any href is never a candidate', () => {
  assert.deepEqual(extractCandidateUrls(SHORT), []);
  assert.deepEqual(extractCandidateUrls(`see ${SHORT}`, `<p>see ${SHORT}</p>`, []), []);
});

test('plain URLs next to a truncated link are kept, trailing punctuation is trimmed', () => {
  const text = `Compare ${SHORT} with https://plain.example.com/page.`;
  assert.deepEqual(extractCandidateUrls(text, liveHtml(FULL), [FULL]), [FULL, 'https://plain.example.com/page']);
});

test('quoted replies are excluded from candidates, hrefs and links', () => {
  const quoted =
    '<blockquote itemtype="http://schema.skype.com/Reply"><a href="https://quoted.example.com/q">https://quoted.example.com/…</a></blockquote>' +
    `<div itemtype="http://schema.skype.com/Reply"><a href='https://reply.example.com/r'>r</a></div>${liveHtml(FULL)}`;
  assert.deepEqual(extractCandidateUrls(SHORT, quoted, [FULL]), [FULL]);
  assert.deepEqual(collectMessageUrls({ rawHtml: quoted }), [FULL]);
  assert.deepEqual(collectMessageUrls({ rawHtml: quoted }, { includeQuotes: true }), [
    'https://quoted.example.com/q',
    'https://reply.example.com/r',
    FULL,
  ]);
});

test('isMessageOnlyUrl: a truncated display of the only link still counts as link-only', () => {
  // Live: anchor with truncated text (double quoted, single quoted, entities in the href).
  assert.equal(isMessageOnlyUrl(SHORT, liveHtml(FULL.replaceAll('&', '&amp;')), [FULL]), true);
  assert.equal(isMessageOnlyUrl(SHORT, liveHtml(FULL, "'"), [FULL]), true);
  assert.equal(isMessageOnlyUrl(SHORT, `<div>${liveHtml(FULL)}&nbsp;</div>`), true);
  // History: visible text only, link objects carry the full URL.
  assert.equal(isMessageOnlyUrl(SHORT, '', [{ url: FULL, text: SHORT }]), true);
  assert.equal(isMessageOnlyUrl(SHORT, SHORT, [{ url: FULL, text: SHORT }]), true);
});

test('isMessageOnlyUrl: words around a truncated link keep it from being link-only', () => {
  const links = [{ url: FULL, text: SHORT }];
  assert.equal(isMessageOnlyUrl(`Read more… ${SHORT}`, '', links), false);
  assert.equal(isMessageOnlyUrl(`${SHORT} thanks`, '', links), false);
  assert.equal(isMessageOnlyUrl(`PROJ-42 ${SHORT}`, `<p>PROJ-42 <a href="${FULL}">${SHORT}</a></p>`, [FULL]), false);
  // A quoted reply does not count as extra text.
  const withQuote = `<blockquote itemtype="http://schema.skype.com/Reply">earlier words</blockquote>${liveHtml(FULL)}`;
  assert.equal(isMessageOnlyUrl(SHORT, withQuote, [FULL]), true);
});

test('stripTruncatedUrlText removes only URL displays, not other words', () => {
  const links = [{ url: MR, text: MR_SHORT }];
  const out = stripTruncatedUrlText(`Read more… PROJ-123 is blocked by ${MR_SHORT} see https://plain.example.com/ok`, {
    links,
  });
  assert.ok(out.includes('Read more…'));
  assert.ok(out.includes('PROJ-123 is blocked by'));
  assert.ok(out.includes('https://plain.example.com/ok'));
  assert.ok(!out.includes('merge_requests/12'));
});

test('integration search text: full hrefs, no truncated display, non-URL context kept', () => {
  const content = `PROJ-123 needs ${MR_SHORT}`;
  const rawHtml = `<p>PROJ-123 needs <a href='${MR}'>${MR_SHORT}</a></p>`;
  for (const msg of [
    { content, rawHtml, links: [MR] }, // live
    { content, links: [{ url: MR, text: MR_SHORT }] }, // history
  ]) {
    const text = buildMessageSearchText(msg);
    assert.ok(text.includes('PROJ-123 needs'));
    assert.ok(text.includes(MR));
    assert.ok(!/merge_requests\/12(?!34)/.test(text), `phantom merge request in: ${text}`);
    assert.ok(!text.includes('<a'), 'raw HTML is not searched');
  }
});

test('integration search text excludes quoted replies unless a command asks for them', () => {
  const quotedMr = 'https://gitlab.example.com/group/project/-/merge_requests/7';
  const rawHtml = `<blockquote itemtype="http://schema.skype.com/Reply">see <a href="${quotedMr}">${quotedMr}</a></blockquote><p>/approve</p>`;
  const automatic = buildMessageSearchText({ content: '/approve', rawHtml, links: [] });
  assert.ok(!automatic.includes(quotedMr));
  const command = buildMessageSearchText({ content: '/approve', rawHtml, links: [] }, { includeQuotes: true });
  assert.ok(command.includes(quotedMr));
});

test('watcher: unrecognized-link detection and screenshot use the full href', async () => {
  const captured = [];
  const watcher = new MergeRequestWatcher({
    config: { conversations: [{ id: 'c1' }], gitlab: {} },
    gitlab: { findMrLinks: () => [], findJobLinks: () => [], findPipelineLinks: () => [] },
    jira: { findIssueLinks: () => [] },
    confluence: { findPageLinks: () => [] },
    opsgenie: { findAlertLinks: () => [] },
    screenshot: {
      isConfigured: () => true,
      capture: async (url) => {
        captured.push(url);
        return null;
      },
    },
  });
  watcher.setSelfMri('8:orgid:f94ccd0d-d140-4d1d-9fee-b00e642b9c11');

  assert.deepEqual(watcher.findUnrecognizedLinks(SHORT, liveHtml(FULL), [FULL]), [FULL]);
  assert.deepEqual(watcher.findUnrecognizedLinks(SHORT, '', [{ url: FULL, text: SHORT }]), [FULL]);

  await watcher.maybeAttachLinkThumbnail({
    conversationId: 'c1',
    messageId: '2001',
    from: 'Alice Example',
    fromMri: '8:orgid:f94ccd0d-d140-4d1d-9fee-b00e642b9c11',
    content: SHORT,
    rawHtml: liveHtml(FULL, "'"),
    links: [FULL],
  });
  assert.deepEqual(captured, [FULL]);
});
