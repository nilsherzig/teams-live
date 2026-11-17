import test from 'node:test';
import assert from 'node:assert/strict';

import { GitLabClient } from '../src/gitlab.mjs';
import { buildMergeRequestCard } from '../src/cards.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';

const SHA = 'a'.repeat(40);
const base = { state: 'open', iid: 7, project: 'group/app', title: 'Example', url: 'https://gitlab.example.com/x', approved: false };
const statsBlock = (card) => card.body[0].items.find((i) => i.type === 'RichTextBlock');
const texts = (block) => block.inlines.map((r) => r.text).join('');

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls.length);
  };
  return Promise.resolve(fn(calls)).finally(() => {
    globalThis.fetch = original;
  });
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const summary = (s) => json({ data: { project: { mergeRequest: { diffStatsSummary: s } } } });

test('the card shows coloured +/- line totals with textual signs', () => {
  const block = statsBlock(buildMergeRequestCard({ ...base, diffStats: { additions: 1822, deletions: 144 } }));
  assert.equal(texts(block), '+1822 −144 lines');
  assert.equal(block.inlines[0].color, 'Good');
  assert.equal(block.inlines[2].color, 'Attention');
  assert.ok(!block.inlines.some((r) => r.type !== 'TextRun'));
  assert.ok(!JSON.stringify(buildMergeRequestCard({ ...base, diffStats: { additions: 1, deletions: 1 } })).includes('Action.'));
});

test('zero totals are shown, unknown or malformed totals are omitted', () => {
  assert.equal(texts(statsBlock(buildMergeRequestCard({ ...base, diffStats: { additions: 0, deletions: 0 } }))), '+0 −0 lines');
  for (const diffStats of [undefined, null, {}, { additions: 5 }, { additions: '5', deletions: 1 }, { additions: -1, deletions: 0 }, { additions: 1.5, deletions: 0 }, { additions: NaN, deletions: 0 }]) {
    assert.equal(statsBlock(buildMergeRequestCard({ ...base, diffStats })), undefined, JSON.stringify(diffStats));
  }
});

test('getMrDiffStats reads GraphQL totals, never changes_count, and caches per head commit', async () => {
  const gitlab = new GitLabClient({ host: 'gitlab.example.com', token: 'unit-test-token' });
  await withFetch(
    () => summary({ additions: 12, deletions: 3, fileCount: 2 }),
    async (calls) => {
      const a = await gitlab.getMrDiffStats('group/app', 7, { sha: SHA, baseSha: 'b' });
      assert.deepEqual(a, { additions: 12, deletions: 3, files: 2 });
      assert.equal(new URL(calls[0].url).pathname, '/api/graphql');
      assert.equal(calls[0].options.method, 'POST');
      assert.ok(calls[0].options.signal, 'bounded by a timeout');
      assert.match(JSON.parse(calls[0].options.body).query, /diffStatsSummary/);
      assert.doesNotMatch(calls[0].options.body, /changes_count/);
      await gitlab.getMrDiffStats('group/app', 7, { sha: SHA, baseSha: 'b' });
      assert.equal(calls.length, 1, 'same head commit is not queried again');
      await gitlab.getMrDiffStats('group/app', 7, { sha: 'c'.repeat(40), baseSha: 'b' });
      assert.equal(calls.length, 2, 'a new head commit is');
    }
  );
});

test('concurrent lookups for the same head commit share one request', async () => {
  const gitlab = new GitLabClient({ host: 'gitlab.example.com', token: 'unit-test-token' });
  await withFetch(
    async () => {
      await new Promise((r) => setTimeout(r, 20));
      return summary({ additions: 1, deletions: 2, fileCount: 1 });
    },
    async (calls) => {
      const results = await Promise.all([1, 2, 3].map(() => gitlab.getMrDiffStats('group/app', 7, { sha: SHA })));
      assert.equal(calls.length, 1);
      assert.ok(results.every((r) => r.additions === 1 && r.deletions === 2));
    }
  );
});

test('missing, partial, errored or failed responses give null and failures are not retried at once', async () => {
  const bad = [
    json({ data: { project: { mergeRequest: null } } }),
    json({ data: { project: { mergeRequest: { diffStatsSummary: null } } } }),
    summary({ additions: 5 }),
    summary({ additions: '5', deletions: 1 }),
    summary({ additions: -2, deletions: 1 }),
    json({ errors: [{ message: 'Field does not exist' }] }),
    json({ errors: [{ message: 'partial' }], data: { project: { mergeRequest: { diffStatsSummary: { additions: 1, deletions: 1 } } } } }),
    json({ message: 'nope' }, 500),
  ];
  for (const [i, response] of bad.entries()) {
    const gitlab = new GitLabClient({ host: 'gitlab.example.com', token: 'unit-test-token' });
    await withFetch(
      () => response.clone(),
      async (calls) => {
        assert.equal(await gitlab.getMrDiffStats('group/app', 7, { sha: SHA }), null, `case ${i}`);
        await gitlab.getMrDiffStats('group/app', 7, { sha: SHA });
        assert.equal(calls.length, 1, `case ${i}: negative result is remembered briefly`);
      }
    );
  }
});

test('a network failure gives null instead of throwing', async () => {
  const gitlab = new GitLabClient({ host: 'gitlab.example.com', token: 'unit-test-token' });
  await withFetch(
    () => {
      throw new Error('offline');
    },
    async () => {
      assert.equal(await gitlab.getMrDiffStats('group/app', 7, { sha: SHA }), null);
    }
  );
});

test('an in-place refresh keeps the last known totals of the same head commit when a lookup fails', () => {
  const watcher = new MergeRequestWatcher({
    config: { conversations: [], gitlab: { group: 'group', notify: { ci: { enable: true } } }, teams: { rich_messages: true } },
    gitlab: { mrLink: (p, i) => `https://gitlab.example.com/${p}/-/merge_requests/${i}`, findMrLinks: () => [] },
    jira: null,
    opsgenie: null,
  });
  watcher.saveState = () => {};
  const mr = { project: 'group/app', iid: 7, title: 'Example' };
  const details = { sha: SHA, title: 'Example', diffStats: { additions: 10, deletions: 4, files: 1 } };
  assert.equal(texts(statsBlock(watcher.buildMrCard(mr, details))), '+10 −4 lines');
  assert.equal(texts(statsBlock(watcher.buildMrCard(mr, { ...details, diffStats: null }))), '+10 −4 lines');
  // Another head commit: the old totals no longer apply, so the row is left out.
  assert.equal(statsBlock(watcher.buildMrCard(mr, { ...details, sha: 'd'.repeat(40), diffStats: null })), undefined);
});
