import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = path.join(PROJECT_ROOT, 'store', 'claudeclaw.db');

export const description = 'Add chat_id to mission_tasks so the scheduler can route results without env fallback';

export async function run(): Promise<void> {
  const db = new Database(DB_PATH);
  try {
    db.pragma('busy_timeout = 5000');
    const cols = db.prepare(`PRAGMA table_info(mission_tasks)`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'chat_id')) return;
    try {
      db.exec(`ALTER TABLE mission_tasks ADD COLUMN chat_id TEXT NOT NULL DEFAULT ''`);
    } catch (err: any) {
      if (/duplicate column/i.test(err?.message ?? '')) return;
      throw err;
    }
  } finally {
    db.close();
  }
}

export async function rollback(): Promise<void> {
  // SQLite DROP COLUMN: see note in 003. Restore from the
  // pre-migration snapshot instead.
}
