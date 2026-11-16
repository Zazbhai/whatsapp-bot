'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { detectLanguage, isGreetingOnly, greetingReply, prepareAppRequestReply } = require('./bot-policy');

const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').replace(/\r\n/g, '\n');

function createServerContext() {
  const context = {
    console,
    Date,
    Set,
    Array,
    Object,
    String,
    Math,
    features: {
      storeLink: () => 'https://store.example.com',
      apkCaption: (_slug, cap) => cap || 'Default caption'
    },
    detectBotLanguage: detectLanguage
  };
  vm.createContext(context);
  
  // Load DEFAULT_AI_CONFIG and localized tables
  const startCfg = serverSource.indexOf('const DEFAULT_AI_CONFIG =');
  const endCfg = serverSource.indexOf('// Bootstrap default bot instance', startCfg);
  vm.runInContext(serverSource.slice(startCfg, endCfg), context);

  // Load detectUserLanguage, isAmbiguousShortToken, detectUserLanguageFromHistory
  const startDetect = serverSource.indexOf('function detectUserLanguage(text) {');
  const endDetect = serverSource.indexOf('// Helper functions for Hindi TTS', startDetect);
  vm.runInContext(serverSource.slice(startDetect, endDetect), context);

  // Load buildSystemPrompt
  const startPrompt = serverSource.indexOf('function buildSystemPrompt(inst, isRetry');
  const endPrompt = serverSource.indexOf('function detectProcessIntent', startPrompt);
  vm.runInContext('function buildAppLinkInstructions(url) { return "URL: " + url; }\n' + serverSource.slice(startPrompt, endPrompt), context);

  // Load URGENCY_REMINDER_POOLS and getLocalizedUrgencyReminder
  const startReminder = serverSource.indexOf('const URGENCY_REMINDER_POOLS =');
  const endReminder = serverSource.indexOf('function createReadFollowupScheduler', startReminder);
  vm.runInContext(serverSource.slice(startReminder, endReminder), context);

  return context;
}

test('detectUserLanguage accurately identifies Hindi (Devanagari), Punjabi (Gurmukhi & Latin), Hinglish, and English', () => {
  const ctx = createServerContext();

  // 1. Hindi Devanagari
  assert.equal(ctx.detectUserLanguage('नमस्ते, मुझे आईफोन कैसे मिलेगा?'), 'hi');
  assert.equal(ctx.detectUserLanguage('क्या प्रक्रिया है?'), 'hi');
  assert.equal(ctx.detectUserLanguage('ऐप डाउनलोड कैसे करें'), 'hi');
  assert.equal(ctx.detectUserLanguage('ऑर्डर हो गया'), 'hi');

  // 2. Punjabi Gurmukhi & Roman
  assert.equal(ctx.detectUserLanguage('ਕਿਵੇਂ ਆਰਡਰ ਕਰਨਾ ਹੈ?'), 'pa');
  assert.equal(ctx.detectUserLanguage('ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ ਜੀ'), 'pa');
  assert.equal(ctx.detectUserLanguage('kive order karna dasso'), 'pa');
  assert.equal(ctx.detectUserLanguage('kiddan veere'), 'pa');

  // 3. Roman Hinglish
  assert.equal(ctx.detectUserLanguage('bhai iphone kaise milega'), 'hinglish');
  assert.equal(ctx.detectUserLanguage('process kya hai'), 'hinglish');
  assert.equal(ctx.detectUserLanguage('order confirm kaise karein'), 'hinglish');

  // 4. English
  assert.equal(ctx.detectUserLanguage('How do I order the iPhone?'), 'en');
  assert.equal(ctx.detectUserLanguage('What is the delivery time after order?'), 'en');
  assert.equal(ctx.detectUserLanguage('Please send the app download link'), 'en');
});

