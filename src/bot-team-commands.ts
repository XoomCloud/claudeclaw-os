/**
 * Multi-user team-management commands (step 5).
 *
 * Each command:
 *   - resolves the actor via gateUser (which the caller has already
 *     run for the message-text path; here we just re-run the lookup
 *     to be safe — bot.command() handlers run independently)
 *   - permission-checks via can() before doing anything
 *   - writes an audit row on every state-changing decision (allowed
 *     and denied alike) so the audit log doubles as the team activity
 *     feed for the dashboard
 *   - re-broadcasts the affected user's per-chat command menu when
 *     their grants change so the Telegram menu stays in sync
 *
 * Imported and registered by createBot() in bot.ts.
 */

import { Bot, Context } from 'grammy';

import { AGENT_ID } from './config.js';
import { logger } from './logger.js';
import { audit, hashPin } from './security.js';
import {
  can,
  createInvite,
  deleteUser,
  getInviteByToken,
  getOwner,
  getUserById,
  getUserByPlatformId,
  getUserByUsername,
  grantSkill,
  grantAgent,
  handoffOwnership,
  listUserAgents,
  listUserSkills,
  listUsers,
  redeemInvite,
  resolveUser,
  revokeSkill,
  revokeAgent,
  setUserPin,
  updateUserRole,
  updateUserStatus,
  type Role,
  type User,
} from './users.js';
import { unlockUser } from './security.js';
import { refreshUserCommands } from './bot.js';

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Parse `@username | numeric chat_id | numeric user_id` from a command
 * argument. Returns the matched User or null. Also returns the rest
 * of the argument string (after the user token) so callers can pull
 * additional positional args like a skill name or new role.
 */
export function parseTargetUser(
  raw: string | undefined,
): { user: User | null; rest: string } {
  if (!raw) return { user: null, rest: '' };
  const trimmed = raw.trim();
  if (!trimmed) return { user: null, rest: '' };

  const [head, ...tail] = trimmed.split(/\s+/);
  const rest = tail.join(' ');

  // @username
  if (head.startsWith('@')) {
    return { user: getUserByUsername('telegram', head), rest };
  }
  // numeric: try chat id first (most common), then internal id.
  if (/^-?\d+$/.test(head)) {
    const byChat = getUserByPlatformId('telegram', head);
    if (byChat) return { user: byChat, rest };
    const asNum = parseInt(head, 10);
    if (Number.isFinite(asNum)) {
      const byId = getUserById(asNum);
      if (byId) return { user: byId, rest };
    }
  }
  return { user: null, rest };
}

function resolveActor(ctx: Context): User | null {
  const u = resolveUser(ctx.chat!.id);
  if (!u || u.status !== 'active') return null;
  return u;
}

function describeUser(u: User): string {
  const tag = u.platform_username ? `@${u.platform_username}` : `chat ${u.platform_user_id}`;
  return `${u.display_name} (${tag}, role=${u.role}, status=${u.status})`;
}

const VALID_ROLES: Role[] = ['admin', 'staff', 'restricted']; // owner excluded — handoff only

// ── Per-chat pending-handoff state (in-memory) ────────────────────────
// Owner runs `/handoff @bob`, bot stashes the target user_id keyed by
// the owner's chat_id and waits for the next message to be the PIN.
// Times out after 60s. PIN verification uses security.unlockUser
// against the owner's pin_hash.

interface PendingHandoff {
  newOwnerId: number;
  expiresAt: number;
}

const pendingHandoff = new Map<string, PendingHandoff>();
const HANDOFF_TIMEOUT_MS = 60_000;

/** Public for bot.ts text-handler integration. Returns true if the
 *  message was consumed as a handoff PIN attempt (regardless of
 *  success), so the text handler should NOT fall through to the
 *  agent. */
