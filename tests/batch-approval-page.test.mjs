import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { BATCH_APPROVAL_SCRIPT } from '../src/batch-approval-page.mjs';

test('bulk approval sends one request at a time and updates each card before the next finishes', async () => {
  const pending = [];
  const calls = [];
  const cards = [0, 1].map((index) => {
    const status = { dataset: {}, textContent: '' };
    const approval = { textContent: '' };
    const button = { dataset: {}, disabled: false, textContent: '', hasAttribute: () => true };
    const card = { dataset: { status: 'ready', index: String(index) }, querySelector: (selector) => selector === '[data-batch-status]' ? status : selector === '[data-approve-item]' ? button : approval };
    button.closest = () => card;
    return { card, button, status, approval };
  });
  const bulk = { dataset: {}, disabled: false, hidden: false, textContent: '', hasAttribute: () => false };
  const progress = { hidden: true, max: 0, value: 0 };
  const message = { textContent: '', dataset: {} };
  const form = { action: 'https://example.com/confirm', querySelectorAll: () => [bulk, ...cards.map((c) => c.button)], addEventListener(_name, fn) { this.submit = fn; } };
  const document = { getElementById: (id) => ({ 'batch-approval': form, 'batch-approve-all': bulk, 'batch-progress': progress, 'batch-message': message })[id], querySelectorAll: () => cards.map((c) => c.card) };
  const fetch = (_url, options) => { calls.push(new URLSearchParams(options.body).get('item_index')); return new Promise((resolve) => pending.push(resolve)); };
  const FakeFormData = class { constructor() { return [['csrf', 'csrf'], ['actors', 'actors']]; } };
  vm.runInNewContext(BATCH_APPROVAL_SCRIPT, { document, fetch, FormData: FakeFormData, URLSearchParams, Array, Error });
  const run = form.submit({ preventDefault() {}, submitter: bulk });
  assert.deepEqual(calls, ['0']);
  assert.equal(cards[0].status.textContent, '⏳ Approving…');
  pending.shift()({ ok: true, json: async () => ({ status: 'approved', text: 'Approved' }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cards[0].status.textContent, '✅ Approved');
  assert.equal(cards[0].approval.textContent, 'Approved by you');
  assert.deepEqual(calls, ['0', '1']);
  assert.equal(cards[1].status.textContent, '⏳ Approving…');
  pending.shift()({ ok: true, json: async () => ({ status: 'failed', text: 'Approval refused' }) });
  await run;
  assert.equal(cards[1].status.textContent, '❌ Approval refused');
  assert.equal(progress.value, 2);
  assert.match(message.textContent, /1 of 2 approval\(s\) were not confirmed/);
});

test('an individual approval with a lost response is not retried', async () => {
  const status = { dataset: {}, textContent: '' };
  const button = { dataset: {}, disabled: false, hasAttribute: () => true };
  const card = { dataset: { status: 'ready', index: '0' }, querySelector: (selector) => selector === '[data-batch-status]' ? status : button };
  button.closest = () => card;
  const bulk = { dataset: {}, hidden: false };
  const progress = { hidden: true };
  const message = { textContent: '', dataset: {} };
  const form = { action: '/confirm', querySelectorAll: () => [button, bulk], addEventListener(_name, fn) { this.submit = fn; } };
  const document = { getElementById: (id) => ({ 'batch-approval': form, 'batch-approve-all': bulk, 'batch-progress': progress, 'batch-message': message })[id], querySelectorAll: () => [card] };
  let calls = 0;
  const fetch = async () => { calls++; throw new Error('connection lost'); };
  const FakeFormData = class { constructor() { return []; } };
  vm.runInNewContext(BATCH_APPROVAL_SCRIPT, { document, fetch, FormData: FakeFormData, URLSearchParams, Array, Error });
  await form.submit({ preventDefault() {}, submitter: button });
  assert.equal(calls, 1);
  assert.equal(status.textContent, '⚠️ Outcome unknown. Check GitLab before retrying.');
  assert.equal(button.disabled, true);
});

test('a fully successful batch shows the requested success message', async () => {
  const status = { dataset: {} };
  const approval = { textContent: '' };
  const itemButton = { dataset: {}, parentElement: { hidden: false } };
  const card = { dataset: { status: 'ready', index: '0' }, querySelector: (s) => s === '[data-batch-status]' ? status : s === '[data-approve-item]' ? itemButton : approval };
  const bulk = { dataset: {}, hidden: false, hasAttribute: () => false };
  const progress = {};
  const message = { dataset: {} };
  const form = { action: '/confirm', querySelectorAll: () => [itemButton, bulk], addEventListener(_name, fn) { this.submit = fn; } };
  const document = { getElementById: (id) => ({ 'batch-approval': form, 'batch-approve-all': bulk, 'batch-progress': progress, 'batch-message': message })[id], querySelectorAll: () => [card] };
  const FakeFormData = class { constructor() { return []; } };
  vm.runInNewContext(BATCH_APPROVAL_SCRIPT, { document, fetch: async () => ({ ok: true, json: async () => ({ status: 'approved', text: 'Approved' }) }), FormData: FakeFormData, URLSearchParams, Array, Error });
  await form.submit({ preventDefault() {}, submitter: bulk });
  assert.equal(message.textContent, '✅ All MRs were approved successfully.');
  assert.equal(bulk.hidden, true);
  assert.equal(itemButton.hidden, true);
  assert.equal(itemButton.parentElement.hidden, true);
});