test('detectUserLanguageFromHistory preserves user language across short tokens (ok, yes, thanks) but honors explicit language switch', () => {
  const ctx = createServerContext();
  let mockHistory = [];
  ctx.getConversationHistory = () => mockHistory;

  // Case 1: Hindi user sending short tokens ("ok", "हाँ", "thanks") remains in Hindi
  mockHistory = [
    { role: 'user', content: 'नमस्ते, मुझे आईफोन चाहिए' },
    { role: 'assistant', content: 'नमस्ते! आप ऐप डाउनलोड करके iPhone क्लेम कर सकते हैं।' }
  ];
  assert.equal(ctx.detectUserLanguageFromHistory('slug', '1234', 'ok'), 'hi');
  assert.equal(ctx.detectUserLanguageFromHistory('slug', '1234', 'yes'), 'hi');
  assert.equal(ctx.detectUserLanguageFromHistory('slug', '1234', 'thanks'), 'hi');

  // Case 2: User explicitly switches to English with a full question
  assert.equal(
    ctx.detectUserLanguageFromHistory('slug', '1234', 'What is the delivery time after order?'),
    'en'
  );

  // Case 3: Hinglish user sending short token "ok" remains in Hinglish
  mockHistory = [
    { role: 'user', content: 'bhai app ka link bhejo' },
    { role: 'assistant', content: 'Ye lijiye link!' }
  ];
  assert.equal(ctx.detectUserLanguageFromHistory('slug', '1234', 'ok'), 'hinglish');
});

test('getLocalizedProcessReply delivers language-specific process steps for Hindi, English, Punjabi, and Hinglish', () => {
  const ctx = createServerContext();
  const inst = { slug: 'primary' };

  // Hindi: Pure Devanagari script
  const hiProcess = ctx.getLocalizedProcessReply(inst, 'hi');
  assert.ok(hiProcess.includes('फ्री iPhone क्लेम करने का आसान तरीका'));
  assert.ok(hiProcess.includes('नीचे दिए गए App (APK) को डाउनलोड और इंस्टॉल करें'));
  assert.ok(/[\u0900-\u097F]/.test(hiProcess));

  // English: Pure English
  const enProcess = ctx.getLocalizedProcessReply(inst, 'en');
  assert.ok(enProcess.includes('Simple Process to Claim Your Free iPhone'));
  assert.ok(enProcess.includes('Download and install the App (APK) given below'));
  assert.ok(!/[\u0900-\u097F]/.test(enProcess));

  // Punjabi: Pure Gurmukhi
  const paProcess = ctx.getLocalizedProcessReply(inst, 'pa');
  assert.ok(paProcess.includes('ਮੁਫ਼ਤ iPhone ਕਲੇਮ ਕਰਨ ਦਾ ਆਸਾਨ ਤਰੀਕਾ'));
  assert.ok(paProcess.includes('ਹੇਠਾਂ ਦਿੱਤੀ ਐਪ (APK) ਨੂੰ ਡਾਊਨਲੋਡ ਅਤੇ ਇੰਸਟਾਲ ਕਰੋ'));
  assert.ok(/[\u0A00-\u0A7F]/.test(paProcess));

  // Hinglish: Roman Hinglish
  const hinglishProcess = ctx.getLocalizedProcessReply(inst, 'hinglish');
  assert.ok(hinglishProcess.includes('Free iPhone Claim Karne Ka Simple Process'));
  assert.ok(hinglishProcess.includes('Niche diye gaye App (APK) ko download aur install karein'));
});

test('getLocalizedApkPreamble delivers localized preambles matching user language', () => {
  const ctx = createServerContext();
  const inst = { slug: 'primary' };

  assert.match(ctx.getLocalizedApkPreamble(inst, 'hi'), /यह रहा ऑफिशियल ऐप/);
  assert.match(ctx.getLocalizedApkPreamble(inst, 'en'), /Here is the official app/);
  assert.match(ctx.getLocalizedApkPreamble(inst, 'pa'), /ਇਹ ਰਹੀ ਔਫੀਸ਼ੀਅਲ ਐਪ/);
  assert.match(ctx.getLocalizedApkPreamble(inst, 'hinglish'), /Ye lijiye official app/);
});

