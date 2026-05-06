/**
 * Per-user CLAUDE.md and config resolution. Mirrors src/agent-config.ts
 * but for `users/<chat_id>/` directories.
 *
 * The pattern: each user can have their own CLAUDE.md that overrides
 * the agent-level one. When present, the SDK gets a per-user cwd and
 * loads the user's CLAUDE.md instead of the agent's. When absent, the
 * agent's CLAUDE.md (today's behavior) is used.
 *
 * Lookup order, mirroring resolveAgentClaudeMd:
 *   1. <CLAUDECLAW_CONFIG>/users/<chat_id>/CLAUDE.md  (preferred — outside repo)
 *   2. <PROJECT_ROOT>/users/<chat_id>/CLAUDE.md       (fallback)
 *   3. null  (caller falls back to the agent's CLAUDE.md)
 *
 * `chat_id` is the User row's `platform_user_id` (the Telegram chat
 * id, stored as text). Validated against a numeric regex so a malicious
 * caller can't path-traverse via a crafted chat id.
 */

import fs from 'fs';
import path from 'path';

import { CLAUDECLAW_CONFIG, PROJECT_ROOT } from './config.js';

/** Reject anything that isn't a valid Telegram chat id. Negative ids
 *  exist (group chats start with `-`) but the bot rejects non-private
 *  chats up front, so users.platform_user_id is always positive. We
 *  still allow the leading `-` for forward compatibility but block any
 *  path-traversal characters. */
export const USER_CHAT_ID_RE = /^-?[0-9]+$/;

/** Cheap "does this user have a CLAUDE.md on disk?" check. */
export function userClaudeMdExists(chatId: string): boolean {
  return resolveUserClaudeMd(chatId) !== null;
}

/**
 * Resolve the directory we'd hand to the SDK as `cwd` for this user.
 * Only returns a path when a CLAUDE.md actually lives there — caller
 * should fall back to the agent's cwd otherwise (5-line change in
 * agent.ts per the design doc).
 */
export function resolveUserCwd(chatId: string): string | null {
  const md = resolveUserClaudeMd(chatId);
  if (!md) return null;
  return path.dirname(md);
}

/**
 * Resolve the CLAUDE.md path for a given chat id. Returns null if
 * none exists in either the external config dir or the repo.
 */
export function resolveUserClaudeMd(chatId: string): string | null {
  if (!USER_CHAT_ID_RE.test(chatId)) return null;

  const externalPath = path.join(CLAUDECLAW_CONFIG, 'users', chatId, 'CLAUDE.md');
  if (fs.existsSync(externalPath)) return externalPath;

  const repoPath = path.join(PROJECT_ROOT, 'users', chatId, 'CLAUDE.md');
  if (fs.existsSync(repoPath)) return repoPath;

  return null;
}

/**
 * List every chat id with a per-user directory. Used by the dashboard
 * Team panel (step 7) and by the user-create-cli (step 6).
 *
 * Mirrors agent-config.listAgentIds: scans both base dirs, dedupes.
 */
export function listUserDirs(): string[] {
  const ids = new Set<string>();
  for (const baseDir of [
    path.join(CLAUDECLAW_CONFIG, 'users'),
    path.join(PROJECT_ROOT, 'users'),
  ]) {
    if (!fs.existsSync(baseDir)) continue;
    for (const d of fs.readdirSync(baseDir)) {
      if (d.startsWith('_')) continue; // skip _template
      if (!USER_CHAT_ID_RE.test(d)) continue;
      const mdPath = path.join(baseDir, d, 'CLAUDE.md');
      if (fs.existsSync(mdPath)) ids.add(d);
    }
  }
  return [...ids].sort();
}
