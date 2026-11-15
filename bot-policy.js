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
  if (/\b(not|nahi|nhi|didn't|did not|abhi nahi|downloaded|download|installed|install)\b|(?:नहीं|नही|डाउनलोड|इंस्टॉल)/i.test(value)) return false;
  return /^(yes|yep|yeah|haan|han|ji|ho gaya|haan kiya|yes i did|हो गया|हाँ|हां)[.!\s]*$/i.test(value) || /\b(order|purchase|checkout)\b.{0,45}\b(placed|done|confirmed|complete|completed|success|successfully|ho gaya|kar diya)\b|\b(placed|ordered|confirmed|completed|successfully ordered)\b|\b(order ho gaya|order kar diya|order place kar diya|haan order|yes order)\b|(?:ऑर्डर.{0,20}(हो गया|कर दिया|पक्का)|आर्डर.{0,20}(हो गया|कर दिया))/i.test(value);
}

function requestedAppAsset(text) {
  const value = String(text || '').toLowerCase();
  if (/\b(send|share|give|need|want|where|get|link|url|apk|download)\b.{0,50}\b(app|application|apk|link|url)\b|\b(app|application|apk|link|url)\b.{0,50}\b(send|share|give|need|want|where|get|download|bhejo|bhej|chahiye|do|dedo|milega)\b|\b(send|share|give|need|want)\s+(it|that)\b/i.test(value)) return true;
  return /ऐप|लिंक|डाउनलोड|apk/i.test(value) && /भेज|चाहिए|दो|दें|कहाँ|कहां/i.test(value);
}

function prepareAppRequestReply(text, userMessage, { storeUrl = '', apkAvailable = false, language = 'en' } = {}) {
  const reply = String(text || '').trim();
  if (!requestedAppAsset(userMessage)) return reply;
  if (apkAvailable) {
    const assetLine = language === 'hinglish'
      ? 'App file attach ki hai; download link APK ke saath hai.'
      : language === 'hi'
        ? 'App file attach की है; download link APK के साथ है।'
        : 'I’ve attached the app file with its download link.';
    const cleaned = reply.replace(/https?:\/\/\S+/gi, '').replace(/\b(sure[,! ]*)?(here (is|are) (the )?(app|apk|download|link)|link (is|attached) below)\b[.! ]*/gi, '').trim();
    return [cleaned, assetLine].filter(Boolean).join('\n');
  }
  if (!storeUrl || reply.includes(storeUrl)) return reply;
  return `${reply || (language === 'hinglish' ? 'Ye raha app ka link:' : language === 'hi' ? 'यह रहा app का link:' : 'Here is the app link:')}\n${storeUrl}`;
}

function isUnorderedInquiry(text) {
  if (!text) return false;
  const clean = String(text).toLowerCase().normalize('NFKC').trim();
  if (!clean) return false;

  // 1. Explicit negative order statements ("didn't order", "order nahi hua", "order ni hoya", "haven't ordered")
  const notOrderedRegex = /(?:\b(haven't|havent|have not|didn't|didnt|did not|not yet|unable to|can't|cant|cannot|fail|failed)\b.{0,30}\b(order|ordered|buy|bought|purchase|purchased|checkout|get)\b|\b(order|buy|purchase)\b.{0,25}\b(not placed|not done|not completed|failed|canceled|cancelled|nahi hua|nhi hua|nahi ho raha|nhi ho raha|ni hoya|ni ho reha|nahi kiya|nhi kiya|ni kita|pending)\b|\b(nahi hua|nhi hua|ni hoya|nahi kiya|nhi kiya|ni kita)\b.{0,20}\b(order|buy)\b|\b(abhi tak nahi|abhi tak nhi|aje tak ni|aje tak nahi)\b|(?:ऑर्डर.*(नहीं हुआ|नहीं हो रहा|नहीं किया|फेल)|आर्डर.*(नहीं हुआ|नहीं हो रहा|नहीं किया|फेल)|नहीं हुआ.*ऑर्डर|ਅਜੇ ਤੱਕ ਨਹੀਂ|ਆਰਡਰ.*(ਨਹੀਂ ਹੋਇਆ|ਨਹੀਂ ਕੀਤਾ|ਨਹੀਂ ਹੋ ਰਿਹਾ)))/i;
  if (notOrderedRegex.test(clean)) return true;

  // 2. Questions asking HOW to buy / order / claim / get
  // English: how to buy, how to order, where to buy, where to order, how to claim, how to get
  // Hinglish: kaise buy kare, order kaise kare, kaise milega, kaha se buy kare, order kaise karein
  // Punjabi: kive buy kariye, kiddan order karna, kive khareediye, kittho milega
  // Hindi: कैसे खरीदें, ऑर्डर कैसे करें, कैसे मिलेगा, कहाँ से ऑर्डर करें
  // Gurmukhi: ਕਿਵੇਂ ਖਰੀਦੀਏ, ਕਿਵੇਂ ਆਰਡਰ ਕਰਨਾ, ਕਿੱਦਾਂ ਆਰਡਰ
  const howToBuyRegex = /(?:\b(how|where)\s+(to|do i|can i|should i)\s+(buy|order|purchase|claim|get|receive|avail|take)\b|\bhow\s+to\s+(place|make)\s+(an?\s+)?order\b|\b(kaise|kaha se|kahan se|kidhar se|kive|kiven|kiwe|kiddan|kida|kidda|kittho|kithe)\s+(buy|order|purchase|khareed[a-z]*|le|lena|lu|loon|laiye|layiye|lau|claim|get|milega|milna|milu|milugi|mildi|hoga|kare|karein|karna|kariye|karie|hunda)\b|\b(order|buy|khareed[a-z]*|claim)\s+(kaise|kaha se|kahan se|kidhar se|kive|kiven|kiwe|kiddan|kida|karu|kare|karein|karna|kariye|karie|hoga|hunda)\b|\b(order|buy|claim)\s+(karna hai|karna chahta|karna chahunda|karni hai|karna paina|karna pau)\b|(?:कैसे (खरीदें|खरीदे|लें|पाएं|मिलेगा|लेना)|(ऑर्डर|आर्डर) कैसे|कैसे मिलेगा|कहाँ से (खरीदें|ऑर्डर|आर्डर|मिलेगा)|किधर से|ਕਿਵੇਂ (ਖਰੀਦੀਏ|ਲੈਣਾ|ਮਿਲੂ|ਮਿਲੇਗਾ)|ਕਿਵੇਂ ਆਰਡਰ|ਕਿੱਦਾਂ ਆਰਡਰ|ਕਿੱਥੋਂ ਮਿਲੇਗਾ))/i;
  if (howToBuyRegex.test(clean)) return true;

  // 3. Questions asking for the PROCESS / STEPS / METHOD
  // English: what is the process, whats the process, what's the process, what are the steps, guide me
  // Hinglish: process kya hai, kya process hai, steps batao, tarika batao
  // Punjabi: process ki hai, ki process hai, tareeka dasso, steps dasso, kive karna dasso
  // Hindi: प्रोसेस क्या है, क्या प्रोसेस है, तरीका बताओ, प्रक्रिया क्या है
  // Gurmukhi: ਪ੍ਰੋਸੈਸ ਕੀ ਹੈ, ਕੀ ਪ੍ਰੋਸੈਸ, ਤਰੀਕਾ ਦੱਸੋ
  const processRegex = /(?:\b(what's|whats|what is|what are)\s+(the\s+)?(process|procedure|method|steps?|way)\b|\bhow\s+does\s+(it|this)\s+work\b|\b(process|procedure|steps?|tarika|tareeka)\s+(kya|ki|batao|bataiye|dasso|samjhao)\b|\b(kya|ki)\s+(process|procedure|steps?|tarika|tareeka)\s+(hai|hunda)\b|\b(guide|batao|bataiye|dasso)\s+(kaise|kive|kiven|kiddan)\b|(?:प्रोसेस क्या है|क्या प्रोसेस|तरीका बताओ|क्या तरीका|प्रक्रिया क्या|ਪ੍ਰੋਸੈਸ ਕੀ ਹੈ|ਕੀ ਪ੍ਰੋਸੈਸ|ਤਰੀਕਾ ਦੱਸੋ|ਕੀ ਤਰੀਕਾ))/i;
  if (processRegex.test(clean)) return true;

  // 4. Inability to download / install / open link / app issues to buy
  const appIssueRegex = /(?:\b(download|install|link|app|apk)\b.{0,25}\b(nahi|nhi|ni|not|failed|unable|can't|cant|cannot)\b.{0,20}\b(ho raha|hunda|opening|working|chal raha|open|khul)\b|\b(nahi|nhi|ni|not)\b.{0,20}\b(download|install|khul|open|chal)\b.{0,20}\b(ho raha|raha|reha|hunda)\b|\b(link|apk|app)\s+(bhejo|dedo|de do|send|share|deyo|kaha hai|kittho)\b.{0,20}\b(order|buy|claim|khareed)?\b|\bwhere\s+is\s+(the\s+)?(app|link|apk)\b|(?:(?:ऐप|एप|लिंक|ਐਪ|ਲਿੰਕ).{0,15}(भेजो|दो|ਦੋ|दें|ਦੇਵੋ|ਭੇਜੋ|ਦੇਓ|ਨਹੀਂ|नहीं))|(?:ऐप डाउनलोड नहीं|डाउनलोड नहीं हो रहा|लिंक नहीं खुल|ऐप नहीं खुल|ਐਪ ਡਾਊਨਲੋਡ ਨਹੀਂ|ਲਿੰਕ ਨਹੀਂ ਖੁੱਲ੍ਹ))/i;
  if (appIssueRegex.test(clean)) return true;

  // 5. Confusion at checkout (payment asking, address problem)
  const checkoutIssueRegex = /(?:\b(paise|payment|money|charges?)\b.{0,25}\b(mang raha|maang raha|mang reha|asking|demand|maange)\b|\b(address|pincode|pin code)\b.{0,25}\b(kaise|kaha|kive|kiddan|daale|bhare|fill|enter)\b|(?:पैसे मांग रहा|पेमेंट मांग रहा|एड्रेस कैसे|ਪੈਸੇ ਮੰਗ ਰਿਹਾ))/i;
  if (checkoutIssueRegex.test(clean)) return true;

  return false;
}

module.exports = { detectLanguage, isGreetingOnly, greetingReply, isInstallOnlyConfirmation, isExplicitOrderConfirmation, requestedAppAsset, prepareAppRequestReply, isUnorderedInquiry };
