/**
 * Step-4 wiring tests. Covers the user_id threading through the writer
 * helpers in db.ts and the orchestrator's can() gate. The user-config
 * resolver gets its own focused test file (user-config.test.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  _getDb,
  saveStructuredMemory,
  logConversationTurn,
  saveTokenUsage,
  createScheduledTask,
  createMissionTask,
  logToHiveMind,
  getRecentMemories,
  getRecentConversation,
  getMissionTask,
} from './db.js';
import { createUser } from './users.js';

describe('db writers persist user_id (step 4)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('saveStructuredMemory writes user_id', () => {
    const id = createUser({
      platform: 'telegram', platform_user_id: '1',
      display_name: 'A', role: 'staff',
    });
    saveStructuredMemory('1', 'raw', 'sum', [], [], 0.5, 'conversation', 'main', id);
    const recent = getRecentMemories('1', 1);
    expect(recent).toHaveLength(1);
    // The Memory interface doesn't include user_id today (didn't need
    // it before step 4); read straight from the DB.
    const row = _getDb().prepare(
      'SELECT user_id FROM memories WHERE id = ?',
    ).get(recent[0].id) as { user_id: number };
    expect(row.user_id).toBe(id);
  });

  it('logConversationTurn writes user_id', () => {
    const id = createUser({
      platform: 'telegram', platform_user_id: '1',
      display_name: 'A', role: 'owner',
    });
    logConversationTurn('1', 'user', 'hello', 'sess', 'main', id);
    const turns = getRecentConversation('1', 1, 'main');
    expect(turns).toHaveLength(1);
    const row = _getDb().prepare(
      'SELECT user_id FROM conversation_log WHERE id = ?',
    ).get(turns[0].id) as { user_id: number };
    expect(row.user_id).toBe(id);
  });

  it('saveTokenUsage writes user_id', () => {
    const id = createUser({
      platform: 'telegram', platform_user_id: '1',
      display_name: 'A', role: 'owner',
    });
    saveTokenUsage('1', 'sess-x', 100, 50, 0, 200, 0.01, false, 'main', id);
    const row = _getDb().prepare(
      'SELECT user_id FROM token_usage WHERE session_id = ?',
    ).get('sess-x') as { user_id: number };
    expect(row.user_id).toBe(id);
  });

  it('createScheduledTask writes user_id', () => {
    const id = createUser({
      platform: 'telegram', platform_user_id: '1',
      display_name: 'A', role: 'staff',
    });
    createScheduledTask('task-1', 'do thing', '0 9 * * *', 9999, 'main', id);
    const row = _getDb().prepare(
      'SELECT user_id FROM scheduled_tasks WHERE id = ?',
    ).get('task-1') as { user_id: number };
    expect(row.user_id).toBe(id);
  });

  it('createMissionTask writes user_id and chat_id', () => {
    const id = createUser({
      platform: 'telegram', platform_user_id: '12345',
      display_name: 'A', role: 'staff',
    });
    createMissionTask('m-1', 'title', 'prompt', 'main', 'main', 5, id, '12345');
    const t = getMissionTask('m-1');
    expect(t).not.toBeNull();
    expect(t!.user_id).toBe(id);
    expect(t!.chat_id).toBe('12345');
  });

  it('createMissionTask defaults chat_id to empty string when omitted', () => {
    const id = createUser({
      platform: 'telegram', platform_user_id: '1',
      display_name: 'A', role: 'owner',
    });
    createMissionTask('m-2', 'title', 'prompt', 'main', 'main', 0, id);
    const t = getMissionTask('m-2');
    expect(t!.chat_id).toBe('');
  });

  it('logToHiveMind writes actor_user_id', () => {
    const id = createUser({
      platform: 'telegram', platform_user_id: '1',
      display_name: 'A', role: 'admin',
    });
    logToHiveMind('main', '1', 'delegate', 'did a thing', undefined, id);
    const row = _getDb().prepare(
      `SELECT actor_user_id FROM hive_mind WHERE summary = 'did a thing'`,
    ).get() as { actor_user_id: number };
    expect(row.actor_user_id).toBe(id);
  });
});