export async function tryHandoffPin(
  chatIdStr: string,
  text: string,
  actor: User,
  ctx: Context,
): Promise<boolean> {
  const pending = pendingHandoff.get(chatIdStr);
  if (!pending) return false;
  if (Date.now() > pending.expiresAt) {
    pendingHandoff.delete(chatIdStr);
    audit({
      agentId: AGENT_ID, chatId: chatIdStr,
      action: 'handoff', detail: 'Handoff timed out before PIN',
      blocked: true, actorUserId: actor.id, targetUserId: pending.newOwnerId,
    });
    await ctx.reply('Handoff timed out. Run /handoff again to retry.');
    return true;
  }
  if (!unlockUser(actor, text)) {
    audit({
      agentId: AGENT_ID, chatId: chatIdStr,
      action: 'handoff', detail: 'PIN failed; handoff aborted',
      blocked: true, actorUserId: actor.id, targetUserId: pending.newOwnerId,
    });
    pendingHandoff.delete(chatIdStr);
    await ctx.reply('PIN incorrect. Handoff aborted.');
    return true;
  }
  // PIN matched. Execute handoff atomically.
  try {
    handoffOwnership(actor.id, pending.newOwnerId);
  } catch (err) {
    audit({
      agentId: AGENT_ID, chatId: chatIdStr,
      action: 'handoff', detail: `Handoff failed: ${(err as Error).message}`,
      blocked: true, actorUserId: actor.id, targetUserId: pending.newOwnerId,
    });
    pendingHandoff.delete(chatIdStr);
    await ctx.reply(`Handoff failed: ${(err as Error).message}`);
    return true;
  }
  pendingHandoff.delete(chatIdStr);
  audit({
    agentId: AGENT_ID, chatId: chatIdStr,
    action: 'handoff', detail: `Owner role transferred to user ${pending.newOwnerId}`,
    blocked: false, actorUserId: actor.id, targetUserId: pending.newOwnerId,
  });
  // Refresh both users' menus so /invite etc. swap visibility.
  const newOwner = getUserById(pending.newOwnerId);
  if (newOwner) {
    await refreshUserCommands(ctx.api, newOwner).catch(() => {});
  }
  // The old owner is now an admin — refresh their menu too.
  const updatedSelf = getUserById(actor.id);
  if (updatedSelf) {
    await refreshUserCommands(ctx.api, updatedSelf).catch(() => {});
  }
  await ctx.reply(`Ownership transferred. ${newOwner?.display_name ?? 'New owner'} is now the owner; you are now an admin.`);
  return true;
}

// ── Command registration ──────────────────────────────────────────────

