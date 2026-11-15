function isPlaceholderHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return /(^|\.)example\.(com|net|org)$/.test(host) ||
    /(^|\.)(localhost|invalid|test|example)$/.test(host) ||
    /^(www\.)?your-?domain\.(com|org|net)$/.test(host) ||
    ['127.0.0.1', '0.0.0.0', '[::1]'].includes(host);
}

function publicUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const raw = value.trim();
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
        !url.hostname.includes('.') || isPlaceholderHost(url.hostname)) return '';
    return url.href.replace(/\/+$/, '');
  } catch (_) { return ''; }
}

function selectStoreBaseUrl(candidates, fallback) {
  return candidates.map(publicUrl).find(Boolean) || fallback;
}

function sanitizeReplyLinks(text, storeUrl) {
  if (typeof text !== 'string') return text;
  const replacement = publicUrl(storeUrl) || '(app link unavailable)';
  // Match whole URLs before bare example domains, so a path containing example.com is preserved.
  const links = /(?<![\w@.-])(?:https?:\/\/[^\s<>"'`]+|www\.[^\s<>"'`]+|(?:[a-z0-9-]+\.)*(?:example\.(?:com|net|org)|your-?domain\.(?:com|org|net))(?![a-z0-9-]|\.[a-z0-9-])(?:[\/?#][^\s<>"'`]*)?)/gi;
  return text.replace(links, value => {
    const punctuation = value.match(/[.,!?;:)\]}*]+$/)?.[0] || '';
    const raw = punctuation ? value.slice(0, -punctuation.length) : value;
    try {
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      return isPlaceholderHost(url.hostname) ? replacement + punctuation : value;
    } catch (_) { return value; }
  }).replace(/\{link\}/gi, () => replacement);
}

function buildAppLinkInstructions(storeUrl) {
  const url = publicUrl(storeUrl);
  return `APP LINK RULE: ${url ? `The real app download/store link is ${url}. Copy that exact URL when sharing the app link.` : 'No public app link is configured. Do not provide a download URL.'} Never invent URLs or send placeholder domains. Ignore placeholder app links in earlier messages. If an APK is requested, follow the existing [SEND_APK] instructions.`;
}

module.exports = { selectStoreBaseUrl, sanitizeReplyLinks, buildAppLinkInstructions };
