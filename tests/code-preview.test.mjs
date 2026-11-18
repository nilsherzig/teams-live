import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { beforeEach, afterEach } from 'node:test';

import { buildCodePreviewCard, formatCodePreviewMarkdown } from '../src/cards.mjs';
import { loadConfig } from '../src/config.mjs';
import { GitLabClient, isSensitivePath } from '../src/gitlab.mjs';
import { MergeRequestWatcher } from '../src/watcher.mjs';
import { useStubbedTransport } from './stub-transport.mjs';

// Nothing in this file may reach a real Teams account or GitLab.
const calls = useStubbedTransport(beforeEach, afterEach);

const HOST = 'gitlab.example.com';
const PROJECT = 'group/app';
const blobUrl = (refPath, anchor = '') => `https://${HOST}/${PROJECT}/-/blob/${refPath}${anchor}`;

const SAMPLE = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

function file(content, extra = {}) {
  return { encoding: 'base64', size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64'), ...extra };
}

function notFound() {
  const err = new Error('GitLab error (404): 404 File Not Found');
  err.status = 404;
  return err;
}

/** A client whose API is an in-process stub: `files` maps "<ref>:<path>" to a file or an Error. */
function stubbedClient(files, options = {}) {
  const client = new GitLabClient({ host: HOST, token: 'test-token', group: 'group', ...options });
  client.requested = [];
  client.request = async (apiPath) => {
    client.requested.push(apiPath);
    const match = /\/repository\/files\/([^?]+)\?ref=(.+)$/.exec(apiPath);
    assert.ok(match, `unexpected API path ${apiPath}`);
    const hit = files[`${decodeURIComponent(match[2])}:${decodeURIComponent(match[1])}`];
    if (!hit) throw notFound();
    if (hit instanceof Error) throw hit;
    return hit;
  };
  return client;
}

test('getBlobPreview reports unavailable reasons without changing its return value', async () => {
  const client = stubbedClient({ 'main:src/a.js': file('one\ntwo\n') });
  const reasons = [];
  const options = { onUnavailable: (reason) => reasons.push(reason) };
  const missing = client.findBlobLinks(blobUrl('main/src/missing.js', '#L1'))[0];
  assert.equal(await client.getBlobPreview(missing, options), null);
  assert.match(reasons.pop(), /404.*access, ref, and path/);
  const beyond = client.findBlobLinks(blobUrl('main/src/a.js', '#L3'))[0];
  assert.equal(await client.getBlobPreview(beyond, options), null);
  assert.equal(reasons.pop(), 'requested line exceeds file length (2 lines)');
});

// ---------------------------------------------------------------------------
// Link parsing

test('findBlobLinks: single line, ranges (both spellings) and reversed ranges', () => {
  const client = new GitLabClient({ host: HOST });
  const text = [
    blobUrl('main/src/a.js', '#L10'),
    blobUrl('main/src/b.js', '#L10-20'),
    blobUrl('main/src/c.js', '#L10-L20'),
    blobUrl('main/src/d.js', '#L20-10'),
  ].join(' ');
  const links = client.findBlobLinks(text);
  assert.deepEqual(
    links.map((l) => [l.project, l.refPath, l.startLine, l.endLine]),
    [
      [PROJECT, 'main/src/a.js', 10, 10],
      [PROJECT, 'main/src/b.js', 10, 20],
      [PROJECT, 'main/src/c.js', 10, 20],
      [PROJECT, 'main/src/d.js', 10, 20],
    ]
  );
  assert.equal(links[1].url, blobUrl('main/src/b.js', '#L10-20'));
});

test('findBlobLinks: query string, slashes in the ref, dedupe', () => {
  const client = new GitLabClient({ host: HOST });
  const links = client.findBlobLinks(
    `${blobUrl('feature/x/src/a.py', '#L3')} ${blobUrl('feature/x/src/a.py', '#L3')} ${blobUrl('main/b.py?plain=1', '#L7-9')}`
  );
  assert.equal(links.length, 2);
  assert.equal(links[0].refPath, 'feature/x/src/a.py');
  assert.equal(links[1].refPath, 'main/b.py');
  assert.equal(links[1].startLine, 7);
});

test('findBlobLinks: the `<project>.git//blob/...` form is recognized like `/-/blob/`', () => {
  const client = new GitLabClient({ host: HOST });
  const dotGit = `https://${HOST}/other-group/sub/project.git//blob/main/src/app.py#L970`;
  const links = client.findBlobLinks(`see ${dotGit} please`);
  assert.equal(links.length, 1);
  assert.deepEqual(
    [links[0].project, links[0].refPath, links[0].startLine, links[0].endLine, links[0].url],
    ['other-group/sub/project', 'main/src/app.py', 970, 970, dotGit]
  );
  // Ranges, a doubled slash without `.git`, the single-slash legacy form and the same file spelled two ways.
  const more = client.findBlobLinks(
    [
      `https://${HOST}/g/p.git//blob/dev/x.js#L5-9`,
      `https://${HOST}/g/p//blob/dev/x.js#L5-L9`,
      `https://${HOST}/g/p/blob/dev/y.js#L1`,
      `https://${HOST}/g/p/-/blob/dev/x.js#L5-9`,
    ].join(' ')
  );
  assert.deepEqual(
    more.map((l) => [l.project, l.refPath, l.startLine, l.endLine]),
    [
      ['g/p', 'dev/x.js', 5, 9],
      ['g/p', 'dev/y.js', 1, 1],
    ]
  );
  // `.git` is only stripped from the project, never from the file path.
  assert.equal(client.findBlobLinks(`https://${HOST}/g/p/-/blob/main/a.git#L1`)[0].refPath, 'main/a.git');
  // A host-only or anchorless link is still not a code reference.
  assert.deepEqual(client.findBlobLinks(`https://${HOST}/g/p.git//blob/main/a.js`), []);
});

test('findBlobLinks: ignores links without a line anchor, other hosts, quotes and replies', () => {
  const client = new GitLabClient({ host: HOST });
  assert.deepEqual(client.findBlobLinks(blobUrl('main/src/a.js')), []);
  assert.deepEqual(client.findBlobLinks(blobUrl('main/src/a.js', '#L0')), []);
  assert.deepEqual(client.findBlobLinks(`https://other.example.com/${PROJECT}/-/blob/main/a.js#L3`), []);
  assert.deepEqual(client.findBlobLinks(`https://${HOST}.evil.example/${PROJECT}/-/blob/main/a.js#L3`), []);

  const text = `<blockquote>${blobUrl('main/q.js', '#L1')}</blockquote><div itemtype="http://schema.skype.com/Reply">${blobUrl('main/r.js', '#L2')}</div>${blobUrl('main/d.js', '#L3')}`;
  assert.equal(client.findBlobLinks(text).length, 1);
  assert.equal(client.findBlobLinks(text, { allowQuotes: true }).length, 3);
});

test('isSensitivePath flags credential-like paths only', () => {
  for (const p of ['.env', 'app/.env.production', 'deploy/id_rsa', 'certs/server.pem', 'k/tls.key', 'infra/terraform.tfstate',
    'config/secrets.yaml', 'a/db_password.txt', '.npmrc', 'kubeconfig']) {
    assert.equal(isSensitivePath(p), true, p);
  }
  for (const p of ['src/main.js', 'README.md', 'docs/environment.md', 'src/keyboard.js', 'app/env.example']) {
    assert.equal(isSensitivePath(p), false, p);
  }
});

// ---------------------------------------------------------------------------
// getBlobPreview

const linkOf = (client, refPath, anchor) => client.findBlobLinks(blobUrl(refPath, anchor))[0];

test('getBlobPreview: single line and range', async () => {
  const client = stubbedClient({ 'main:src/a.txt': file(SAMPLE) });
  const single = await client.getBlobPreview(linkOf(client, 'main/src/a.txt', '#L7'));
  assert.deepEqual(single.lines, [{ n: 7, text: 'line 7' }]);
  assert.equal(single.truncated, false);
  assert.equal(single.ref, 'main');
  assert.equal(single.path, 'src/a.txt');

  const range = await client.getBlobPreview(linkOf(client, 'main/src/a.txt', '#L3-5'));
  assert.deepEqual(range.lines.map((l) => l.n), [3, 4, 5]);
  assert.equal(range.lines[2].text, 'line 5');
  assert.equal(client.requested[0], `projects/group%2Fapp/repository/files/src%2Fa.txt?ref=main`);
});

test('getBlobPreview: long ranges are capped, ranges past the end are clamped', async () => {
  const client = stubbedClient({ 'main:a.txt': file(SAMPLE) });
  const capped = await client.getBlobPreview(linkOf(client, 'main/a.txt', '#L1-40'), { maxLines: 10 });
  assert.equal(capped.lines.length, 10);
  assert.equal(capped.endLine, 10);
  assert.equal(capped.requestedEndLine, 40);
  assert.equal(capped.truncated, true);

  const clamped = await client.getBlobPreview(linkOf(client, 'main/a.txt', '#L48-99'));
  assert.deepEqual(clamped.lines.map((l) => l.n), [48, 49, 50]);
  assert.equal(clamped.truncated, false);

  assert.equal(await client.getBlobPreview(linkOf(client, 'main/a.txt', '#L51')), null);
});

test('getBlobPreview: CRLF files and a missing trailing newline', async () => {
  const client = stubbedClient({ 'main:w.txt': file('one\r\ntwo\r\nthree') });
  const preview = await client.getBlobPreview(linkOf(client, 'main/w.txt', '#L2-3'));
  assert.deepEqual(preview.lines, [{ n: 2, text: 'two' }, { n: 3, text: 'three' }]);
});

test('getBlobPreview: a ref with slashes is found by trying the next split on 404', async () => {
  const client = stubbedClient({ 'feature/x:src/a.txt': file(SAMPLE) });
  const preview = await client.getBlobPreview(linkOf(client, 'feature/x/src/a.txt', '#L2'));
  assert.equal(preview.ref, 'feature/x');
  assert.equal(preview.path, 'src/a.txt');
  assert.equal(client.requested.length, 2);
});

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const LAST_TOUCHED = 'fedcba9876543210fedcba9876543210fedcba98';
const permalink = (filePath, anchor) => `https://${HOST}/${PROJECT}/-/blob/${COMMIT}/${filePath}${anchor}`;

test('getBlobPreview: the link is pinned to the commit_id of the content that was read, not last_commit_id', async () => {
  const client = stubbedClient({ 'main:src/a.txt': file(SAMPLE, { commit_id: COMMIT, last_commit_id: LAST_TOUCHED }) });
  const single = await client.getBlobPreview(linkOf(client, 'main/src/a.txt', '#L7'));
  assert.equal(single.url, permalink('src/a.txt', '#L7'));
  assert.equal(single.originalUrl, blobUrl('main/src/a.txt', '#L7'));
  assert.equal(single.commitId, COMMIT);

  // Both range spellings and reversed ranges become `#L<start>-<end>`.
  for (const anchor of ['#L3-5', '#L3-L5', '#L5-3']) {
    const range = await client.getBlobPreview(linkOf(client, 'main/src/a.txt', anchor));
    assert.equal(range.url, permalink('src/a.txt', '#L3-5'), anchor);
  }

  // The requested range is kept even when the preview is capped or clamped.
  const capped = await client.getBlobPreview(linkOf(client, 'main/src/a.txt', '#L1-40'), { maxLines: 10 });
  assert.equal(capped.endLine, 10);
  assert.equal(capped.url, permalink('src/a.txt', '#L1-40'));
  const clamped = await client.getBlobPreview(linkOf(client, 'main/src/a.txt', '#L48-99'));
  assert.equal(clamped.url, permalink('src/a.txt', '#L48-99'));
});

test('getBlobPreview: a ref with slashes yields a permalink without the ref, and the path is encoded per segment', async () => {
  const client = stubbedClient({
    'feature/x:docs/my file (1)/a#b.txt': file(SAMPLE, { commit_id: COMMIT.toUpperCase() }),
  });
  const preview = await client.getBlobPreview(
    linkOf(client, 'feature/x/docs/my%20file%20(1)/a%23b.txt', '#L2-3')
  );
  assert.equal(preview.ref, 'feature/x');
  assert.equal(preview.path, 'docs/my file (1)/a#b.txt');
  assert.equal(preview.url, permalink('docs/my%20file%20%281%29/a%23b.txt', '#L2-3'));
  assert.ok(!preview.url.includes('feature'));
  // The commit id is normalized to lower case.
  assert.equal(preview.commitId, COMMIT.toUpperCase());
  assert.ok(preview.url.includes(`/blob/${COMMIT}/`));
});

test('getBlobPreview: the original link is kept without a usable commit_id', async () => {
  for (const extra of [{}, { commit_id: '' }, { commit_id: 'main' }, { commit_id: 'abc123' }, { commit_id: 42 }, { last_commit_id: LAST_TOUCHED }]) {
    const client = stubbedClient({ 'main:src/a.txt': file(SAMPLE, extra) });
    const link = linkOf(client, 'main/src/a.txt', '#L2-4');
    const preview = await client.getBlobPreview(link);
    assert.equal(preview.url, link.url, JSON.stringify(extra));
    assert.equal(preview.originalUrl, link.url);
    assert.equal(preview.commitId, null);
    assert.deepEqual(preview.lines.map((l) => l.n), [2, 3, 4]);
  }
});

test('buildCodePreviewCard and formatCodePreviewMarkdown link to the permalink', async () => {
  const client = stubbedClient({ 'main:src/a.txt': file(SAMPLE, { commit_id: COMMIT }) });
  const preview = await client.getBlobPreview(linkOf(client, 'main/src/a.txt', '#L8-10'));
  assert.ok(JSON.stringify(buildCodePreviewCard(preview)).includes(permalink('src/a.txt', '#L8-10')));
  assert.ok(formatCodePreviewMarkdown(preview).includes(`(${permalink('src/a.txt', '#L8-10')})`));
});

test('getBlobPreview: unknown file or ref gives nothing', async () => {
  const client = stubbedClient({});
  assert.equal(await client.getBlobPreview(linkOf(client, 'main/missing.txt', '#L1')), null);
});

test('getBlobPreview: other failures are thrown so the caller can retry', async () => {
  const boom = Object.assign(new Error('GitLab error (500): boom'), { status: 500 });
  const client = stubbedClient({ 'main:a.txt': boom });
  await assert.rejects(() => client.getBlobPreview(linkOf(client, 'main/a.txt', '#L1')), /500/);
});

test('getBlobPreview: a project in another group is previewed by default (the group only scopes MR monitoring)', async () => {
  const client = stubbedClient({ 'main:a.txt': file(SAMPLE) });
  const other = client.findBlobLinks(`https://${HOST}/other/app.git//blob/main/a.txt#L2`)[0];
  const preview = await client.getBlobPreview(other);
  assert.equal(preview.project, 'other/app');
  assert.equal(preview.lines[0].text, 'line 2');
  assert.deepEqual(client.requested, ['projects/other%2Fapp/repository/files/a.txt?ref=main']);
});

test('getBlobPreview: restrictToGroup never requests projects outside the configured group', async () => {
  const client = stubbedClient({ 'main:a.txt': file(SAMPLE) });
  const outside = client.findBlobLinks(`https://${HOST}/other/app/-/blob/main/a.txt#L1`)[0];
  assert.equal(await client.getBlobPreview(outside, { restrictToGroup: true }), null);
  // `group-evil` shares the prefix text but is another group.
  const lookalike = client.findBlobLinks(`https://${HOST}/group-evil/app/-/blob/main/a.txt#L1`)[0];
  assert.equal(await client.getBlobPreview(lookalike, { restrictToGroup: true }), null);
  assert.deepEqual(client.requested, []);
  assert.ok(await client.getBlobPreview(client.findBlobLinks(blobUrl('main/a.txt', '#L1'))[0], { restrictToGroup: true }));

  // Without a configured group there is nothing to restrict to.
  const open = stubbedClient({ 'main:a.txt': file(SAMPLE) }, { group: '' });
  assert.ok(await open.getBlobPreview(open.findBlobLinks(`https://${HOST}/other/app/-/blob/main/a.txt#L1`)[0], { restrictToGroup: true }));
});

test('getBlobPreview: credential-like paths, traversal, binary and huge files are skipped without leaking content', async () => {
  const client = stubbedClient({
    'main:.env': file('TOKEN=hunter2\n'),
    'main:bin/blob.dat': file('abc\u0000def\n'),
    'main:big.txt': file('x\n', { size: 5_000_000 }),
    'main:b64.txt': file('x\n', { encoding: 'text' }),
  });
  for (const refPath of ['main/.env', 'main/config/secrets.yaml', 'main/bin/blob.dat', 'main/big.txt', 'main/b64.txt']) {
    assert.equal(await client.getBlobPreview(linkOf(client, refPath, '#L1')), null, refPath);
  }
  assert.equal(
    await client.getBlobPreview({ project: PROJECT, refPath: 'main/../../etc/passwd', startLine: 1, endLine: 1, url: 'u' }),
    null
  );
  assert.equal(
    await client.getBlobPreview({ project: PROJECT, refPath: 'main/%2e%2e/a.txt', startLine: 1, endLine: 1, url: 'u' }),
    null
  );
  assert.ok(!client.requested.some((r) => r.includes('.env') || r.includes('secrets') || r.includes('passwd')));
});

test('GitLabClient.request errors carry the HTTP status and only the configured host is called', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  try {
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return { ok: false, status: 404, text: async () => '{"message":"404 File Not Found"}' };
    };
    const client = new GitLabClient({ host: HOST, token: 'test-token', group: 'group' });
    assert.equal(await client.getBlobPreview(linkOf(client, 'main/nope.txt', '#L1')), null);
    assert.ok(urls.length > 0);
    assert.ok(urls.every((u) => u.startsWith(`https://${HOST}/api/v4/`)), urls.join('\n'));
    await assert.rejects(
      () => client.request('projects/1'),
      (err) => err.status === 404 && /404/.test(err.message)
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Rendering

const previewOf = (extra = {}) => ({
  project: PROJECT,
  ref: 'main',
  path: 'src/a.txt',
  startLine: 8,
  endLine: 10,
  requestedEndLine: 10,
  totalLines: 50,
  truncated: false,
  lines: [8, 9, 10].map((n) => ({ n, text: `  line ${n}` })),
  url: blobUrl('main/src/a.txt', '#L8-10'),
  ...extra,
});

test('buildCodePreviewCard shows the file, the range and one monospace row per line', () => {
  const card = buildCodePreviewCard(previewOf());
  const json = JSON.stringify(card);
  assert.match(json, /src\/a\.txt \(L8-10\)/);
  assert.match(json, /group\/app @ main/);
  assert.ok(json.includes(blobUrl('main/src/a.txt', '#L8-10')));
  const rows = JSON.stringify(card).match(/"fontType":"Monospace"/g) || [];
  assert.equal(rows.length, 3);
  assert.doesNotMatch(json, /Showing/);

  const single = JSON.stringify(buildCodePreviewCard(previewOf({ startLine: 9, endLine: 9, lines: [{ n: 9, text: 'x' }] })));
  assert.match(single, /\(L9\)/);

  const truncated = JSON.stringify(buildCodePreviewCard(previewOf({ truncated: true, requestedEndLine: 40 })));
  assert.match(truncated, /Showing 3 of 33 lines/);
});

test('formatCodePreviewMarkdown escapes the header and cannot be broken out of by backticks in the code', () => {
  const md = formatCodePreviewMarkdown(
    previewOf({ path: 'src/<b>.txt', lines: [{ n: 8, text: '```' }, { n: 9, text: 'a <script> & b' }], endLine: 9 })
  );
  assert.match(md, /src\/&lt;b&gt;\.txt/);
  const fences = md.match(/^`{4,}$/gm);
  assert.equal(fences?.length, 2, 'a fence longer than the longest backtick run in the code');
  assert.match(md, /a <script> & b/, 'the code itself is left to the markdown converter to escape');
});

// ---------------------------------------------------------------------------
// Configuration

test('loadConfig: gitlab.code_preview defaults and overrides', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-live-code-preview-'));
  try {
    const write = (gitlab) => {
      const p = path.join(dir, 'config.json');
      fs.writeFileSync(p, JSON.stringify({ gitlab, conversations: [{ id: '48:notes', name: 'Notes' }] }));
      return p;
    };
    assert.deepEqual(loadConfig(write({})).gitlab.code_preview, {
      enable: true,
      max_lines: 30,
      allow_other_senders: false,
      restrict_to_group: false,
    });
    assert.deepEqual(
      loadConfig(write({ code_preview: { enable: false, max_lines: 12, allow_other_senders: true, restrict_to_group: true } })).gitlab.code_preview,
      { enable: false, max_lines: 12, allow_other_senders: true, restrict_to_group: true }
    );
    assert.equal(loadConfig(write({ code_preview: { max_lines: -3 } })).gitlab.code_preview.max_lines, 30);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Watcher flow

const CONV = '19:team@thread.v2';
// Placeholder identities: the authenticated user and another chat participant.
const SELF_MRI = '8:orgid:11111111-1111-4111-8111-111111111111';
const OTHER_MRI = '8:orgid:22222222-2222-4222-8222-222222222222';

function newWatcher(client, { codePreview = { enable: true, max_lines: 30 }, rich = false } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-live-code-preview-state-'));
  process.env.XDG_STATE_HOME = stateDir;
  const watcher = new MergeRequestWatcher({
    config: {
      conversations: [{ id: CONV, name: 'team' }],
      gitlab: { code_preview: codePreview },
      teams: { rich_messages: rich },
    },
    gitlab: client,
    jira: null,
    opsgenie: null,
  });
  watcher.setSelfMri(SELF_MRI);
  watcher.testStateDir = stateDir;
  return watcher;
}

async function settle(watcher, key) {
  await watcher.watchedChecks?.get(key);
}

test('watcher: a line-range link gets exactly one reply with the lines', async () => {
  const client = stubbedClient({ 'main:src/a.txt': file(SAMPLE) });
  const watcher = newWatcher(client);
  const key = `${CONV}/1690000000001`;
  try {
    watcher.watch(CONV, '1690000000001', `look at ${blobUrl('main/src/a.txt', '#L3-5')}`, { from: 'Alice Example', fromMri: SELF_MRI });
    await settle(watcher, key);

    assert.equal(calls.sent.length, 1);
    const html = calls.sent[0].html;
    assert.match(html, /line 3/);
    assert.match(html, /line 5/);
    assert.doesNotMatch(html, /line 6/);
    assert.match(html, /src\/a\.txt/);

    // Everything is done: the entry is unwatched, and a second check posts nothing.
    assert.equal(watcher.watched.has(key), false);
    await watcher.checkWatchedKey(key);
    assert.equal(calls.sent.length, 1);
  } finally {
    fs.rmSync(watcher.testStateDir, { recursive: true, force: true });
    delete process.env.XDG_STATE_HOME;
  }
});

test('watcher: the `<project>.git//blob/<ref>/<path>#L970` form in another group gets a reply and is recognized', async () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `row ${i + 1}`).join('\n') + '\n';
  const client = stubbedClient({ 'main:src/app.py': file(lines) });
  const watcher = newWatcher(client);
  const url = `https://${HOST}/other-group/project.git//blob/main/src/app.py#L970`;
  const key = `${CONV}/1690000000009`;
  try {
    assert.equal(watcher.isRecognizedUrl(url), true);
    watcher.watch(CONV, '1690000000009', url, { from: 'Alice Example', fromMri: SELF_MRI });
    await settle(watcher, key);
    assert.equal(calls.sent.length, 1);
    assert.match(calls.sent[0].html, /row 970/);
    assert.doesNotMatch(calls.sent[0].html, /row 971/);
    assert.deepEqual(client.requested, ['projects/other-group%2Fproject/repository/files/src%2Fapp.py?ref=main']);
  } finally {
    fs.rmSync(watcher.testStateDir, { recursive: true, force: true });
    delete process.env.XDG_STATE_HOME;
  }
});

test('watcher: links from other senders never trigger a file read (own messages only by default)', async () => {
  const client = stubbedClient({ 'main:src/a.txt': file(SAMPLE) });
  const watcher = newWatcher(client);
  const url = blobUrl('main/src/a.txt', '#L3-5');
  try {
    // Another participant, a sender without an identity, and a name that merely looks like ours.
    watcher.watch(CONV, '1690000000011', url, { from: 'Mallory Example', fromMri: OTHER_MRI });
    watcher.watch(CONV, '1690000000012', url, { from: 'Alice Example' });
    watcher.watch(CONV, '1690000000013', url, { from: 'Alice Example', fromMri: '' });
    assert.equal(watcher.watched.size, 0);
    assert.deepEqual(calls.sent, []);
    assert.deepEqual(client.requested, []);

    // Restored state of someone else's message is dropped without a read as well.
    const key = `${CONV}/1690000000014`;
    watcher.watched.set(key, {
      conversationId: CONV,
      messageId: '1690000000014',
      isSelf: false,
      mrs: [],
      jobs: [],
      pipelines: [],
      jiraIssues: [],
      opsgenieAlerts: [],
      confluenceDocs: [],
      codeLinks: [{ key: 'k', project: PROJECT, refPath: 'main/src/a.txt', startLine: 1, endLine: 1, url }],
      createdAt: Date.now(),
    });
    await watcher.checkWatchedKey(key);
    assert.deepEqual(client.requested, []);
    assert.deepEqual(calls.sent, []);

    // The authenticated user's own message is answered.
    watcher.watch(CONV, '1690000000015', url, { from: 'Alice Example', fromMri: SELF_MRI });
    await settle(watcher, `${CONV}/1690000000015`);
    assert.equal(calls.sent.length, 1);
    assert.equal(client.requested.length, 1);
  } finally {
    fs.rmSync(watcher.testStateDir, { recursive: true, force: true });
    delete process.env.XDG_STATE_HOME;
  }
});

test('watcher: gitlab.code_preview.allow_other_senders opts in to previews for other participants', async () => {
  const client = stubbedClient({ 'main:src/a.txt': file(SAMPLE) });
  const watcher = newWatcher(client, { codePreview: { enable: true, max_lines: 30, allow_other_senders: true } });
  const key = `${CONV}/1690000000016`;
  try {
    watcher.watch(CONV, '1690000000016', blobUrl('main/src/a.txt', '#L2'), { from: 'Mallory Example', fromMri: OTHER_MRI });
    await settle(watcher, key);
    assert.equal(calls.sent.length, 1);
  } finally {
    fs.rmSync(watcher.testStateDir, { recursive: true, force: true });
    delete process.env.XDG_STATE_HOME;
  }
});

test('watcher: rich mode sends a code card', async () => {
  const client = stubbedClient({ 'main:src/a.txt': file(SAMPLE) });
  const watcher = newWatcher(client, { rich: true });
  const key = `${CONV}/1690000000002`;
  try {
    watcher.watch(CONV, '1690000000002', blobUrl('main/src/a.txt', '#L9'), { from: 'Alice Example', fromMri: SELF_MRI });
    await settle(watcher, key);
    assert.equal(calls.sent.length, 1);
    const cards = calls.sent[0].options?.properties?.cards || '';
    assert.match(cards, /src\/a\.txt \(L9\)/);
    assert.match(cards, /line 9/);
  } finally {
    fs.rmSync(watcher.testStateDir, { recursive: true, force: true });
    delete process.env.XDG_STATE_HOME;
  }
});

test('watcher: a link with nothing to show (secrets, outside the group when restricted, missing) sends nothing and is dropped', async () => {
  const client = stubbedClient({ 'main:.env': file('TOKEN=hunter2\n'), 'main:a.txt': file(SAMPLE) });
  const watcher = newWatcher(client, { codePreview: { enable: true, max_lines: 30, restrict_to_group: true } });
  const text = [
    blobUrl('main/.env', '#L1'),
    `https://${HOST}/other/app/-/blob/main/a.txt#L1`,
    blobUrl('main/missing.txt', '#L1'),
  ].join(' ');
  const key = `${CONV}/1690000000003`;
  try {
    watcher.watch(CONV, '1690000000003', text, { from: 'Alice Example', fromMri: SELF_MRI });
    await settle(watcher, key);
    assert.deepEqual(calls.sent, []);
    assert.equal(watcher.watched.has(key), false);
    assert.ok(!client.requested.some((r) => r.includes('.env') || r.includes('other')));
  } finally {
    fs.rmSync(watcher.testStateDir, { recursive: true, force: true });
    delete process.env.XDG_STATE_HOME;
  }
});

test('watcher: a persistent API failure is retried a few times and then given up on', async () => {
  const boom = Object.assign(new Error('GitLab error (500): boom'), { status: 500 });
  const client = stubbedClient({ 'main:a.txt': boom });
  const watcher = newWatcher(client);
  const key = `${CONV}/1690000000004`;
  try {
    watcher.watch(CONV, '1690000000004', blobUrl('main/a.txt', '#L1'), { from: 'Alice Example', fromMri: SELF_MRI });
    await settle(watcher, key);
    assert.equal(watcher.watched.has(key), true, 'first failure keeps the entry for a retry');
    await watcher.checkWatchedKey(key);
    await watcher.checkWatchedKey(key);
    assert.deepEqual(calls.sent, []);
    assert.equal(watcher.watched.has(key), false, 'given up after the third failure');
  } finally {
    fs.rmSync(watcher.testStateDir, { recursive: true, force: true });
    delete process.env.XDG_STATE_HOME;
  }
});

test('watcher: the preview is not repeated after a restart (state is restored)', async () => {
  const client = stubbedClient({ 'main:src/a.txt': file(SAMPLE) });
  const watcher = newWatcher(client);
  const key = `${CONV}/1690000000005`;
  try {
    const entry = {
      key: `${PROJECT}:main/src/a.txt#L1-1`,
      project: PROJECT,
      refPath: 'main/src/a.txt',
      startLine: 1,
      endLine: 1,
      url: blobUrl('main/src/a.txt', '#L1'),
      messageServerId: '1800000000099',
    };
    watcher.savedEntries.set(key, { codeLinks: [entry], createdAt: Date.now() });
    watcher.watch(CONV, '1690000000005', blobUrl('main/src/a.txt', '#L1'), { from: 'Alice Example', fromMri: SELF_MRI });
    await settle(watcher, key);
    assert.deepEqual(calls.sent, []);
    assert.equal(client.requested.length, 0);
  } finally {
    fs.rmSync(watcher.testStateDir, { recursive: true, force: true });
    delete process.env.XDG_STATE_HOME;
  }
});

test('watcher: gitlab.code_preview.enable=false leaves blob links alone', async () => {
  const client = stubbedClient({ 'main:src/a.txt': file(SAMPLE) });
  const watcher = newWatcher(client, { codePreview: { enable: false, max_lines: 30 } });
  try {
    const url = blobUrl('main/src/a.txt', '#L1');
    watcher.watch(CONV, '1690000000006', url, { from: 'Alice Example', fromMri: SELF_MRI });
    assert.equal(watcher.watched.size, 0);
    assert.equal(watcher.isRecognizedUrl(url), false);
    assert.deepEqual(calls.sent, []);
  } finally {
    fs.rmSync(watcher.testStateDir, { recursive: true, force: true });
    delete process.env.XDG_STATE_HOME;
  }

  const enabled = newWatcher(client);
  try {
    assert.equal(enabled.isRecognizedUrl(blobUrl('main/src/a.txt', '#L1')), true);
    assert.equal(enabled.isRecognizedUrl(blobUrl('main/src/a.txt')), false, 'no line anchor, not a code reference');
  } finally {
    fs.rmSync(enabled.testStateDir, { recursive: true, force: true });
    delete process.env.XDG_STATE_HOME;
  }
});
