'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ORDER_OR_APP_CONTEXT = /\b(app|apk|download|install|iphone|order|purchase|claim|offer|store)\b|(?:ऐप|डाउनलोड|इंस्टॉल|ऑर्डर|आर्डर|खरीद|आईफोन|ऑफर|दुकान)/i;

function isEligibleFollowup({ direct = false, text = '', storeUrl = '' } = {}) {
  return Boolean(direct && typeof text === 'string' && text.trim() &&
    ((storeUrl && text.includes(storeUrl)) || ORDER_OR_APP_CONTEXT.test(text)));
}

class ReadFollowupScheduler {
  constructor({ dataDir, delayMs = 5 * 60 * 1000, maxDelayMs = 24 * 60 * 60 * 1000, cooldownMs = 24 * 60 * 60 * 1000, maxReminders = 3, setTimer = setTimeout, clearTimer = clearTimeout, onDue = async () => {}, onLimitReached = async () => {}, canSend = () => true, now = Date.now }) {
    this.dataDir = dataDir;
    this.delayMs = Math.max(1000, Math.min(Number(delayMs) || 5 * 60 * 1000, maxDelayMs));
    this.cooldownMs = cooldownMs;
    this.maxReminders = Math.max(1, Number(maxReminders) || 3);
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onDue = onDue;
    this.onLimitReached = onLimitReached;
    this.canSend = canSend;
    this.now = now;
    this.instances = new Map();
    this.timers = new Map();
    this.restore();
  }

  file(slug) { return path.join(this.dataDir, `read_followups_${slug}.json`); }

  state(slug) {
    if (!this.instances.has(slug)) this.instances.set(slug, { pending: {}, lastSentByUser: {}, reminderCountByUser: {} });
    return this.instances.get(slug);
  }

  persist(slug) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.file(slug), JSON.stringify(this.state(slug), null, 2), 'utf8');
  }

  restore() {
    if (!fs.existsSync(this.dataDir)) return;
    for (const name of fs.readdirSync(this.dataDir)) {
      const match = /^read_followups_([a-z0-9_-]+)\.json$/.exec(name);
      if (!match) continue;
      try {
        const saved = JSON.parse(fs.readFileSync(path.join(this.dataDir, name), 'utf8'));
        this.instances.set(match[1], { pending: saved.pending || {}, lastSentByUser: saved.lastSentByUser || {}, reminderCountByUser: saved.reminderCountByUser || {} });
        for (const [messageId, entry] of Object.entries(saved.pending || {})) {
          if (entry.readAt && !entry.cancelled && !entry.sentAt) this.schedule(match[1], messageId, Math.max(0, entry.dueAt - this.now()));
        }
      } catch {}
    }
  }

  track({ slug, sender, chatId, messageId, text, direct, storeUrl, userLanguage }) {
    if (!messageId || !sender || !isEligibleFollowup({ direct, text, storeUrl })) return false;
    const state = this.state(slug);
    if ((state.reminderCountByUser[sender] || 0) >= this.maxReminders) return false;
    if ((state.lastSentByUser[sender] || 0) > this.now()) return false;
    if (state.lastSentByUser[sender] && this.now() - state.lastSentByUser[sender] < this.cooldownMs) return false;
    if (Object.values(state.pending).some(entry => entry.sender === sender && !entry.cancelled && !entry.sentAt)) return false;
    state.pending[messageId] = { sender, chatId, userLanguage: userLanguage || '', createdAt: this.now(), readAt: null, dueAt: null, cancelled: false, sentAt: null };
    this.persist(slug);
    return true;
  }

  read(slug, messageId) {
    const state = this.state(slug);
    const entry = state.pending[messageId];
    if (!entry || entry.cancelled || entry.sentAt) return false;
    if (!entry.readAt) {
      entry.readAt = this.now();
      entry.dueAt = entry.readAt + this.delayMs;
      this.persist(slug);
    }
    this.schedule(slug, messageId, Math.max(0, entry.dueAt - this.now()));
    return true;
  }

  isPending(slug, messageId) {
    const entry = this.state(slug).pending[messageId];
    return Boolean(entry && !entry.cancelled && !entry.sentAt);
  }

  schedule(slug, messageId, delay) {
    if (this.timers.has(messageId)) return;
    const timer = this.setTimer(async () => {
      this.timers.delete(messageId);
      const state = this.state(slug);
      const entry = state.pending[messageId];
      if (!entry || entry.cancelled || entry.sentAt) return;
      let allowed = false;
      try { allowed = await this.canSend(slug, entry); } catch {}
      if (!allowed || entry.cancelled || entry.sentAt) {
        entry.cancelled = true;
        this.persist(slug);
        return;
      }
      // Reserve immediately before the async send to prevent parallel ACK timers
      // for this sender from racing through the cooldown check.
      if ((state.lastSentByUser[entry.sender] || 0) > this.now() ||
          (state.lastSentByUser[entry.sender] && this.now() - state.lastSentByUser[entry.sender] < this.cooldownMs)) {
        entry.cancelled = true;
        this.persist(slug);
        return;
      }
      const previousReservation = state.lastSentByUser[entry.sender] || 0;
      state.lastSentByUser[entry.sender] = this.now();
      try {
        await this.onDue(slug, { ...entry, messageId });
        entry.sentAt = this.now();
        state.lastSentByUser[entry.sender] = entry.sentAt;
        state.reminderCountByUser[entry.sender] = (state.reminderCountByUser[entry.sender] || 0) + 1;
        if (state.reminderCountByUser[entry.sender] >= this.maxReminders) {
          try { await this.onLimitReached(slug, { ...entry, reminderCount: state.reminderCountByUser[entry.sender] }); } catch {}
        }
      } catch {
        entry.cancelled = true;
        if (state.lastSentByUser[entry.sender] <= this.now()) {
          if (previousReservation) state.lastSentByUser[entry.sender] = previousReservation;
          else delete state.lastSentByUser[entry.sender];
        }
      }
      this.persist(slug);
    }, Math.max(0, delay));
    if (timer && typeof timer.unref === 'function') timer.unref();
    this.timers.set(messageId, timer);
  }

  cancelForUser(slug, sender, { optOut = false } = {}) {
    const state = this.state(slug);
    let changed = false;
    for (const [messageId, entry] of Object.entries(state.pending)) {
      if (entry.sender !== sender || entry.sentAt || entry.cancelled) continue;
      entry.cancelled = true;
      if (this.timers.has(messageId)) {
        this.clearTimer(this.timers.get(messageId));
        this.timers.delete(messageId);
      }
      changed = true;
    }
    if (optOut) state.lastSentByUser[sender] = this.now() + this.cooldownMs * 365;
    if (changed || optOut) this.persist(slug);
  }

  resetReminderCount(slug, sender) {
    const state = this.state(slug);
    if (!state.reminderCountByUser[sender]) return;
    delete state.reminderCountByUser[sender];
    this.persist(slug);
  }

  markCompleted(slug, sender) { this.cancelForUser(slug, sender, { optOut: true }); }

  updateDelay(delayMs) {
    this.delayMs = Math.max(1000, Math.min(Number(delayMs) || 5 * 60 * 1000, 24 * 60 * 60 * 1000));
  }

  close() {
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
  }
}

module.exports = { ReadFollowupScheduler, isEligibleFollowup };
