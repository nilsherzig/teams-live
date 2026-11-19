// Single place that turns a Teams message into link candidates.
//
// Teams shows long URLs truncated ("https://host/a/b/very-lo…") while the anchor's
// href holds the full URL. A live event carries the raw HTML (`rawHtml`) and `links`
// as plain href strings; a history message carries `links` as `{ url, text }`
// objects and only the visible text. The visible text must never turn into a link
// candidate or into integration search text when it is such a truncated display:
// it would produce phantom matches (a merge request number cut in half, a
// non-existent page). The full hrefs are used instead. Quoted replies are excluded
// unless a caller opts in with `includeQuotes`.
//
// Nothing here fetches or expands a URL: it only reads out what the message says.

const BLOCKQUOTE_RE = /<blockquote[\s\S]*?<\/blockquote>/gi;
const REPLY_DIV_RE = /<div[^>]*itemtype="http:\/\/schema\.skype\.com\/Reply"[\s\S]*?<\/div>/gi;
const ANCHOR_TAG_RE = /<a\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi;
const ANCHOR_BLOCK_RE = /<a\b(?:"[^"]*"|'[^']*'|[^>"'])*>[\s\S]*?<\/a>/gi;
const HREF_ATTR_RE = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const URL_TOKEN_RE = /https?:\/\/[^\s"'<>`]+/gi;

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decodes the HTML entities that appear in Teams markup (named, decimal and hex). */
export function decodeHtmlEntities(value) {
  return String(value ?? '').replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec, hex, name) => {
    if (dec !== undefined || hex !== undefined) {
      const code = dec !== undefined ? Number(dec) : parseInt(hex, 16);
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Removes quoted replies (blockquotes and Skype reply wrappers) from HTML or text. */
export function stripQuotedHtml(html) {
  return String(html ?? '').replace(BLOCKQUOTE_RE, '').replace(REPLY_DIV_RE, '');
}

/** One `link` entry (live: href string, history: `{ url, text }`) as `{ url, text }`. */
export function normalizeLinks(links) {
  if (!Array.isArray(links)) return [];
  const out = [];
  for (const l of links) {
    const url = String(typeof l === 'string' ? l : (l?.url ?? '')).trim();
    if (!url) continue;
    out.push({ url, text: typeof l === 'string' ? '' : String(l?.text ?? '').trim() });
  }
  return out;
}

/** The anchors of an HTML fragment as `{ url, text }` (all quote styles, entities decoded). */
export function extractAnchors(html, { includeQuotes = false } = {}) {
  if (!html) return [];
  const source = includeQuotes ? String(html) : stripQuotedHtml(html);
  const anchors = [];
  for (const block of source.matchAll(ANCHOR_BLOCK_RE)) {
    const tag = block[0].match(ANCHOR_TAG_RE)?.[0] ?? '';
    const attr = tag.match(HREF_ATTR_RE);
    const href = decodeHtmlEntities(attr?.[1] ?? attr?.[2] ?? attr?.[3] ?? '').trim();
    if (!href) continue;
    const inner = block[0].slice(tag.length, -'</a>'.length).replace(/<[^>]+>/g, '');
    anchors.push({ url: href, text: decodeHtmlEntities(inner).trim() });
  }
  return anchors;
}

/** The href values of an HTML fragment (quoted replies excluded unless asked for). */
export function extractHrefs(html, options) {
  return extractAnchors(html, options).map((a) => a.url);
}

/** Every full URL a message states: anchor hrefs plus the `links` entries, in order, deduplicated. */
export function collectMessageUrls({ rawHtml = '', links = [] } = {}, options) {
  const urls = [...extractHrefs(rawHtml, options), ...normalizeLinks(links).map((l) => l.url)];
  return [...new Set(urls)];
}

function looksLikeUrlText(text) {
  // Words ("Read more…") are not displays of a URL and stay in the text.
  return /^https?:\/\//i.test(text) || /^[\w-]+(?:\.[\w-]+)+\/\S*(?:…|\.\.\.)/.test(text);
}

// Display texts (anchor text, `links[].text`) that are URL-like but not the href itself.
function displayTexts({ rawHtml, links }, options) {
  const texts = new Set();
  for (const a of [...extractAnchors(rawHtml, options), ...normalizeLinks(links)]) {
    if (a.text && a.text !== a.url && looksLikeUrlText(a.text)) texts.add(a.text);
  }
  // Longest first so a text that contains another one is removed whole.
  return [...texts].sort((a, b) => b.length - a.length);
}

// A token cut by Teams: a real ellipsis character is never part of a URL; three dots
// only count when the text before them is the start of a known, longer URL.
function isTruncatedToken(token, urls) {
  if (token.includes('…')) return true;
  const at = token.indexOf('...');
  if (at < 0) return false;
  const head = token.slice(0, at);
  return urls.some((u) => u.length > head.length && u.startsWith(head));
}

/**
 * Visible text without URL display texts that Teams truncated or replaced: the
 * display texts of anchors and `links` that differ from their href, and every URL
 * token cut with an ellipsis. Everything else is kept (Jira keys, prose, plain URLs).
 */
export function stripTruncatedUrlText(text, { rawHtml = '', links = [] } = {}, options) {
  let out = String(text ?? '');
  if (!out) return out;
  for (const display of displayTexts({ rawHtml, links }, options)) {
    out = out.split(display).join(' ');
  }
  const urls = collectMessageUrls({ rawHtml, links }, options);
  return out.replace(URL_TOKEN_RE, (token) => (isTruncatedToken(token, urls) ? ' ' : token));
}

/** The visible text of an HTML fragment (tags dropped, entities decoded). */
export function visibleTextFromHtml(html, { includeQuotes = false } = {}) {
  const source = includeQuotes ? String(html ?? '') : stripQuotedHtml(html);
  return decodeHtmlEntities(
    source
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  ).trim();
}

/**
 * The text integrations (GitLab, Jira, Confluence, OpsGenie, ...) search for links:
 * the visible message text without truncated URL displays, followed by the full
 * hrefs. The raw HTML is not searched itself, only read for hrefs, so the truncated
 * anchor text cannot match next to the proper URL. With `includeQuotes` the quoted
 * reply counts too (commands that act on the message they reply to).
 */
export function buildMessageSearchText({ content = '', rawHtml = '', links = [] } = {}, { includeQuotes = false } = {}) {
  const options = { includeQuotes };
  const parts = [content];
  // The raw HTML supplies visible text only where the content does not (no content, or
  // the quoted reply the stripped content leaves out).
  if (rawHtml && (includeQuotes || !content)) parts.push(visibleTextFromHtml(rawHtml, options));
  const visible = parts
    .filter(Boolean)
    .map((p) => stripTruncatedUrlText(p, { rawHtml, links }, options))
    .join('\n');
  return [visible, ...collectMessageUrls({ rawHtml, links }, options)].filter(Boolean).join(' ').trim();
}

/**
 * URL candidates of a message before any policy filtering: full hrefs first, then
 * plain-text URLs that are not truncated displays. `text` is the visible text.
 */
export function collectCandidateUrlStrings(text, rawHtml = '', links = []) {
  const urls = collectMessageUrls({ rawHtml, links });
  const found = new Set(urls);
  const visible = stripTruncatedUrlText(stripQuotedHtml(text), { rawHtml, links });
  for (const match of visible.matchAll(URL_TOKEN_RE)) {
    let token = match[0];
    if (isTruncatedToken(token, urls)) continue;
    token = token.replace(/[.,!?:;)]+$/, '');
    if (token) found.add(token);
  }
  return [...found];
}

function normalizeUrl(value) {
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

/**
 * Whether the message consists of nothing but `targetUrl`: its anchor (with whatever
 * display text, truncated or not), the URL as plain text, or a truncated display of
 * it, plus markup, entities and whitespace.
 */
export function isOnlyUrlMessage(targetUrl, { text = '', rawHtml = '', links = [] } = {}) {
  const target = normalizeUrl(targetUrl);
  if (!target) return false;

  let rest = stripQuotedHtml(rawHtml || text);
  rest = rest.replace(ANCHOR_BLOCK_RE, (block) => {
    const tag = block.match(ANCHOR_TAG_RE)?.[0] ?? '';
    const attr = tag.match(HREF_ATTR_RE);
    const href = decodeHtmlEntities(attr?.[1] ?? attr?.[2] ?? attr?.[3] ?? '').trim();
    return normalizeUrl(href) === target ? ' ' : block;
  });

  const known = normalizeLinks(links);
  for (const l of known) {
    if (l.text && normalizeUrl(l.url) === target) rest = rest.split(l.text).join(' ');
  }

  const urls = collectMessageUrls({ rawHtml, links });
  rest = decodeHtmlEntities(rest.replace(/<[^>]+>/g, ' ')).replace(URL_TOKEN_RE, (token) => {
    if (isTruncatedToken(token, urls)) return ' ';
    return normalizeUrl(token.replace(/[.,!?:;)]+$/, '')) === target ? ' ' : token;
  });

  return rest.replace(/&[a-z0-9#]+;/gi, ' ').trim().length === 0;
}

/**
 * Deep link to one Teams message (opens it in Teams). Without a conversation or message id there
 * is nothing to link to and the result is ''.
 */
export function teamsMessageLink(conversationId, messageId) {
  const conversation = String(conversationId ?? '').trim();
  const message = String(messageId ?? '').trim();
  if (!conversation || !message) return '';
  return `https://teams.microsoft.com/l/message/${encodeURIComponent(conversation)}/${encodeURIComponent(message)}`;
}
