import { randomUUID } from 'node:crypto';
import { isTestRun, refuseLiveWriteInTests } from './test-guard.mjs';
import {
  sendMessage,
  getThreadMessages,
  getMessage as mcpGetMessage,
  editMessage,
  parseContentWithMentionsAndLinks,
} from 'msteams-mcp/dist/api/chatsvc-messaging.js';
import { addReaction as mcpAddReaction, removeReaction as mcpRemoveReaction } from 'msteams-mcp/dist/api/chatsvc-reactions.js';
import { getCalendarView as mcpGetCalendarView } from 'msteams-mcp/dist/api/calendar-api.js';
import { requireSkypeSpacesAuth, requireMessageAuthWithConfig } from 'msteams-mcp/dist/utils/auth-guards.js';
import { httpRequest } from 'msteams-mcp/dist/utils/http.js';
import { markdownToTeamsHtml } from 'msteams-mcp/dist/utils/parsers-markdown.js';
import { buildReplyCard, splitMarkdownForCards, stripMentionMarkup, MAX_CARD_BYTES } from './cards.mjs';
import { refreshTokensViaHttp } from 'msteams-mcp/dist/auth/token-refresh-http.js';
import { searchPeople as mcpSearchPeople } from 'msteams-mcp/dist/api/substrate-api.js';
import { resolveProfiles as mcpResolveProfiles } from 'msteams-mcp/dist/api/profile-api.js';

export {
  getThreadMessages,
  markdownToTeamsHtml,
  parseContentWithMentionsAndLinks,
};

export async function getMessage(conversationId, messageId) {
  let res = await mcpGetMessage(conversationId, messageId);
  if (!res.ok && (await attemptTokenRefreshOnAuthError(res))) {
    res = await mcpGetMessage(conversationId, messageId);
  }
  return res;
}

async function attemptTokenRefreshOnAuthError(res) {
  if (!res || res.ok) return false;
  const errText = (res.error?.message || '').toLowerCase();
  const isAuth =
    errText.includes('auth') ||
    errText.includes('unauthorized') ||
    errText.includes('401') ||
    res.error?.code === 'AUTH_EXPIRED' ||
    res.error?.code === 'AUTH_REQUIRED';
  if (!isAuth) return false;

  console.warn(new Date().toISOString(), `[teams] Auth error detected (${res.error?.message}), attempting token refresh...`);
  try {
    const refreshed = await refreshTokensViaHttp();
    if (refreshed.ok) {
      console.log(new Date().toISOString(), '[teams] Token refresh succeeded, retrying operation...');
      return true;
    }
  } catch (err) {
    console.error(new Date().toISOString(), '[teams] Token refresh threw:', err.message);
  }
  return false;
}

export { isTestRun };

async function liveAddReaction(conversationId, messageId, emojiKey) {
  const refused = refuseLiveWriteInTests('addReaction');
  if (refused) return refused;
  let res = await mcpAddReaction(conversationId, messageId, emojiKey);
  if (!res.ok && (await attemptTokenRefreshOnAuthError(res))) {
    res = await mcpAddReaction(conversationId, messageId, emojiKey);
  }
  return res;
}

async function liveRemoveReaction(conversationId, messageId, emojiKey) {
  const refused = refuseLiveWriteInTests('removeReaction');
  if (refused) return refused;
  let res = await mcpRemoveReaction(conversationId, messageId, emojiKey);
  if (!res.ok && (await attemptTokenRefreshOnAuthError(res))) {
    res = await mcpRemoveReaction(conversationId, messageId, emojiKey);
  }
  return res;
}

export const addReaction = (...args) => transport.addReaction(...args);
export const removeReaction = (...args) => transport.removeReaction(...args);

function isRetryableNetworkError(res) {
  if (!res || res.ok) return false;
  const msg = (res.error?.message || String(res.error || '')).toLowerCase();
  return (
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('eai_again') ||
    msg.includes('enotfound') ||
    msg.includes('timeout') ||
    msg.includes('socket hang up')
  );
}

