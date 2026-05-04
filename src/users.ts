/**
 * Multi-user identity, role, and permission layer.
 *
 * Design doc: docs/multi-user-design.md
 *
 * The User row is keyed by (platform, platform_user_id) so a future
 * src/discord.ts attaches without a schema migration. Today every row
 * is platform='telegram' and platform_user_id is the Telegram chat.id.
 *
 * Owner is implicit-grant: the can() helper short-circuits to true on
 * role='owner' for everything except the few owner-only actions that
 * make no sense to delegate (handoff, kill switch). Skill grants are
 * the primary control for non-owners; bypassPermissions stays true at
 * the SDK layer per the safety rule (see docs/multi-user-design.md §11).
 */

import crypto from 'crypto';

import { _getDb } from './db.js';

// ── Types ────────────────────────────────────────────────────────────

export type Platform = 'telegram' | 'discord';

export type Role = 'owner' | 'admin' | 'staff' | 'restricted';

export type UserStatus = 'active' | 'locked' | 'pending';

export interface User {
  id: number;
  platform: Platform;
  platform_user_id: string;
  platform_username: string | null;
  display_name: string;
  role: Role;
  status: UserStatus;
  pin_hash: string | null;
  idle_lock_minutes: number | null;
  dashboard_token: string | null;
  created_at: number;
  created_by: number | null;
  last_active_at: number | null;
}

export interface UserInvite {
  id: number;
  token: string;
  invited_by: number;
  role: Exclude<Role, 'owner'>;
  display_name: string | null;
  expires_at: number;
  redeemed_at: number | null;
  redeemed_by: number | null;
  created_at: number;
}

/**
 * Discriminated permission action. Adding a new action should be a
 * compile error everywhere can() is called until the matrix below
 * gets a branch for it.
 */
export type Action =
  // Identity / membership
  | 'invite.create'
  | 'role.change'
  | 'lockout'
  | 'user.delete'
  | 'handoff'
  // Skill / agent grants
  | 'skill.grant'
  | 'skill.revoke'
  | 'skill.run'
  | 'agent.delegate'
  // Data scopes
  | 'memory.read'
  | 'memory.write'
  | 'mission.create'
  | 'mission.cancel'
  | 'schedule.create'
  | 'schedule.delete'
  // Admin surfaces
  | 'audit.read'
  | 'hive.read'
  | 'dashboard.team'
  | 'kill.switch';

export type Resource =
  | { kind: 'role'; role: Role }
  | { kind: 'user'; target: User }
  | { kind: 'skill'; skill: string }
  | { kind: 'agent'; agent: string }
  | { kind: 'memory'; userId: number }
  | { kind: 'scope'; scope: 'self' | 'team' | 'all' }
  | { kind: 'none' };

const ROLE_RANK: Record<Role, number> = {
  owner: 3,
  admin: 2,
  staff: 1,
  restricted: 0,
};

// ── Errors ───────────────────────────────────────────────────────────

export class PermissionDeniedError extends Error {
  constructor(
    public readonly user: User,
    public readonly action: Action,
    public readonly reason: string,
  ) {
    super(`Permission denied: ${user.role} cannot ${action} (${reason})`);
    this.name = 'PermissionDeniedError';
  }
}

// ── Permission core ──────────────────────────────────────────────────

/**
 * The single permission gate. Pure function — no DB calls. Caller
 * passes hydrated User and target objects in. Returns true/false; the
 * caller is responsible for writing an audit row (see auditDecision
 * below for the canonical helper).
 */
