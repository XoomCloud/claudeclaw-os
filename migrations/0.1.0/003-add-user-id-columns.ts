import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = path.join(PROJECT_ROOT, 'store', 'claudeclaw.db');

export const description = 'Add user_id (and actor/target) columns to existing per-chat tables';

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  typeAndDefault: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeAndDefault}`);
  } catch (err: any) {
    if (/duplicate column/i.test(err?.message ?? '')) return;
    throw err;
  }
}

export async function run(): Promise<void> {
  const db = new Database(DB_PATH);
  try {
    db.pragma('busy_timeout = 5000');

    // Per-chat owner column on every table that today implicitly
    // belongs to "the one user." Nullable — backfill happens in 004.
    addColumnIfMissing(db, 'sessions',          'user_id', 'INTEGER REFERENCES users(id)');
    addColumnIfMissing(db, 'memories',          'user_id', 'INTEGER REFERENCES users(id)');
    addColumnIfMissing(db, 'consolidations',    'user_id', 'INTEGER REFERENCES users(id)');
    addColumnIfMissing(db, 'scheduled_tasks',   'user_id', 'INTEGER REFERENCES users(id)');
    addColumnIfMissing(db, 'mission_tasks',     'user_id', 'INTEGER REFERENCES users(id)');
    addColumnIfMissing(db, 'conversation_log',  'user_id', 'INTEGER REFERENCES users(id)');
    addColumnIfMissing(db, 'token_usage',       'user_id', 'INTEGER REFERENCES users(id)');
    addColumnIfMissing(db, 'wa_message_map',    'user_id', 'INTEGER REFERENCES users(id)');
    addColumnIfMissing(db, 'wa_outbox',         'user_id', 'INTEGER REFERENCES users(id)');
    addColumnIfMissing(db, 'wa_messages',       'user_id', 'INTEGER REFERENCES users(id)');
    addColumnIfMissing(db, 'slack_messages',    'user_id', 'INTEGER REFERENCES users(id)');

    // Actor/target attribution on cross-cutting tables.
    addColumnIfMissing(db, 'hive_mind', 'actor_user_id',  'INTEGER REFERENCES users(id)');
    addColumnIfMissing(db, 'audit_log', 'actor_user_id',  'INTEGER REFERENCES users(id)');
    addColumnIfMissing(db, 'audit_log', 'target_user_id', 'INTEGER REFERENCES users(id)');

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_user      ON memories(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sched_user         ON scheduled_tasks(user_id, status, next_run);
      CREATE INDEX IF NOT EXISTS idx_missions_user      ON mission_tasks(user_id, status, priority DESC, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_convo_user         ON conversation_log(user_id, agent_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_token_usage_user   ON token_usage(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_hive_actor         ON hive_mind(actor_user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_actor        ON audit_log(actor_user_id, created_at DESC);
    `);
  } finally {
    db.close();
  }
}

export async function rollback(): Promise<void> {
  // SQLite doesn't support DROP COLUMN before 3.35 reliably. We leave
  // the columns in place; they're nullable and harmless. To fully
  // revert, restore from store/claudeclaw.db.pre-0.1.0.bak (the
  // automatic pre-migration snapshot).
}
