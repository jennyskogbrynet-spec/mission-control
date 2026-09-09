#!/usr/bin/env node
/**
 * MC PR Link — Creates a GitHub PR and links it to a Mission Control ticket
 * Usage: node mc-pr-link.mjs --ticket <id> --repo <owner/repo> --branch <branch> --title "<pr title>"
 * 
 * This creates the PR via gh CLI and updates the MC ticket with the PR URL.
 * One-way: GitHub → MC (never syncs back).
 */
import { execSync } from 'child_process';

const HOME = process.env.HOME || '/Users/inesskogbrynet';
const MC_DB = `${HOME}/mission-control/.data/mission-control.db`;
const MC_API = 'http://localhost:3001/api';

function run(cmd, timeoutMs = 30000) {
  try {
    return { ok: true, output: execSync(cmd, { encoding: 'utf8', timeout: timeoutMs, cwd: HOME }).trim() };
  } catch (e) {
    return { ok: false, output: e.stdout?.toString().trim() || e.message };
  }
}

function sql(query) {
  const r = run(`sqlite3 "${MC_DB}" "${query}"`);
  return r.ok ? r.output : '';
}

function getApiKey() {
  const r = run(`grep MC_API_KEY ~/.openclaw/.env 2>/dev/null | head -1 | cut -d= -f2-`);
  return r.ok ? r.output : '';
}

// Parse args
const args = process.argv.slice(2);
const getArg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

const ticketId = getArg('--ticket');
const repo = getArg('--repo') || 'jennyskogbrynet-spec/babysential';
const branch = getArg('--branch');
const prTitle = getArg('--title');
const base = getArg('--base') || 'main';

if (!ticketId || !branch || !prTitle) {
  console.error('Usage: mc-pr-link.mjs --ticket <id> --repo <owner/repo> --branch <branch> --title "<title>" [--base main]');
  process.exit(1);
}

// Step 1: Create PR via gh CLI
console.log(`Creating PR in ${repo}: ${branch} → ${base}`);
const prResult = run(`gh pr create --repo ${repo} --head ${branch} --base ${base} --title "${prTitle}" --body "Linked to TASK-${ticketId}" 2>&1`);

if (!prResult.ok) {
  console.error(`Failed to create PR: ${prResult.output}`);
  process.exit(1);
}

const prUrl = prResult.output.split('\n').find(l => l.includes('https://github.com'));
if (!prUrl) {
  console.error(`Could not extract PR URL from: ${prResult.output}`);
  process.exit(1);
}

console.log(`PR created: ${prUrl}`);

// Step 2: Extract PR number from URL
const prNumber = prUrl.split('/').pop();

// Step 3: Update MC ticket
const apiKey = getApiKey();
const now = Math.floor(Date.now() / 1000);

// Update via SQLite directly (more reliable than HTTP API)
const updateResult = run(`sqlite3 "${MC_DB}" "UPDATE tasks SET github_pr_number=${prNumber}, github_pr_state='open', github_branch='${branch}', github_repo='${repo}', updated_at=${now} WHERE id=${ticketId};"`);

if (updateResult.ok) {
  console.log(`✅ MC ticket TASK-${ticketId} updated with PR #${prNumber}`);
  
  // Also store PR URL in metadata
  const existingMeta = sql(`SELECT metadata FROM tasks WHERE id=${ticketId};`);
  let metadata = {};
  try { metadata = JSON.parse(existingMeta || '{}'); } catch {}
  metadata.prUrl = prUrl;
  metadata.prLinkedAt = new Date().toISOString();
  
  const metaEsc = JSON.stringify(metadata).replace(/'/g, "''");
  run(`sqlite3 "${MC_DB}" "UPDATE tasks SET metadata='${metaEsc}' WHERE id=${ticketId};"`);
} else {
  console.error(`⚠️ Could not update MC ticket: ${updateResult.output}`);
}

console.log(`\nPR: ${prUrl}`);
console.log(`Ticket: TASK-${ticketId}`);
