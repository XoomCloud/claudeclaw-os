import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = path.join(PROJECT_ROOT, 'store', 'claudeclaw.db');

export const description = 'Backfill user_id on every per-chat row to the auto-promoted owner';

const TABLES_WITH_USER_ID = [
  'sessions',
  'memories',
  'consolidations',
  'scheduled_tasks',
  'mission_tasks',
  'conversation_log',
  'token_usage',
  'wa_message_map',
  'wa_outbox',
  'wa_messages',
  'slack_messages',
] as const;

export async function run(): Promise<void> {
  const db = new Database(DB_PATH);
  try {
    db.pragma('busy_timeout = 5000');

    const owner = db
      .prepare(`SELECT id FROM users WHERE role = 'owner' ORDER BY id ASC LIMIT 1`)
      .get() as { id: number } | undefined;

    if (!owner) {
      // No owner — fresh install path from 002. Nothing to backfill.
      return;
    }

    const txn = db.transaction(() => {
      for (const table of TABLES_WITH_USER_ID) {
        db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`).run(owner.id);
      }
      db.prepare(
        `UPDATE hive_mind SET actor_user_id = ? WHERE actor_user_id IS NULL`,
      ).run(owner.id);
      db.prepare(
        `UPDATE audit_log SET actor_user_id = ? WHERE actor_user_id IS NULL`,
      ).run(owner.id);
    });
    txn();
  } finally {
    db.close();
  }
}

export async function rollback(): Promise<void> {
  // Backfill is destructive in the sense that we can't tell which rows
  // were originally NULL vs explicitly assigned to the owner. To revert,
  // restore from store/claudeclaw.db.pre-0.1.0.bak.
}
