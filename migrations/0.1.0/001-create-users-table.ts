import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = path.join(PROJECT_ROOT, 'store', 'claudeclaw.db');

export const description = 'Create the users table (multi-user identity, role, status)';

export async function run(): Promise<void> {
  const db = new Database(DB_PATH);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        platform            TEXT NOT NULL DEFAULT 'telegram'
                            CHECK (platform IN ('telegram','discord')),
        platform_user_id    TEXT NOT NULL,
        platform_username   TEXT,
        display_name        TEXT NOT NULL,
        role                TEXT NOT NULL
                            CHECK (role IN ('owner','admin','staff','restricted')),
        status              TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','locked','pending')),
        pin_hash            TEXT,
        idle_lock_minutes   INTEGER,
        dashboard_token     TEXT UNIQUE,
        created_at          INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        created_by          INTEGER REFERENCES users(id),
        last_active_at      INTEGER,
        UNIQUE (platform, platform_user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_users_platform_lookup
        ON users(platform, platform_user_id);
      CREATE INDEX IF NOT EXISTS idx_users_dashboard_token
        ON users(dashboard_token);
    `);
  } finally {
    db.close();
  }
}

export async function rollback(): Promise<void> {
  const db = new Database(DB_PATH);
  try {
    db.exec('DROP TABLE IF EXISTS users;');
  } finally {
    db.close();
  }
}
