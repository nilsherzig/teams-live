import { transport } from '../src/teams.mjs';

// The watcher talks to Teams through the shared `transport`. Tests that drive
// code which sends, edits or reacts replace it so they can inspect the outgoing
// calls and never reach a real account (see src/test-guard.mjs).
export async function withStubbedTransport(fn) {
  const original = { ...transport };
  const calls = { sent: [], edited: [], reactions: [] };
  transport.sendMessage = async (conversationId, html, options) => {
    calls.sent.push({ conversationId, html, options });
    const id = `18000000000${calls.sent.length}`;
    return { ok: true, value: { id, messageId: id, timestamp: id } };
  };
  transport.editMessage = async (conversationId, messageId, html, ...rest) => {
    calls.edited.push({ conversationId, messageId, html, rest });
    return { ok: true, value: {} };
  };
  transport.addReaction = async (conversationId, messageId, key) => {
    calls.reactions.push({ op: 'add', conversationId, messageId, key });
    return { ok: true };
  };
  transport.removeReaction = async (conversationId, messageId, key) => {
    calls.reactions.push({ op: 'remove', conversationId, messageId, key });
    return { ok: true };
  };
  try {
    return await fn(calls.sent, calls);
  } finally {
    Object.assign(transport, original);
  }
}

// Stubs the transport for every test of the calling file. `calls` is reset
// before each test and reflects the current test.
export function useStubbedTransport(beforeEachHook, afterEachHook) {
  const original = { ...transport };
  const state = { sent: [], edited: [], reactions: [] };
  beforeEachHook(() => {
    state.sent.length = 0;
    state.edited.length = 0;
    state.reactions.length = 0;
    transport.sendMessage = async (conversationId, html, options) => {
      state.sent.push({ conversationId, html, options });
      const id = `18000000000${state.sent.length}`;
      return { ok: true, value: { id, messageId: id, timestamp: id } };
    };
    transport.editMessage = async (conversationId, messageId, html, ...rest) => {
      state.edited.push({ conversationId, messageId, html, rest });
      return { ok: true, value: {} };
    };
    transport.addReaction = async (conversationId, messageId, key) => {
      state.reactions.push({ op: 'add', conversationId, messageId, key });
      return { ok: true };
    };
    transport.removeReaction = async (conversationId, messageId, key) => {
      state.reactions.push({ op: 'remove', conversationId, messageId, key });
      return { ok: true };
    };
  });
  afterEachHook(() => {
    Object.assign(transport, original);
  });
  return state;
}
