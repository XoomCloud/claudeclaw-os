import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  USER_CHAT_ID_RE,
  resolveUserClaudeMd,
  resolveUserCwd,
  userClaudeMdExists,
  listUserDirs,
} from './user-config.js';
import { PROJECT_ROOT } from './config.js';

const REPO_USERS_DIR = path.join(PROJECT_ROOT, 'users');

function writeUserClaudeMd(chatId: string, contents: string): string {
  const dir = path.join(REPO_USERS_DIR, chatId);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(p, contents);
  return p;
}

describe('user-config', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const d of createdDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
    }
    createdDirs.length = 0;
  });

  describe('USER_CHAT_ID_RE', () => {
    it('accepts numeric chat ids', () => {
      expect(USER_CHAT_ID_RE.test('12345')).toBe(true);
      expect(USER_CHAT_ID_RE.test('-100123456789')).toBe(true);
    });
    it('rejects path-traversal characters', () => {
      expect(USER_CHAT_ID_RE.test('../foo')).toBe(false);
      expect(USER_CHAT_ID_RE.test('123/sub')).toBe(false);
      expect(USER_CHAT_ID_RE.test('123\\bar')).toBe(false);
      expect(USER_CHAT_ID_RE.test('alice')).toBe(false);
      expect(USER_CHAT_ID_RE.test('')).toBe(false);
    });
  });

  describe('resolveUserClaudeMd', () => {
    it('returns null for an unknown chat id', () => {
      expect(resolveUserClaudeMd('99999999')).toBeNull();
      expect(userClaudeMdExists('99999999')).toBe(false);
    });

    it('returns the repo path when a user has a CLAUDE.md there', () => {
      const chatId = '88888888';
      const dir = path.join(REPO_USERS_DIR, chatId);
      createdDirs.push(dir);
      writeUserClaudeMd(chatId, '# Test user CLAUDE.md');
      expect(resolveUserClaudeMd(chatId)).toBe(path.join(dir, 'CLAUDE.md'));
      expect(userClaudeMdExists(chatId)).toBe(true);
    });

    it('rejects path-traversal chat ids by returning null', () => {
      expect(resolveUserClaudeMd('../etc')).toBeNull();
      expect(resolveUserClaudeMd('../../../etc/passwd')).toBeNull();
    });
  });

  describe('resolveUserCwd', () => {
    it('returns the directory when CLAUDE.md exists', () => {
      const chatId = '77777777';
      const dir = path.join(REPO_USERS_DIR, chatId);
      createdDirs.push(dir);
      writeUserClaudeMd(chatId, '# User CLAUDE.md');
      expect(resolveUserCwd(chatId)).toBe(dir);
    });

    it('returns null when no CLAUDE.md exists', () => {
      expect(resolveUserCwd('66666666')).toBeNull();
    });
  });

  describe('listUserDirs', () => {
    it('finds chat-id directories with CLAUDE.md and skips _template', () => {
      const real = '55555551';
      const realDir = path.join(REPO_USERS_DIR, real);
      const tmpl = path.join(REPO_USERS_DIR, '_template');
      // The repo ships a real users/_template/CLAUDE.md (step 6).
      // Don't include it in createdDirs — we'd wipe a checked-in file.
      // listUserDirs filters _template out by name regardless.
      createdDirs.push(realDir);
      writeUserClaudeMd(real, '# Real user');
      const tmplExisted = fs.existsSync(tmpl);
      if (!tmplExisted) {
        fs.mkdirSync(tmpl, { recursive: true });
        fs.writeFileSync(path.join(tmpl, 'CLAUDE.md'), '# Template');
        createdDirs.push(tmpl);
      }

      const ids = listUserDirs();
      expect(ids).toContain(real);
      expect(ids).not.toContain('_template');
    });

    it('skips entries whose name fails the chat-id regex', () => {
      const bogus = path.join(REPO_USERS_DIR, 'not-a-chat-id');
      createdDirs.push(bogus);
      fs.mkdirSync(bogus, { recursive: true });
      fs.writeFileSync(path.join(bogus, 'CLAUDE.md'), '# Bogus');
      const ids = listUserDirs();
      expect(ids).not.toContain('not-a-chat-id');
    });
  });
});
