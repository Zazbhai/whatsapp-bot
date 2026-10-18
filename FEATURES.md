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

## Add sessions from Telegram + App Coupons

Anyone can link a WhatsApp number to the bot from Telegram (private chat with your bot):

| Command | Who | What it does |
|---|---|---|
| `/addsession` | anyone | Offers two login options: 📷 QR code (sent as a photo to scan, refreshed automatically) or 🔢 pairing code (user sends their number, gets the 8-character code). When connected, users can choose their preferred app coupon (Blinkit, BigBasket, Zepto, Swiggy, etc.). |
| `/mycodes` | anyone | Shows that user's own coupons delivered after keeping the session active for 6 hours |
| `/addcoupon <App> <Code>` | admins | Adds a coupon code for an app (e.g. `Blinkit`, `BigBasket`, `Zepto`, `Swiggy`, etc.) into the pool. No random codes are generated. |
| `/coupons` / `/codes` | admins | Lists coupon inventory (available in pool and delivered to connected sessions) |
| `/findcode <code / app / number / tg id>` | admins | Looks up a coupon by code, app name, phone number, or Telegram ID |

Admins (TELEGRAM_ADMIN_IDS) get notified when sessions connect and when coupons are delivered.
Coupons are stored per bot in `instances.json` (`redeemCodes`) and are available at `GET /api/redeem-codes`.
Optional `.env`: `TELEGRAM_SESSION_BOT=<bot slug>` — which bot new sessions are added to (default: the first bot).
Optional `.env`: `COUPON_DELIVERY_DELAY_MS` — customize the 6-hour delay for testing (default: `21600000` ms = 6 hours).

## Telegram button menus

Send `/start` or `/menu` in a private chat to open the interactive menu:
- **📱 Add session** — enter a number and approve our server as a linked device in WhatsApp. Once connected, choose a preferred app (Blinkit, BigBasket, Zepto, Swiggy, Any).
- **🎁 My coupons** — paginated personal coupons delivered after 6 hours of keeping the session connected.
- **📊 My sessions** — see connection status and countdown to coupon arrival (`⏳ Blinkit Coupon arrives in ~5h`).
- **❓ Help** — pairing explanation and your Telegram ID.
- **👑 Admin panel** — admins get an inventory management menu:
  - **➕ Add coupon**: Select an app (Blinkit, BigBasket, Zepto, Swiggy, Amazon, Flipkart, or custom app) and input the code.
  - **🎁 View coupons**: Inventory view showing status (`🟢 Available in pool` vs `📤 Delivered to +phone (User)`).
  - **🔎 Find coupon**: Search by code, app, phone, or Telegram user ID.
  - **📦 Update APK**: APK upload instructions and dashboard links.

The bot uses bold headings, copyable codes, status emojis and inline buttons. Random coupon generation and used/unused toggles have been removed in favor of clean pool-to-user delivery. Run `node --test telegram-ui.test.js telegram-flow.test.js` to verify the Telegram access rules and button flows without live credentials.

## WhatsApp Auto-Redirect Gateway (Port 3001)

A dedicated web service running on `http://localhost:3001` (configured via `REDIRECT_PORT` in `.env`):
- **Instant Redirect**: When visitors open `http://localhost:3001` (or `http://your-server-ip:3001`), they are automatically redirected (HTTP 302) to `https://wa.me/<active_number>` for the WhatsApp number currently active in the bot.
- **Failover-aware**: If the bot switches or auto-rotates to a backup number, the redirect immediately points to the new active number without browser cache locking.
- **Pre-filled Message Support**: Forward any text message, e.g. `http://localhost:3001/?text=Hello%20Support` -> `https://wa.me/<active_number>?text=Hello%20Support`.
- **Status API**: `GET /api/status` returns `{ ok: true, active: true, phone: "...", url: "https://wa.me/..." }`.
- **Waiting Screen**: If no number is online or linked yet, visitors see a modern real-time connection screen that polls and automatically forwards them the moment a number becomes ready.
