#!/usr/bin/env node
/**
 * ClaudeClaw User CLI
 *
 * Mirror of src/agent-create-cli.ts but for human users. Used by the
 * setup wizard and by operators who want to manage the team without
 * opening Telegram or the dashboard.
 *
 * Usage:
 *   npm run user:list
 *   npm run user:add -- --chat-id 12345 --name "Alice" --role owner
 *   npm run user:add -- --chat-id 12345 --name "Alice" --role staff --username alice
 *   npm run user:remove -- <user-id|chat-id|@username>
 *
 * Optional flags for `add`:
 *   --pin <pin>             set initial PIN (hashed before storage)
 *   --idle-lock <minutes>   per-user idle auto-lock override
 *   --no-claude-md          skip creating users/<chat_id>/CLAUDE.md
 *   --confirm               required for destructive ops in CI
 */

import {
  initDatabase,
  getAuditLog,
} from './db.js';
import {
  getUserById,
  getUserByPlatformId,
  getUserByUsername,
  listUsers,
  listUserSkills,
  listUserAgents,
  grantSkill,
  revokeSkill,
  type User,
} from './users.js';
import { createUser, removeUser, UserCreateError } from './user-create.js';

initDatabase();

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    // The bare `--` separator (used by `npm run user:add -- ...` to
    // pass args through to the script) carries no value of its own.
    // Skip it instead of treating it as a flag named "".
    if (t === '--') continue;
    if (t.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags.set(t.slice(2), true);
      } else {
        flags.set(t.slice(2), next);
        i++;
      }
    } else {
      positional.push(t);
    }
  }
  return { positional, flags };
}

function strFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const v = flags.get(name);
  if (v === undefined || v === true) return undefined;
  return v;
}

function boolFlag(flags: Map<string, string | true>, name: string): boolean {
  return flags.get(name) === true;
}