export function can(user: User, action: Action, resource: Resource = { kind: 'none' }): boolean {
  // A locked account does nothing. Status check happens upstream in
  // resolveUser/requireUser too, but defence in depth.
  if (user.status !== 'active') return false;

  switch (action) {
    case 'invite.create': {
      // Owner can invite anyone. Admin can invite staff or restricted
      // (cannot create another admin or owner).
      if (resource.kind !== 'role') return false;
      if (user.role === 'owner') return resource.role !== 'owner';
      if (user.role === 'admin') return resource.role === 'staff' || resource.role === 'restricted';
      return false;
    }

    case 'role.change': {
      // Owner can change any non-owner role. Admin can only flip
      // staff <-> restricted. Nobody can change owner via this path
      // — that's what handoff is for.
      if (resource.kind !== 'user') return false;
      const target = resource.target;
      if (target.role === 'owner') return false;
      if (user.id === target.id) return false; // no self-demote/self-promote
      if (user.role === 'owner') return true;
      if (user.role === 'admin') return target.role === 'staff' || target.role === 'restricted';
      return false;
    }

    case 'lockout': {
      if (resource.kind !== 'user') return false;
      const target = resource.target;
      if (target.role === 'owner') return false;
      if (user.id === target.id) return false;
      if (user.role === 'owner') return true;
      if (user.role === 'admin') return target.role === 'staff' || target.role === 'restricted';
      return false;
    }

    case 'user.delete': {
      if (resource.kind !== 'user') return false;
      const target = resource.target;
      if (target.role === 'owner') return false;
      if (user.id === target.id) return false;
      // Only owner can delete users. Admin can lockout but not delete.
      return user.role === 'owner';
    }

    case 'handoff': {
      // Owner only. PIN check happens at the call site.
      return user.role === 'owner';
    }

    case 'skill.grant':
    case 'skill.revoke': {
      // Owner: always. Admin: yes (scoped to staff/restricted by
      // call-site target check).
      return user.role === 'owner' || user.role === 'admin';
    }

    case 'skill.run': {
      // Owner: every skill. Anyone else: must have a user_skills row
      // for this skill. Caller is responsible for the lookup.
      if (user.role === 'owner') return true;
      if (resource.kind !== 'skill') return false;
      return userHasSkill(user.id, resource.skill);
    }

    case 'agent.delegate': {
      if (user.role === 'owner') return true;
      if (user.role === 'restricted') {
        // Strict: even main-agent delegation requires explicit grant.
        if (resource.kind !== 'agent') return false;
        return userCanDelegate(user.id, resource.agent);
      }
      if (resource.kind !== 'agent') return false;
      // Staff/admin: agent grants are required for specialist agents.
      // The 'main' agent is always available to staff/admin.
      if (resource.agent === 'main') return true;
      return userCanDelegate(user.id, resource.agent);
    }

    case 'memory.read':
    case 'memory.write': {
      if (user.role === 'owner') return true;
      if (resource.kind !== 'memory') return false;
      return resource.userId === user.id;
    }

    case 'mission.create':
    case 'schedule.create': {
      // Restricted: needs main delegation. Others: yes.
      if (user.role === 'owner') return true;
      if (user.role === 'restricted') return userCanDelegate(user.id, 'main');
      return true;
    }

    case 'mission.cancel':
    case 'schedule.delete': {
      // Same as create — own data only for non-owner.
      return user.role === 'owner' || user.role !== 'restricted';
    }

    case 'audit.read':
    case 'kill.switch': {
      return user.role === 'owner';
    }

    case 'hive.read': {
      if (resource.kind !== 'scope') return false;
      if (resource.scope === 'self') return true;
      if (resource.scope === 'team') return user.role === 'owner' || user.role === 'admin';
      if (resource.scope === 'all') return user.role === 'owner';
      return false;
    }

    case 'dashboard.team': {
      return user.role === 'owner' || user.role === 'admin';
    }
  }
}

/**
 * Throwing wrapper. Bot handlers and dashboard endpoints catch
 * PermissionDeniedError and translate it to a Telegram reply / 403.
 */
export function requireRole(user: User, action: Action, resource: Resource = { kind: 'none' }): void {
  if (!can(user, action, resource)) {
    throw new PermissionDeniedError(user, action, describeResource(resource));
  }
}

