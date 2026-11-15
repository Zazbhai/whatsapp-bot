'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  shortenUrl,
  shortenAllLinksInText,
  getShortLinkSync,
  shortenTextSync,
  resolveShortCode,
  isAlreadyShortened
} = require('./link-shortener');

test('isAlreadyShortened detects short links and does not re-shorten', () => {
  assert.equal(isAlreadyShortened('https://tinyurl.com/289vbzth'), true);
  assert.equal(isAlreadyShortened('https://is.gd/GRlFyw'), true);
  assert.equal(isAlreadyShortened('https://bit.ly/3xyz'), true);
  assert.equal(isAlreadyShortened('https://playstores.istoreoffer.quest/s/f75e3d'), true);
  assert.equal(isAlreadyShortened('https://playstores.istoreoffer.quest/app/primary'), false);
  assert.equal(isAlreadyShortened('http://example.com/long/path/to/app'), false);
  assert.equal(isAlreadyShortened('not-a-url'), false);
});

test('shortenUrl shortens a raw URL and caches the result for instant sync access', async () => {
  const rawUrl = 'https://playstores.istoreoffer.quest/app/test-slug';
  const shortUrl = await shortenUrl(rawUrl);

  assert.ok(shortUrl, 'Should return a shortened URL');
  assert.notEqual(shortUrl, rawUrl, 'Shortened URL must not equal the raw URL');
  assert.ok(
    shortUrl.startsWith('https://tinyurl.com/') ||
    shortUrl.startsWith('https://is.gd/') ||
    shortUrl.includes('/s/'),
    `Expected valid short URL, got: ${shortUrl}`
  );

  // Synchronous cache lookup must return the cached short URL
  const syncShort = getShortLinkSync(rawUrl);
  assert.equal(syncShort, shortUrl, 'Synchronous lookup should match the cached shortened URL');

  // Second call must return cached value immediately
  const secondCall = await shortenUrl(rawUrl);
  assert.equal(secondCall, shortUrl, 'Subsequent call must return cached value');
});

test('shortenAllLinksInText replaces all raw links while preserving punctuation', async () => {
  const input = 'Download here: https://playstores.istoreoffer.quest/app/test-slug. Also visit (https://playstores.istoreoffer.quest/app/test-slug)!';
  const result = await shortenAllLinksInText(input);

  assert.ok(!result.includes('https://playstores.istoreoffer.quest/app/test-slug'), 'Raw link must be replaced');
  assert.match(result, /Download here: https:\/\/\S+\./, 'Must preserve trailing period');
  assert.match(result, /\(https:\/\/\S+\)!/, 'Must preserve parenthesis and exclamation');
});

test('shortenAllLinksInText leaves messages without links untouched', async () => {
  const msg = 'Hi, how can I help you with your iPhone order?';
  const result = await shortenAllLinksInText(msg);
  assert.equal(result, msg);
});

test('shortenTextSync replaces cached raw URLs synchronously', () => {
  const rawUrl = 'https://playstores.istoreoffer.quest/app/test-slug';
  const cachedShort = getShortLinkSync(rawUrl);
  assert.ok(cachedShort, 'URL should be cached from earlier test');

  const text = `App is at ${rawUrl} - enjoy!`;
  const replaced = shortenTextSync(text);
  assert.equal(replaced, `App is at ${cachedShort} - enjoy!`);
});

test('internal short link fallback generates valid code and resolves accurately', async () => {
  const rawUrl = 'https://custom-portal.example.com/unique-download-path';
  const internalShort = await shortenUrl(rawUrl, { provider: 'internal', baseUrl: 'https://istoreoffer.quest' });

  assert.match(internalShort, /^https:\/\/istoreoffer\.quest\/s\/[a-f0-9]{6}$/);
  const code = internalShort.split('/s/')[1];
  assert.equal(resolveShortCode(code), rawUrl, 'Short code must resolve to the original long URL');
});

