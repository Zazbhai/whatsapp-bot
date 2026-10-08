# New features

## Setup (.env)

```
# Telegram bot that receives APK updates (create it with @BotFather)
TELEGRAM_BOT_TOKEN=123456:ABC...
# Telegram user IDs allowed to upload APKs (send /id to your bot to see yours)
TELEGRAM_ADMIN_IDS=111111111,222222222
# Optional: only update these bots (comma separated slugs). Default: all bots
TELEGRAM_APK_INSTANCES=
# Public address of this server, used in the download link sent on WhatsApp
PUBLIC_URL=https://your-domain.com
# Optional: allow the old "upload APK in a WhatsApp group" behaviour again
ALLOW_WHATSAPP_APK_UPLOAD=false
```

## What changed

1. **Phone-number login, unlimited sessions** – Sessions page: add any number of phone numbers. Each gets an 8-character pairing code (WhatsApp → Linked devices → Link with phone number instead). QR codes are no longer used.
2. **APK from Telegram** – Send an `.apk` to your Telegram bot. Caption format: `v2.4 Bug fixes` (optionally `@bot-slug v2.4 ...` to target one bot). Telegram bots can only download files up to 20 MB; bigger files can be uploaded on the APK & Store page.
3. **Play Store page** – `https://<PUBLIC_URL>/app/<bot-slug>` (or `/app` for the first bot). Edit name, icon, screenshots and texts on the APK & Store page.
4. **APK + link** – Every APK the bot sends on WhatsApp now carries a message with the store page link (editable, `{link}` placeholder).
5. **Auto failover** – Numbers are listed in priority order. When the active number logs out, the next linked number starts automatically. Backup numbers are linked in the background and kept on standby.
6. **Watch words** – Flagged Chats page: add words. Matching messages are saved with a screenshot of the chat; search, view, export CSV, delete.

Also: new light theme (`public/light-theme.css`).

New code lives in `features.js` (server) and `public/features.js` (dashboard); `server.js` only has small hooks into it.

## Add sessions from Telegram + redeem codes

Anyone can link a WhatsApp number to the bot from Telegram (private chat with your bot):

| Command | Who | What it does |
|---|---|---|
| `/addsession` | anyone | Asks for a WhatsApp number, replies with the 8-character login code. When login succeeds the user gets a redeem code like `RDM-7KQ2M9XA`. |
| `/mycodes` | anyone | Shows that user's own redeem codes |
| `/codes` (`/codes unused`, `/codes used`) | admins | Lists all stored redeem codes with number, Telegram user and date |
| `/findcode <code / number / tg id>` | admins | Looks up a code |
| `/used <code>` / `/unused <code>` | admins | Marks a code as redeemed or not |

Admins (TELEGRAM_ADMIN_IDS) also get a message every time a new code is issued.
Codes are stored per bot in `instances.json` (`redeemCodes`) and are available at `GET /api/redeem-codes`.
Optional `.env`: `TELEGRAM_SESSION_BOT=<bot slug>` — which bot new sessions are added to (default: the first bot).