async function retrySendWithRecovery(sendFn) {
  let result = await sendFn();
  if (result.ok) return result;

  // 1. If auth error, refresh tokens and retry
  if (await attemptTokenRefreshOnAuthError(result)) {
    result = await sendFn();
    if (result.ok) return result;
  }

  // 2. If transient network error / fetch failed, retry with backoff
  const maxRetries = 3;
  let attempt = 0;
  while (!result.ok && isRetryableNetworkError(result) && attempt < maxRetries) {
    attempt++;
    const delayMs = attempt * 1500;
    console.warn(
      new Date().toISOString(),
      `[teams] Transient network error (${result.error?.message || result.error}), retry ${attempt}/${maxRetries} in ${delayMs / 1000}s...`
    );
    await new Promise((r) => setTimeout(r, delayMs));
    result = await sendFn();
  }

  return result;
}

export async function searchPeople(query, limit = 10) {
  let res = await mcpSearchPeople(query, limit);
  if (!res.ok && (await attemptTokenRefreshOnAuthError(res))) {
    res = await mcpSearchPeople(query, limit);
  }
  return res;
}

export async function resolveProfiles(mris) {
  let res = await mcpResolveProfiles(mris);
  if (!res.ok && (await attemptTokenRefreshOnAuthError(res))) {
    res = await mcpResolveProfiles(mris);
  }
  return res;
}

export async function getCalendarView(options = {}) {
  const mcpRes = await mcpGetCalendarView(options);
  if (mcpRes.ok) return mcpRes;

  // Fallback: direct MiddleTier call for EMEA
  const authRes = requireSkypeSpacesAuth();
  if (!authRes.ok) return mcpRes;

  const { skypeToken, spacesToken } = authRes.value;
  const now = new Date();
  const defaultEnd = new Date(now);
  defaultEnd.setDate(defaultEnd.getDate() + 7);
  const startDate = options.startDate || now.toISOString();
  const endDate = options.endDate || defaultEnd.toISOString();
  const limit = options.limit ?? 50;

  const params = new URLSearchParams({
    startDate,
    endDate,
    $top: limit.toString(),
    $count: 'true',
    $skip: '0',
    $orderby: 'startTime asc',
    $filter: 'isAppointment eq false and isAllDayEvent eq false and isCancelled eq false',
  });

  const url = `https://teams.microsoft.com/api/mt/emea/v2.1/me/calendars/calendarView?${params.toString()}`;
  const response = await httpRequest(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authentication: `skypetoken=${skypeToken}`,
      Authorization: `Bearer ${spacesToken}`,
      'x-ms-client-version': '49/25113001312',
    },
  });

  if (!response.ok) return mcpRes;

  const rawMeetings = response.value?.data?.value || [];
  const meetings = rawMeetings.map((raw) => {
    const rawResponse = raw.myResponseType;
    let myResponse = 'None';
    if (rawResponse === 'Accepted' || rawResponse === 'Organizer') myResponse = 'Accepted';
    else if (rawResponse === 'Tentative' || rawResponse === 'TentativelyAccepted') myResponse = 'Tentative';
    else if (rawResponse === 'Declined') myResponse = 'Declined';

    return {
      id: raw.objectId,
      subject: raw.subject || '(No subject)',
      startTime: raw.startTime,
      endTime: raw.endTime,
      organizer: {
        name: raw.organizerName || 'Unknown',
        email: raw.organizerAddress || '',
      },
      location: raw.location,
      isOnlineMeeting: raw.isOnlineMeeting === true,
      joinUrl: raw.skypeTeamsMeetingUrl,
      myResponse,
    };
  });

  return { ok: true, value: { count: meetings.length, meetings } };
}

