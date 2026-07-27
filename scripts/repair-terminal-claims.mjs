#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const dbPath = path.resolve(process.env.MISSION_CONTROL_DB_PATH || path.join(projectRoot, ".data", "mission-control.db"));
const apply = process.argv.includes("--apply");
const limit = Math.max(1, Number(process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1] || 20));

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(2);
}

const db = new Database(dbPath);
const candidates = db
  .prepare(
    `
    SELECT id, title, status, claim_state, claimed_by, claimed_at
    FROM tasks
    WHERE status IN ('done', 'failed', 'wontfix')
      AND claim_state IN ('Claimed', 'Running')
    ORDER BY id ASC
    `,
  )
  .all();

console.log(`terminal_claim_candidates=${candidates.length}`);
for (const task of candidates.slice(0, limit)) {
  console.log(
    `- #${task.id} [${task.status}/${task.claim_state}] claimed_by=${task.claimed_by || "-"} title=${String(task.title || "").slice(0, 140)}`,
  );
}
if (candidates.length > limit) console.log(`- ... ${candidates.length - limit} more`);

if (!apply) {
  console.log("mode=dry-run");
  db.close();
  process.exit(candidates.length > 0 ? 1 : 0);
}

const backupDir = path.join(path.dirname(dbPath), "backups");
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const backupPath = path.join(backupDir, `mission-control-pre-terminal-claim-repair-${stamp}.db`);
await db.backup(backupPath);

const result = db
  .prepare(
    `
    UPDATE tasks
    SET claim_state = 'Released',
        claimed_by = NULL,
        claimed_at = NULL,
        updated_at = unixepoch()
    WHERE status IN ('done', 'failed', 'wontfix')
      AND claim_state IN ('Claimed', 'Running')
    `,
  )
  .run();

console.log(`mode=apply`);
console.log(`updated=${result.changes}`);
console.log(`backup=${backupPath}`);
db.close();
