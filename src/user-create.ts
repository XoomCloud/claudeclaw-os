/**
 * User provisioning library (step 6).
 *
 * Mirrors src/agent-create.ts but for users instead of agents.
 * A "user" here is a row in the users table plus an optional
 * `users/<chat_id>/CLAUDE.md` for personal context. There are no
 * service files (no plist, no bot token) since one bot serves many
 * humans now.
 *
 * Public surface used by:
 *   - src/user-create-cli.ts (npm run user:add | list | remove)
 *   - scripts/setup.ts (the "single user or team?" branch)
 *   - src/dashboard.ts (step 7 — Team panel)
 */

import fs from 'fs';
import path from 'path';

import { CLAUDECLAW_CONFIG, PROJECT_ROOT } from './config.js';
import { hashPin } from './security.js';
import {
  createUser as dbCreateUser,
  deleteUser as dbDeleteUser,
  getUserByPlatformId,
  listUsers,
  type Role,
  type User,
} from './users.js';
import { USER_CHAT_ID_RE, resolveUserClaudeMd } from './user-config.js';

export interface CreateUserOpts {
  chatId: string;         // Telegram chat.id (stored as string)
  displayName: string;
  role: Role;
  username?: string;      // Telegram @handle, optional
  pin?: string;           // optional cleartext PIN; hashed before write
  idleLockMinutes?: number | null;
  /** Internal id of the inviter, when applicable (npm run user:add
   *  doesn't have an inviter, so this is undefined for CLI calls). */
  createdBy?: number;
  /** When true, also create users/<chat_id>/CLAUDE.md from the
   *  template so the new user has personal-context boilerplate. */
  createClaudeMd?: boolean;
}

export interface CreateUserResult {
  user: User;
  claudeMdPath: string | null;
}

export class UserCreateError extends Error {}

/**
 * Validate a chat_id. The numeric-only regex from user-config blocks
 * path-traversal; reject anything else up front so the caller gets a
 * clean error instead of a "user_chat_id_re" failure deeper in.
 */
export function validateChatId(chatId: string): void {
  if (!chatId) throw new UserCreateError('chat_id is required');
  if (!USER_CHAT_ID_RE.test(chatId)) {
    throw new UserCreateError(
      `chat_id must be a Telegram chat id (digits, optionally leading "-"). Got "${chatId}".`,
    );
  }
}

const VALID_ROLES: Role[] = ['owner', 'admin', 'staff', 'restricted'];

export function validateRole(role: string): asserts role is Role {
  if (!VALID_ROLES.includes(role as Role)) {
    throw new UserCreateError(
      `role must be one of: ${VALID_ROLES.join(', ')}. Got "${role}".`,
    );
  }
}

/**
 * Create a user end-to-end:
 *   1. Validates chat_id + role.
 *   2. Rejects duplicate (platform, platform_user_id).
 *   3. Refuses to create a second owner unless none exists yet.
 *   4. INSERTs the users row.
 *   5. Optionally writes users/<chat_id>/CLAUDE.md from the template.
 *
 * Returns the hydrated User row.
 */
export function createUser(opts: CreateUserOpts): CreateUserResult {
  validateChatId(opts.chatId);
  validateRole(opts.role);
  if (!opts.displayName?.trim()) {
    throw new UserCreateError('display_name is required');
  }

  if (getUserByPlatformId('telegram', opts.chatId)) {
    throw new UserCreateError(
      `User already exists for chat ${opts.chatId}. Use /role to change their role, or remove first.`,
    );
  }

  if (opts.role === 'owner') {
    const existingOwners = listUsers({ role: 'owner' });
    if (existingOwners.length > 0) {
      throw new UserCreateError(
        `Cannot create a second owner. Use /handoff to transfer ownership.`,
      );
    }
  }

  const pinHash = opts.pin ? hashPin(opts.pin) : null;
  const id = dbCreateUser({
    platform: 'telegram',
    platform_user_id: opts.chatId,
    platform_username: opts.username?.replace(/^@/, ''),
    display_name: opts.displayName.trim(),
    role: opts.role,
    status: 'active',
    pin_hash: pinHash,
    idle_lock_minutes: opts.idleLockMinutes ?? null,
    created_by: opts.createdBy ?? null,
  });

  // Best-effort fetch of the inserted row. dbCreateUser returns the id;
  // listUsers + filter is a lookup that's cheaper than re-querying.
  const newRow = listUsers({}).find((u) => u.id === id);
  if (!newRow) throw new UserCreateError('Internal: user inserted but cannot be read back');

  let claudeMdPath: string | null = null;
  if (opts.createClaudeMd) {
    claudeMdPath = writeUserClaudeMdFromTemplate(opts.chatId, opts.displayName);
  }

  return { user: newRow, claudeMdPath };
}

