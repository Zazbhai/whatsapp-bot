'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectLanguage, isGreetingOnly, greetingReply, isInstallOnlyConfirmation, isExplicitOrderConfirmation, requestedAppAsset, prepareAppRequestReply } = require('./bot-policy');

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
  assert.equal(isInstallOnlyConfirmation('I have downloaded the app'), true);
  assert.equal(isInstallOnlyConfirmation('app install ho gaya, order nahi kiya'), true);
  assert.equal(isInstallOnlyConfirmation('installed the app and order placed successfully'), false);
  assert.equal(isExplicitOrderConfirmation('yes'), true);
  assert.equal(isExplicitOrderConfirmation('order ho gaya'), true);
  assert.equal(isExplicitOrderConfirmation('no, order nahi kiya'), false);
  assert.equal(isExplicitOrderConfirmation('I downloaded the app'), false);
  assert.equal(isExplicitOrderConfirmation('I installed it'), false);
  assert.equal(isExplicitOrderConfirmation('yes, I only downloaded the app'), false);
});

test('detects app asset requests and guarantees a link or APK notice', () => {
  assert.equal(requestedAppAsset('Sure, send the APK please'), true);
  assert.equal(requestedAppAsset('Where is the app link?'), true);
  assert.equal(requestedAppAsset('I downloaded the app'), false);
  assert.equal(prepareAppRequestReply('Sure, here is the link', 'send the app link', {
    storeUrl: 'https://store.example.net/app', language: 'en'
  }), 'Sure, here is the link\nhttps://store.example.net/app');
  assert.equal(prepareAppRequestReply('Sure, here is the link https://old.example.net/app', 'send the APK', {
    apkAvailable: true, language: 'hinglish'
  }), 'App file attach ki hai; download link APK ke saath hai.');
});
