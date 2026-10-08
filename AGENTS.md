# Architecture rules
- Keep the original Express/whatsapp-web.js engine on the owner's PC/VPS; session pairing needs a persistent Chromium process.
- Telegram uses the existing long-polling handler in features.js; add button callbacks to the same handler so commands and buttons share authorization and session logic.
- Keep Telegram presentation helpers in telegram-ui.js, separate from network/session operations, so ownership and admin callback guards can be tested without live credentials.
