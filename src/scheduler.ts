import { CronExpressionParser } from 'cron-parser';

import { AGENT_ID, ALLOWED_CHAT_ID, agentMcpAllowlist } from './config.js';
import {
  getDueTasks,
  getSession,
  logConversationTurn,
  markTaskRunning,
  updateTaskAfterRun,
  resetStuckTasks,
  claimNextMissionTask,
  completeMissionTask,
  resetStuckMissionTasks,
  getMissionTask,
} from './db.js';
import { logger } from './logger.js';
import { messageQueue } from './message-queue.js';
import { runAgent } from './agent.js';
import { formatForTelegram, splitMessage } from './bot.js';
import { resolveUserCwd } from './user-config.js';
import { getUserById, type User } from './users.js';

type Sender = (text: string) => Promise<void>;

/** Max time (ms) a scheduled task can run before being killed. */
const TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

let sender: Sender;

/**
 * In-memory set of task IDs currently being executed.
 * Acts as a fast-path guard alongside the DB-level lock in markTaskRunning.
 */
const runningTaskIds = new Set<string>();

/**
 * Initialise the scheduler. Call once after the Telegram bot is ready.
 * @param send  Function that sends a message to the user's Telegram chat.
 */
let schedulerAgentId = 'main';

export function initScheduler(send: Sender, agentId = 'main'): void {
  if (!ALLOWED_CHAT_ID) {
    logger.warn('ALLOWED_CHAT_ID not set — scheduler will not send results');
  }
  sender = send;
  schedulerAgentId = agentId;

  // Recover tasks stuck in 'running' from a previous crash
  const recovered = resetStuckTasks(agentId);
  if (recovered > 0) {
    logger.warn({ recovered, agentId }, 'Reset stuck tasks from previous crash');
  }
  const recoveredMission = resetStuckMissionTasks(agentId);
  if (recoveredMission > 0) {
    logger.warn({ recovered: recoveredMission, agentId }, 'Reset stuck mission tasks from previous crash');
  }

  setInterval(() => void runDueTasks(), 60_000);
  logger.info({ agentId }, 'Scheduler started (checking every 60s)');
}

/**
 * Resolve the human a task belongs to. Looks up via task.user_id
 * (post-migration), falls back to the auto-promoted owner row, and
 * finally to ALLOWED_CHAT_ID for any pre-migration row that somehow
 * survived the backfill. Returned `chatId` is `''` only when there's
 * no owner at all, in which case the caller skips the conversation
 * injection block (was the same outcome under the old code).
 */
function resolveTaskOwner(taskUserId: number | null | undefined): {
  user: User | null;
  chatId: string;
  userCwd: string | undefined;
} {
  let user: User | null = null;
  if (typeof taskUserId === 'number') {
    user = getUserById(taskUserId);
  }
  // user_id can be null on pre-migration rows that somehow survived 004.
  // Fallback chain mirrors the design doc: explicit user → ALLOWED_CHAT_ID.
  const chatId = user?.platform_user_id || ALLOWED_CHAT_ID || '';
  const userCwd = chatId ? (resolveUserCwd(chatId) ?? undefined) : undefined;
  return { user, chatId, userCwd };
}

async function runDueTasks(): Promise<void> {
  const tasks = getDueTasks(schedulerAgentId);

  if (tasks.length > 0) {
    logger.info({ count: tasks.length }, 'Running due scheduled tasks');
  }

  for (const task of tasks) {
    // In-memory guard: skip if already running in this process
    if (runningTaskIds.has(task.id)) {
      logger.warn({ taskId: task.id }, 'Task already running, skipping duplicate fire');
      continue;
    }

    // Compute next occurrence BEFORE executing so we can lock the task
    // in the DB immediately, preventing re-fire on subsequent ticks.
    const nextRun = computeNextRun(task.schedule);
    runningTaskIds.add(task.id);
    markTaskRunning(task.id, nextRun);

    logger.info({ taskId: task.id, prompt: task.prompt.slice(0, 60) }, 'Firing task');

    // Multi-user (v0.1.0): resolve the task's owner from task.user_id.
    // Routes results back to that user's chat instead of always-owner,
    // and uses their per-user CLAUDE.md if they have one.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const owner = resolveTaskOwner((task as any).user_id);
    const queueKey = owner.chatId || 'scheduler';

    // Route through the message queue so scheduled tasks wait for any
    // in-flight user message to finish before running. This prevents
    // two Claude processes from hitting the same session simultaneously.
    messageQueue.enqueue(queueKey, async () => {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), TASK_TIMEOUT_MS);

      try {
        await sender(`Scheduled task running: "${task.prompt.slice(0, 80)}${task.prompt.length > 80 ? '...' : ''}"`);

        // Run as a fresh agent call (no session — scheduled tasks are autonomous)
        const result = await runAgent(
          task.prompt, undefined, () => {}, undefined, undefined,
          abortController, undefined, agentMcpAllowlist, owner.userCwd,
        );
        clearTimeout(timeout);

        if (result.aborted) {
          updateTaskAfterRun(task.id, nextRun, 'Timed out after 10 minutes', 'timeout');
          await sender(`⏱ Task timed out after 10m: "${task.prompt.slice(0, 60)}..." — killed.`);
          logger.warn({ taskId: task.id }, 'Task timed out');
          return;
        }

        const text = result.text?.trim() || 'Task completed with no output.';
        for (const chunk of splitMessage(formatForTelegram(text))) {
          await sender(chunk);
        }

        // Inject task output into the active chat session so user replies have context.
        // Routes by the task's owner now, not the global ALLOWED_CHAT_ID.
        if (owner.chatId) {
          const activeSession = getSession(owner.chatId, schedulerAgentId);
          logConversationTurn(owner.chatId, 'user', `[Scheduled task]: ${task.prompt}`, activeSession ?? undefined, schedulerAgentId, owner.user?.id);
          logConversationTurn(owner.chatId, 'assistant', text, activeSession ?? undefined, schedulerAgentId, owner.user?.id);
        }

        updateTaskAfterRun(task.id, nextRun, text, 'success');

        logger.info({ taskId: task.id, nextRun }, 'Task complete, next run scheduled');
      } catch (err) {
        clearTimeout(timeout);
        const errMsg = err instanceof Error ? err.message : String(err);
        updateTaskAfterRun(task.id, nextRun, errMsg.slice(0, 500), 'failed');

        logger.error({ err, taskId: task.id }, 'Scheduled task failed');
        try {
          await sender(`❌ Task failed: "${task.prompt.slice(0, 60)}..." — ${errMsg.slice(0, 200)}`);
        } catch {
          // ignore send failure
        }
      } finally {
        runningTaskIds.delete(task.id);
      }
    });
  }

  // Also check for queued mission tasks (one-shot async tasks from Mission Control)
  await runDueMissionTasks();
}

