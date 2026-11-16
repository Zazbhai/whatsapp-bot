'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectLanguage, isGreetingOnly, greetingReply, isInstallOnlyConfirmation, isExplicitOrderConfirmation, requestedAppAsset, prepareAppRequestReply, isUnorderedInquiry } = require('./bot-policy');

test('detects Roman Hinglish and Devanagari Hindi separately from English and Punjabi', () => {
  assert.equal(detectLanguage('hi kaise ho'), 'hinglish');
  assert.equal(detectLanguage('App download karna hai'), 'hinglish');
  assert.equal(detectLanguage('नमस्ते, app kaise install karun?'), 'hi');
  assert.equal(detectLanguage('How do I install the app?'), 'en');
  assert.equal(detectLanguage('ਕਿਵੇਂ ਆਰਡਰ ਕਰਨਾ ਹੈ?'), 'pa');
  assert.equal(detectLanguage('kive order karna dasso'), 'pa');
});

test('recognizes only standalone casual greetings and redirects in the detected style', () => {
  assert.equal(isGreetingOnly('hi kaise ho'), true);
  assert.equal(isGreetingOnly('Hello!'), true);
  assert.equal(isGreetingOnly('ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ'), true);
  assert.equal(isGreetingOnly('Hi, app kaise download karu?'), false);
  assert.match(greetingReply('hinglish'), /app download.*help/i);
  assert.match(greetingReply('hi'), /ऐप डाउनलोड.*मदद/i);
  assert.match(greetingReply('pa'), /ਐਪ ਡਾਊਨਲੋਡ.*ਮਦਦ/i);
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

test('isUnorderedInquiry detects false-positive un-ordered queries across English, Hinglish, Hindi, and Punjabi', () => {
  // English inquiries
  assert.equal(isUnorderedInquiry('how to buy'), true);
  assert.equal(isUnorderedInquiry('whats the process'), true);
  assert.equal(isUnorderedInquiry('what is the process'), true);
  assert.equal(isUnorderedInquiry('what are the steps'), true);
  assert.equal(isUnorderedInquiry("haven't ordered yet"), true);
  assert.equal(isUnorderedInquiry("where to buy"), true);
  assert.equal(isUnorderedInquiry("link not working"), true);

  // Hinglish inquiries
  assert.equal(isUnorderedInquiry('kaise buy kare'), true);
  assert.equal(isUnorderedInquiry('order kaise karna hai'), true);
  assert.equal(isUnorderedInquiry('order nahi ho raha'), true);
  assert.equal(isUnorderedInquiry('process kya hai'), true);
  assert.equal(isUnorderedInquiry('kaha se buy kare'), true);
  assert.equal(isUnorderedInquiry('app download nahi ho raha'), true);
  assert.equal(isUnorderedInquiry('paise mang raha hai'), true);
  assert.equal(isUnorderedInquiry('address kaise daale'), true);

  // Hindi (Devanagari) inquiries
  assert.equal(isUnorderedInquiry('ऑर्डर कैसे करें'), true);
  assert.equal(isUnorderedInquiry('प्रोसेस क्या है'), true);
  assert.equal(isUnorderedInquiry('ऑर्डर नहीं हुआ'), true);
  assert.equal(isUnorderedInquiry('ऐप डाउनलोड नहीं हो रहा'), true);
  assert.equal(isUnorderedInquiry('कैसे खरीदें'), true);
  assert.equal(isUnorderedInquiry('पैसे मांग रहा है'), true);

  // Punjabi (Roman) inquiries
  assert.equal(isUnorderedInquiry('kive buy kariye'), true);
  assert.equal(isUnorderedInquiry('kiddan order karna'), true);
  assert.equal(isUnorderedInquiry('process ki hai'), true);
  assert.equal(isUnorderedInquiry('order ni hoya'), true);
  assert.equal(isUnorderedInquiry('tareeka dasso'), true);
  assert.equal(isUnorderedInquiry('kive khareediye'), true);
  assert.equal(isUnorderedInquiry('kittho milega'), true);

  // Punjabi (Gurmukhi) inquiries
  assert.equal(isUnorderedInquiry('ਕਿਵੇਂ ਖਰੀਦੀਏ'), true);
  assert.equal(isUnorderedInquiry('ਕਿਵੇਂ ਆਰਡਰ ਕਰਨਾ'), true);
  assert.equal(isUnorderedInquiry('ਪ੍ਰੋਸੈਸ ਕੀ ਹੈ'), true);
  assert.equal(isUnorderedInquiry('ਆਰਡਰ ਨਹੀਂ ਹੋਇਆ'), true);
  assert.equal(isUnorderedInquiry('ਲਿੰਕ ਭੇਜੋ'), true);

  // Negative cases (casual / delivery / tracking queries should remain silent)
  assert.equal(isUnorderedInquiry('ok'), false);
  assert.equal(isUnorderedInquiry('thanks'), false);
  assert.equal(isUnorderedInquiry('thank you'), false);
  assert.equal(isUnorderedInquiry('done'), false);
  assert.equal(isUnorderedInquiry('thik hai'), false);
  assert.equal(isUnorderedInquiry('haan'), false);
  assert.equal(isUnorderedInquiry('when will delivery come'), false);
  assert.equal(isUnorderedInquiry('kab tak aayega'), false);
  assert.equal(isUnorderedInquiry('ਠੀਕ ਹੈ'), false);
  assert.equal(isUnorderedInquiry('ਧੰਨਵਾਦ'), false);
  assert.equal(isUnorderedInquiry('डिलीवरी कब होगी'), false);
});