/**
 * Remove a user by id. Cascades via FK ON DELETE CASCADE to
 * user_skills + user_agents. Refuses to delete the only owner.
 */
export function removeUser(userId: number): void {
  const user = listUsers({}).find((u) => u.id === userId);
  if (!user) throw new UserCreateError(`User #${userId} not found`);
  if (user.role === 'owner') {
    const owners = listUsers({ role: 'owner' });
    if (owners.length <= 1) {
      throw new UserCreateError(
        'Cannot delete the only owner. Hand off ownership first via /handoff.',
      );
    }
  }
  const ok = dbDeleteUser(userId);
  if (!ok) throw new UserCreateError(`Delete failed for user #${userId}`);

  // Best-effort: remove the on-disk users/<chat_id>/ dir too. We do
  // NOT touch backfilled rows in other tables — those keep user_id
  // dangling-but-historical, which is fine for audit purposes. Step 4
  // backfilled NULLs to the owner so we're not orphaning any data.
  const md = resolveUserClaudeMd(user.platform_user_id);
  if (md) {
    const dir = path.dirname(md);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      // Non-fatal — operator can clean up the dir manually if needed.
      // eslint-disable-next-line no-console
      console.warn(`Could not remove ${dir}: ${(err as Error).message}`);
    }
  }
}

/**
 * Write users/<chat_id>/CLAUDE.md from the _template, substituting
 * [DISPLAY_NAME] placeholder if present. Returns the absolute path.
 *
 * Lookup order matches the agents/ pattern: prefer the external
 * CLAUDECLAW_CONFIG/users/ dir when CLAUDECLAW_CONFIG exists, otherwise
 * fall back to PROJECT_ROOT/users/. This way personal context can
 * live outside the repo just like personal agent configs do today.
 */
export function writeUserClaudeMdFromTemplate(chatId: string, displayName: string): string {
  validateChatId(chatId);

  const templatePath = resolveTemplate();
  const template = templatePath
    ? fs.readFileSync(templatePath, 'utf-8')
    : DEFAULT_USER_CLAUDE_MD;

  const populated = template
    .replace(/\[DISPLAY_NAME\]/g, displayName)
    .replace(/\[CHAT_ID\]/g, chatId);

  const baseDir = fs.existsSync(CLAUDECLAW_CONFIG)
    ? path.join(CLAUDECLAW_CONFIG, 'users', chatId)
    : path.join(PROJECT_ROOT, 'users', chatId);
  fs.mkdirSync(baseDir, { recursive: true });

  const target = path.join(baseDir, 'CLAUDE.md');
  // Don't clobber an existing file.
  if (fs.existsSync(target)) return target;

  fs.writeFileSync(target, populated, { mode: 0o600 });
  return target;
}

function resolveTemplate(): string | null {
  const candidates = [
    path.join(CLAUDECLAW_CONFIG, 'users', '_template', 'CLAUDE.md'),
    path.join(PROJECT_ROOT, 'users', '_template', 'CLAUDE.md'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Last-resort template inlined here so a fresh checkout that hasn't
 *  yet shipped users/_template/CLAUDE.md still works. */
const DEFAULT_USER_CLAUDE_MD = `# Personal context for [DISPLAY_NAME]

This file overrides the agent-level CLAUDE.md when this user is the
active human. Add your personal preferences, working style, ongoing
projects, anything the agent should remember about you specifically.

## Working style

- (your preferences)

## Active projects

- (what you're working on)
`;