export async function getUserPresence(mris) {
  const authRes = requireSkypeSpacesAuth();
  if (!authRes.ok) {
    if (await attemptTokenRefreshOnAuthError(authRes)) {
      return getUserPresence(mris);
    }
    return authRes;
  }

  const { skypeToken, spacesToken } = authRes.value;
  const mriList = Array.isArray(mris) ? mris : [mris];
  const payload = mriList.map((m) => (typeof m === 'string' ? { mri: m } : m));

  const url = 'https://presence.teams.microsoft.com/v1/presence/getpresence/';
  const response = await httpRequest(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${spacesToken}`,
      Authentication: `skypetoken=${skypeToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-ms-client-version': '1415/26101515217',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok && (await attemptTokenRefreshOnAuthError(response))) {
    return getUserPresence(mris);
  }

  return response;
}

// Send/edit entry points of the Teams chat service. Indirection so tests can
// observe the exact payloads without a Teams session.
export const transport = {
  sendMessage: async (...args) => refuseLiveWriteInTests('sendMessage') || sendMessage(...args),
  editMessage: async (...args) => refuseLiveWriteInTests('editMessage') || editMessage(...args),
  addReaction: liveAddReaction,
  removeReaction: liveRemoveReaction,
};

export const botSentMessageIds = new Set();
export const BOT_WATERMARK = '\u200B\u200C\u200B';

export function recordBotMessageId(id) {
  if (id) {
    const s = String(id);
    botSentMessageIds.add(s);
    if (/^\d{12,14}$/.test(s)) {
      const num = Number(s);
      try {
        botSentMessageIds.add(new Date(num).toISOString());
      } catch {}
    } else {
      const parsed = Date.parse(s);
      if (!isNaN(parsed)) {
        botSentMessageIds.add(String(parsed));
      }
    }
    if (botSentMessageIds.size > 2000) {
      const iter = botSentMessageIds.values();
      botSentMessageIds.delete(iter.next().value);
    }
  }
}

export const STATUS_REACTIONS = {
  pending: '1f440_eyes', // 👀 needs approval
  approved: 'like', // 👍 approved, not merged
  merged: '2705_whiteheavycheckmark', // ✅
  failed: '274c_crossmark', // ❌ CI failed
  closed: '274c_crossmark', // ❌ closed unmerged
};

export const COMMAND_REACTIONS = {
  pending: '1f440_eyes', // 👀
  success: '2705_whiteheavycheckmark', // ✅
  failure: '274c_crossmark', // ❌
  warning: '26a0_warning', // ⚠️
  running: '23f3_hourglass', // ⏳
  ban: '26d4_noentry', // ⛔
};

export const BAN_REACTION = '26d4_noentry'; // ⛔

export const STATUS_BY_REACTION = new Map(
  Object.entries(STATUS_REACTIONS).map(([status, key]) => [key, status])
);

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildMentionsProperty(mentions) {
  const mentionObjects = mentions.map((mention, index) => ({
    '@type': 'http://schema.skype.com/Mention',
    'itemid': mention.itemid !== undefined ? mention.itemid : index,
    'mri': String(mention.mri).split('/contacts/').pop(),
    'mentionType': mention.mentionType || (String(mention.mri).includes('tag:') ? 'tag' : 'person'),
    'displayName': mention.displayName,
  }));
  return JSON.stringify(mentionObjects);
}

export const ADAPTIVE_CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';

const RICH_MESSAGE = Symbol.for('teams-live.richMessage');

/**
 * A message that can be shown as an Adaptive Card (`teams.rich_messages`) and
 * always carries its regular markdown text as the fallback.
 * Without a card this returns the plain markdown string, so callers can pass
 * the result to the send/update/edit functions either way.
 */
export function makeRichMessage(markdown, card) {
  const text = String(markdown ?? '').trim();
  if (!card || typeof card !== 'object') return text;
  return { [RICH_MESSAGE]: true, markdown: text, card };
}

export function isRichMessage(message) {
  return Boolean(message && typeof message === 'object' && message[RICH_MESSAGE] === true && message.card);
}

/** The regular markdown text of a plain or rich message. */
export function messageMarkdown(message) {
  return isRichMessage(message) ? message.markdown : String(message ?? '');
}

/**
 * Transport for an Adaptive Card in the Teams chat service (the wire format of
 * the Teams client): the HTML body references the card with an `InputExtension`
 * span carrying a `cardClientId`, and the card itself goes into the `cards`
 * message property as a JSON string of `{cardClientId, content, contentType}`.
 * The `cardClientId` is a UUID without hyphens, like the ones Teams generates.
 * Best effort: callers fall back to the plain markdown when the send fails.
 */
export function buildCardAttachment(message) {
  const id = randomUUID().replaceAll('-', '');
  const content = { ...message.card };
  if (!content.fallbackText && message.markdown) {
    // Notification and preview text: names, not the raw mention markup.
    content.fallbackText = stripMentionMarkup(message.markdown);
  }
  return {
    id,
    tag:
      `<span itemid="${id}" itemscope="" itemtype="http://schema.skype.com/InputExtension">` +
      '<span itemprop="cardId"></span></span>',
    cards: JSON.stringify([{ cardClientId: id, content, contentType: ADAPTIVE_CARD_CONTENT_TYPE }]),
  };
}

/**
 * Size in bytes of what a rich message puts on the wire as a card: the card
 * with its fallback text (see buildCardAttachment), JSON-escaped once more as
 * the `cards` string property, plus the HTML body. The size limit applies to
 * this number, not to the bare card.
 */
export function richMessageWireBytes(message) {
  const attachment = buildCardAttachment(message);
  const html = `${attachment.tag}<span style="display:none">${BOT_WATERMARK}</span>`;
  return Buffer.byteLength(JSON.stringify({ content: html, properties: { cards: attachment.cards } }));
}

/**
 * Rich mode (`teams.rich_messages`) switch for the whole transport: when on,
 * every outward message (see prepareRichMessages) is an Adaptive Card. Set once
 * at startup by the watcher; off by default, which leaves every message the
 * regular markdown it always was.
 */
let richMessagesEnabled = false;

export function setRichMessages(enabled) {
  richMessagesEnabled = enabled === true;
}

export function isRichMessagesEnabled() {
  return richMessagesEnabled;
}

/**
 * The messages to send for one outward message. Regular mode: the message
 * itself. Rich mode: a card for every message, whatever it is, so nothing
 * leaves the bot as plain text:
 * - a rich message (entity card) that fits is passed through unchanged (never
 *   wrapped twice);
 * - plain text, and a card that is too large, become generic reply cards built
 *   from the markdown (buildReplyCard);
 * - text too large for one card is split into several cards, in order, each
 *   within MAX_CARD_BYTES on the wire (at most 10 cards, see
 *   splitMarkdownForCards).
 * Mentions are rendered as names in the card; nobody is notified.
 */
export function prepareRichMessages(message) {
  if (!richMessagesEnabled) return [message];
  const markdown = messageMarkdown(message).trim();
  if (!markdown) return [message];
  if (isRichMessage(message) && richMessageWireBytes(message) <= MAX_CARD_BYTES) return [message];

  const asMessage = (text, part) => {
    try {
      return makeRichMessage(text, buildReplyCard(text, { part }));
    } catch (err) {
      console.warn(new Date().toISOString(), '[teams] Could not build a card, sending regular message:', err?.message || err);
      return text;
    }
  };
  // The fallback text alone is in the message: a markdown over the budget never fits one card, so
  // do not build (a slow, pointless) card of it.
  if (Buffer.byteLength(markdown) <= MAX_CARD_BYTES) {
    const single = asMessage(markdown, null);
    if (isRichMessage(single) && richMessageWireBytes(single) <= MAX_CARD_BYTES) return [single];
  }

  const texts = splitMarkdownForCards(markdown, (text) => {
    const candidate = asMessage(text, [2, 2]);
    return isRichMessage(candidate) && richMessageWireBytes(candidate) <= MAX_CARD_BYTES;
  });
  return texts.map((text, i) => asMessage(text, [i + 1, texts.length]));
}

/**
 * Renders a message to Teams HTML plus its mention and card properties.
 *
 * A rich message is always an Adaptive Card. A card cannot carry the mention
 * metadata, so mentions in it are shown as plain names and notify nobody (the
 * regular message of the explicit card-failure fallback keeps them).
 */
export function renderReplyContent(replyMarkdown) {
  if (isRichMessage(replyMarkdown)) {
    const attachment = buildCardAttachment(replyMarkdown);
    return {
      html: `${attachment.tag}<span style="display:none">${BOT_WATERMARK}</span>`,
      mentions: [],
      cards: attachment.cards,
    };
  }
  return renderPlainContent(replyMarkdown);
}

function renderPlainContent(replyMarkdown) {
  const cleanMarkdown = String(replyMarkdown || '').trim();
  const parsed = parseContentWithMentionsAndLinks(cleanMarkdown);
  const mentions = parsed.mentions || [];
  let html = (parsed.html || '').trim();

  for (let i = 0; i < mentions.length; i++) {
    const mention = mentions[i];
    if (typeof mention.mri === 'string' && mention.mri.endsWith('#contact')) {
      mention.mri = mention.mri.replace(/#contact$/, '');
      mention.mentionType = 'share-contact';
      html = html.replace(
        new RegExp(`<span itemtype="http://schema\\.skype\\.com/Mention" itemscope itemid="${i}">`),
        `<span itemtype="http://schema.skype.com/Mention" itemscope="Share_Contact_Card" itemid="${i}">`
      );
    }
  }

  // Remove trailing paragraph margin to avoid extra blank space in cards
  html = html.replace(/(<p)(?![\s\S]*<p)([^>]*>[\s\S]*?<\/p>)$/i, (_m, open, rest) => {
    if (open.includes('style="')) {
      return open.replace(/style="([^"]*)"/, 'style="$1;margin-bottom:0;"') + rest;
    }
    return `${open} style="margin-bottom:0;"${rest}`;
  });

  return {
    html: `${html}<span style="display:none">${BOT_WATERMARK}</span>`,
    mentions,
  };
}

export function cleanPreviewText(text) {
  if (!text) return '';
  return String(text)
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
    .replace(/<div[^>]*itemtype="http:\/\/schema\.skype\.com\/Reply"[\s\S]*?<\/div>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<\/li>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
}

/**
 * Builds a Teams blockquote quoting an existing message.
 * This is how Teams client renders threaded replies in chats and meetings.
 */
export function buildQuotedReplyHtml({ messageId, from, fromMri, previewText, replyMarkdown }) {
  const cleanPreview = cleanPreviewText(previewText);
  const cleanMri = fromMri ? String(fromMri).split('/contacts/').pop() : '';
  const quote =
    `<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="${escapeHtml(messageId)}">` +
    `<strong itemprop="mri" itemid="${escapeHtml(cleanMri)}">${escapeHtml(from || '')}</strong>` +
    `<span itemprop="time" itemid="${escapeHtml(messageId)}"></span>` +
    `<p itemprop="preview">${escapeHtml(cleanPreview)}</p>` +
    '</blockquote>';

  const { html, mentions, cards } = renderReplyContent(replyMarkdown);
  return {
    html: quote + html,
    mentions,
    cards,
  };
}

/**
 * Runs a send/update/edit for a message. A rich message that fails to go out
 * as an Adaptive Card is retried once as its regular markdown text, so a
 * transport problem with cards never costs the notification.
 */
async function withCardFallback(message, run) {
  const result = await run(message);
  // Network and auth failures were already retried; a plain message would not fare better.
  if (result.ok || !isRichMessage(message) || isRetryableNetworkError(result)) return result;
  console.warn(
    new Date().toISOString(),
    '[teams] Adaptive Card message failed, retrying as regular message:',
    result.error?.message || result.error
  );
  return run(message.markdown);
}

/**
 * Sends a direct (non-reply) message to a conversation.
 */
export async function sendDirectMessage(conversationId, markdown) {
  let first = null;
  for (const part of prepareRichMessages(markdown)) {
    const result = await withCardFallback(part, (message) => sendDirectMessageOnce(conversationId, message));
    if (!first) first = result;
    if (!result.ok) return result;
  }
  return first;
}

async function sendDirectMessageOnce(conversationId, markdown) {
  const { html, mentions, cards } = renderReplyContent(markdown);
  const options = {
    contentType: 'html',
    properties: {
      formatVariant: 'TEAMS',
      mentions: mentions.length > 0 ? buildMentionsProperty(mentions) : '[]',
      cards: cards || '[]',
      links: '[]',
      files: '[]',
    },
  };
  const result = await retrySendWithRecovery(() => transport.sendMessage(conversationId, html, options));
  if (!result.ok) {
    console.error(new Date().toISOString(), `[teams] sendDirectMessage failed in ${conversationId}:`, result.error?.message || result.error);
  } else if (result.value) {
    recordBotMessageId(result.value.timestamp);
    recordBotMessageId(result.value.messageId);
  }
  return result;
}

/**
 * Sends a reply to a message in a conversation.
 * Handles both channel threads (@thread.tacv2) and chat/meeting quote-replies.
 */
export async function sendReply(conversationId, originalMessage, replyMarkdown, opts = {}) {
  const pendingUpdateId = originalMessage?.replyMessageIdToUpdate;
  let first = null;
  // A text too large for one card goes out as several cards in the same thread/quote, in order.
  // Only the first one may take over a pending in-place update; the result of the first is returned
  // (its message id is what callers update later), unless a part fails.
  for (const [index, part] of prepareRichMessages(replyMarkdown).entries()) {
    const result = await withCardFallback(part, (message) => {
      // sendReplyOnce consumes the pending update id; restore it for the plain retry
      if (index === 0 && originalMessage && pendingUpdateId && !originalMessage.replyMessageIdToUpdate) {
        originalMessage.replyMessageIdToUpdate = pendingUpdateId;
      }
      return sendReplyOnce(conversationId, originalMessage, message, index === 0 ? opts : { ...opts, updateMessageId: null, noUpdate: true });
    });
    if (!first) first = result;
    if (!result.ok) return result;
  }
  return first;
}

async function sendReplyOnce(conversationId, originalMessage, replyMarkdown, opts = {}) {
  const updateId = opts.noUpdate ? null : opts.updateMessageId || originalMessage?.replyMessageIdToUpdate;
  if (updateId) {
    if (originalMessage) originalMessage.replyMessageIdToUpdate = null;
    const updateResult = await updateReplyOnce(conversationId, updateId, originalMessage, replyMarkdown);
    if (updateResult.ok) {
      return updateResult;
    }
    console.warn(new Date().toISOString(), `[teams] updateReply failed for ${updateId}, falling back to sendMessage:`, updateResult.error?.message || updateResult.error);
  }

  const isChannel = conversationId.endsWith('@thread.tacv2');
  const messageId = originalMessage.messageId || originalMessage.id;
  const from = originalMessage.from || originalMessage.sender?.displayName || '';
  const fromMri = originalMessage.fromMri || originalMessage.sender?.mri || '';
  const previewText = originalMessage.previewText || originalMessage.content || originalMessage.text || '';

  const { html, mentions, cards } = buildQuotedReplyHtml({
    messageId,
    from,
    fromMri,
    previewText,
    replyMarkdown,
  });

  const cleanMri = fromMri ? String(fromMri).split('/contacts/').pop() : '';

  const properties = {
    formatVariant: 'TEAMS',
    mentions: mentions.length > 0 ? buildMentionsProperty(mentions) : '[]',
    cards: cards || '[]',
    links: '[]',
    files: '[]',
  };

  if (messageId) {
    properties.hasValidMsgReferences = true;
    properties.qtdMsgs = JSON.stringify([
      {
        messageId: Number(messageId) || messageId,
        sender: cleanMri,
        time: Number(messageId) || Date.now(),
        message: null,
        validationResult: 'Valid',
        sharedRefId: null,
        replyChainId: null,
      },
    ]);
  }

  const options = {
    contentType: 'html',
    properties,
  };

  if (isChannel && messageId) {
    options.replyToMessageId = messageId;
  }

  const result = await retrySendWithRecovery(() => transport.sendMessage(conversationId, html, options));
  if (!result.ok) {
    console.error(new Date().toISOString(), `[teams] sendReply failed in ${conversationId}:`, result.error?.message || result.error);
  } else if (result.value) {
    recordBotMessageId(result.value.timestamp);
    recordBotMessageId(result.value.messageId);
  }
  return result;
}

// Overflow cards posted for an edited reply, by conversation and message id: later edits update
// them in place instead of posting them again. Bounded: the oldest entries are forgotten first
// (an edit of a forgotten message then reposts its overflow, as before).
const OVERFLOW_TRACKED_MAX = 200;
const overflowCards = new Map();

const messageSignature = (message) => (typeof message === 'string' ? message : JSON.stringify(message));

function trackOverflow(key) {
  let entries = overflowCards.get(key);
  if (entries) {
    overflowCards.delete(key); // re-insert: most recently used last
  } else {
    entries = [];
  }
  overflowCards.set(key, entries);
  while (overflowCards.size > OVERFLOW_TRACKED_MAX) overflowCards.delete(overflowCards.keys().next().value);
  return entries;
}

/**
 * Updates an existing reply message in-place.
 *
 * A text that no longer fits one card keeps the first card in the message; the rest is posted as
 * further replies once, and later edits update those in place (and skip the unchanged ones).
 */
export async function updateReply(conversationId, serverMessageId, originalMessage, replyMarkdown) {
  const [head, ...rest] = prepareRichMessages(replyMarkdown);
  const result = await withCardFallback(head, (message) =>
    updateReplyOnce(conversationId, serverMessageId, originalMessage, message)
  );
  if (!result.ok || rest.length === 0) return result;

  const entries = trackOverflow(`${conversationId}\n${serverMessageId}`);
  for (const [index, part] of rest.entries()) {
    const signature = messageSignature(part);
    const known = entries[index];
    if (known?.signature === signature) continue;
    if (known) {
      const edited = await withCardFallback(part, (message) =>
        updateReplyOnce(conversationId, known.id, originalMessage, message)
      );
      if (edited.ok) {
        known.signature = signature;
        continue;
      }
    }
    const sent = await withCardFallback(part, (message) =>
      sendReplyOnce(conversationId, originalMessage, message, { noUpdate: true })
    );
    if (!sent.ok) return sent;
    // Edits address a message by its server id (the timestamp); the client message id is only a fallback.
    const id = sent.value?.timestamp ?? sent.value?.messageId;
    if (id) entries[index] = { id: String(id), signature };
    else entries.length = Math.min(entries.length, index);
  }
  return result;
}

async function updateReplyOnce(conversationId, serverMessageId, originalMessage, replyMarkdown) {
  recordBotMessageId(serverMessageId);
  const messageId = originalMessage.messageId || originalMessage.id;
  const from = originalMessage.from || originalMessage.sender?.displayName || '';
  const fromMri = originalMessage.fromMri || originalMessage.sender?.mri || '';
  const previewText = originalMessage.previewText || originalMessage.content || originalMessage.text || '';

  const { html, mentions, cards } = buildQuotedReplyHtml({
    messageId,
    from,
    fromMri,
    previewText,
    replyMarkdown,
  });

  const cleanMri = fromMri ? String(fromMri).split('/contacts/').pop() : '';

  const properties = {
    mentions: mentions.length > 0 ? buildMentionsProperty(mentions) : '[]',
    cards: cards || '[]',
  };

  if (messageId) {
    properties.hasValidMsgReferences = true;
    properties.qtdMsgs = JSON.stringify([
      {
        messageId: Number(messageId) || messageId,
        sender: cleanMri,
        time: Number(messageId) || Date.now(),
        message: null,
        validationResult: 'Valid',
        sharedRefId: null,
        replyChainId: null,
      },
    ]);
  }

  const options = {
    properties,
  };

  const result = await retrySendWithRecovery(() => transport.editMessage(conversationId, String(serverMessageId), html, 'html', options));
  if (!result.ok) {
    console.error(new Date().toISOString(), `[teams] updateReply failed for ${serverMessageId} in ${conversationId}:`, result.error?.message || result.error);
  }
  return result;
}

/**
 * Uploads an image Buffer or Base64 string to Skype/Teams AMS (Attachment Management Service).
 * Returns { ok: true, objectId, url } or { ok: false, error }
 */
export async function uploadImageToAms(imageBufferOrB64, conversationId) {
  try {
    const authRes = requireMessageAuthWithConfig();
    if (!authRes.ok) {
      return { ok: false, error: authRes.error || new Error('No messaging auth available') };
    }
    const { auth } = authRes.value;
    const { skypeToken, userMri } = auth;
    if (!skypeToken) {
      return { ok: false, error: new Error('No skypeToken available for AMS upload') };
    }

    const imgBuf = Buffer.isBuffer(imageBufferOrB64)
      ? imageBufferOrB64
      : Buffer.from(imageBufferOrB64, 'base64');

    const permissions = {};
    if (conversationId) permissions[conversationId] = ['read'];
    if (userMri) permissions[userMri] = ['read'];

    const createRes = await fetch('https://api.asm.skype.com/v1/objects', {
      method: 'POST',
      headers: {
        Authorization: `skype_token ${skypeToken}`,
        'User-Agent': '1415/1.0.0.2025010401',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'pish/image',
        permissions,
        filename: 'preview.jpg',
      }),
    });

    if (!createRes.ok) {
      const errBody = await createRes.text().catch(() => '');
      return {
        ok: false,
        error: new Error(`AMS object creation failed (${createRes.status}): ${errBody.slice(0, 200)}`),
      };
    }

    const { id: objectId } = await createRes.json();
    if (!objectId) {
      return { ok: false, error: new Error('AMS returned no object ID') };
    }

    const uploadRes = await fetch(`https://api.asm.skype.com/v1/objects/${objectId}/content/imgpsh`, {
      method: 'PUT',
      headers: {
        Authorization: `skype_token ${skypeToken}`,
        'User-Agent': '1415/1.0.0.2025010401',
        'Content-Type': 'image/jpeg',
      },
      body: imgBuf,
    });

    if (!uploadRes.ok) {
      const errBody = await uploadRes.text().catch(() => '');
      return {
        ok: false,
        error: new Error(`AMS content upload failed (${uploadRes.status}): ${errBody.slice(0, 200)}`),
      };
    }

    const url = `https://eu-api.asm.skype.com/v1/objects/${objectId}/views/imgo`;
    return { ok: true, objectId, url };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/**
 * Appends a thumbnail screenshot to a user message by editing it.
 * Keeps original content and adds the thumbnail image link.
 */
export async function appendThumbnailToMessage(
  conversationId,
  serverMessageId,
  originalContent,
  originalRawHtml,
  url,
  thumbnailData
) {
  recordBotMessageId(serverMessageId);

  let baseHtml = (originalRawHtml || '').trim();
  if (!baseHtml) {
    baseHtml = `<p>${escapeHtml((originalContent || '').trim())}</p>`;
  }

  const b64 = typeof thumbnailData === 'string' ? thumbnailData : thumbnailData?.b64;
  if (!b64) {
    return { ok: false, error: new Error('No base64 thumbnail provided') };
  }

  const cleanUrl = escapeHtml((url || '').trim());

  let thumbnailBlock;
  const amsRes = await retrySendWithRecovery(() => uploadImageToAms(b64, conversationId));
  if (amsRes.ok && amsRes.objectId && amsRes.url) {
    thumbnailBlock = `<p style="margin-top:6px;margin-bottom:0;"><a href="${cleanUrl}"><img src="${amsRes.url}" itemscope="" itemtype="http://schema.skype.com/AMSImage" itemid="${amsRes.objectId}" alt="Preview" style="display:block;border-radius:6px;border:1px solid #d1d1d1;max-width:320px;" /></a></p><span style="display:none">${BOT_WATERMARK}</span>`;
  } else {
    console.warn(
      new Date().toISOString(),
      `[teams] AMS upload failed (${amsRes.error?.message || amsRes.error}), falling back to data URI:`,
      amsRes.error
    );
    thumbnailBlock = `<p style="margin-top:6px;margin-bottom:0;"><a href="${cleanUrl}"><img src="data:image/jpeg;base64,${b64}" width="280" alt="Preview" style="display:block;border-radius:6px;border:1px solid #d1d1d1;max-width:320px;" /></a></p><span style="display:none">${BOT_WATERMARK}</span>`;
  }

  const newHtml = `${baseHtml}${thumbnailBlock}`;

  const options = {
    properties: {
      cards: '[]',
      links: '[]',
      files: '[]',
    },
  };

  const result = await retrySendWithRecovery(() =>
    transport.editMessage(conversationId, String(serverMessageId), newHtml, 'html', options)
  );
  if (!result.ok) {
    console.error(
      new Date().toISOString(),
      `[teams] appendThumbnailToMessage failed for ${serverMessageId} in ${conversationId}:`,
      result.error?.message || result.error
    );
  }
  return result;
}

/**
 * Edits the original message sent by self to include the card markdown.
 * Preserves the original URL link and appends the rendered card HTML.
 */
export async function editOriginalMessage(conversationId, messageId, originalUrl, cardMarkdown) {
  // One message cannot become several: a text too large for one card stays a regular message here.
  const parts = prepareRichMessages(cardMarkdown);
  const body = parts.length === 1 ? parts[0] : messageMarkdown(cardMarkdown);
  return withCardFallback(body, (message) =>
    editOriginalMessageOnce(conversationId, messageId, originalUrl, message)
  );
}

async function editOriginalMessageOnce(conversationId, messageId, originalUrl, cardMarkdown) {
  recordBotMessageId(messageId);
  const cleanUrl = String(originalUrl || '').trim();
  const { html: cardHtml, mentions, cards } = renderReplyContent(
    isRichMessage(cardMarkdown) ? cardMarkdown : String(cardMarkdown || '').trim()
  );
  const baseHtml = cleanUrl ? `<p><a href="${escapeHtml(cleanUrl)}">${escapeHtml(cleanUrl)}</a></p>` : '';
  const fullHtml = `${baseHtml}<div style="margin-top:6px;">${cardHtml}</div>`;

  const properties = {
    mentions: mentions.length > 0 ? buildMentionsProperty(mentions) : '[]',
    cards: cards || '[]',
    links: '[]',
    files: '[]',
  };

  const result = await retrySendWithRecovery(() =>
    transport.editMessage(conversationId, String(messageId), fullHtml, 'html', { properties })
  );
  if (!result.ok) {
    console.error(
      new Date().toISOString(),
      `[teams] editOriginalMessage failed for ${messageId} in ${conversationId}:`,
      result.error?.message || result.error
    );
  }
  return result;
}
