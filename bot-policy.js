'use strict';

const HINGLISH_WORDS = new Set([
  'aap', 'apka', 'apki', 'batao', 'bhejo', 'chahiye', 'dedo', 'diya', 'gaya', 'gayi',
  'hai', 'haan', 'han', 'ho', 'hua', 'ka', 'kaise', 'kar', 'karo', 'karke', 'kya',
  'mein', 'mujhe', 'nahi', 'nhi', 'order', 'par', 'please', 'raha', 'rahi', 'send',
  'ya', 'karna', 'karein', 'milega', 'chahiye', 'karo'
]);

function detectLanguage(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return 'en';
  if (/[\u0900-\u097f]/.test(value)) return 'hi';
  const words = value.match(/[a-z]+/g) || [];
  if (words.some(word => HINGLISH_WORDS.has(word))) return 'hinglish';
  return 'en';
}

function isGreetingOnly(text) {
  const value = String(text || '').toLowerCase().normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return /^(?:(?:hi|hello|hey|namaste|नमस्ते)(?:\s+(?:kaise ho|how are you|कैसे हो|कैसे हैं))?|(?:kaise ho|how are you|कैसे हो|कैसे हैं))$/i.test(value);
}

function greetingReply(language) {
  if (language === 'hinglish') return 'Hi! Main app download, install, aur iPhone order ke steps mein help karta hoon. Aapko kis step mein help chahiye?';
  if (language === 'hi') return 'नमस्ते! मैं ऐप डाउनलोड, इंस्टॉल और iPhone ऑर्डर के steps में मदद कर सकता हूँ। आपको किस step में मदद चाहिए?';
  return 'Hello! I can help with downloading and installing the app, or with the iPhone order steps. What do you need help with?';
}

function isInstallOnlyConfirmation(text) {
  const value = String(text || '').toLowerCase();
  const install = /\b(installed|install ho gaya|install kar liya|app lag gaya|download kar liya|downloaded)\b|(?:इंस्टॉल|डाउनलोड कर लिया|ऐप install)/i.test(value);
  const positiveOrder = /\b(order|purchase|checkout)\b.{0,35}\b(placed|done|confirmed|complete|completed|success|successfully|ho gaya|kar diya)\b|\b(placed|ordered|confirmed|completed)\b|\b(order ho gaya|order kar diya|order place kar diya)\b|(?:ऑर्डर.{0,20}(हो गया|कर दिया|पक्का))/i.test(value);
  return install && !positiveOrder;
}

function isExplicitOrderConfirmation(text) {
  const value = String(text || '').toLowerCase();
  if (/\b(not|nahi|nhi|didn't|did not|abhi nahi)\b|(?:नहीं|नही)/i.test(value)) return false;
  return /^(yes|yep|yeah|haan|han|ji|हो गया|हाँ|हां)[.!\s]*$/i.test(value) || /\b(order|purchase|checkout)\b.{0,35}\b(placed|done|confirmed|complete|completed|success|successfully|ho gaya|kar diya)\b|\b(placed|ordered|confirmed|completed|successfully ordered)\b|\b(order ho gaya|order kar diya|order place kar diya|haan order|yes order)\b|(?:ऑर्डर.{0,20}(हो गया|कर दिया|पक्का)|आर्डर.{0,20}(हो गया|कर दिया))/i.test(value);
}

module.exports = { detectLanguage, isGreetingOnly, greetingReply, isInstallOnlyConfirmation, isExplicitOrderConfirmation };
