import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = path.join(PROJECT_ROOT, 'store', 'claudeclaw.db');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');

export const description = 'Promote ALLOWED_CHAT_ID from .env to the auto-created owner row';

interface EnvBag {
  ALLOWED_CHAT_ID?: string;
  SECURITY_PIN_HASH?: string;
  IDLE_LOCK_MINUTES?: string;
  DASHBOARD_TOKEN?: string;
}

function readEnvFile(): EnvBag {
  if (!fs.existsSync(ENV_PATH)) return {};
  const out: EnvBag = {};
  const lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, rawV] = m;
    let v = rawV;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k === 'ALLOWED_CHAT_ID' || k === 'SECURITY_PIN_HASH' || k === 'IDLE_LOCK_MINUTES' || k === 'DASHBOARD_TOKEN') {
      (out as Record<string, string>)[k] = v;
    }
  }
  return out;
}

export async function run(): Promise<void> {
  const env = readEnvFile();
  const chatId =
    process.env.ALLOWED_CHAT_ID ||
    env.ALLOWED_CHAT_ID ||
    '';

  if (!chatId) {
    // Fresh install path — no existing single-user to promote. The
    // owner will be created interactively via setup wizard or
    // /invite-on-empty-table fallback in the bot.
    return;
  }

  const db = new Database(DB_PATH);
  try {
    db.pragma('busy_timeout = 5000');
    const existing = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    if (existing.c > 0) {
      // Someone already populated the users table. Don't double-promote.
      return;
    }

    const pinHash = process.env.SECURITY_PIN_HASH || env.SECURITY_PIN_HASH || null;
    const idleLockMinutesRaw = process.env.IDLE_LOCK_MINUTES || env.IDLE_LOCK_MINUTES || '';
    const idleLockMinutes = idleLockMinutesRaw ? parseInt(idleLockMinutesRaw, 10) : null;
    const dashboardToken =
      process.env.DASHBOARD_TOKEN ||
      env.DASHBOARD_TOKEN ||
      crypto.randomBytes(32).toString('hex');

    db.prepare(
      `INSERT INTO users
         (platform, platform_user_id, display_name, role, status,
          pin_hash, idle_lock_minutes, dashboard_token, created_by)
       VALUES ('telegram', ?, 'Owner', 'owner', 'active', ?, ?, ?, NULL)`,
    ).run(
      chatId,
      pinHash,
      Number.isFinite(idleLockMinutes) ? idleLockMinutes : null,
      dashboardToken,
    );
  } finally {
    db.close();
  }
}

export async function rollback(): Promise<void> {
  const db = new Database(DB_PATH);
  try {
    // Only delete the auto-created owner. Anything created later
    // (admins, staff) stays — manual cleanup if reverting fully.
    db.prepare(
      `DELETE FROM users WHERE role = 'owner' AND created_by IS NULL AND id = (
         SELECT id FROM users WHERE role = 'owner' ORDER BY id ASC LIMIT 1
       )`,
    ).run();
  } finally {
    db.close();
  }
}
