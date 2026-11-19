import test from 'node:test';
import assert from 'node:assert/strict';
import { AvatarService } from '../src/avatars.mjs';
import { BUILTIN_AVATAR_OVERRIDES } from '../src/bot-avatars.mjs';
import { PLACEHOLDER_AVATAR } from '../src/placeholder-avatar.mjs';

const service = (overrides) =>
  new AvatarService({ directory: { findUser: () => null, lookup: () => null }, fetchPhoto: async () => ({ kind: 'none' }), overrides });

test('the built-in Renovate picture is a small PNG under the names the account goes by', () => {
  const names = BUILTIN_AVATAR_OVERRIDES.map((o) => o.name);
  for (const name of ['Renovate Service User', 'Renovate Bot']) assert.ok(names.includes(name), name);
  for (const { dataUri } of BUILTIN_AVATAR_OVERRIDES) {
    assert.match(dataUri, /^data:image\/png;base64,/);
    assert.ok(dataUri.length < 1200, 'a few hundred characters of a card budget');
  }
});

test('an account without a profile gets the Renovate logo, ignoring case and spacing; others keep the placeholder', () => {
  const svc = service(BUILTIN_AVATAR_OVERRIDES);
  const logo = BUILTIN_AVATAR_OVERRIDES[0].dataUri;
  assert.equal(svc.peek('Renovate Service User'), logo);
  assert.equal(svc.peek('  renovate   service user '), logo);
  assert.equal(svc.peek('Someone Else'), null);
  assert.notEqual(logo, PLACEHOLDER_AVATAR);
});

test('a configured picture for the same name replaces the built-in one', () => {
  const mine = 'data:image/png;base64,AAAA';
  const svc = service([...BUILTIN_AVATAR_OVERRIDES, { name: 'Renovate Service User', dataUri: mine }]);
  assert.equal(svc.peek('Renovate Service User'), mine);
  assert.equal(svc.peek('Renovate Bot'), BUILTIN_AVATAR_OVERRIDES[0].dataUri);
});
