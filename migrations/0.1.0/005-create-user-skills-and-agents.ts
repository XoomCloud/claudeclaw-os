import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = path.join(PROJECT_ROOT, 'store', 'claudeclaw.db');

export const description = 'Create user_skills and user_agents grant tables';

export async function run(): Promise<void> {
  const db = new Database(DB_PATH);
  try {
    db.pragma('busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_skills (
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        skill_name  TEXT NOT NULL,
        granted_by  INTEGER REFERENCES users(id),
        granted_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        PRIMARY KEY (user_id, skill_name)
      );

      CREATE TABLE IF NOT EXISTS user_agents (
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        agent_id      TEXT NOT NULL,
        can_delegate  INTEGER NOT NULL DEFAULT 1,
        granted_by    INTEGER REFERENCES users(id),
        granted_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        PRIMARY KEY (user_id, agent_id)
      );
    `);
  } finally {
    db.close();
  }
}

export async function rollback(): Promise<void> {
  const db = new Database(DB_PATH);
  try {
    db.exec(`
      DROP TABLE IF EXISTS user_skills;
      DROP TABLE IF EXISTS user_agents;
    `);
  } finally {
    db.close();
  }
}
