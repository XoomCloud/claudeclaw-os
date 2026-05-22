import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { _initTestDatabase } from './db.js';
import { PROJECT_ROOT } from './config.js';
import { getUserById, getUserByPlatformId, listUsers } from './users.js';
import {
  createUser,
  removeUser,
  validateChatId,
  validateRole,
  UserCreateError,
  writeUserClaudeMdFromTemplate,
} from './user-create.js';

describe('user-create — validation', () => {
  it('validateChatId accepts numeric ids', () => {
    expect(() => validateChatId('12345')).not.toThrow();
    expect(() => validateChatId('-100123456789')).not.toThrow();
  });

  it('validateChatId rejects empty, non-numeric, or traversal', () => {
    expect(() => validateChatId('')).toThrow(UserCreateError);
    expect(() => validateChatId('alice')).toThrow(UserCreateError);
    expect(() => validateChatId('../etc/passwd')).toThrow(UserCreateError);
    expect(() => validateChatId('123/sub')).toThrow(UserCreateError);
  });

  it('validateRole accepts valid roles', () => {
    expect(() => validateRole('owner')).not.toThrow();
    expect(() => validateRole('admin')).not.toThrow();
    expect(() => validateRole('staff')).not.toThrow();
    expect(() => validateRole('restricted')).not.toThrow();
  });

  it('validateRole rejects unknowns', () => {
    expect(() => validateRole('superuser')).toThrow(UserCreateError);
    expect(() => validateRole('')).toThrow(UserCreateError);
  });
});

describe('user-create — createUser', () => {
  const createdDirs: string[] = [];

  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    for (const d of createdDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
    }
    createdDirs.length = 0;
  });

  it('creates an owner with sane defaults', () => {
    const { user, claudeMdPath } = createUser({
      chatId: '111',
      displayName: 'Alice',
      role: 'owner',
    });
    expect(user.id).toBeGreaterThan(0);
    expect(user.role).toBe('owner');
    expect(user.status).toBe('active');
    expect(user.platform).toBe('telegram');
    expect(user.platform_user_id).toBe('111');
    expect(user.pin_hash).toBeNull();
    // createClaudeMd defaults to false unless explicitly set
    expect(claudeMdPath).toBeNull();
  });

  it('hashes PIN when provided', () => {
    const { user } = createUser({
      chatId: '111',
      displayName: 'Alice',
      role: 'owner',
      pin: '4242',
    });
    expect(user.pin_hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
  });

  it('strips leading @ from username', () => {
    const { user } = createUser({
      chatId: '111',
      displayName: 'Alice',
      role: 'staff',
      username: '@alice',
    });
    expect(user.platform_username).toBe('alice');
  });

  it('refuses a second owner', () => {
    createUser({ chatId: '111', displayName: 'Alice', role: 'owner' });
    expect(() =>
      createUser({ chatId: '222', displayName: 'Bob', role: 'owner' }),
    ).toThrow(/second owner/i);
  });

  it('refuses a duplicate chat id', () => {
    createUser({ chatId: '111', displayName: 'Alice', role: 'staff' });
    expect(() =>
      createUser({ chatId: '111', displayName: 'Other Alice', role: 'staff' }),
    ).toThrow(/already exists/i);
  });

  it('requires a non-empty display name', () => {
    expect(() =>
      createUser({ chatId: '111', displayName: '   ', role: 'staff' }),
    ).toThrow(/display_name is required/i);
  });

  it('writes users/<chat_id>/CLAUDE.md when createClaudeMd is true', () => {
    const chatId = '99887766';
    const dir = path.join(PROJECT_ROOT, 'users', chatId);
    createdDirs.push(dir);

    const { user, claudeMdPath } = createUser({
      chatId,
      displayName: 'Cassidy',
      role: 'staff',
      createClaudeMd: true,
    });
    expect(claudeMdPath).not.toBeNull();
    expect(fs.existsSync(claudeMdPath!)).toBe(true);
    const contents = fs.readFileSync(claudeMdPath!, 'utf-8');
    // [DISPLAY_NAME] placeholder gets substituted
    expect(contents).toContain('Cassidy');
    expect(contents).toContain(chatId);
    // Owner permission bit (best-effort check on non-Windows)
    if (process.platform !== 'win32') {
      const stat = fs.statSync(claudeMdPath!);
      expect(stat.mode & 0o777).toBe(0o600);
    }
    expect(user.platform_user_id).toBe(chatId);
  });

  it('does not clobber an existing CLAUDE.md', () => {
    const chatId = '88776655';
    const dir = path.join(PROJECT_ROOT, 'users', chatId);
    createdDirs.push(dir);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(target, 'PRE-EXISTING — do not overwrite');

    writeUserClaudeMdFromTemplate(chatId, 'Whatever');
    expect(fs.readFileSync(target, 'utf-8')).toContain('PRE-EXISTING');
  });
});

describe('user-create — removeUser', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('removes a non-owner user', () => {
    createUser({ chatId: '111', displayName: 'Owner', role: 'owner' });
    const { user: staff } = createUser({
      chatId: '222', displayName: 'Staff', role: 'staff',
    });
    removeUser(staff.id);
    expect(getUserById(staff.id)).toBeNull();
    expect(getUserByPlatformId('telegram', '222')).toBeNull();
  });

  it('refuses to delete the only owner', () => {
    const { user } = createUser({ chatId: '111', displayName: 'Owner', role: 'owner' });
    expect(() => removeUser(user.id)).toThrow(/only owner/i);
    expect(listUsers({}).length).toBe(1);
  });

  it('deletes the on-disk users/<chat_id>/ directory if present', () => {
    const chatId = '77665544';
    const dir = path.join(PROJECT_ROOT, 'users', chatId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# test');

    // Need an owner first so removing the staff member doesn't trip the
    // "only owner" guard.
    createUser({ chatId: '111', displayName: 'Owner', role: 'owner' });
    const { user } = createUser({ chatId, displayName: 'ToDelete', role: 'staff' });

    removeUser(user.id);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('throws when the user does not exist', () => {
    expect(() => removeUser(99999)).toThrow(/not found/i);
  });
});