export function registerTeamCommands(bot: Bot): void {
  // /whoami — visible to everyone authenticated.
  bot.command('whoami', async (ctx) => {
    const user = resolveActor(ctx);
    if (!user) return;
    const skills = listUserSkills(user.id);
    const agents = listUserAgents(user.id);
    const lines = [
      `<b>${user.display_name}</b>`,
      `Role: ${user.role}`,
      `Status: ${user.status}`,
      `Platform: ${user.platform} (${user.platform_user_id})`,
      user.role === 'owner'
        ? 'Skills: <i>all (implicit owner grant)</i>'
        : `Skills: ${skills.length ? skills.join(', ') : '<i>none</i>'}`,
      user.role === 'owner'
        ? 'Agents: <i>all</i>'
        : `Agents: ${agents.length ? ['main', ...agents].filter((v, i, a) => a.indexOf(v) === i).join(', ') : '<i>main only</i>'}`,
    ];
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  // /setpin <new> — set or change your own PIN.
  bot.command('setpin', async (ctx) => {
    const user = resolveActor(ctx);
    if (!user) return;
    const newPin = (ctx.match ?? '').trim();
    if (!newPin) {
      await ctx.reply('Usage: /setpin <new-pin>');
      return;
    }
    if (newPin.length < 4) {
      await ctx.reply('PIN must be at least 4 characters.');
      return;
    }
    setUserPin(user.id, hashPin(newPin));
    audit({
      agentId: AGENT_ID, chatId: ctx.chat!.id.toString(),
      action: 'unlock', detail: 'PIN set/changed via /setpin',
      blocked: false, actorUserId: user.id,
    });
    await ctx.reply('PIN updated. Use /lock to lock the session.');
  });

  // /users — list team members. Owner sees everyone, admin sees the
  // team (everyone but other owners), staff/restricted see only self.
  bot.command('users', async (ctx) => {
    const user = resolveActor(ctx);
    if (!user) return;
    let visible: User[];
    if (user.role === 'owner') {
      visible = listUsers({});
    } else if (user.role === 'admin') {
      visible = listUsers({}).filter((u) => u.role !== 'owner' || u.id === user.id);
    } else {
      visible = [user];
    }
    if (visible.length === 0) {
      await ctx.reply('No users.');
      return;
    }
    const lines = visible.map((u) => {
      const lastSeen = u.last_active_at
        ? `${Math.round((Date.now() / 1000 - u.last_active_at) / 60)}m ago`
        : 'never';
      const tag = u.platform_username ? `@${u.platform_username}` : `chat ${u.platform_user_id}`;
      return `<b>#${u.id}</b> ${u.display_name} (${tag}) — ${u.role}${u.status !== 'active' ? ` [${u.status}]` : ''} — last: ${lastSeen}`;
    });
    await ctx.reply(`<b>Team (${visible.length})</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  });

  // /invite <role> [@username] — generate a one-time invite token.
  // Args are role-first so the @username is optional (used as a
  // pre-fill for display_name + as a label on the invite list).
  bot.command('invite', async (ctx) => {
    const user = resolveActor(ctx);
    if (!user) return;
    const args = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
    const role = args[0]?.toLowerCase() as Role | undefined;
    const usernameArg = args[1];

    if (!role || !VALID_ROLES.includes(role)) {
      await ctx.reply(`Usage: /invite <admin|staff|restricted> [@username]`);
      return;
    }
    if (!can(user, 'invite.create', { kind: 'role', role })) {
      audit({
        agentId: AGENT_ID, chatId: ctx.chat!.id.toString(),
        action: 'denied', detail: `Cannot invite role=${role}`,
        blocked: true, actorUserId: user.id,
      });
      await ctx.reply(`You cannot invite a ${role}.`);
      return;
    }

    const display = usernameArg?.startsWith('@') ? usernameArg.slice(1) : usernameArg;
    // VALID_ROLES guards excluded 'owner' at runtime; cast tells TS.
    const invite = createInvite({
      invited_by: user.id,
      role: role as Exclude<Role, 'owner'>,
      display_name: display,
    });
    audit({
      agentId: AGENT_ID, chatId: ctx.chat!.id.toString(),
      action: 'invite.create',
      detail: `Created ${role} invite${display ? ` for @${display}` : ''}`,
      blocked: false, actorUserId: user.id,
    });
    // Telegram bot username isn't always discoverable cheaply; show
    // the token so the inviter can craft the link manually if needed.
    const days = Math.round((invite.expires_at - Math.floor(Date.now() / 1000)) / 86400);
    let me: string | undefined;
    try {
      const info = await ctx.api.getMe();
      me = info.username ? `https://t.me/${info.username}?start=${invite.token}` : undefined;
    } catch { /* non-fatal */ }
    const lines = [
      `<b>Invite created (${role})</b>`,
      `Token: <code>${invite.token}</code>`,
      `Expires: ${days} day${days === 1 ? '' : 's'}`,
      me ? `Link: ${me}` : `Tell the invitee to send <code>/start ${invite.token}</code> to this bot.`,
    ];
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  // /grant @user skill_name
  bot.command('grant', async (ctx) => {
    const user = resolveActor(ctx);
    if (!user) return;
    const { user: target, rest } = parseTargetUser(ctx.match ?? '');
    const skill = rest.trim();
    if (!target || !skill) {
      await ctx.reply('Usage: /grant <@user|chat_id> <skill_name>');
      return;
    }
    if (!can(user, 'skill.grant', { kind: 'skill', skill })) {
      auditDenied(ctx, user, 'skill.grant', `target=${target.id} skill=${skill}`);
      await ctx.reply('You cannot grant skills.');
      return;
    }
    if (target.role === 'owner') {
      await ctx.reply('Owner has every skill implicitly — no grant needed.');
      return;
    }
    // Admin can only grant to staff/restricted, not other admins.
    if (user.role === 'admin' && target.role === 'admin') {
      auditDenied(ctx, user, 'skill.grant', `target=${target.id} (admin) skill=${skill}`);
      await ctx.reply('Admins cannot grant skills to other admins.');
      return;
    }
    grantSkill(target.id, skill, user.id);
    audit({
      agentId: AGENT_ID, chatId: ctx.chat!.id.toString(),
      action: 'skill.grant',
      detail: `Granted '${skill}' to ${describeUser(target)}`,
      blocked: false, actorUserId: user.id, targetUserId: target.id,
    });
    await refreshUserCommands(ctx.api, target).catch(() => {});
    await ctx.reply(`Granted ${skill} to ${target.display_name}.`);
  });

  // /revoke @user skill_name
  bot.command('revoke', async (ctx) => {
    const user = resolveActor(ctx);
    if (!user) return;
    const { user: target, rest } = parseTargetUser(ctx.match ?? '');
    const skill = rest.trim();
    if (!target || !skill) {
      await ctx.reply('Usage: /revoke <@user|chat_id> <skill_name>');
      return;
    }
    if (!can(user, 'skill.revoke', { kind: 'skill', skill })) {
      auditDenied(ctx, user, 'skill.revoke', `target=${target.id} skill=${skill}`);
      await ctx.reply('You cannot revoke skills.');
      return;
    }
    if (target.role === 'owner') {
      await ctx.reply('Owner skills are implicit; nothing to revoke.');
      return;
    }
    const ok = revokeSkill(target.id, skill);
    audit({
      agentId: AGENT_ID, chatId: ctx.chat!.id.toString(),
      action: 'skill.revoke',
      detail: ok ? `Revoked '${skill}' from ${describeUser(target)}` : `'${skill}' was not granted to ${describeUser(target)}`,
      blocked: false, actorUserId: user.id, targetUserId: target.id,
    });
    await refreshUserCommands(ctx.api, target).catch(() => {});
    await ctx.reply(ok
      ? `Revoked ${skill} from ${target.display_name}.`
      : `${target.display_name} did not have ${skill}.`);
  });

  // /role @user newrole
  bot.command('role', async (ctx) => {
    const user = resolveActor(ctx);
    if (!user) return;
    const { user: target, rest } = parseTargetUser(ctx.match ?? '');
    const newRole = rest.trim().toLowerCase() as Role;
    if (!target || !VALID_ROLES.includes(newRole)) {
      await ctx.reply(`Usage: /role <@user|chat_id> <admin|staff|restricted>`);
      return;
    }
    if (!can(user, 'role.change', { kind: 'user', target })) {
      auditDenied(ctx, user, 'role.change', `target=${target.id}/${target.role} → ${newRole}`);
      await ctx.reply(`You cannot change ${target.display_name}'s role.`);
      return;
    }
    const oldRole = target.role;
    updateUserRole(target.id, newRole);
    const refreshed = getUserById(target.id);
    audit({
      agentId: AGENT_ID, chatId: ctx.chat!.id.toString(),
      action: 'role.change',
      detail: `${describeUser(target)} → role=${newRole} (was ${oldRole})`,
      blocked: false, actorUserId: user.id, targetUserId: target.id,
    });
    if (refreshed) await refreshUserCommands(ctx.api, refreshed).catch(() => {});
    await ctx.reply(`${target.display_name}: ${oldRole} → ${newRole}.`);
  });

  // /lockout @user
  bot.command('lockout', async (ctx) => {
    const user = resolveActor(ctx);
    if (!user) return;
    const { user: target } = parseTargetUser(ctx.match ?? '');
    if (!target) {
      await ctx.reply('Usage: /lockout <@user|chat_id>');
      return;
    }
    if (!can(user, 'lockout', { kind: 'user', target })) {
      auditDenied(ctx, user, 'lockout', `target=${target.id}/${target.role}`);
      await ctx.reply(`You cannot lock out ${target.display_name}.`);
      return;
    }
    updateUserStatus(target.id, 'locked');
    audit({
      agentId: AGENT_ID, chatId: ctx.chat!.id.toString(),
      action: 'lockout.set',
      detail: `Locked out ${describeUser(target)}`,
      blocked: false, actorUserId: user.id, targetUserId: target.id,
    });
    await ctx.reply(`Locked out ${target.display_name}.`);
  });

  // /unlockout @user
  bot.command('unlockout', async (ctx) => {
    const user = resolveActor(ctx);
    if (!user) return;
    const { user: target } = parseTargetUser(ctx.match ?? '');
    if (!target) {
      await ctx.reply('Usage: /unlockout <@user|chat_id>');
      return;
    }
    if (!can(user, 'lockout', { kind: 'user', target })) {
      auditDenied(ctx, user, 'lockout.clear', `target=${target.id}/${target.role}`);
      await ctx.reply(`You cannot reactivate ${target.display_name}.`);
      return;
    }
    updateUserStatus(target.id, 'active');
    audit({
      agentId: AGENT_ID, chatId: ctx.chat!.id.toString(),
      action: 'lockout.clear',
      detail: `Reactivated ${describeUser(target)}`,
      blocked: false, actorUserId: user.id, targetUserId: target.id,
    });
    await ctx.reply(`Reactivated ${target.display_name}.`);
  });

  // /handoff @user — owner only, two-step PIN-confirmed.
  bot.command('handoff', async (ctx) => {
    const user = resolveActor(ctx);
    if (!user) return;
    if (!can(user, 'handoff')) {
      auditDenied(ctx, user, 'handoff', 'attempted by non-owner');
      await ctx.reply('Only the owner can run /handoff.');
      return;
    }
    const { user: target } = parseTargetUser(ctx.match ?? '');
    if (!target) {
      await ctx.reply('Usage: /handoff <@user|chat_id>');
      return;
    }
    if (target.id === user.id) {
      await ctx.reply('Cannot hand off to yourself.');
      return;
    }
    if (target.status !== 'active') {
      await ctx.reply(`${target.display_name} is not active. Use /unlockout first.`);
      return;
    }
    if (!user.pin_hash) {
      await ctx.reply('Set a PIN first with /setpin — handoff requires it for confirmation.');
      return;
    }
    pendingHandoff.set(ctx.chat!.id.toString(), {
      newOwnerId: target.id,
      expiresAt: Date.now() + HANDOFF_TIMEOUT_MS,
    });
    audit({
      agentId: AGENT_ID, chatId: ctx.chat!.id.toString(),
      action: 'handoff', detail: `Handoff initiated to ${describeUser(target)} (awaiting PIN)`,
      blocked: false, actorUserId: user.id, targetUserId: target.id,
    });
    await ctx.reply(`Send your PIN now to confirm handing ownership to ${target.display_name}. (60s timeout — anything else cancels.)`);
  });

  logger.info('Multi-user team commands registered');
}

function auditDenied(ctx: Context, actor: User, label: string, detail: string): void {
  audit({
    agentId: AGENT_ID,
    chatId: ctx.chat!.id.toString(),
    action: 'denied',
    detail: `${label}: ${detail}`,
    blocked: true,
    actorUserId: actor.id,
  });
}

// ── /start <token> redemption helper ───────────────────────────────────
//
// bot.ts owns the /start command itself; this helper is exported so
// the command body can pre-empt the normal greeting when the user
// passes a token. Returns true if the message was consumed.

export async function tryRedeemInvite(ctx: Context): Promise<boolean> {
  // ctx.match is the post-/start payload; grammY also surfaces it
  // through the deep-link `?start=<token>` mechanism. The type can be
  // string OR RegExpMatchArray depending on how the handler is wired,
  // so coerce to string defensively.
  const raw = ctx.match;
  const token = (typeof raw === 'string' ? raw : raw?.[0] ?? '').trim();
  if (!token) return false;
  if (!/^[0-9a-f]{32}$/.test(token)) return false; // not a token shape

  const invite = getInviteByToken(token);
  if (!invite) {
    await ctx.reply('Invite token not recognised.');
    return true;
  }
  if (invite.redeemed_at) {
    await ctx.reply('That invite has already been redeemed.');
    return true;
  }
  if (invite.expires_at < Math.floor(Date.now() / 1000)) {
    await ctx.reply('That invite has expired. Ask the inviter for a new one.');
    return true;
  }

  // Use the redeemer's Telegram identity for the new row. If they
  // already exist (different invite, same chat), redeemInvite throws.
  const username = ctx.from?.username;
  const displayFromTelegram = ctx.from?.first_name
    || (username ? `@${username}` : `User ${ctx.chat!.id}`);
  try {
    const newUser = redeemInvite({
      token,
      platform: 'telegram',
      platform_user_id: String(ctx.chat!.id),
      platform_username: username,
      display_name: invite.display_name || displayFromTelegram,
    });
    audit({
      agentId: AGENT_ID, chatId: ctx.chat!.id.toString(),
      action: 'invite.redeem',
      detail: `Redeemed ${invite.role} invite (id=${invite.id})`,
      blocked: false, actorUserId: newUser.id, targetUserId: newUser.id,
    });
    // Push the new user's per-chat menu so /whoami etc. show up.
    await refreshUserCommands(ctx.api, newUser).catch(() => {});
    await ctx.reply(
      `Welcome, ${newUser.display_name}. You're in as a ${newUser.role}. Run /whoami to see what you can do.`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    audit({
      agentId: AGENT_ID, chatId: ctx.chat!.id.toString(),
      action: 'invite.redeem',
      detail: `Redeem failed: ${msg}`,
      blocked: true, actorUserId: undefined,
    });
    await ctx.reply(`Could not redeem invite: ${msg}`);
  }
  return true;
}

// Suppress unused-import lint while keeping the explicit re-export
// surface obvious. deleteUser, grantAgent, revokeAgent, getOwner are
// part of step 5 even if their handlers ship in step 6 (CLI) and step 7
// (dashboard). Re-export them so callers don't have to chase imports.
export { deleteUser, grantAgent, revokeAgent, getOwner };
