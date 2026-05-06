import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  // CRUD
  createUser,
  getUserById,
  getUserByPlatformId,
  getUserByDashboardToken,
  getUserByUsername,
  listUsers,
  updateUserRole,
  updateUserStatus,
  setUserPin,
  setUserDashboardToken,
  touchUserLastActive,
  deleteUser,
  getOwner,
  // Skill grants
  grantSkill,
  revokeSkill,
  listUserSkills,
  userHasSkill,
  // Agent grants
  grantAgent,
  revokeAgent,
  listUserAgents,
  userCanDelegate,
  // Invites
  createInvite,
  getInviteByToken,
  redeemInvite,
  listPendingInvites,
  expireOldInvites,
  // Handoff
  handoffOwnership,
  // Permissions
  can,
  requireRole,
  PermissionDeniedError,
  resolveUser,
  roleAtLeast,
  type User,
  type Role,
} from './users.js';

// Convenience builders so each test reads as a permission matrix.
function makeUser(role: Role, overrides: Partial<Omit<User, 'role'>> = {}): User {
  const id = createUser({
    platform: 'telegram',
    platform_user_id: overrides.platform_user_id ?? `${role}-${Math.floor(Math.random() * 1e9)}`,
    display_name: overrides.display_name ?? role,
    role,
    status: overrides.status ?? 'active',
  });
  return getUserById(id)!;
}

