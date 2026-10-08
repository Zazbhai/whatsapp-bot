# Architecture rules
- Keep the original Express/whatsapp-web.js engine on the owner's PC/VPS; session pairing needs a persistent Chromium process.
- Telegram uses the existing long-polling handler in features.js; add button callbacks to the same handler so commands and buttons share authorization and session logic.
- Keep Telegram presentation helpers in telegram-ui.js, separate from network/session operations, so ownership and admin callback guards can be tested without live credentials.
- Apply WhatsApp ID compatibility in whatsapp-compat.js (browser LoadUtils and Node structure _patch) before loading Client; keep upstream fixes centralized without modifying installed dependencies.
- Treat both @c.us and @lid senders as private chats via isDirectChatId; WhatsApp now addresses many private chats by LID.
- Keep read receipts outside incoming-message processing and isolate unread-chat scan failures so optional chat operations cannot stop automatic replies.
- Centralize health checks and backup selection in session-health.js; rotate only connection/session failures, avoid duplicate/stale recovery, and preserve authentication on transient errors.
