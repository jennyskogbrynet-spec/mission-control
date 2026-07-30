#!/usr/bin/env node
/**
 * mc-gh-pr.mjs — one-way GitHub → Mission Control PR deep-link.
 *
 * Wraps `gh pr create` for a ticket: creates the PR via gh, then updates the
 * MC task with the PR URL via PUT /api/tasks/:id (metadata is shallow-merged
 * server-side, so workflow_contract etc. are preserved). Also nudges
 * GET /api/tasks/:id/branch so the server backfills the github_pr_number
 * column from GitHub. Never writes from MC back to GitHub.
 *
 * Usage:
 *   mc-gh-pr.mjs --task 123 [--profile default] -- <gh pr create args...>
 *   mc-gh-pr.mjs --task 123 --existing            # link an already-open PR
 *
 * Task id resolution order: --task flag, MC_TASK_ID env, current branch
 * matching feat/<prefix>-<id>-<slug> (the MC branch convention).
 * Auth/URL: --url/--api-key flags, else ~/.mission-control/profiles/<name>.json,
 * else MC_URL/MC_API_KEY env (same resolution as mc-cli.cjs).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const flags = {};
  const ghArgs = [];
  let passthrough = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (passthrough) { ghArgs.push(token); continue; }
    if (token === '--') { passthrough = true; continue; }
    if (token.startsWith('--')) {
      const key = token.slice(2);
      if (['existing', 'dry-run', 'help'].includes(key)) {
        flags[key] = true;
      } else {
        flags[key] = argv[++i];
      }
    } else {
      ghArgs.push(token);
    }
  }
  return { flags, ghArgs };
}

function loadProfile(name) {
  const p = path.join(os.homedir(), '.mission-control', 'profiles', `${name}.json`);
  let parsed = {};
  if (fs.existsSync(p)) {
    try { parsed = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* fall through to env */ }
  }
  return {
    url: parsed.url || process.env.MC_URL || 'http://127.0.0.1:3000',
    apiKey: parsed.apiKey || process.env.MC_API_KEY || '',
    cookie: parsed.cookie || process.env.MC_COOKIE || '',
  };
}

function currentBranch() {
  const res = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

function resolveTaskId(flags) {
  if (flags.task) return { id: parseInt(flags.task, 10), source: '--task' };
  if (process.env.MC_TASK_ID) return { id: parseInt(process.env.MC_TASK_ID, 10), source: 'MC_TASK_ID' };
  const branch = currentBranch();
  const match = branch && branch.match(/^feat\/[a-z0-9]+-(\d+)-/);
  if (match) return { id: parseInt(match[1], 10), source: `branch ${branch}` };
  return { id: NaN, source: null };
}

function runGh(args, { existing }) {
  const ghArgs = existing
    ? ['pr', 'view', '--json', 'url']
    : ['pr', 'create', ...args];
  const res = spawnSync('gh', ghArgs, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  if (res.error) {
    console.error(`mc-gh-pr: failed to run gh: ${res.error.message}`);
    process.exit(1);
  }
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.status !== 0) process.exit(res.status ?? 1);
  const urlMatch = res.stdout.match(/https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/);
  if (!urlMatch) {
    console.error('mc-gh-pr: gh succeeded but no PR URL found in output; MC task not updated');
    process.exit(1);
  }
  return { url: urlMatch[0], repo: urlMatch[1], number: parseInt(urlMatch[2], 10) };
}

async function mcRequest(profile, method, route, body) {
  const headers = { Accept: 'application/json' };
  if (profile.apiKey) headers['x-api-key'] = profile.apiKey;
  if (profile.cookie) headers['Cookie'] = profile.cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const url = `${profile.url.replace(/\/+$/, '')}${route}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

const { flags, ghArgs } = parseArgs(process.argv.slice(2));

if (flags.help) {
  console.log('Usage: mc-gh-pr.mjs --task <id> [--profile <name>] [--url <mc-url>] [--api-key <key>] [--existing] [--dry-run] -- <gh pr create args...>');
  process.exit(0);
}

const { id: taskId, source } = resolveTaskId(flags);
if (!Number.isInteger(taskId) || taskId <= 0) {
  console.error('mc-gh-pr: no task id (use --task <id>, MC_TASK_ID, or a feat/<prefix>-<id>-* branch)');
  process.exit(2);
}

const profile = loadProfile(flags.profile || process.env.MC_PROFILE || 'default');
if (flags.url) profile.url = flags.url;
if (flags['api-key']) profile.apiKey = flags['api-key'];

if (flags['dry-run']) {
  console.log(`mc-gh-pr: would run gh pr ${flags.existing ? 'view' : 'create'} and update task #${taskId} (from ${source}) at ${profile.url}`);
  process.exit(0);
}

const pr = runGh(ghArgs, { existing: flags.existing });

const update = await mcRequest(profile, 'PUT', `/api/tasks/${taskId}`, {
  metadata: {
    github_pr_url: pr.url,
    github_pr_repo: pr.repo,
    github_pr_linked_at: new Date().toISOString(),
  },
});
if (!update.ok) {
  console.error(`mc-gh-pr: PR created (${pr.url}) but MC update failed: HTTP ${update.status} ${JSON.stringify(update.data)}`);
  process.exit(3);
}

// Nudge the server to backfill github_pr_number/github_pr_state columns from
// GitHub (fire-and-forget on the server; needs github_branch set on the task).
const nudge = await mcRequest(profile, 'GET', `/api/tasks/${taskId}/branch`);
if (!nudge.ok) {
  console.error(`mc-gh-pr: warning: branch-status nudge failed (HTTP ${nudge.status}) — PR link saved in metadata regardless`);
}

console.log(`mc-gh-pr: linked ${pr.url} -> MC task #${taskId}`);