function describeResource(r: Resource): string {
  switch (r.kind) {
    case 'role':   return `role=${r.role}`;
    case 'user':   return `target=${r.target.id}/${r.target.role}`;
    case 'skill':  return `skill=${r.skill}`;
    case 'agent':  return `agent=${r.agent}`;
    case 'memory': return `memory.user_id=${r.userId}`;
    case 'scope':  return `scope=${r.scope}`;
    case 'none':   return '';
  }
}

/** Hierarchy comparison for callers that need it (display ordering, etc). */
export function roleAtLeast(user: User, minimum: Role): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK[minimum];
}

// ── Resolver ─────────────────────────────────────────────────────────

/**
 * Look up a user by platform chat id. Returns null if not found.
 *
 * Bootstrap rule: if the users table is empty AND the caller hands us
 * a chat id that matches the legacy ALLOWED_CHAT_ID (passed in via
 * `legacyOwnerChatId`), we promote the chat id to a fresh owner row
 * inline. This makes single-user installs that pulled new code without
 * running migrations Just Work — first authenticated message creates
 * the owner.
 */
export function resolveUser(
  chatId: string | number,
  opts: { platform?: Platform; legacyOwnerChatId?: string } = {},
): User | null {
  const platform = opts.platform ?? 'telegram';
  const idStr = String(chatId);
  const found = getUserByPlatformId(platform, idStr);
  if (found) return found;

  // Bootstrap fallback: empty users table + this chat is the legacy
  // ALLOWED_CHAT_ID owner → promote inline.
  if (opts.legacyOwnerChatId && idStr === opts.legacyOwnerChatId) {
    const empty = (_getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c === 0;
    if (empty) {
      const id = createUser({
        platform,
        platform_user_id: idStr,
        display_name: 'Owner',
        role: 'owner',
        dashboard_token: crypto.randomBytes(32).toString('hex'),
      });
      return getUserById(id);
    }
  }
  return null;
}

// ── User CRUD ────────────────────────────────────────────────────────

export interface CreateUserOpts {
  platform: Platform;
  platform_user_id: string;
  platform_username?: string;
  display_name: string;
  role: Role;
  status?: UserStatus;
  pin_hash?: string | null;
  idle_lock_minutes?: number | null;
  dashboard_token?: string | null;
  created_by?: number | null;
}

export function createUser(opts: CreateUserOpts): number {
  const result = _getDb().prepare(
    `INSERT INTO users
       (platform, platform_user_id, platform_username, display_name,
        role, status, pin_hash, idle_lock_minutes, dashboard_token, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.platform,
    opts.platform_user_id,
    opts.platform_username ?? null,
    opts.display_name,
    opts.role,
    opts.status ?? 'active',
    opts.pin_hash ?? null,
    opts.idle_lock_minutes ?? null,
    opts.dashboard_token ?? null,
    opts.created_by ?? null,
  );
  return Number(result.lastInsertRowid);
}

export function getUserById(id: number): User | null {
  return (_getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as User) ?? null;
}

export function getUserByPlatformId(platform: Platform, platformUserId: string): User | null {
  return (
    _getDb().prepare(
      'SELECT * FROM users WHERE platform = ? AND platform_user_id = ?',
    ).get(platform, platformUserId) as User
  ) ?? null;
}

export function getUserByDashboardToken(token: string): User | null {
  if (!token) return null;
  return (
    _getDb().prepare('SELECT * FROM users WHERE dashboard_token = ?').get(token) as User
  ) ?? null;
}

export function getUserByUsername(platform: Platform, username: string): User | null {
  // Normalise leading @
  const u = username.startsWith('@') ? username.slice(1) : username;
  return (
    _getDb().prepare(
      `SELECT * FROM users WHERE platform = ? AND platform_username = ?`,
    ).get(platform, u) as User
  ) ?? null;
}

export function listUsers(filter: { role?: Role; status?: UserStatus } = {}): User[] {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.role) { conds.push('role = ?'); params.push(filter.role); }
  if (filter.status) { conds.push('status = ?'); params.push(filter.status); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return _getDb().prepare(
    `SELECT * FROM users ${where} ORDER BY id ASC`,
  ).all(...params) as User[];
}

export function updateUserRole(id: number, role: Role): void {
  _getDb().prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
}

export function updateUserStatus(id: number, status: UserStatus): void {
  _getDb().prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
}

export function updateUserDisplayName(id: number, displayName: string): void {
  _getDb().prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, id);
}

export function setUserPin(id: number, pinHash: string | null): void {
  _getDb().prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(pinHash, id);
}

export function setUserDashboardToken(id: number, token: string | null): void {
  _getDb().prepare('UPDATE users SET dashboard_token = ? WHERE id = ?').run(token, id);
}

export function touchUserLastActive(id: number): void {
  _getDb().prepare(
    `UPDATE users SET last_active_at = strftime('%s','now') WHERE id = ?`,
  ).run(id);
}

export function deleteUser(id: number): boolean {
  const r = _getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
  return r.changes > 0;
}

/**
 * Get the single owner. Returns null on a fresh install before any
 * owner has been created.
 */
export function getOwner(): User | null {
  return (
    _getDb().prepare(
      `SELECT * FROM users WHERE role = 'owner' ORDER BY id ASC LIMIT 1`,
    ).get() as User
  ) ?? null;
}

// ── Skill grants ─────────────────────────────────────────────────────

export function grantSkill(userId: number, skillName: string, grantedBy: number | null = null): void {
  _getDb().prepare(
    `INSERT OR IGNORE INTO user_skills (user_id, skill_name, granted_by) VALUES (?, ?, ?)`,
  ).run(userId, skillName, grantedBy);
}

export function revokeSkill(userId: number, skillName: string): boolean {
  const r = _getDb().prepare(
    'DELETE FROM user_skills WHERE user_id = ? AND skill_name = ?',
  ).run(userId, skillName);
  return r.changes > 0;
}

export function listUserSkills(userId: number): string[] {
  const rows = _getDb().prepare(
    'SELECT skill_name FROM user_skills WHERE user_id = ? ORDER BY skill_name',
  ).all(userId) as Array<{ skill_name: string }>;
  return rows.map((r) => r.skill_name);
}

export function userHasSkill(userId: number, skillName: string): boolean {
  // Owner short-circuit. The can() branch already handles this, but
  // exposing it here lets dashboard/UI helpers ask the same question
  // without duplicating role logic.
  const u = getUserById(userId);
  if (u?.role === 'owner') return true;
  const row = _getDb().prepare(
    'SELECT 1 FROM user_skills WHERE user_id = ? AND skill_name = ?',
  ).get(userId, skillName);
  return !!row;
}

// ── Agent grants ─────────────────────────────────────────────────────

export function grantAgent(userId: number, agentId: string, grantedBy: number | null = null): void {
  _getDb().prepare(
    `INSERT OR REPLACE INTO user_agents (user_id, agent_id, can_delegate, granted_by)
     VALUES (?, ?, 1, ?)`,
  ).run(userId, agentId, grantedBy);
}

export function revokeAgent(userId: number, agentId: string): boolean {
  const r = _getDb().prepare(
    'DELETE FROM user_agents WHERE user_id = ? AND agent_id = ?',
  ).run(userId, agentId);
  return r.changes > 0;
}

export function listUserAgents(userId: number): string[] {
  const rows = _getDb().prepare(
    `SELECT agent_id FROM user_agents WHERE user_id = ? AND can_delegate = 1 ORDER BY agent_id`,
  ).all(userId) as Array<{ agent_id: string }>;
  return rows.map((r) => r.agent_id);
}

export function userCanDelegate(userId: number, agentId: string): boolean {
  const u = getUserById(userId);
  if (u?.role === 'owner') return true;
  // Staff/admin get 'main' for free; restricted does not.
  if (agentId === 'main' && u && u.role !== 'restricted') return true;
  const row = _getDb().prepare(
    `SELECT 1 FROM user_agents WHERE user_id = ? AND agent_id = ? AND can_delegate = 1`,
  ).get(userId, agentId);
  return !!row;
}

// ── Invites ──────────────────────────────────────────────────────────

const INVITE_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

export interface CreateInviteOpts {
  invited_by: number;
  role: Exclude<Role, 'owner'>;
  display_name?: string;
  ttl_seconds?: number;
}

export function createInvite(opts: CreateInviteOpts): UserInvite {
  const token = crypto.randomBytes(16).toString('hex');
  const ttl = opts.ttl_seconds ?? INVITE_TTL_SEC;
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const result = _getDb().prepare(
    `INSERT INTO user_invites (token, invited_by, role, display_name, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(token, opts.invited_by, opts.role, opts.display_name ?? null, expiresAt);
  return getInviteById(Number(result.lastInsertRowid))!;
}

export function getInviteById(id: number): UserInvite | null {
  return (
    _getDb().prepare('SELECT * FROM user_invites WHERE id = ?').get(id) as UserInvite
  ) ?? null;
}

export function getInviteByToken(token: string): UserInvite | null {
  if (!token) return null;
  return (
    _getDb().prepare('SELECT * FROM user_invites WHERE token = ?').get(token) as UserInvite
  ) ?? null;
}

export function listPendingInvites(): UserInvite[] {
  const now = Math.floor(Date.now() / 1000);
  return _getDb().prepare(
    `SELECT * FROM user_invites
     WHERE redeemed_at IS NULL AND expires_at > ?
     ORDER BY created_at DESC`,
  ).all(now) as UserInvite[];
}

/**
 * Atomically redeem an invite by creating the user and marking the
 * invite consumed. Throws if the token is invalid, expired, already
 * redeemed, or the platform_user_id is already claimed by another row.
 */
export function redeemInvite(args: {
  token: string;
  platform: Platform;
  platform_user_id: string;
  platform_username?: string;
  display_name?: string;
}): User {
  const db = _getDb();
  const txn = db.transaction(() => {
    const invite = getInviteByToken(args.token);
    if (!invite) throw new Error('invite token not found');
    if (invite.redeemed_at) throw new Error('invite already redeemed');
    if (invite.expires_at < Math.floor(Date.now() / 1000)) throw new Error('invite expired');

    const existing = getUserByPlatformId(args.platform, args.platform_user_id);
    if (existing) throw new Error('platform user already registered');

    const userId = createUser({
      platform: args.platform,
      platform_user_id: args.platform_user_id,
      platform_username: args.platform_username,
      display_name: args.display_name ?? invite.display_name ?? 'New user',
      role: invite.role,
      status: 'active',
      created_by: invite.invited_by,
    });
    db.prepare(
      `UPDATE user_invites SET redeemed_at = strftime('%s','now'), redeemed_by = ?
       WHERE id = ?`,
    ).run(userId, invite.id);
    return getUserById(userId)!;
  });
  return txn();
}

export function expireOldInvites(): number {
  const now = Math.floor(Date.now() / 1000);
  const r = _getDb().prepare(
    `DELETE FROM user_invites WHERE redeemed_at IS NULL AND expires_at < ?`,
  ).run(now);
  return r.changes;
}

// ── Handoff ──────────────────────────────────────────────────────────

/**
 * Atomic ownership transfer. Old owner becomes admin; target becomes
 * owner. PIN verification happens at the call site (bot.ts) — this
 * function trusts that the call-site already authenticated the action
 * via the owner's PIN. Throws if there's already exactly one owner
 * and target is not currently a member of the team.
 */
export function handoffOwnership(currentOwnerId: number, newOwnerId: number): void {
  const db = _getDb();
  const txn = db.transaction(() => {
    const current = getUserById(currentOwnerId);
    const next = getUserById(newOwnerId);
    if (!current || current.role !== 'owner') throw new Error('not the current owner');
    if (!next) throw new Error('target user not found');
    if (next.id === current.id) throw new Error('cannot hand off to self');
    if (next.status !== 'active') throw new Error('target is not active');
    db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(currentOwnerId);
    db.prepare(`UPDATE users SET role = 'owner' WHERE id = ?`).run(newOwnerId);
  });
  txn();
}
