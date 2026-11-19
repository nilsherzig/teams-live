import test from 'node:test';
import assert from 'node:assert/strict';
import { BADGED_SIZE, TEAMS_PURPLE, badgeAvatar, badgedDisplayPx, decodeImageDataUri } from '../src/badge-avatar.mjs';
import { AVATAR_PX, pictureItem } from '../src/card-user-row.mjs';
import { PLACEHOLDER_AVATAR } from '../src/placeholder-avatar.mjs';

// A 32x32 gradient JPEG (red grows to the right, green downwards, blue constant), like a Teams picture.
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSgBBwcHCggKEwoKEygaFhooKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKP/AABEIACAAIAMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/APCbTTunFfczrnNhcSbNpp3TiuOpXPpMLiTatNO6cVxVK59LhcSbNpp3TiuOdc+kwuJMW007pxXbUrn854XEmzaad04rjnXPpcLiTatNO6fLXFUrn0mFxJtWmndOK46lc+lwuJMS007pxXbUrn854XEm1aad04riqVz6TC4k2bTTunFcc659LhcSbVpp3TiuOpXPpMLiTEtNO6cV2Trn854XEm1aad0+WuOpXPpMLiTZtNO6cVx1K59LhcSbVpp3T5a4p1z6XC4k/wD/2Q==';

const pixelAt = (image, x, y) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];

test('a JPEG and a PNG picture are decoded', () => {
  const jpeg = decodeImageDataUri(JPEG);
  assert.deepEqual([jpeg.width, jpeg.height], [32, 32]);
  assert.ok(pixelAt(jpeg, 30, 2)[0] > pixelAt(jpeg, 2, 2)[0], 'red grows to the right');
  assert.ok(pixelAt(jpeg, 2, 30)[1] > pixelAt(jpeg, 2, 2)[1], 'green grows downwards');
  const png = decodeImageDataUri(PLACEHOLDER_AVATAR);
  assert.ok(png.width > 0 && png.data.length === png.width * png.height * 4);
  for (const bad of ['', null, 'data:image/svg+xml;base64,AAAA', 'data:image/jpeg;base64,AAAA', 'https://example.com/a.png']) assert.equal(decodeImageDataUri(bad), null);
});

test('the badged picture is a round PNG with a purple badge on its top-right rim', () => {
  for (const source of [JPEG, PLACEHOLDER_AVATAR]) {
    const out = badgeAvatar(source);
    assert.match(out, /^data:image\/png;base64,/);
    const image = decodeImageDataUri(out);
    assert.deepEqual([image.width, image.height], [BADGED_SIZE, BADGED_SIZE]);
    // Transparent corners (the picture is round), except the badge's corner.
    assert.equal(pixelAt(image, 0, BADGED_SIZE - 1)[3], 0, 'bottom-left corner is transparent');
    assert.equal(pixelAt(image, 0, 0)[3], 0, 'top-left corner is transparent');
    // The badge: opaque Teams purple near the top-right, fully inside the image.
    const [r, g, b, a] = pixelAt(image, Math.round(BADGED_SIZE * 0.77), Math.round(BADGED_SIZE * 0.23));
    assert.equal(a, 255);
    assert.deepEqual([r, g, b], TEAMS_PURPLE);
    // The picture itself is in the middle, opaque.
    assert.equal(pixelAt(image, BADGED_SIZE / 2 - 4, BADGED_SIZE / 2 + 6)[3], 255);
  }
  assert.equal(badgeAvatar('data:image/jpeg;base64,AAAA'), null, 'an unreadable picture: no badge, the caller keeps the plain one');
});

test('a badged picture keeps the picture size of every other picture', () => {
  assert.equal(badgedDisplayPx(AVATAR_PX), 22);
  const plain = pictureItem('Alice Example', JPEG);
  assert.deepEqual([plain.width, plain.style], [`${AVATAR_PX}px`, 'Person']);
  const badged = pictureItem('Alice Example', JPEG, { badged: true });
  assert.equal(badged.style, undefined, 'no circular crop, it would cut the badge off');
  assert.equal(badged.width, '22px');
  assert.match(badged.altText, /Alice Example/);
  assert.match(badged.altText, /MS Teams bot/);
  // The picture inside is 18px of the 22px image.
  const image = decodeImageDataUri(badged.url);
  let left = -1;
  let right = -1;
  const mid = BADGED_SIZE / 2 + 2;
  for (let x = 0; x < BADGED_SIZE; x++) if (pixelAt(image, x, mid)[3] === 255) { if (left < 0) left = x; right = x; }
  assert.ok(Math.abs(((right - left + 1) / BADGED_SIZE) * badgedDisplayPx(AVATAR_PX) - AVATAR_PX) <= 1.2, 'the picture is about 18px');
  // An unreadable picture falls back to the plain, cropped picture.
  assert.equal(pictureItem('Alice Example', 'data:image/jpeg;base64,AAAA', { badged: true }).style, 'Person');
});
