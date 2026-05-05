#!/usr/bin/env node
/**
 * ClaudeClaw Schedule CLI
 *
 * Used by your Claude assistant via the Bash tool to manage scheduled tasks.
 *
 * Usage:
 *   node dist/schedule-cli.js create "prompt text" "0 9 * * 1"
 *   node dist/schedule-cli.js list
 *   node dist/schedule-cli.js delete <id>
 *   node dist/schedule-cli.js pause <id>
 *   node dist/schedule-cli.js resume <id>
 */

import { randomBytes } from 'crypto';

import {
  initDatabase,
  createScheduledTask,
  getAllScheduledTasks,
  deleteScheduledTask,
  pauseScheduledTask,
  resumeScheduledTask,
} from './db.js';
import { computeNextRun } from './scheduler.js';
import { getOwner, getUserById, getUserByPlatformId, getUserByUsername } from './users.js';

initDatabase();

/** Parse a flag with its value from argv. Returns the value and a list
 *  of indices to strip. When the flag isn't present, value is null. */
function takeFlag(argv: string[], name: string): { value: string | null; strip: number[] } {
  const idx = argv.indexOf(name);
  if (idx === -1) return { value: null, strip: [] };
  return { value: argv[idx + 1] ?? null, strip: [idx, idx + 1] };
}

const agent = takeFlag(process.argv, '--agent');
const userArg = takeFlag(process.argv, '--user');
const cliAgentId = agent.value ?? process.env.CLAUDECLAW_AGENT_ID ?? 'main';

// Multi-user (v0.1.0): --user accepts either a numeric chat id, a
// numeric user_id, or a @username. Defaults to CLAUDECLAW_USER_ID env
// var, then to the auto-promoted owner. Single-user installs without
// any users at all just get user_id=null on the row, which is fine —
// the scheduler resolveTaskOwner falls back to ALLOWED_CHAT_ID.
function resolveCliUserId(arg: string | null | undefined): number | undefined {
  const raw = arg ?? process.env.CLAUDECLAW_USER_ID;
  if (raw) {
    const trimmed = raw.startsWith('@') ? raw : raw.trim();
    if (/^\d+$/.test(trimmed)) {
      // Numeric: try platform_user_id (chat id) first, then internal user_id.
      const byChat = getUserByPlatformId('telegram', trimmed);
      if (byChat) return byChat.id;
      const byId = getUserById(parseInt(trimmed, 10));
      if (byId) return byId.id;
    } else {
      const byUsername = getUserByUsername('telegram', trimmed);
      if (byUsername) return byUsername.id;
    }
    console.error(`--user "${raw}" did not match any user. Falling back to owner.`);
  }
  const owner = getOwner();
  return owner?.id;
}

const cliUserId = resolveCliUserId(userArg.value);

const stripIndices = new Set<number>([...agent.strip, ...userArg.strip]);
const cleanedArgv = process.argv.filter((_, i) => !stripIndices.has(i));
const [, , command, ...rest] = cleanedArgv;

function formatDate(unix: number | null): string {
  if (!unix) return 'never';
  return new Date(unix * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

switch (command) {
  case 'create': {
    const prompt = rest[0];
    const cron = rest[1];

    if (!prompt || !cron) {
      console.error('Usage: schedule-cli create "prompt" "cron expression"');
      console.error('Example: schedule-cli create "Summarise AI news" "0 9 * * 1"');
      process.exit(1);
    }

    let nextRun: number;
    try {
      nextRun = computeNextRun(cron);
    } catch {
      console.error(`Invalid cron expression: "${cron}"`);
      console.error('Examples: "0 9 * * 1" (Mon 9am)  "0 8 * * *" (daily 8am)  "0 */4 * * *" (every 4h)');
      process.exit(1);
    }

    const id = randomBytes(4).toString('hex');
    createScheduledTask(id, prompt, cron, nextRun, cliAgentId, cliUserId);

    console.log(`Task created: ${id}`);
    console.log(`Agent:        ${cliAgentId}`);
    if (cliUserId) console.log(`User:         #${cliUserId}`);
    console.log(`Prompt:       ${prompt}`);
    console.log(`Schedule:     ${cron}`);
    console.log(`Next run:     ${formatDate(nextRun)}`);
    break;
  }

  case 'list': {
    const tasks = getAllScheduledTasks(cliAgentId === 'main' ? undefined : cliAgentId);
    if (tasks.length === 0) {
      console.log('No scheduled tasks.');
      break;
    }
    console.log(`${tasks.length} scheduled task${tasks.length === 1 ? '' : 's'}:\n`);
    for (const t of tasks) {
      const status = t.status === 'paused' ? ' [PAUSED]' : '';
      console.log(`${t.id}${status}`);
      console.log(`  Prompt:   ${t.prompt}`);
      console.log(`  Schedule: ${t.schedule}`);
      console.log(`  Next run: ${formatDate(t.next_run)}`);
      console.log(`  Last run: ${formatDate(t.last_run)}`);
      console.log();
    }
    break;
  }

  case 'delete': {
    const id = rest[0];
    if (!id) { console.error('Usage: schedule-cli delete <id>'); process.exit(1); }
    deleteScheduledTask(id);
    console.log(`Deleted task: ${id}`);
    break;
  }

  case 'pause': {
    const id = rest[0];
    if (!id) { console.error('Usage: schedule-cli pause <id>'); process.exit(1); }
    pauseScheduledTask(id);
    console.log(`Paused task: ${id}`);
    break;
  }

  case 'resume': {
    const id = rest[0];
    if (!id) { console.error('Usage: schedule-cli resume <id>'); process.exit(1); }
    resumeScheduledTask(id);
    console.log(`Resumed task: ${id}`);
    break;
  }

  default:
    console.error('Commands: create | list | delete | pause | resume');
    process.exit(1);
}
