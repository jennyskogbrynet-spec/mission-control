#!/usr/bin/env node
/**
 * Daily Ops Digest — collects system health into a morning briefing
 * Usage: node daily-ops-digest.mjs [--post]
 * Without --post: prints to stdout
 * With --post: sends to Discord via webhook
 */
import { execSync } from 'child_process';

const HOME = process.env.HOME || '/Users/inesskogbrynet';
const MC_DB = `${HOME}/mission-control/.data/mission-control.db`;
const ALERTS_DB = `${HOME}/mission-control/.data/alerts.db`;

function run(cmd, timeoutMs = 10000) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: timeoutMs, cwd: HOME }).trim(); } catch { return ''; }
}

function sql(db, query) {
  return run(`sqlite3 "${db}" "${query}"`);
}

const today = new Date().toLocaleDateString('nb-NO', { day: 'numeric', month: 'long', year: 'numeric' });
const yesterday = Math.floor(Date.now() / 1000) - 86400;

// 1. System status
const ocStatus = run(`HOME=${HOME} openclaw status 2>/dev/null | head -20`);
const agentsOK = ocStatus.includes('running') ? '✅' : '⚠️';
const sessionCount = (ocStatus.match(/sessions (\d+)/) || [])[1] || '?';

// 2. Disk
const diskInfo = run(`df -h /System/Volumes/Data 2>/dev/null | tail -1`);
const diskParts = diskInfo.split(/\s+/);
const diskAvail = diskParts[3] || '?';
const diskPct = diskParts[4] || '?';
const diskStatus = parseInt(diskPct) > 90 ? '🔴' : parseInt(diskPct) > 80 ? '🟡' : '✅';

// 3. MC Tickets
const newTickets = sql(MC_DB, `SELECT COUNT(*) FROM tasks WHERE created_at >= ${yesterday};`);
const doneTickets = sql(MC_DB, `SELECT COUNT(*) FROM tasks WHERE status='done' AND updated_at >= ${yesterday};`);
const openTickets = sql(MC_DB, `SELECT COUNT(*) FROM tasks WHERE status NOT IN ('done');`);
const inboxTickets = sql(MC_DB, `SELECT COUNT(*) FROM tasks WHERE status='inbox';`);

// 4. Cron health (last 24h)
const cronFailCount = run(`HOME=${HOME} openclaw cron runs --limit 100 --json 2>/dev/null | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  runs = d if isinstance(d,list) else d.get('runs',[])
  fails = [r for r in runs if r.get('status')=='failed' or r.get('error')]
  print(len(fails))
except: print('?')
" 2>/dev/null`) || '?';

// 5. Vault learnings (last 24h)
const newLearnings = run(`find ${HOME}/.openclaw/workspace/vault/04-resources/learnings/ -name "*.md" -mtime -1 2>/dev/null | wc -l`).trim();

// 6. GitHub PRs
const babysentialPRs = run(`gh pr list --repo jennyskogbrynet-spec/babysential --state open --json number,title 2>/dev/null`, 8000);
let prList = [];
try { prList = JSON.parse(babysentialPRs || '[]'); } catch {}

// 7. Babysential health
const babysentialHealth = run(`curl -s -o /dev/null -w '%{http_code}' https://babysential.com/api/health 2>/dev/null`, 10000);
const babyStatus = babysentialHealth === '200' ? '✅' : '⚠️';

// 8. Active alerts
let activeAlerts = '0';
try {
  const alerts = run(`sqlite3 "${ALERTS_DB}" "SELECT COUNT(*) FROM alerts WHERE state != 'resolved';" 2>/dev/null`);
  activeAlerts = alerts || '0';
} catch {}

// Build digest
const lines = [];
lines.push(`☀️ **Daglig Ops Digest — ${today}**`);
lines.push('');
lines.push(`**System:** ${agentsOK} Agenter OK | ${sessionCount} sessions | Disk: ${diskAvail} ledig (${diskPct} brukt) ${diskStatus}`);
lines.push(`**Babysential:** ${babyStatus} Live (HTTP ${babysentialHealth}) | ${prList.length} åpne PRs`);
lines.push(`**Tickets:** ${newTickets} nye i går | ${doneTickets} ferdige | ${openTickets} åpne (${inboxTickets} i inbox)`);
lines.push('');
lines.push(`📊 **Vault:** ${newLearnings} nye learnings siste 24t`);
lines.push(`🔄 **Cron:** ${cronFailCount} feil siste kjøringer`);
lines.push(`🚨 **Aktive alarmer:** ${activeAlerts}`);

if (prList.length > 0) {
  lines.push('');
  lines.push('🔗 **Åpne PRs:**');
  prList.slice(0, 5).forEach(pr => lines.push(`- #${pr.number} ${pr.title}`));
}

// Warnings
const warnings = [];
if (parseInt(diskPct) > 90) warnings.push(`Disk ${diskPct} brukt — over 90% terskel`);
if (cronFailCount !== '?' && parseInt(cronFailCount) > 3) warnings.push(`${cronFailCount} cron-feil — sjekk logger`);
if (parseInt(inboxTickets) > 10) warnings.push(`${inboxTickets} tickets i inbox — trenger triage`);

if (warnings.length > 0) {
  lines.push('');
  lines.push('⚠️ **Oppmerksomhet:**');
  warnings.forEach(w => lines.push(`- ${w}`));
}

// Recommendations
lines.push('');
lines.push('🎯 **Anbefalt fokus:**');
if (prList.length > 0) lines.push(`1. Review ${prList.length} åpne PRs`);
if (parseInt(inboxTickets) > 0) lines.push(`2. Triage ${inboxTickets} tickets i inbox`);
if (warnings.length > 0) lines.push(`3. Løs ${warnings.length} advarsler over`);
lines.push('');
lines.push('_Generert av Ines • Full rapport i vault_');

const digest = lines.join('\n');

if (process.argv.includes('--post')) {
  const webhook = run(`grep DISCORD_WEBHOOK_MC ~/.openclaw/.env 2>/dev/null | head -1 | cut -d= -f2-`);
  if (webhook) {
    const payload = JSON.stringify({ content: digest });
    const result = run(`curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '${payload.replace(/'/g, "'\\''")}' "${webhook}"`);
    console.log(`Digest posted to Discord: HTTP ${result}`);
  } else {
    console.log('No webhook found — printing only');
    console.log(digest);
  }
} else {
  console.log(digest);
}