async function runDueMissionTasks(): Promise<void> {
  const mission = claimNextMissionTask(schedulerAgentId);
  if (!mission) return;

  const missionKey = 'mission-' + mission.id;
  if (runningTaskIds.has(missionKey)) return;
  runningTaskIds.add(missionKey);

  logger.info({ missionId: mission.id, title: mission.title }, 'Running mission task');

  // Multi-user (v0.1.0): mission rows now carry user_id and chat_id
  // directly. Mission's chat_id is the routing target; user_id is the
  // ownership identity we pass through to per-user CLAUDE.md and
  // conversation-log writes.
  const owner = resolveTaskOwner(mission.user_id);
  // mission.chat_id wins over the resolved owner.chatId because the
  // task author may have explicitly chosen a different routing target.
  const routingChatId = mission.chat_id || owner.chatId;
  const queueKey = routingChatId || 'mission';

  messageQueue.enqueue(queueKey, async () => {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), TASK_TIMEOUT_MS);

    // Cross-process cancel signal: dashboard flips status to 'cancelled' in
    // SQLite, this poll picks it up within 5s and aborts the runAgent call.
    let cancelledByUser = false;
    const cancelPoll = setInterval(() => {
      const current = getMissionTask(mission.id);
      if (current?.status === 'cancelled') {
        cancelledByUser = true;
        abortController.abort();
        clearInterval(cancelPoll);
      }
    }, 5_000);

    try {
      const result = await runAgent(
        mission.prompt, undefined, () => {}, undefined, undefined,
        abortController, undefined, agentMcpAllowlist, owner.userCwd,
      );
      clearTimeout(timeout);
      clearInterval(cancelPoll);

      if (result.aborted) {
        if (cancelledByUser) {
          // Status is already 'cancelled' from the dashboard write — leave it.
          logger.info({ missionId: mission.id }, 'Mission task cancelled by user');
        } else {
          completeMissionTask(mission.id, null, 'failed', 'Timed out after 10 minutes');
          logger.warn({ missionId: mission.id }, 'Mission task timed out');
          try {
            await sender('Mission task timed out: "' + mission.title + '"');
          } catch (sendErr) {
            // Sender can fail for Telegram API blips or chat-not-found. We
            // still want to see it so the user isn't silently unnotified.
            logger.warn({ err: sendErr, missionId: mission.id }, 'Failed to send mission timeout notification');
          }
        }
      } else {
        const text = result.text?.trim() || 'Task completed with no output.';
        completeMissionTask(mission.id, text, 'completed');
        logger.info({ missionId: mission.id }, 'Mission task completed');

        // Send result to Telegram
        for (const chunk of splitMessage(formatForTelegram(text))) {
          await sender(chunk);
        }

        // Inject into conversation context so agent can reference it.
        // Per-user routing now — falls back gracefully when neither
        // mission.chat_id nor a resolvable owner exists.
        if (routingChatId) {
          const activeSession = getSession(routingChatId, schedulerAgentId);
          logConversationTurn(routingChatId, 'user', '[Mission task: ' + mission.title + ']: ' + mission.prompt, activeSession ?? undefined, schedulerAgentId, owner.user?.id);
          logConversationTurn(routingChatId, 'assistant', text, activeSession ?? undefined, schedulerAgentId, owner.user?.id);
        }
      }
    } catch (err) {
      clearTimeout(timeout);
      clearInterval(cancelPoll);
      const errMsg = err instanceof Error ? err.message : String(err);
      if (cancelledByUser) {
        logger.info({ missionId: mission.id }, 'Mission task cancelled by user (threw on abort)');
      } else {
        completeMissionTask(mission.id, null, 'failed', errMsg.slice(0, 500));
        logger.error({ err, missionId: mission.id }, 'Mission task failed');
      }
    } finally {
      clearInterval(cancelPoll);
      runningTaskIds.delete(missionKey);
    }
  });
}

export function computeNextRun(cronExpression: string): number {
  const interval = CronExpressionParser.parse(cronExpression);
  return Math.floor(interval.next().getTime() / 1000);
}
