#!/usr/bin/env node
/**
 * Alert Manager — State-machine based alert dedup and state-change detection
 * Usage: 
 *   alert-manager.mjs --key "<source>:<category>:<fingerprint>" --severity <info|warning|critical> --message "<msg>"
 *   alert-manager.mjs --list
 *   alert-manager.mjs --resolve --key "<key>"
 * 
 * State machine: new → acknowledged → warning → critical → resolved
 * Only sends Discord alert on state TRANSITION (not on repeated same-severity)
 */
import { execSync } from 'child_process';

const HOME = process.env.HOME || '/Users/inesskogbrynet';
const ALERTS_DB = `${HOME}/mission-control/.data/alerts.db`;
const DEDUP_WINDOW_MIN = 30; // Don't re-alert same key within 30 min

function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 10000, cwd: HOME }).trim(); } catch { return ''; }
}

function getWebhook() {
  const env = run(`grep DISCORD_WEBHOOK_MC ~/.openclaw/.env 2>/dev/null | head -1 | cut -d= -f2-`);
  return env || '';
}

// Ensure DB exists
run(`sqlite3 "${ALERTS_DB}" "CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_key TEXT UNIQUE NOT NULL,
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  severity TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'new',
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  last_sent INTEGER,
  message TEXT NOT NULL,
  metadata TEXT
);"`);

// Parse args
const args = process.argv.slice(2);
const keyIdx = args.indexOf('--key');
const sevIdx = args.indexOf('--severity');
const msgIdx = args.indexOf('--message');
const isList = args.includes('--list');
const isResolve = args.includes('--resolve');

if (isList) {
  const rows = run(`sqlite3 "${ALERTS_DB}" "SELECT alert_key, severity, state, datetime(last_seen,'unixepoch'), message FROM alerts WHERE state != 'resolved' ORDER BY last_seen DESC LIMIT 20;"`);
  if (rows) {
    rows.split('\n').forEach(r => console.log(r));
  } else {
    console.log('No active alerts');
  }
  process.exit(0);
}

if (isResolve) {
  const key = keyIdx >= 0 ? args[keyIdx + 1] : null;
  if (!key) { console.error('Need --key for resolve'); process.exit(1); }
  run(`sqlite3 "${ALERTS_DB}" "UPDATE alerts SET state='resolved', last_seen=strftime('%s','now') WHERE alert_key='${key.replace(/'/g, "''")}';"`);
  console.log(`Resolved: ${key}`);
  process.exit(0);
}

const key = keyIdx >= 0 ? args[keyIdx + 1] : null;
const severity = sevIdx >= 0 ? args[sevIdx + 1] : 'warning';
const message = msgIdx >= 0 ? args[msgIdx + 1] : 'No message';

if (!key) { console.error('Usage: alert-manager.mjs --key <key> --severity <level> --message <msg>'); process.exit(1); }

// Parse key: source:category:fingerprint
const [source, category, ...fpParts] = key.split(':');
const fingerprint = fpParts.join(':');

const now = Math.floor(Date.now() / 1000);
const keyEsc = key.replace(/'/g, "''");
const msgEsc = message.replace(/'/g, "''");

// Check existing
const existing = run(`sqlite3 "${ALERTS_DB}" "SELECT severity, state, last_sent, last_seen FROM alerts WHERE alert_key='${keyEsc}' LIMIT 1;"`);

let shouldSend = false;
let newState = 'new';

if (!existing) {
  // New alert — always send
  shouldSend = true;
  newState = 'new';
  run(`sqlite3 "${ALERTS_DB}" "INSERT INTO alerts (alert_key, source, category, fingerprint, severity, state, first_seen, last_seen, message) VALUES ('${keyEsc}', '${source}', '${category}', '${fingerprint}', '${severity}', '${newState}', ${now}, ${now}, '${msgEsc}');"`);
} else {
  const [oldSeverity, oldState, lastSent, lastSeen] = existing.split('|');
  const lastSentTs = parseInt(lastSent || '0');
  const withinDedup = (now - lastSentTs) < (DEDUP_WINDOW_MIN * 60);
  
  // Update last_seen
  run(`sqlite3 "${ALERTS_DB}" "UPDATE alerts SET last_seen=${now}, message='${msgEsc}' WHERE alert_key='${keyEsc}';"`);
  
  if (severity !== oldSeverity) {
    // Severity changed — state transition
    const severityOrder = { info: 0, warning: 1, critical: 2 };
    if ((severityOrder[severity] || 0) > (severityOrder[oldSeverity] || 0)) {
      // Escalation
      shouldSend = true;
      newState = severity;
      run(`sqlite3 "${ALERTS_DB}" "UPDATE alerts SET severity='${severity}', state='${severity}' WHERE alert_key='${keyEsc}';"`);
    } else {
      // De-escalation — don't send, just update
      run(`sqlite3 "${ALERTS_DB}" "UPDATE alerts SET severity='${severity}' WHERE alert_key='${keyEsc}';"`);
    }
  } else if (!withinDedup) {
    // Same severity but outside dedup window — re-send (could be a persistent issue)
    shouldSend = true;
    run(`sqlite3 "${ALERTS_DB}" "UPDATE alerts SET state='acknowledged' WHERE alert_key='${keyEsc}';"`);
  }
  // else: same severity, within dedup window → silent
}

if (shouldSend) {
  const webhook = getWebhook();
  if (webhook) {
    const emoji = severity === 'critical' ? '🔴' : severity === 'warning' ? '🟡' : '🔵';
    const payload = JSON.stringify({ content: `${emoji} **[${severity.toUpperCase()}]** ${message}\n\`${key}\`` });
    const result = run(`curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '${payload.replace(/'/g, "'\\''")}'  "${webhook}"`);
    if (result === '204' || result === '200') {
      run(`sqlite3 "${ALERTS_DB}" "UPDATE alerts SET last_sent=${now} WHERE alert_key='${keyEsc}';"`);
      console.log(`Alert sent: [${severity}] ${key}`);
    } else {
      console.error(`Discord send failed: HTTP ${result}`);
    }
  } else {
    console.log(`No webhook configured — alert logged only: [${severity}] ${key}`);
    run(`sqlite3 "${ALERTS_DB}" "UPDATE alerts SET last_sent=${now} WHERE alert_key='${keyEsc}';"`);
  }
} else {
  console.log(`Suppressed (dedup/state unchanged): ${key}`);
}
