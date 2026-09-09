#!/usr/bin/env node
/**
 * Context Pack Generator for Mission Control
 * Usage: node context-pack.mjs --ticket-id <id>
 * Output: markdown to stdout
 */
import { execSync } from 'child_process';

const HOME = process.env.HOME || '/Users/inesskogbrynet';
const MC_DB = `${HOME}/mission-control/.data/mission-control.db`;
const VAULT = `${HOME}/.openclaw/workspace/vault`;
const SKILLS = `${HOME}/.openclaw/workspace/skills`;
const MEMORY = `${HOME}/.openclaw/workspace/memory`;

function run(cmd, timeoutMs = 5000) {
  try {
    return execSync(cmd, { timeout: timeoutMs, encoding: 'utf8', cwd: HOME }).trim();
  } catch { return ''; }
}

function rg(pattern, dir, max = 5) {
  const out = run(`rg -l --max-count 1 -i "${pattern}" "${dir}/" 2>/dev/null | head -${max}`);
  return out ? out.split('\n').filter(Boolean) : [];
}

function sql(query) {
  return run(`sqlite3 "${MC_DB}" "${query}" 2>/dev/null`);
}

const ticketId = process.argv.includes('--ticket-id') 
  ? process.argv[process.argv.indexOf('--ticket-id') + 1] : null;

if (!ticketId) { console.error('Usage: context-pack.mjs --ticket-id <id>'); process.exit(1); }

// Get ticket
const ticketRow = sql(`SELECT id, title, description, status, priority, tags, metadata, github_repo, github_issue_number FROM tasks WHERE id = ${Number(ticketId)} LIMIT 1;`);
if (!ticketRow) { console.error(`Ticket ${ticketId} not found`); process.exit(1); }

const [id, title, desc, status, priority, tags, metadataStr, githubRepo, githubIssue] = ticketRow.split('|');
let metadata = {};
try { metadata = JSON.parse(metadataStr || '{}'); } catch {}

// Build search query
const tagList = (() => { try { return JSON.parse(tags || '[]'); } catch { return []; } })();
const searchTerms = [title, ...tagList].filter(Boolean);

const lines = [];
lines.push(`## 📦 Context Pack for ${title}`);
lines.push('');
lines.push('### Ticket');
lines.push(`- **ID:** TASK-${id}`);
lines.push(`- **Prioritet:** ${priority}`);
lines.push(`- **Tags:** ${tags || '[]'}`);
lines.push(`- **Beskrivelse:** ${(desc || '').substring(0, 500)}`);
if (githubRepo) lines.push(`- **GitHub:** ${githubRepo}${githubIssue ? `#${githubIssue}` : ''}`);
lines.push('');

// Previous attempts — find related tickets by tag overlap or title similarity
const tagPattern = tagList.map(t => t.replace(/'/g, "''")).join('|');
let prevQuery = '';
if (tagPattern) {
  prevQuery = `SELECT id, title, status, outcome FROM tasks WHERE id != ${id} AND (tags LIKE '%${tagList[0] || ''}%' OR title LIKE '%${title.substring(0, 20).replace(/'/g, "''")}%') ORDER BY id DESC LIMIT 5;`;
} else {
  prevQuery = `SELECT id, title, status, outcome FROM tasks WHERE id != ${id} AND title LIKE '%${title.substring(0, 20).replace(/'/g, "''")}%' ORDER BY id DESC LIMIT 5;`;
}
const prev = sql(prevQuery);
if (prev) {
  lines.push('### Tidligere forsøk');
  prev.split('\n').forEach(line => {
    const parts = line.split('|');
    if (parts.length >= 2) lines.push(`- **[TASK-${parts[0]}]** ${parts[1]} — ${parts[2] || '?'}`);
  });
  lines.push('');
}

// Vault learnings
const searchPattern = searchTerms.slice(0, 3).map(t => t.replace(/"/g, '').substring(0, 30)).join('|');
const learnings = rg(searchPattern, `${VAULT}/04-resources/learnings`, 5);
if (learnings.length > 0) {
  lines.push('### Relevante learnings');
  learnings.forEach(l => lines.push(`- \`${l.replace(HOME, '~')}\``));
  lines.push('');
}

// Skills
const skills = rg(searchPattern, SKILLS, 3);
if (skills.length > 0) {
  lines.push('### Relevante skills');
  skills.forEach(s => lines.push(`- \`${s.replace(HOME, '~')}\``));
  lines.push('');
}

// Recent memory
const memFiles = run(`ls -t ${MEMORY}/2026-07-*.md 2>/dev/null | head -5`);
if (memFiles) {
  const memMatches = [];
  for (const f of memFiles.split('\n').filter(Boolean).slice(0, 5)) {
    const hit = run(`rg -l -i "${searchTerms.slice(0, 2).join('|').replace(/"/g, '')}" "${f}" 2>/dev/null`);
    if (hit) memMatches.push(f.replace(HOME, '~'));
  }
  if (memMatches.length > 0) {
    lines.push('### Siste memory-notater');
    memMatches.slice(0, 3).forEach(m => lines.push(`- ${m}`));
    lines.push('');
  }
}

// GitHub context
if (githubRepo) {
  const prs = run(`gh pr list --repo ${githubRepo} --state open --json number,title 2>/dev/null`, 8000);
  if (prs) {
    try {
      const prList = JSON.parse(prs);
      if (prList.length > 0) {
        lines.push('### Åpne PRs');
        prList.slice(0, 5).forEach(pr => lines.push(`- #${pr.number} ${pr.title}`));
        lines.push('');
      }
    } catch {}
  }
}

lines.push('---');
lines.push('_Auto-generert av context-pack.mjs — alle tidligere forsøk og learnings bør verifiseres mot faktisk tilstand._');

console.log(lines.join('\n'));
