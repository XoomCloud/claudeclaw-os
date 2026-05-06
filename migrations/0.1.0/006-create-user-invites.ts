import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = path.join(PROJECT_ROOT, 'store', 'claudeclaw.db');

export const description = 'Create user_invites table for one-time invite tokens';

export async function run(): Promise<void> {
  const db = new Database(DB_PATH);
  try {
    db.pragma('busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_invites (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        token         TEXT NOT NULL UNIQUE,
        invited_by    INTEGER NOT NULL REFERENCES users(id),
        role          TEXT NOT NULL
                      CHECK (role IN ('admin','staff','restricted')),
        display_name  TEXT,
        expires_at    INTEGER NOT NULL,
        redeemed_at   INTEGER,
        redeemed_by   INTEGER REFERENCES users(id),
        created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_invites_token ON user_invites(token);
    `);
  } finally {
    db.close();
  }
}

export async function rollback(): Promise<void> {
  const db = new Database(DB_PATH);
  try {
    db.exec('DROP TABLE IF EXISTS user_invites;');
  } finally {
    db.close();
  }
}