test('buildSystemPrompt enforces strict language mandate without conflicting Hinglish rules for Hindi and English users', () => {
  const ctx = createServerContext();
  const inst = { slug: 'primary' };

  // 1. Hindi mandate
  const hiPrompt = ctx.buildSystemPrompt(inst, false, '', false, 'hi');
  assert.ok(hiPrompt.includes('STRICT LANGUAGE MANDATE (HINDI IN DEVANAGARI)'));
  assert.ok(hiPrompt.includes('The user communicates in Hindi (हिन्दी)'));
  assert.ok(hiPrompt.includes('Devanagari script (हिन्दी लिपि)'));
  assert.ok(!hiPrompt.includes('LANGUAGE STYLE (HINGLISH)'));

  // 2. English mandate
  const enPrompt = ctx.buildSystemPrompt(inst, false, '', false, 'en');
  assert.ok(enPrompt.includes('STRICT LANGUAGE MANDATE (ENGLISH)'));
  assert.ok(enPrompt.includes('The user communicates in English'));
  assert.ok(!enPrompt.includes('LANGUAGE STYLE (HINGLISH)'));

  // 3. Punjabi mandate
  const paPrompt = ctx.buildSystemPrompt(inst, false, '', false, 'pa');
  assert.ok(paPrompt.includes('STRICT LANGUAGE MANDATE (PUNJABI)'));
  assert.ok(!paPrompt.includes('LANGUAGE STYLE (HINGLISH)'));

  // 4. Hinglish style
  const hinglishPrompt = ctx.buildSystemPrompt(inst, false, '', false, 'hinglish');
  assert.ok(hinglishPrompt.includes('LANGUAGE STYLE (HINGLISH)'));
  assert.ok(!hinglishPrompt.includes('STRICT LANGUAGE MANDATE (HINDI IN DEVANAGARI)'));
});

test('greetingReply and prepareAppRequestReply provide Punjabi, Hindi, Hinglish, and English support', () => {
  assert.equal(isGreetingOnly('ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ'), true);
  assert.match(greetingReply('pa'), /ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ/);
  assert.match(greetingReply('hi'), /नमस्ते/);
  assert.match(greetingReply('hinglish'), /Hi! Main app download/);
  assert.match(greetingReply('en'), /Hello! I can help/);

  const paAsset = prepareAppRequestReply('Sure', 'ਐਪ ਭੇਜੋ', { apkAvailable: true, language: 'pa' });
  assert.match(paAsset, /ਐਪ ਫਾਈਲ ਅਟੈਚ ਕੀਤੀ ਹੈ/);

  const hiAsset = prepareAppRequestReply('Sure', 'ऐप भेजें', { apkAvailable: true, language: 'hi' });
  assert.match(hiAsset, /App file attach की है/);
});

