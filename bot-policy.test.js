'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectLanguage, isGreetingOnly, greetingReply, isInstallOnlyConfirmation, isExplicitOrderConfirmation } = require('./bot-policy');

test('detects Roman Hinglish and Devanagari Hindi separately from English', () => {
  assert.equal(detectLanguage('hi kaise ho'), 'hinglish');
  assert.equal(detectLanguage('App download karna hai'), 'hinglish');
  assert.equal(detectLanguage('नमस्ते, app kaise install karun?'), 'hi');
  assert.equal(detectLanguage('How do I install the app?'), 'en');
});

test('recognizes only standalone casual greetings and redirects in the detected style', () => {
  assert.equal(isGreetingOnly('hi kaise ho'), true);
  assert.equal(isGreetingOnly('Hello!'), true);
  assert.equal(isGreetingOnly('Hi, app kaise download karu?'), false);
  assert.match(greetingReply('hinglish'), /app download.*help/i);
  assert.match(greetingReply('en'), /downloading and installing the app/i);
});

test('distinguishes an app installation confirmation from an order confirmation', () => {
  assert.equal(isInstallOnlyConfirmation('app install ho gaya'), true);
  assert.equal(isInstallOnlyConfirmation('app install ho gaya, order nahi kiya'), true);
  assert.equal(isInstallOnlyConfirmation('installed the app and order placed successfully'), false);
  assert.equal(isExplicitOrderConfirmation('yes'), true);
  assert.equal(isExplicitOrderConfirmation('order ho gaya'), true);
  assert.equal(isExplicitOrderConfirmation('no, order nahi kiya'), false);
});