describe('users module', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  // ── CRUD ────────────────────────────────────────────────────────

  describe('CRUD', () => {
    it('creates and reads a user by id', () => {
      const id = createUser({
        platform: 'telegram',
        platform_user_id: '12345',
        display_name: 'Alice',
        role: 'owner',
      });
      const u = getUserById(id);
      expect(u).not.toBeNull();
      expect(u!.display_name).toBe('Alice');
      expect(u!.role).toBe('owner');
      expect(u!.status).toBe('active');
      expect(u!.platform_user_id).toBe('12345');
    });

    it('looks up by platform tuple', () => {
      const id = createUser({ platform: 'telegram', platform_user_id: 'abc', display_name: 'A', role: 'staff' });
      const found = getUserByPlatformId('telegram', 'abc');
      expect(found?.id).toBe(id);
      expect(getUserByPlatformId('telegram', 'nope')).toBeNull();
      expect(getUserByPlatformId('discord', 'abc')).toBeNull();
    });

    it('rejects duplicate (platform, platform_user_id)', () => {
      createUser({ platform: 'telegram', platform_user_id: '1', display_name: 'A', role: 'staff' });
      expect(() =>
        createUser({ platform: 'telegram', platform_user_id: '1', display_name: 'B', role: 'staff' }),
      ).toThrow();
    });

    it('looks up by dashboard token', () => {
      const id = createUser({
        platform: 'telegram', platform_user_id: '1', display_name: 'A', role: 'owner',
        dashboard_token: 'secret-token',
      });
      expect(getUserByDashboardToken('secret-token')?.id).toBe(id);
      expect(getUserByDashboardToken('')).toBeNull();
      expect(getUserByDashboardToken('wrong')).toBeNull();
    });

    it('looks up by @username, normalising leading @', () => {
      createUser({
        platform: 'telegram', platform_user_id: '1', display_name: 'Alice',
        role: 'staff', platform_username: 'alice',
      });
      expect(getUserByUsername('telegram', 'alice')?.display_name).toBe('Alice');
      expect(getUserByUsername('telegram', '@alice')?.display_name).toBe('Alice');
      expect(getUserByUsername('telegram', 'bob')).toBeNull();
    });

    it('updates role and status', () => {
      const id = createUser({ platform: 'telegram', platform_user_id: '1', display_name: 'A', role: 'staff' });
      updateUserRole(id, 'admin');
      updateUserStatus(id, 'locked');
      const u = getUserById(id)!;
      expect(u.role).toBe('admin');
      expect(u.status).toBe('locked');
    });

    it('sets and clears pin', () => {
      const id = createUser({ platform: 'telegram', platform_user_id: '1', display_name: 'A', role: 'owner' });
      setUserPin(id, 'salt:hash');
      expect(getUserById(id)!.pin_hash).toBe('salt:hash');
      setUserPin(id, null);
      expect(getUserById(id)!.pin_hash).toBeNull();
    });

    it('rotates dashboard token', () => {
      const id = createUser({
        platform: 'telegram', platform_user_id: '1', display_name: 'A', role: 'owner',
        dashboard_token: 'old',
      });
      setUserDashboardToken(id, 'new');
      expect(getUserByDashboardToken('old')).toBeNull();
      expect(getUserByDashboardToken('new')?.id).toBe(id);
    });

    it('touches last_active_at to a unix timestamp', () => {
      const id = createUser({ platform: 'telegram', platform_user_id: '1', display_name: 'A', role: 'staff' });
      expect(getUserById(id)!.last_active_at).toBeNull();
      touchUserLastActive(id);
      const t = getUserById(id)!.last_active_at!;
      expect(t).toBeGreaterThan(0);
    });

    it('listUsers filters by role and status', () => {
      makeUser('owner');
      makeUser('admin');
      makeUser('staff');
      const lockedStaff = makeUser('staff');
      updateUserStatus(lockedStaff.id, 'locked');
      expect(listUsers({}).length).toBe(4);
      expect(listUsers({ role: 'staff' }).length).toBe(2);
      expect(listUsers({ status: 'locked' }).length).toBe(1);
      expect(listUsers({ role: 'staff', status: 'active' }).length).toBe(1);
    });

    it('deleteUser removes the row and cascades user_skills/user_agents', () => {
      const id = createUser({ platform: 'telegram', platform_user_id: '1', display_name: 'A', role: 'staff' });
      grantSkill(id, 'gmail');
      grantAgent(id, 'comms');
      expect(deleteUser(id)).toBe(true);
      expect(getUserById(id)).toBeNull();
      expect(listUserSkills(id)).toEqual([]);
      expect(listUserAgents(id)).toEqual([]);
    });

    it('getOwner returns null on an empty install', () => {
      expect(getOwner()).toBeNull();
    });

    it('getOwner returns the first owner row', () => {
      const owner = makeUser('owner');
      makeUser('admin');
      expect(getOwner()?.id).toBe(owner.id);
    });
  });

  // ── Skill grants ────────────────────────────────────────────────

  describe('skill grants', () => {
    it('grant + has + revoke flow', () => {
      const u = makeUser('staff');
      expect(userHasSkill(u.id, 'gmail')).toBe(false);
      grantSkill(u.id, 'gmail');
      expect(userHasSkill(u.id, 'gmail')).toBe(true);
      expect(listUserSkills(u.id)).toEqual(['gmail']);
      expect(revokeSkill(u.id, 'gmail')).toBe(true);
      expect(userHasSkill(u.id, 'gmail')).toBe(false);
      expect(revokeSkill(u.id, 'gmail')).toBe(false); // idempotent
    });

    it('owner has every skill implicitly without rows', () => {
      const o = makeUser('owner');
      expect(userHasSkill(o.id, 'gmail')).toBe(true);
      expect(userHasSkill(o.id, 'arbitrary-future-skill')).toBe(true);
      expect(listUserSkills(o.id)).toEqual([]); // implicit, no rows
    });

    it('grantSkill is idempotent', () => {
      const u = makeUser('staff');
      grantSkill(u.id, 'gmail', null);
      grantSkill(u.id, 'gmail', null); // INSERT OR IGNORE
      expect(listUserSkills(u.id)).toEqual(['gmail']);
    });
  });

  // ── Agent grants ────────────────────────────────────────────────

  describe('agent grants', () => {
    it('staff/admin get main for free, restricted does not', () => {
      const staff = makeUser('staff');
      const restricted = makeUser('restricted');
      expect(userCanDelegate(staff.id, 'main')).toBe(true);
      expect(userCanDelegate(restricted.id, 'main')).toBe(false);
    });

    it('specialist agent requires explicit grant for non-owner', () => {
      const staff = makeUser('staff');
      expect(userCanDelegate(staff.id, 'comms')).toBe(false);
      grantAgent(staff.id, 'comms');
      expect(userCanDelegate(staff.id, 'comms')).toBe(true);
      revokeAgent(staff.id, 'comms');
      expect(userCanDelegate(staff.id, 'comms')).toBe(false);
    });

    it('owner can delegate to any agent without rows', () => {
      const o = makeUser('owner');
      expect(userCanDelegate(o.id, 'comms')).toBe(true);
      expect(userCanDelegate(o.id, 'someone-future')).toBe(true);
    });

    it('listUserAgents returns granted-and-enabled agents only', () => {
      const u = makeUser('staff');
      grantAgent(u.id, 'comms');
      grantAgent(u.id, 'ops');
      expect(listUserAgents(u.id).sort()).toEqual(['comms', 'ops']);
    });
  });

  // ── Permission matrix ───────────────────────────────────────────

  describe('can() — role.change', () => {
    it('owner can change any non-owner role', () => {
      const owner = makeUser('owner');
      const admin = makeUser('admin');
      const staff = makeUser('staff');
      expect(can(owner, 'role.change', { kind: 'user', target: admin })).toBe(true);
      expect(can(owner, 'role.change', { kind: 'user', target: staff })).toBe(true);
    });

    it('owner cannot change another owner via this path (must use handoff)', () => {
      const owner = makeUser('owner');
      const otherOwner = makeUser('owner');
      expect(can(owner, 'role.change', { kind: 'user', target: otherOwner })).toBe(false);
    });

    it('admin can flip staff <-> restricted but not admin or owner', () => {
      const admin = makeUser('admin');
      const staff = makeUser('staff');
      const restricted = makeUser('restricted');
      const otherAdmin = makeUser('admin');
      const owner = makeUser('owner');
      expect(can(admin, 'role.change', { kind: 'user', target: staff })).toBe(true);
      expect(can(admin, 'role.change', { kind: 'user', target: restricted })).toBe(true);
      expect(can(admin, 'role.change', { kind: 'user', target: otherAdmin })).toBe(false);
      expect(can(admin, 'role.change', { kind: 'user', target: owner })).toBe(false);
    });

    it('staff cannot change anyone', () => {
      const staff = makeUser('staff');
      const other = makeUser('staff');
      expect(can(staff, 'role.change', { kind: 'user', target: other })).toBe(false);
    });

    it('nobody can self-demote/promote', () => {
      const owner = makeUser('owner');
      const admin = makeUser('admin');
      expect(can(owner, 'role.change', { kind: 'user', target: owner })).toBe(false);
      expect(can(admin, 'role.change', { kind: 'user', target: admin })).toBe(false);
    });
  });

  describe('can() — invite.create', () => {
    it('owner can invite admin, staff, restricted; never owner', () => {
      const o = makeUser('owner');
      expect(can(o, 'invite.create', { kind: 'role', role: 'admin' })).toBe(true);
      expect(can(o, 'invite.create', { kind: 'role', role: 'staff' })).toBe(true);
      expect(can(o, 'invite.create', { kind: 'role', role: 'restricted' })).toBe(true);
      expect(can(o, 'invite.create', { kind: 'role', role: 'owner' })).toBe(false);
    });

    it('admin can invite staff and restricted only', () => {
      const a = makeUser('admin');
      expect(can(a, 'invite.create', { kind: 'role', role: 'staff' })).toBe(true);
      expect(can(a, 'invite.create', { kind: 'role', role: 'restricted' })).toBe(true);
      expect(can(a, 'invite.create', { kind: 'role', role: 'admin' })).toBe(false);
      expect(can(a, 'invite.create', { kind: 'role', role: 'owner' })).toBe(false);
    });

    it('staff and restricted cannot invite', () => {
      const s = makeUser('staff');
      const r = makeUser('restricted');
      expect(can(s, 'invite.create', { kind: 'role', role: 'staff' })).toBe(false);
      expect(can(r, 'invite.create', { kind: 'role', role: 'staff' })).toBe(false);
    });
  });

  describe('can() — lockout, user.delete, handoff, kill.switch', () => {
    it('owner can lockout anyone except other owners and self', () => {
      const o = makeUser('owner');
      const a = makeUser('admin');
      const otherO = makeUser('owner');
      expect(can(o, 'lockout', { kind: 'user', target: a })).toBe(true);
      expect(can(o, 'lockout', { kind: 'user', target: otherO })).toBe(false);
      expect(can(o, 'lockout', { kind: 'user', target: o })).toBe(false);
    });

    it('admin can lockout staff/restricted only', () => {
      const a = makeUser('admin');
      const s = makeUser('staff');
      const r = makeUser('restricted');
      const otherA = makeUser('admin');
      expect(can(a, 'lockout', { kind: 'user', target: s })).toBe(true);
      expect(can(a, 'lockout', { kind: 'user', target: r })).toBe(true);
      expect(can(a, 'lockout', { kind: 'user', target: otherA })).toBe(false);
    });

    it('only owner can delete users; admin must use lockout', () => {
      const o = makeUser('owner');
      const a = makeUser('admin');
      const s = makeUser('staff');
      expect(can(o, 'user.delete', { kind: 'user', target: s })).toBe(true);
      expect(can(a, 'user.delete', { kind: 'user', target: s })).toBe(false);
    });

    it('handoff and kill.switch are owner-only', () => {
      const o = makeUser('owner');
      const a = makeUser('admin');
      expect(can(o, 'handoff')).toBe(true);
      expect(can(a, 'handoff')).toBe(false);
      expect(can(o, 'kill.switch')).toBe(true);
      expect(can(a, 'kill.switch')).toBe(false);
    });
  });

  describe('can() — skill.run, agent.delegate', () => {
    it('owner runs any skill regardless of grants', () => {
      const o = makeUser('owner');
      expect(can(o, 'skill.run', { kind: 'skill', skill: 'gmail' })).toBe(true);
      expect(can(o, 'skill.run', { kind: 'skill', skill: 'totally-new' })).toBe(true);
    });

    it('staff runs only granted skills', () => {
      const s = makeUser('staff');
      expect(can(s, 'skill.run', { kind: 'skill', skill: 'gmail' })).toBe(false);
      grantSkill(s.id, 'gmail');
      expect(can(s, 'skill.run', { kind: 'skill', skill: 'gmail' })).toBe(true);
      expect(can(s, 'skill.run', { kind: 'skill', skill: 'slack' })).toBe(false);
    });

    it('restricted needs explicit main delegation (strict role)', () => {
      const r = makeUser('restricted');
      expect(can(r, 'agent.delegate', { kind: 'agent', agent: 'main' })).toBe(false);
      grantAgent(r.id, 'main');
      expect(can(r, 'agent.delegate', { kind: 'agent', agent: 'main' })).toBe(true);
    });

    it('staff gets main for free', () => {
      const s = makeUser('staff');
      expect(can(s, 'agent.delegate', { kind: 'agent', agent: 'main' })).toBe(true);
    });
  });

  describe('can() — memory, hive, dashboard.team, audit.read', () => {
    it('memory: owner sees all; others only their own', () => {
      const o = makeUser('owner');
      const s = makeUser('staff');
      expect(can(o, 'memory.read', { kind: 'memory', userId: s.id })).toBe(true);
      expect(can(s, 'memory.read', { kind: 'memory', userId: s.id })).toBe(true);
      expect(can(s, 'memory.read', { kind: 'memory', userId: o.id })).toBe(false);
    });

    it('hive scope ladder: self for all, team for owner+admin, all for owner', () => {
      const o = makeUser('owner');
      const a = makeUser('admin');
      const s = makeUser('staff');
      expect(can(s, 'hive.read', { kind: 'scope', scope: 'self' })).toBe(true);
      expect(can(s, 'hive.read', { kind: 'scope', scope: 'team' })).toBe(false);
      expect(can(a, 'hive.read', { kind: 'scope', scope: 'team' })).toBe(true);
      expect(can(a, 'hive.read', { kind: 'scope', scope: 'all' })).toBe(false);
      expect(can(o, 'hive.read', { kind: 'scope', scope: 'all' })).toBe(true);
    });

    it('dashboard.team is owner+admin', () => {
      expect(can(makeUser('owner'), 'dashboard.team')).toBe(true);
      expect(can(makeUser('admin'), 'dashboard.team')).toBe(true);
      expect(can(makeUser('staff'), 'dashboard.team')).toBe(false);
    });

    it('audit.read is owner only', () => {
      expect(can(makeUser('owner'), 'audit.read')).toBe(true);
      expect(can(makeUser('admin'), 'audit.read')).toBe(false);
    });
  });

  describe('can() — locked accounts cannot do anything', () => {
    it('locked owner is gated', () => {
      const o = makeUser('owner');
      updateUserStatus(o.id, 'locked');
      const reread = getUserById(o.id)!;
      expect(can(reread, 'invite.create', { kind: 'role', role: 'staff' })).toBe(false);
      expect(can(reread, 'memory.read', { kind: 'memory', userId: reread.id })).toBe(false);
    });
  });

  describe('requireRole throws PermissionDeniedError', () => {
    it('throws for forbidden actions', () => {
      const s = makeUser('staff');
      expect(() => requireRole(s, 'audit.read')).toThrow(PermissionDeniedError);
    });

    it('returns silently for allowed actions', () => {
      const o = makeUser('owner');
      expect(() => requireRole(o, 'audit.read')).not.toThrow();
    });
  });

  describe('roleAtLeast', () => {
    it('orders owner > admin > staff > restricted', () => {
      const o = makeUser('owner');
      const a = makeUser('admin');
      const s = makeUser('staff');
      const r = makeUser('restricted');
      expect(roleAtLeast(o, 'admin')).toBe(true);
      expect(roleAtLeast(a, 'admin')).toBe(true);
      expect(roleAtLeast(s, 'admin')).toBe(false);
      expect(roleAtLeast(r, 'staff')).toBe(false);
    });
  });

  // ── Resolver ────────────────────────────────────────────────────

  describe('resolveUser', () => {
    it('returns the user for a known chat id', () => {
      const u = createUser({
        platform: 'telegram', platform_user_id: '12345',
        display_name: 'A', role: 'staff',
      });
      expect(resolveUser('12345')!.id).toBe(u);
      expect(resolveUser(12345)!.id).toBe(u);
    });

    it('returns null for an unknown chat id when no bootstrap path', () => {
      expect(resolveUser('99999')).toBeNull();
    });

    it('bootstraps an owner from legacy ALLOWED_CHAT_ID when users table empty', () => {
      const u = resolveUser('555', { legacyOwnerChatId: '555' });
      expect(u).not.toBeNull();
      expect(u!.role).toBe('owner');
      expect(u!.platform_user_id).toBe('555');
      expect(u!.dashboard_token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('does NOT bootstrap when users table is non-empty', () => {
      makeUser('owner', { platform_user_id: '111' });
      // Even if legacyOwnerChatId is supplied, we don't promote because
      // someone is already running the team.
      expect(resolveUser('555', { legacyOwnerChatId: '555' })).toBeNull();
    });

    it('does NOT bootstrap if chat id mismatches legacyOwnerChatId', () => {
      expect(resolveUser('999', { legacyOwnerChatId: '555' })).toBeNull();
    });
  });

  // ── Invites ─────────────────────────────────────────────────────

  describe('invites', () => {
    it('creates an invite with a 32-hex token, default 7-day expiry', () => {
      const o = makeUser('owner');
      const inv = createInvite({ invited_by: o.id, role: 'staff' });
      expect(inv.token).toMatch(/^[0-9a-f]{32}$/);
      const now = Math.floor(Date.now() / 1000);
      expect(inv.expires_at).toBeGreaterThan(now);
      expect(inv.expires_at - now).toBeGreaterThan(6 * 86400);
      expect(inv.redeemed_at).toBeNull();
    });

    it('redeems an invite into a fresh user', () => {
      const o = makeUser('owner');
      const inv = createInvite({ invited_by: o.id, role: 'staff', display_name: 'Bob' });
      const newUser = redeemInvite({
        token: inv.token,
        platform: 'telegram',
        platform_user_id: '888',
      });
      expect(newUser.role).toBe('staff');
      expect(newUser.display_name).toBe('Bob');
      expect(newUser.created_by).toBe(o.id);
      const after = getInviteByToken(inv.token)!;
      expect(after.redeemed_at).not.toBeNull();
      expect(after.redeemed_by).toBe(newUser.id);
    });

    it('rejects double-redemption', () => {
      const o = makeUser('owner');
      const inv = createInvite({ invited_by: o.id, role: 'staff' });
      redeemInvite({ token: inv.token, platform: 'telegram', platform_user_id: '1' });
      expect(() =>
        redeemInvite({ token: inv.token, platform: 'telegram', platform_user_id: '2' }),
      ).toThrow(/already redeemed/);
    });

    it('rejects an unknown token', () => {
      expect(() =>
        redeemInvite({ token: 'nope', platform: 'telegram', platform_user_id: '1' }),
      ).toThrow(/not found/);
    });

    it('rejects an expired invite', () => {
      const o = makeUser('owner');
      const inv = createInvite({ invited_by: o.id, role: 'staff', ttl_seconds: -1 });
      expect(() =>
        redeemInvite({ token: inv.token, platform: 'telegram', platform_user_id: '1' }),
      ).toThrow(/expired/);
    });

    it('rejects when the platform user already exists', () => {
      const o = makeUser('owner');
      makeUser('staff', { platform_user_id: '999' });
      const inv = createInvite({ invited_by: o.id, role: 'staff' });
      expect(() =>
        redeemInvite({ token: inv.token, platform: 'telegram', platform_user_id: '999' }),
      ).toThrow(/already registered/);
    });

    it('listPendingInvites excludes redeemed and expired rows', () => {
      const o = makeUser('owner');
      const live = createInvite({ invited_by: o.id, role: 'staff' });
      const expired = createInvite({ invited_by: o.id, role: 'staff', ttl_seconds: -1 });
      const redeemed = createInvite({ invited_by: o.id, role: 'staff' });
      redeemInvite({ token: redeemed.token, platform: 'telegram', platform_user_id: '777' });

      const pending = listPendingInvites();
      const tokens = pending.map((p) => p.token);
      expect(tokens).toContain(live.token);
      expect(tokens).not.toContain(expired.token);
      expect(tokens).not.toContain(redeemed.token);
    });

    it('expireOldInvites garbage-collects expired unredeemed rows', () => {
      const o = makeUser('owner');
      const expired = createInvite({ invited_by: o.id, role: 'staff', ttl_seconds: -1 });
      expect(expireOldInvites()).toBe(1);
      expect(getInviteByToken(expired.token)).toBeNull();
    });
  });

  // ── Handoff ─────────────────────────────────────────────────────

  describe('handoffOwnership', () => {
    it('atomically swaps owner -> admin and target -> owner', () => {
      const o = makeUser('owner');
      const a = makeUser('admin');
      handoffOwnership(o.id, a.id);
      expect(getUserById(o.id)!.role).toBe('admin');
      expect(getUserById(a.id)!.role).toBe('owner');
    });

    it('refuses to hand off to self', () => {
      const o = makeUser('owner');
      expect(() => handoffOwnership(o.id, o.id)).toThrow(/self/);
    });

    it('refuses if caller is not actually owner', () => {
      const a = makeUser('admin');
      const s = makeUser('staff');
      expect(() => handoffOwnership(a.id, s.id)).toThrow(/not the current owner/);
    });

    it('refuses if target is locked', () => {
      const o = makeUser('owner');
      const a = makeUser('admin');
      updateUserStatus(a.id, 'locked');
      expect(() => handoffOwnership(o.id, a.id)).toThrow(/not active/);
      // State unchanged on rollback
      expect(getUserById(o.id)!.role).toBe('owner');
      expect(getUserById(a.id)!.role).toBe('admin');
    });
  });
});