test('getLocalizedUrgencyReminder delivers unique urgency messages in user\'s native language across reminder stages', () => {
  const ctx = createServerContext();

  // 1. Hinglish stage progression
  const h1 = ctx.getLocalizedUrgencyReminder('hinglish', 1, '', '9876543210');
  const h2 = ctx.getLocalizedUrgencyReminder('hinglish', 2, '', '9876543210');
  const h3 = ctx.getLocalizedUrgencyReminder('hinglish', 3, '', '9876543210');
  assert.ok(h1.includes('Offer Limited Hai') || h1.includes('Hurry Up') || h1.includes('Order Fast'));
  assert.ok(h2.includes('Aaj Last Date Hai') || h2.includes('Offer Expiring Soon') || h2.includes("Don't Miss Out"));
  assert.ok(h3.includes('Final Reminder') || h3.includes('Last Call') || h3.includes('Order Fast or Expire'));
  assert.notEqual(h1, h2);
  assert.notEqual(h2, h3);

  // 2. Hindi (Devanagari) stage progression
  const hi1 = ctx.getLocalizedUrgencyReminder('hi', 1, 'आज रात 12 बजे', '9876543210');
  const hi2 = ctx.getLocalizedUrgencyReminder('hi', 2, 'आज रात 12 बजे', '9876543210');
  const hi3 = ctx.getLocalizedUrgencyReminder('hi', 3, 'आज रात 12 बजे', '9876543210');
  assert.ok(/[\u0900-\u097F]/.test(hi1));
  assert.ok(/[\u0900-\u097F]/.test(hi2));
  assert.ok(/[\u0900-\u097F]/.test(hi3));
  assert.ok(hi1.includes('ऑफर सीमित है') || hi1.includes('जल्दी करें') || hi1.includes('तुरंत ऑर्डर'));
  assert.ok(hi2.includes('आज आख़िरी तारीख़ है') || hi2.includes('ऑफर जल्द समाप्त') || hi2.includes('मौका न गंवाएं'));
  assert.ok(hi3.includes('अंतिम रिमाइंडर') || hi3.includes('लास्ट कॉल') || hi3.includes('जल्दी ऑर्डर करें वरना ऑफर'));
  assert.ok(hi1.includes('डेडलाइन: आज रात 12 बजे'));
  assert.notEqual(hi1, hi2);
  assert.notEqual(hi2, hi3);

  // 3. English stage progression
  const en1 = ctx.getLocalizedUrgencyReminder('en', 1, 'Tonight 12 PM', '9876543210');
  const en2 = ctx.getLocalizedUrgencyReminder('en', 2, 'Tonight 12 PM', '9876543210');
  const en3 = ctx.getLocalizedUrgencyReminder('en', 3, 'Tonight 12 PM', '9876543210');
  assert.ok(en1.includes('Limited Offer') || en1.includes('Hurry Up') || en1.includes('Order Fast'));
  assert.ok(en2.includes('Today is the Last Date') || en2.includes('Offer Expiring Soon') || en2.includes("Don't Miss Out"));
  assert.ok(en3.includes('Final Reminder') || en3.includes('Last Call') || en3.includes('Order Fast or Offer Expires'));
  assert.ok(en1.includes('Deadline: Tonight 12 PM'));
  assert.notEqual(en1, en2);
  assert.notEqual(en2, en3);

  // 4. Punjabi stage progression
  const pa1 = ctx.getLocalizedUrgencyReminder('pa', 1, 'ਅੱਜ ਰਾਤ', '9876543210');
  const pa2 = ctx.getLocalizedUrgencyReminder('pa', 2, 'ਅੱਜ ਰਾਤ', '9876543210');
  const pa3 = ctx.getLocalizedUrgencyReminder('pa', 3, 'ਅੱਜ ਰਾਤ', '9876543210');
  assert.ok(/[\u0A00-\u0A7F]/.test(pa1));
  assert.ok(/[\u0A00-\u0A7F]/.test(pa2));
  assert.ok(/[\u0A00-\u0A7F]/.test(pa3));
  assert.ok(pa1.includes('ਆਫਰ ਸੀਮਤ ਹੈ') || pa1.includes('ਜਲਦੀ ਕਰੋ') || pa1.includes('ਹੁਣੇ ਆਰਡਰ'));
  assert.ok(pa2.includes('ਅੱਜ ਆਖਰੀ ਤਾਰੀਖ਼ ਹੈ') || pa2.includes('ਆਫਰ ਜਲਦ ਖਤਮ') || pa2.includes('ਮੌਕਾ ਨਾ ਗੁਆਓ'));
  assert.ok(pa3.includes('ਆਖਰੀ ਰਿਮਾਈਂਡਰ') || pa3.includes('ਲਾਸਟ ਕਾਲ') || pa3.includes('ਜਲਦੀ ਆਰਡਰ ਕਰੋ'));
  assert.ok(pa1.includes('ਆਖਰੀ ਸਮਾਂ: ਅੱਜ ਰਾਤ'));
  assert.notEqual(pa1, pa2);
  assert.notEqual(pa2, pa3);
});