function intFlag(flags: Map<string, string | true>, name: string): number | undefined {
  const v = strFlag(flags, name);
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function resolveUserArg(arg: string | undefined): User | null {
  if (!arg) return null;
  const trimmed = arg.trim();
  if (trimmed.startsWith('@')) return getUserByUsername('telegram', trimmed);
  if (/^-?\d+$/.test(trimmed)) {
    const byChat = getUserByPlatformId('telegram', trimmed);
    if (byChat) return byChat;
    const byId = getUserById(parseInt(trimmed, 10));
    if (byId) return byId;
  }
  return null;
}

function fail(msg: string): never {
  // eslint-disable-next-line no-console
  console.error(msg);
  process.exit(1);
}

function formatUser(u: User): string {
  const tag = u.platform_username ? `@${u.platform_username}` : `chat ${u.platform_user_id}`;
  const lastSeen = u.last_active_at
    ? new Date(u.last_active_at * 1000).toISOString().replace('T', ' ').slice(0, 16)
    : 'never';
  return `#${u.id}  ${u.display_name.padEnd(20)}  ${tag.padEnd(28)}  ${u.role.padEnd(10)}  ${u.status.padEnd(8)}  last: ${lastSeen}`;
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional[0];

switch (command) {
  case 'list': {
    const roleFilter = strFlag(flags, 'role');
    const statusFilter = strFlag(flags, 'status');
    const users = listUsers({
      role: (roleFilter as User['role']) || undefined,
      status: (statusFilter as User['status']) || undefined,
    });
    if (users.length === 0) {
      // eslint-disable-next-line no-console
      console.log('No users.');
      break;
    }
    // eslint-disable-next-line no-console
    console.log(`${users.length} user${users.length === 1 ? '' : 's'}:\n`);
    for (const u of users) {
      // eslint-disable-next-line no-console
      console.log(formatUser(u));
    }
    break;
  }

  case 'add': {
    const chatId = strFlag(flags, 'chat-id') ?? strFlag(flags, 'chatId');
    const name = strFlag(flags, 'name');
    const role = strFlag(flags, 'role');
    const username = strFlag(flags, 'username');
    const pin = strFlag(flags, 'pin');
    const idleLock = intFlag(flags, 'idle-lock');
    const noClaudeMd = boolFlag(flags, 'no-claude-md');

    if (!chatId || !name || !role) {
      fail('Usage: user:add -- --chat-id <id> --name "Display" --role <owner|admin|staff|restricted> [--username alice] [--pin 1234] [--idle-lock 30] [--no-claude-md]');
    }

    try {
      const { user, claudeMdPath } = createUser({
        chatId: chatId!,
        displayName: name!,
        role: role as User['role'],
        username,
        pin,
        idleLockMinutes: idleLock ?? undefined,
        createClaudeMd: !noClaudeMd,
      });
      // eslint-disable-next-line no-console
      console.log(`Created user #${user.id}: ${user.display_name} (${user.role})`);
      if (claudeMdPath) {
        // eslint-disable-next-line no-console
        console.log(`CLAUDE.md:    ${claudeMdPath}`);
      }
    } catch (err) {
      if (err instanceof UserCreateError) fail(err.message);
      throw err;
    }
    break;
  }

  case 'remove': {
    const target = resolveUserArg(positional[1]);
    if (!target) fail('Usage: user:remove -- <user-id|chat-id|@username> [--confirm]');
    if (!boolFlag(flags, 'confirm')) {
      // eslint-disable-next-line no-console
      console.log(`About to remove: ${formatUser(target!)}`);
      // eslint-disable-next-line no-console
      console.log('Pass --confirm to proceed. This also removes the users/<chat_id>/ directory.');
      process.exit(2);
    }
    try {
      removeUser(target!.id);
      // eslint-disable-next-line no-console
      console.log(`Removed user #${target!.id} (${target!.display_name}).`);
    } catch (err) {
      if (err instanceof UserCreateError) fail(err.message);
      throw err;
    }
    break;
  }

  case 'grant': {
    const target = resolveUserArg(positional[1]);
    const skill = positional[2];
    if (!target || !skill) {
      fail('Usage: user:grant -- <user-id|chat-id|@username> <skill_name>');
    }
    grantSkill(target!.id, skill!, null);
    // eslint-disable-next-line no-console
    console.log(`Granted ${skill} to ${target!.display_name}.`);
    break;
  }

  case 'revoke': {
    const target = resolveUserArg(positional[1]);
    const skill = positional[2];
    if (!target || !skill) {
      fail('Usage: user:revoke -- <user-id|chat-id|@username> <skill_name>');
    }
    const ok = revokeSkill(target!.id, skill!);
    // eslint-disable-next-line no-console
    console.log(ok
      ? `Revoked ${skill} from ${target!.display_name}.`
      : `${target!.display_name} did not have ${skill}.`);
    break;
  }

  case 'show': {
    const target = resolveUserArg(positional[1]);
    if (!target) fail('Usage: user:show -- <user-id|chat-id|@username>');
    const skills = listUserSkills(target!.id);
    const agents = listUserAgents(target!.id);
    // eslint-disable-next-line no-console
    console.log(formatUser(target!));
    // eslint-disable-next-line no-console
    console.log(`Skills:  ${target!.role === 'owner' ? '(all — implicit)' : skills.join(', ') || '(none)'}`);
    // eslint-disable-next-line no-console
    console.log(`Agents:  ${target!.role === 'owner' ? '(all)' : agents.join(', ') || '(main only for staff/admin)'}`);
    // Recent activity from audit_log (last 5 entries actor=this user)
    const recent = getAuditLog(50).filter((e) => e.actor_user_id === target!.id).slice(0, 5);
    if (recent.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`\nRecent audit:`);
      for (const r of recent) {
        // eslint-disable-next-line no-console
        console.log(`  ${new Date(r.created_at * 1000).toISOString()} ${r.action} — ${r.detail.slice(0, 80)}`);
      }
    }
    break;
  }

  default:
    // eslint-disable-next-line no-console
    console.error(`Commands: list | add | remove | grant | revoke | show
Usage examples:
  user:list -- [--role owner] [--status locked]
  user:add -- --chat-id 12345 --name "Alice" --role owner [--username alice --pin 1234]
  user:remove -- <id|chat|@username> --confirm
  user:grant -- <id|chat|@username> <skill>
  user:revoke -- <id|chat|@username> <skill>
  user:show -- <id|chat|@username>`);
    process.exit(1);
}
