# Multi-User Support — Design Doc

Status: **draft for review**. No code has been written yet. Stops here for sign-off.

Targets a single ClaudeClaw OS install supporting 2–20 humans on one machine, one DB, one bot per agent (existing model). Backwards compatible with today's single-user `.env`-driven install: an existing user's bot keeps working with zero config change after migration.

---

## 1. The single-user assumption today, in one paragraph

ClaudeClaw is locked to one human via `ALLOWED_CHAT_ID` (a single string in `.env`, resolved in `src/config.ts:84-85`). `src/bot.ts:335` is the gate: every handler calls `isAuthorised(chatId)` which compares against that scalar. The dashboard uses one shared `DASHBOARD_TOKEN` checked by `?token=` query string (`src/dashboard.ts:271-294`). The scheduler falls back to `ALLOWED_CHAT_ID` when a task fires (`src/scheduler.ts:86, 111-115, 151, 199-203`) because tasks have no triggering user. Memory, conversation log, sessions, mission tasks, scheduled tasks, hive_mind, token_usage, audit_log, and the encrypted `wa_messages`/`slack_messages`/`wa_outbox`/`wa_message_map` tables are all keyed by `chat_id` (or `agent_id`, or both) — but never by user identity. There's effectively one user per install today.

The good news: most data paths are already partitioned along `chat_id`. Multi-user mostly means (a) replacing the single allow-list scalar with a `users` table, (b) introducing a `user_id` foreign key alongside the existing `chat_id` (because chat_id is already the de-facto owner key, but we want explicit identity for permission decisions and so the chat_id can change without losing data), (c) adding permission checks at command and API entry points, and (d) making the dashboard token per-user.

---

## 2. Goals & non-goals

**Goals (recap from request).**

- Multiple authenticated Telegram users on one install. Roles: `owner`, `admin`, `staff`, `restricted`.
- Per-user enabled skills, agent grants, scheduled tasks, missions, memories, CLAUDE.md.
- Hive Mind / audit gated by role.
- Backwards compatible: single-user install keeps working without config changes; existing `ALLOWED_CHAT_ID` is auto-promoted to the `owner` row.
- Per-user dashboard auth.
- Existing tests pass; new tests cover the permission matrix.
- Existing CLIs extended with optional `--user` flags, never breaking shape.
- Encrypted message tables get `user_id`; 3-day retention sweep keeps working.
- Migrations additive and reversible, written as files in `migrations/<version>/<name>.ts` per the existing pattern.

**Non-goals.**

- Multi-tenancy beyond a single team/install. We are not building a SaaS multi-tenant boundary.
- Sandboxing the SDK's `bypassPermissions` per role. Out of scope per the safety rule. We keep `bypassPermissions = true` for every authenticated user and rely on skill-grant + role checks for access control, not on tool-level sandbox. **This is a deliberate trust decision documented below in §11.**
- One-bot-many-users. The recommendation in §3 is one-bot-per-agent (today's model) with users distinguishing via `chat_id`. Sharing a single bot across multiple humans is technically possible (Telegram delivers `from.id` per message even in a chat with the bot) but doesn't help — Telegram pairs each human with a unique `chat_id` against any given bot anyway, so we already get per-user separation for free.

---

## 3. One bot vs one bot per user

The user asked for the tradeoff. Recommendation: **keep the existing one-bot-per-agent model. Don't change bot topology.**

Telegram's `chat.id` is already unique per (bot, user) pair — when Alice and Bob both DM the `comms` agent's bot, the bot sees two distinct chat IDs and routes them separately. There is **nothing** in Telegram that requires a separate bot per human. The `users` table simply maps `telegram_chat_id → user_id → role` and the existing handler dispatch naturally fans out per-chat.

Tradeoffs of the rejected alternatives:

| Option | Pros | Cons |
|---|---|---|
| One bot per agent, many humans (recommended) | Zero new bot tokens. Handler code stays single-process per agent. Existing per-agent identity preserved. | Telegram bot displays one identity to all users. Fine for a small team. |
| One bot per human | Each human gets a uniquely-named bot. Cleaner identity. | 20 bot tokens × 5 agents = 100 BotFather bots. Operational nightmare. Not doing this. |
| One bot total, no agents | Simpler model | Loses the agent-routing core feature. Not a real option. |

Decision: keep the existing 1 bot ↔ 1 agent model. Add a `users` layer underneath that's chat-id keyed.

---

## 4. Permission model

Four roles. Closed permission set with a small `can(user, action, resource)` matrix.

```
owner       — install owner. Manages everyone. PIN-gated handoff.
admin       — manages staff. Cannot manage owner or other admins.
staff       — uses the bot. Sees own data only.
restricted  — read-only-ish; explicit grants required for anything.
```

Concrete `can()` examples (the permission table is enumerated below; `can()` is the runtime function call signature):

```ts
can(user, 'invite',          { role: 'staff' })            // owner|admin → true
can(user, 'invite',          { role: 'admin' })            // owner only
can(user, 'invite',          { role: 'owner' })            // false (handoff is a separate path)
can(user, 'role.change',     { target: someStaff })        // owner|admin → if target.role !== 'owner'
can(user, 'role.change',     { target: someAdmin })        // owner only
can(user, 'lockout',         { target: someStaff })        // owner|admin
can(user, 'lockout',         { target: someAdmin })        // owner only
can(user, 'skill.grant',     { skill: 'gmail' })           // owner|admin (admin scoped to staff)
can(user, 'skill.run',       { skill: 'gmail' })           // user_skills lookup
can(user, 'agent.delegate',  { agent: 'comms' })           // user_agents lookup
can(user, 'memory.read',     { memory: m })                // owner all; others if m.user_id === user.id
can(user, 'mission.create',  { agent: 'comms' })           // requires agent.delegate
can(user, 'audit.read',      {})                           // owner only
can(user, 'hive.read',       { scope: 'self' })            // any
can(user, 'hive.read',       { scope: 'team' })            // owner|admin
can(user, 'hive.read',       { scope: 'all' })             // owner only
can(user, 'dashboard.team',  {})                           // owner|admin
can(user, 'handoff',         {})                           // owner only + PIN
```

The full table lives in `src/users.ts` as a pure function — no DB calls inside `can()` for the leaf decision; the caller passes hydrated `User` and target objects in. Every `can(user, 'X', ...)` call that returns `false` writes one audit row with `blocked=1`. Every `true` for sensitive actions (anything that mutates another user, grants skills, changes roles) also writes an audit row with `blocked=0`.

`requireRole(user, role)` is sugar for `can()` plus a thrown `PermissionDeniedError`. Bot handlers catch it and return a friendly Telegram message; dashboard endpoints catch it and return 403.

---

## 5. Schema changes

All migrations are **additive**, every column has a sensible default so existing rows backfill, and the migration is reversible (each migration file ships an optional `rollback()` that drops the new column or table).

### 5.1 New tables

```sql
-- Single source of truth for user identity, role, status, lock state.
CREATE TABLE users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_chat_id    TEXT NOT NULL UNIQUE,
  telegram_username   TEXT,                              -- for display + @-mention resolution
  display_name        TEXT NOT NULL,
  role                TEXT NOT NULL CHECK (role IN ('owner','admin','staff','restricted')),
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','locked','pending')),
  pin_hash            TEXT,                              -- per-user PIN, salt:sha256 like SECURITY_PIN_HASH
  idle_lock_minutes   INTEGER,                           -- per-user override, NULL = use global
  dashboard_token     TEXT UNIQUE,                       -- per-user dashboard auth token
  created_at          INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  created_by          INTEGER REFERENCES users(id),      -- NULL for the owner
  last_active_at      INTEGER
);
CREATE INDEX idx_users_chat_id ON users(telegram_chat_id);
CREATE INDEX idx_users_dashboard_token ON users(dashboard_token);

-- Skills granted to each user. Presence = allowed; absence = denied.
-- Owner is implicitly granted all skills (no rows needed).
CREATE TABLE user_skills (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_name  TEXT NOT NULL,
  granted_by  INTEGER REFERENCES users(id),
  granted_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (user_id, skill_name)
);

-- Specialist-agent delegation rights. Owner gets all by default.
CREATE TABLE user_agents (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL,
  can_delegate  INTEGER NOT NULL DEFAULT 1,
  granted_by    INTEGER REFERENCES users(id),
  granted_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (user_id, agent_id)
);

-- Pending invites with one-time tokens. Created by /invite, redeemed by
-- the new user messaging the bot with the token (or PIN).
CREATE TABLE user_invites (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token         TEXT NOT NULL UNIQUE,            -- 16-byte hex
  invited_by    INTEGER NOT NULL REFERENCES users(id),
  role          TEXT NOT NULL,                   -- target role on accept
  display_name  TEXT,                            -- optional preset
  expires_at    INTEGER NOT NULL,                -- 7 days default
  redeemed_at   INTEGER,
  redeemed_by   INTEGER REFERENCES users(id)
);
CREATE INDEX idx_invites_token ON user_invites(token);
```

### 5.2 Add `user_id` columns

Every table that today implicitly belongs to "the one user" gets a nullable `user_id` foreign key. Backfill on migrate to the auto-created owner. Indexes added to keep filter-by-user fast.

```
sessions               + user_id INTEGER REFERENCES users(id)
memories               + user_id INTEGER REFERENCES users(id)
consolidations         + user_id INTEGER REFERENCES users(id)
scheduled_tasks        + user_id INTEGER REFERENCES users(id)
mission_tasks          + user_id INTEGER REFERENCES users(id)
                       + chat_id TEXT          -- this column is missing today (see §6)
conversation_log       + user_id INTEGER REFERENCES users(id)
token_usage            + user_id INTEGER REFERENCES users(id)
hive_mind              + actor_user_id INTEGER REFERENCES users(id)
audit_log              + actor_user_id INTEGER REFERENCES users(id)
                       + target_user_id INTEGER REFERENCES users(id)
wa_message_map         + user_id INTEGER REFERENCES users(id)
wa_outbox              + user_id INTEGER REFERENCES users(id)
wa_messages            + user_id INTEGER REFERENCES users(id)
slack_messages         + user_id INTEGER REFERENCES users(id)
```

Every column nullable in DDL but the application **requires** it on insert post-migration. Nullable to keep the migration painless; a v0.3.x cleanup migration can `NOT NULL` them later once we're sure backfill is complete.

Existing indexes (e.g. `idx_memories_chat`) stay. New compound indexes:

```sql
CREATE INDEX idx_memories_user      ON memories(user_id, created_at DESC);
CREATE INDEX idx_sched_user         ON scheduled_tasks(user_id, status, next_run);
CREATE INDEX idx_missions_user      ON mission_tasks(user_id, status, priority DESC, created_at ASC);
CREATE INDEX idx_convo_user         ON conversation_log(user_id, agent_id, created_at DESC);
CREATE INDEX idx_token_usage_user   ON token_usage(user_id, created_at DESC);
CREATE INDEX idx_hive_actor         ON hive_mind(actor_user_id, created_at DESC);
CREATE INDEX idx_audit_actor        ON audit_log(actor_user_id, created_at DESC);
```

### 5.3 Why both `chat_id` AND `user_id`?

Keeping both is deliberate. `chat_id` is the Telegram-side join key — every inbound message brings a chat_id, sessions are keyed by it (`sessions(chat_id, agent_id)`), and memories use it for retrieval scoping. Replacing it with `user_id` would force every retrieval site to do an extra lookup. Keeping both lets us (a) leave existing chat-keyed queries alone for performance, (b) handle the rare case where a user's `telegram_chat_id` changes (e.g. account migration) without losing their data, and (c) keep the per-chat-id session resumption semantics that Claude Code's SDK expects.

The relationship is `users.telegram_chat_id` UNIQUE → 1:1 today, but if a user's chat_id ever changes we update the users row and all `chat_id`-keyed historical rows continue to belong to that user via their `user_id`.

### 5.4 Schema changes for `mission_tasks`

`mission_tasks` doesn't carry `chat_id` today (see scheduler.ts:151, where it falls back to `ALLOWED_CHAT_ID`). Multi-user requires both `user_id` AND `chat_id` on each mission task so the scheduler can route the result back to the right Telegram chat without consulting env. New columns:

```
mission_tasks  + user_id  INTEGER REFERENCES users(id)
               + chat_id  TEXT
```

### 5.5 Migration files (mirroring the existing pattern)

```
migrations/
  version.json                              -- registry, currently empty
  0.1.0/
    001-create-users-table.ts
    002-promote-allowed-chat-id-to-owner.ts -- creates the owner row from .env
    003-add-user-id-columns.ts              -- ALTER ADD COLUMN ... (idempotent via PRAGMA)
    004-backfill-user-id-to-owner.ts        -- UPDATE every table SET user_id = <owner.id>
    005-create-user-skills-and-agents.ts
    006-create-user-invites.ts
    007-add-mission-chat-id.ts
```

`version.json` becomes:

```json
{ "migrations": { "0.1.0": [
  "001-create-users-table",
  "002-promote-allowed-chat-id-to-owner",
  "003-add-user-id-columns",
  "004-backfill-user-id-to-owner",
  "005-create-user-skills-and-agents",
  "006-create-user-invites",
  "007-add-mission-chat-id"
]}}
```

Each migration file exports `{ description: string, run: () => Promise<void>, rollback?: () => Promise<void> }`. Rollback drops added columns/tables; not destructive to historical data because we never DELETE in these migrations.

The migrate.ts driver already does pre-migration backups (`store/claudeclaw.db.pre-0.1.0.bak`) and rotates 3 deep, so we get cheap recovery for free.

---

## 6. Upgrade path for existing installs

The hard requirement: an existing single-user install must keep working after migration with zero config changes.

Flow on first start after upgrade:

1. **`src/migrations.ts:checkPendingMigrations`** detects pending migrations → bot won't start, prints "run `npm run migrate`" — same as today.
2. **`npm run migrate`** runs `0.1.0/001-create-users-table` etc.
3. **`002-promote-allowed-chat-id-to-owner`**: reads `.env` → if `ALLOWED_CHAT_ID` is set AND `users` table is empty, INSERT a row:
   ```
   role='owner', status='active', telegram_chat_id=<env value>,
   display_name=<env username if known else "Owner">,
   created_by=NULL,
   pin_hash=<copy from SECURITY_PIN_HASH>,
   idle_lock_minutes=<copy from IDLE_LOCK_MINUTES>,
   dashboard_token=<copy from DASHBOARD_TOKEN>
   ```
4. **`004-backfill-user-id-to-owner`** sets `user_id = <owner.id>` on every existing row.
5. Migrations applied; bot starts; everything that used to work still works because the owner row is wired up identically to the old single-user.
6. The owner can now run `/invite @bob staff` from Telegram or open the dashboard's new "Team" panel to add staff.

**Auto-create on bootstrap if migration race:** as a belt-and-braces, `src/bot.ts` calls `ensureOwnerExists()` at startup. If the migration didn't fire (e.g. user pulled the new code but didn't run migrate, or `ALLOWED_CHAT_ID` was added later), and there are no rows in `users`, but `ALLOWED_CHAT_ID` is set, create the owner row inline and continue. This makes the upgrade path bulletproof against ordering surprises.

**.env stays the same.** `ALLOWED_CHAT_ID`, `DASHBOARD_TOKEN`, `SECURITY_PIN_HASH`, `IDLE_LOCK_MINUTES` are all preserved; they become the defaults the owner inherits. Once the `users` table exists, the source of truth shifts to the row, and `.env` becomes a fallback only used during upgrade.

**For new installs:** setup wizard asks "single user or team?" — if single-user, behaves exactly as today. If team, walks through creating the owner first (display name, optional PIN, optional dashboard token), then loops to invite staff, mirroring the existing agent-creation loop in `scripts/setup.ts:1010-1126`.

---

## 7. Files I'll touch (the full inventory)

### 7.1 New files

```
src/users.ts                  # the heart — User type, can(), requireRole(), CRUD
src/users.test.ts             # unit + permission-matrix tests
src/user-config.ts            # mirrors src/agent-config.ts — load per-user CLAUDE.md
src/user-create.ts            # mirrors src/agent-create.ts — provision a user
src/user-create-cli.ts        # mirrors src/agent-create-cli.ts — npm run user:add
src/permissions.ts            # the resolveUser middleware + shared helpers
src/permissions.test.ts
users/_template/CLAUDE.md     # template per-user CLAUDE.md
docs/multi-user-design.md     # this file
docs/multi-user-guide.md      # walkthrough for owners

migrations/0.1.0/001-create-users-table.ts
migrations/0.1.0/002-promote-allowed-chat-id-to-owner.ts
migrations/0.1.0/003-add-user-id-columns.ts
migrations/0.1.0/004-backfill-user-id-to-owner.ts
migrations/0.1.0/005-create-user-skills-and-agents.ts
migrations/0.1.0/006-create-user-invites.ts
migrations/0.1.0/007-add-mission-chat-id.ts
migrations/version.json       # add 0.1.0 entry
```

### 7.2 Modified files

| File | Changes |
|---|---|
| `src/config.ts` | Keep `ALLOWED_CHAT_ID` export but mark as fallback. Add a default for `users/<id>/CLAUDE.md` lookup path. |
| `src/db.ts` | Add User CRUD next to existing CRUD. New `users.*` helpers, `user_skills.*`, `user_agents.*`, `user_invites.*`. New scoping params on existing functions: `searchMemories(..., userId?)`, `getRecentConversation(..., userId?)`, `createScheduledTask(..., userId)`, `createMissionTask(..., userId, chatId)`, etc. Default-undefined to keep existing callers compiling. Old `chat_id`-only paths still work for migration period. Audit log helpers gain `actorUserId` + `targetUserId`. Pruning of `wa_*`/`slack_*` already by `created_at`; nothing changes there besides the new column being preserved. |
| `src/bot.ts` | Replace `isAuthorised(chatId)` with `resolveUser(chatId): User \| null`. Every handler hydrates a `User` once at the top and passes it down. New per-user `setMyCommands` calls (Telegram supports `BotCommandScopeChat` — we set per-chat menus when a user authenticates). New commands: `/invite`, `/users`, `/grant`, `/revoke`, `/role`, `/whoami`, `/lockout`, `/handoff`. Every existing command's first line becomes `const user = requireUser(ctx); if (!user) return;`. The `audit({...})` helper signature gains `actorUserId`. The high-importance memory callback (line 858-863) becomes per-user; iterates `users` and only sends to that user. |
| `src/agent.ts` | `runAgent()` signature gains `chatId` and `userId` (currently only takes `sessionId`). The SDK `cwd` becomes per-user when a `users/<chat_id>/CLAUDE.md` exists, else per-agent (today's behavior). MCP allowlist resolution can incorporate per-user toggles later. **`bypassPermissions` stays true** (per safety rule). |
| `src/scheduler.ts` | Replace the six `ALLOWED_CHAT_ID` references with reads from the task row's `user_id` → `chat_id`. `scheduledTask.user_id` becomes mandatory on insert post-migration; old rows already backfilled to the owner. Mission task rows now carry `chat_id` directly so we don't need env fallback at all. |
| `src/memory.ts` | `buildMemoryContext()` gains optional `userId`; passes through to `db.searchMemories(..., userId)` etc. Cross-agent team-activity (Layer 4) gets a role check: staff sees only their own; admins see team; owner sees everything. |
| `src/orchestrator.ts` | `delegateToAgent()` checks `can(user, 'agent.delegate', { agent })` before queuing. Added `actorUserId` to inter-agent task rows. |
| `src/dashboard.ts` | Replace single-token middleware with per-user token lookup against `users.dashboard_token`. Every `/api/*` handler hydrates the requesting `User` and filters queries by `user_id`. Cross-user endpoints (audit, hive, agent registry) gated by `requireRole`. New routes under `/api/team/*`. Per-user SSE on `/api/chat/stream`. |
| `src/skill-registry.ts` | Add `getSkillIndex(userId?)`, `getAllSkills(userId?)` that filter through `user_skills` for non-owner. The flat-file skill loader stays unchanged; filtering happens at the public accessor. |
| `src/schedule-cli.ts` | New optional `--user <chat_id_or_username>` flag. Defaults to env `CLAUDECLAW_USER_ID`, then to the owner. |
| `src/mission-cli.ts` | Same pattern: `--user <chat_id_or_username>` flag. |
| `src/agent-create-cli.ts` | No structural changes; a created agent is a system-wide resource. |
| `scripts/setup.ts` | New "single user vs team" branch around line 240. If team, owner-creation prompt; then optional staff-invite loop (mirrors agents loop at 1010-1126). For existing installs (detected by `users` table being non-empty already from migration), offer "upgrade dialog" that walks through inviting the first additional staff member. |
| `scripts/migrate.ts` | No code changes — the existing migrate driver already supports per-version files. We just add migration files in the directory. |
| `package.json` | New scripts: `user:add`, `user:list`, `user:remove`. |
| `.env.example` | Add a comment block above `ALLOWED_CHAT_ID` saying "Multi-user installs: this becomes the auto-created `owner`. Manage additional users via `/invite` in Telegram or `npm run user:add`." Don't change `ALLOWED_CHAT_ID` itself. |
| `README.md` | New `## Multi-user` section between `## Security` (line 1508) and `## Troubleshooting` (line 1573), mirroring the existing security-table format. Update the "Do not expose it to untrusted users" caveat at line 1525 to point at the new model. Update `## Creating a Team of Agents` cross-link. |
| `CLAUDE.md.example` | Adds a sentence noting that per-user CLAUDE.md files at `users/<chat_id>/CLAUDE.md` override this one. |

---

## 8. The bot wiring in detail

The single most important change. Every handler today reads `ctx.chat.id` and runs it through `isAuthorised`. Replace with `resolveUser`:

```ts
// src/permissions.ts
export interface BotUser {
  id: number;
  telegram_chat_id: string;
  display_name: string;
  role: 'owner' | 'admin' | 'staff' | 'restricted';
  status: 'active' | 'locked' | 'pending';
  pin_hash: string | null;
  idle_lock_minutes: number | null;
  dashboard_token: string | null;
}

export function resolveUser(chatId: number | string): BotUser | null {
  // 1. Look up by telegram_chat_id
  // 2. If not found AND ALLOWED_CHAT_ID matches AND users table empty → bootstrap owner inline
  // 3. If not found AND chat_id matches a pending invite → return null (handler routes to redemption flow)
  // 4. Otherwise return null
}

export async function requireUser(ctx: Context): Promise<BotUser | null> {
  const user = resolveUser(ctx.chat!.id);
  if (!user) {
    // first-run, invite redemption, or unauthorised — caller decides
    return null;
  }
  if (user.status === 'locked') {
    await ctx.reply('Your account is locked. Ask an admin to reactivate.');
    audit({ action: 'denied.locked', actorUserId: user.id, ... });
    return null;
  }
  // ... idle / PIN check inline, mirrors existing securityGate()
  return user;
}
```

`bot.command(...)` handlers become:

```ts
bot.command('memory', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  if (!can(user, 'memory.read', { scope: 'self' })) return;
  // ... uses user.id everywhere chat_id was used implicitly
});
```

**Per-chat command menus.** Telegram's `setMyCommands` accepts a `scope` parameter. We call `bot.api.setMyCommands(commandsForUser(user), { scope: { type: 'chat', chat_id: user.telegram_chat_id }})` once per user when:
- they first authenticate after migration,
- their grants change (skill grant/revoke, role change),
- the bot starts up (re-broadcast for everyone with `status='active'`).

`commandsForUser(user)` returns the built-in commands the user's role permits + the skills they have grants for. Owner always sees everything; staff sees only granted skills.

**The audit firehose.** Every `can()` check that returns false writes one `audit_log` row with `blocked=1` and the action label. Every state-changing `can()=true` for sensitive actions also writes a row with `blocked=0`. The `audit()` helper signature becomes:

```ts
audit({
  agentId, chatId,                  // existing fields
  actorUserId,                      // new
  targetUserId,                     // new, for cross-user actions
  action,                           // existing
  detail,                           // existing
  blocked,                          // existing
});
```

---

## 9. Per-user CLAUDE.md

Mirror the agent layout:

```
users/
  _template/
    CLAUDE.md                       # bare template
  <chat_id>/
    CLAUDE.md                       # personal context
```

`src/user-config.ts` (mirrors `src/agent-config.ts:65-87`) does dual-lookup:

1. `<CLAUDECLAW_CONFIG>/users/<chat_id>/CLAUDE.md` (preferred, outside repo, like personal agent configs today)
2. `<PROJECT_ROOT>/users/<chat_id>/CLAUDE.md` (fallback)
3. If neither exists → fall back to the agent's `CLAUDE.md`. Today's behavior preserved.

`runAgent()` gains an optional `userClaudeMdPath` argument. Caller (the bot handler) resolves the user's CLAUDE.md path and passes it; agent.ts sets the SDK `cwd` to a temporary working dir or splices the per-user file into the prompt — preferred approach is **a per-user `cwd`**, since the SDK already loads `<cwd>/CLAUDE.md` via `settingSources: ['project']` (`src/agent.ts:233-239`).

Practical implementation: `<PROJECT_ROOT>/users/<chat_id>/` is the SDK cwd when a user CLAUDE.md exists; the directory contains a symlink or copy of the agent's other context files (or just CLAUDE.md alone — the SDK only auto-loads CLAUDE.md from the cwd). Specifically:

- If `users/<chat_id>/CLAUDE.md` exists → cwd = `users/<chat_id>/`.
- Else → cwd = current per-agent default (today's behavior).

This is a 5-line change to agent.ts: `cwd: userCwd ?? agentCwd ?? PROJECT_ROOT`.

---

## 10. Dashboard

Today: one `DASHBOARD_TOKEN`, query-string auth, no identity. Tomorrow: per-user token, per-user identity threaded through every handler.

**Auth.** Each user's row carries a `dashboard_token` (random 32-byte hex). The middleware (`src/dashboard.ts:271-294`) becomes:

```ts
app.use('/api/*', async (c, next) => {
  const token = c.req.query('token') ?? c.req.header('Authorization')?.replace(/^Bearer /, '');
  if (!token) return c.json({ error: 'Auth required' }, 401);
  const user = lookupUserByDashboardToken(token);
  if (!user) return c.json({ error: 'Invalid token' }, 401);
  if (user.status !== 'active') return c.json({ error: 'Account locked' }, 403);
  c.set('user', user);
  await next();
});
```

**Per-handler scoping.** Every `/api/*` handler reads `c.get('user')` and uses it. Today's flat list of routes from §`dashboard.ts inventory` becomes role-aware:

| Route family | Multi-user behavior |
|---|---|
| `/api/memories*`, `/api/tokens`, `/api/chat/history`, `/api/agents/:id/conversation`, `/api/agents/:id/tokens` | Filter by `user_id`. Ignore `?chatId=` query param (it was the old multi-tenant escape hatch) — owner can override via `?onBehalfOf=<userId>` for support purposes; emits an audit row. |
| `/api/tasks*`, `/api/mission/tasks*`, `/api/mission/history` | Filter by `user_id`. Owner sees all when `?all=1` is passed. |
| `/api/audit*` | Owner-only. Admin gets a scoped view via `/api/team/audit/:userId`. |
| `/api/hive-mind` | Staff sees only `actor_user_id = self`. Admin sees their team. Owner sees everything. |
| `/api/agents*` (list, create, deactivate, model, files, suggestions) | Owner-only. The agent registry is install-wide. |
| `/api/dashboard/settings` | Per-user. Settings keyed by `user_id`. Migration namespaces existing rows under owner. |
| `/api/security/*` | Owner-only. |
| `/api/warroom/*` | Existing chat-scoping (`requireChatMatches`) is reused; the chat is now backed by `user_id`. Voice warroom remains owner-only (single Pipecat backend; multi-user voice is out of scope). |
| `/api/team/*` (NEW) | Owner+admin. Endpoints: `GET /users`, `POST /users/invite`, `PATCH /users/:id/role`, `POST /users/:id/lockout`, `POST /users/:id/skills/:skill`, `DELETE /users/:id/skills/:skill`, `GET /users/:id/audit` (admin → only their team). |
| `/api/chat/stream` (SSE) | Currently broadcasts every event to every connected client (line 2861). Becomes per-user filtered: events tagged with `userId`, the SSE stream only forwards events whose `userId` matches `c.get('user').id` (or all events for owner). |

**UI.** The SPA reads `c.get('user')` from a new `GET /api/me` endpoint (returns role + grants + display_name) and conditionally renders the new "Team" panel. The token still rides in `?token=` so existing bookmarks keep working — they just resolve to a user instead of "the dashboard."

---

## 10b. Process-global state that needs to become per-user

The bot.ts read surfaced three process-singletons that need attention beyond the `ALLOWED_CHAT_ID` migration:

1. **PIN lock (`src/security.ts`).** `isLocked()`, `lock()`, `unlock()`, `touchActivity()` are process-wide. Today when the owner `/lock`s, the bot has no other users so it's fine. Multi-user: one user `/lock`-ing must NOT lock everyone else. Fix: replace the module-level `_locked` boolean with a `Map<userId, LockState>`. Each function gains a `userId` argument. The migration backfills existing single-user `_locked` to the owner. `replyIfLocked(ctx, user)` becomes the per-user version. PIN lock is the most important security primitive on the bot, so this MUST be per-user — keeping it global would let any staff member halt the owner's bot.

2. **Rate tracker (`src/rate-tracker.ts`).** Process-wide cost/token budgets. Decision: **keep these global** because the budget is "money this install spends per day" and the install pays one Anthropic bill. Per-user rate limits can be added later as a separate feature; not in scope here. We DO need to record `actor_user_id` on rate events for audit and per-user attribution in the dashboard, but the limit enforcement stays global.

3. **`setMainModelOverride(model)` (bot.ts:133).** Today writes to `ALLOWED_CHAT_ID` only. Becomes `setModelOverride(chatId, model)` — keep the existing `chatModelOverride: Map<string,string>` keyed by chat_id, just change the exported helper signature. `/model` already calls `chatModelOverride.set(chatIdStr, model)` per-chat at bot.ts:1037ish so the in-memory side is fine; only the exported boot helper needs the signature change.

4. **First-run `.env` auto-writer (bot.ts:381-406).** Today an unconfigured bot accepts the first message, writes `ALLOWED_CHAT_ID` to `.env`, and `process.exit(0)` to restart. In multi-user, an unrecognised chat_id is either (a) the owner during fresh install, (b) a pending invite redemption, or (c) unauthorised. Replace the auto-write+exit with a router:
   - If `users` table empty AND no `ALLOWED_CHAT_ID` in env → bootstrap: create owner row inline from this chat, no restart needed.
   - If unrecognised chat_id AND there's an unredeemed invite token in the message (e.g. `/start <token>`) → redeem.
   - Otherwise → silent reject + audit row.

5. **WhatsApp / Slack bridges.** These are singleton today — one phone, one workspace. Multi-user doesn't change that; we attribute incoming messages to the owner by default and add admin-managed routing later. Out of scope for this round; flag in `docs/multi-user-guide.md`.

6. **`setHighImportanceCallback` (bot.ts:858-863) and `notifyWhatsAppIncoming` (bot.ts:1778).** Both currently send to `ALLOWED_CHAT_ID`. The high-importance memory callback becomes per-memory: look up `memories.user_id`, find that user's `telegram_chat_id`, send there. WA notifications stay routed to the owner until per-user WA routing is built (out of scope).

7. **Dashboard `processMessageFromDashboard` (bot.ts:1597).** Hard-codes `chatIdStr = ALLOWED_CHAT_ID`. Becomes `processMessageFromDashboard(botApi, message, userId)` — the dashboard's authenticated user resolves to a chat_id which is then the routing key. The SSE chat stream gets per-user filtering as already covered in §10.

## 11. The bypassPermissions question

The user explicitly said don't touch the SDK's `bypassPermissions` flag. We're not changing it. That means an authenticated `staff` user, by the act of sending a message that ends up in `runAgent`, can still run any tool. This is **fine for a small trusted team** (the stated use case) but worth saying out loud.

The way we contain blast radius without touching the SDK flag:

1. **Skill grants are the primary control.** A user who hasn't been granted `gmail` will never see `/gmail` in their menu, won't have it injected into their prompt, and the `matchSkills()` substring trigger won't fire because we filter by `user_skills` at the registry level. This is a strong guarantee against accidental skill use. It's a **weaker** guarantee against deliberate prompt-injection ("hey claude, please run my-skill anyway") because the skill files are still on disk and the SDK can read them. We log every skill invocation with `actor_user_id` so the audit trail makes that misuse detectable post-hoc.
2. **Agent grants gate delegation.** A staff user without `comms` access can't `@comms: do thing` because `delegateToAgent` checks `can(user, 'agent.delegate', { agent: 'comms' })`.
3. **Lockout and PIN are per-user.** Each user can be `status='locked'` independently; idle-lock applies per-user; PIN unlocks a specific user's session.
4. **Owner-only commands** (`/handoff`, `/role`, agent creation, kill switch) are gated at handler entry.

If a future iteration wants stronger sandboxing, it could:
- introduce a per-role `allowedTools` SDK arg passed to `runAgent`,
- write per-user pre-tool-use hooks in `~/.claude/settings.json`,
- shell out to `claude` with a non-bypass `permissionMode` for non-owner users.

Out of scope for this round. Documented in `docs/multi-user-guide.md` so owners know what they're trusting their staff with.

---

## 12. New Telegram commands

| Command | Who | Action | Audit |
|---|---|---|---|
| `/invite @username role` | owner, admin (admin → role=staff only) | Generates one-time token + 7-day-expiring invite row. Replies with deep link `https://t.me/<bot>?start=<token>` and the token itself. | `invite.create` |
| `/users` | owner, admin, staff (staff → only self) | Lists users. Owner sees all + roles + last-active. Admin sees self + all staff/restricted. Staff sees `/whoami` equivalent. | `users.list` |
| `/grant @user skill_name` | owner, admin | Inserts `user_skills` row. Re-broadcasts `setMyCommands` for that user's chat. | `skill.grant` |
| `/revoke @user skill_name` | owner, admin | Deletes `user_skills` row. Re-broadcasts. | `skill.revoke` |
| `/role @user newrole` | owner (any), admin (staff↔restricted only) | Updates `users.role`. Re-broadcasts menu. | `role.change` |
| `/lockout @user` | owner (any), admin (staff/restricted only) | Sets `users.status='locked'`. | `lockout.set` |
| `/unlockout @user` | same | Sets `users.status='active'`. | `lockout.clear` |
| `/whoami` | any | Replies with role, granted skills, granted agents, last-active. | `whoami` |
| `/handoff @user` | owner only | Two-step: `/handoff @newowner` → bot replies "send your PIN to confirm." Next message is the PIN. On match, atomically swaps roles (old owner → admin, new owner → owner). PIN required even if owner has no PIN — we generate one inline and require it via the dashboard once first. | `handoff` (always logged, even on PIN failure) |

`/start <token>` (the existing `bot.command('start')`) gains a token-redemption branch: if the user is unauthorised AND a `?start=<token>` payload arrived, look up `user_invites.token`, promote the inviter's pending row to active, set `telegram_chat_id` from the redeemer's chat, and reply with welcome text.

---

## 13. CLI extensions

Backwards-compat rule: existing positional args and flags don't move; `--user` is added everywhere as an optional flag with the same parse-and-strip pattern used today for `--agent` (`src/schedule-cli.ts:30-37`).

```
node dist/schedule-cli.js create "PROMPT" "CRON" [--user <chat_id_or_username>] [--agent <id>]
node dist/mission-cli.js  create "PROMPT" [--user <chat_id_or_username>] [--agent <id>] [--title ...] [--priority N]

# new helpers
node dist/user-create-cli.js list
node dist/user-create-cli.js add --chat-id 12345 --name "Alice" --role staff
node dist/user-create-cli.js remove <user-id-or-chatid>
node dist/user-create-cli.js grant <user> <skill>
node dist/user-create-cli.js revoke <user> <skill>
```

Default for `--user` is `process.env.CLAUDECLAW_USER_ID` then the auto-created owner. So existing scripts that don't pass `--user` keep working — they implicitly target the owner, which is the same human as before.

`package.json` gets:

```json
"user:list":   "tsx src/user-create-cli.ts list",
"user:add":    "tsx src/user-create-cli.ts add",
"user:remove": "tsx src/user-create-cli.ts remove"
```

---

## 14. Encrypted message tables + retention

The existing `pruneWaMessages(retentionDays=3)` and `pruneSlackMessages(retentionDays=3)` (`src/db.ts:1427` and `:1452`) operate on `created_at`. Adding `user_id` columns doesn't break this — pruning is still time-keyed. Each user's messages get pruned on the same 3-day cycle automatically.

For per-user retrieval (e.g. `/wa` and `/slack` commands), the queries gain a `user_id` filter. Existing message records get backfilled to the owner so the owner's `/wa` and `/slack` work unchanged after migration.

Encryption key (`DB_ENCRYPTION_KEY`) stays single-key; encrypting per-user with separate keys was considered and rejected — the security boundary is the host filesystem, and adding multi-key derivation here adds complexity without changing the threat model (a host compromise gets every user's data anyway).

---

## 15. Test plan

**Existing tests** must keep passing. The `_initTestDatabase()` helper (`src/db.ts:739-746`) creates a fresh in-memory DB and now also runs the new migrations; existing tests get an auto-created `system` user with `id=1, role='owner'` so they don't have to know anything about users. We add a `_initTestUser()` helper for tests that want to assert per-user behavior.

**New tests:**

- `src/users.test.ts`
  - `can()` matrix: 16+ cases covering owner/admin/staff/restricted × every action.
  - Role-change forbids self-demotion when last owner.
  - Handoff atomicity (rolls back on PIN failure).
- `src/permissions.test.ts`
  - `resolveUser()` happy path.
  - `resolveUser()` with `ALLOWED_CHAT_ID` fallback when `users` table empty (the upgrade-bootstrap path).
  - Pending invite redemption flow.
  - Lockout enforcement.
- `src/bot.test.ts` (new cases added)
  - Each new command returns a denial message + audit row when caller lacks permission.
  - `setMyCommands` is called with the per-chat scope on grant changes.
- `src/dashboard.contract.test.ts` (new cases)
  - Cross-user data leak: `staff` token can't access `owner`'s memories.
  - `/api/team/users` invisible to staff.
  - SSE filtering: events for other users not delivered.
- `src/scheduler.test.ts`
  - Scheduled task fires with `user_id` from row, not env.
  - Mission task carries `chat_id` directly.
- `migrations/0.1.0/*.test.ts`
  - 002: missing `ALLOWED_CHAT_ID` → migration succeeds without creating an owner (fresh install path).
  - 002: present `ALLOWED_CHAT_ID` → owner created with expected fields.
  - 004: backfill correctness on a populated test DB.

After every step in the implementation plan, the existing test suite plus new tests must pass via `npm run typecheck && npm test && npm run build` (per the user's safety rule).

---

## 16. Open questions for review

These are the decisions I want explicit thumbs-up on before writing any code.

1. **Bot topology.** Confirming the recommendation: keep one bot per agent, each routing N humans by chat_id. (Alternative: one bot per human per agent — explicitly rejected as operationally awful.)

2. **`mission_tasks` getting `chat_id`.** I'm proposing this column gets added (not just `user_id`). It removes the only remaining `ALLOWED_CHAT_ID` fallback in `src/scheduler.ts`. OK?

3. **Owner skill grants implicit?** Plan: owner row has no `user_skills` rows because they have everything. `getSkillsForUser(owner)` returns the full registry. Alternative: insert one `user_skills` row per skill at promotion time. The implicit version is cleaner; the explicit version makes audit trail more uniform. I lean **implicit** unless you'd rather see explicit.

4. **`bypassPermissions` for non-owner users.** Confirmed in safety rule: don't touch. So staff/restricted users still run the SDK with full bypass after authentication. Skill/agent grants are the primary control. Documented in §11. **Confirm this is acceptable for a 2–20 person trusted team** — if not, we need a separate design pass on per-role tool allowlisting, which is a much bigger change.

5. **Per-user PIN.** Spec says "optional per-user PIN." I'll implement it as: each user can `/setpin <new>` to set/change their own; admin can force a reset; owner's PIN is required for `/handoff`. OK to require PIN on handoff even if owner never set one (we'd prompt them to set one first)?

6. **Restricted role definition.** I'm reading "restricted" as "explicit-grant for everything, including basic chat with the main agent." So a fresh `restricted` user can do nothing by default; admin grants them `agent.delegate:main` and skills one by one. Confirm this matches what you want, vs a softer "restricted = staff minus skill grants" interpretation.

7. **Dashboard `?onBehalfOf`** for owner support actions on staff data. I propose owner can append `?onBehalfOf=<userId>` to any `/api/memories`-class endpoint to view that user's data, with an audit row written every time. OK or do you want this strictly behind a separate `/api/team/users/:id/memories` route?

8. **Migration version bump.** I want to land this as `0.1.0` (the first real entry in `migrations/version.json`). Today the registry is empty. Confirm this version label is fine or you want `0.0.1` etc.

9. **Per-user `last_active_at`.** Updated on every authenticated message? Cheap (one UPDATE). Alternative is a debounced update every 60s. I lean every-message — it's a single indexed UPDATE, no cost worth optimising.

10. **Existing `wa_message_map` PK.** Today it's `telegram_msg_id` only. Adding `user_id` doesn't conflict with the PK but means two users replying to the same telegram message could collide. In practice each user has their own outbound msg_ids per chat so this is fine. Flagging for the record.

11. **Per-user PIN lock vs global.** Confirming the §10b decision: lock state moves from process-global to per-user (`Map<userId, LockState>`). One user locking does not lock everyone. The existing `EMERGENCY_KILL_PHRASE` stays global — a kill phrase from anyone tears the install down (same blast radius as today, intentionally).

12. **Rate tracker stays global.** Daily cost / hourly token budgets remain process-wide. We record `actor_user_id` per event for attribution but the limit enforcement is one bucket. Sound, or do you want per-user budgets in this round?

13. **WhatsApp/Slack bridges stay singleton.** Out of scope for this iteration. WA incoming notifications continue to route to owner. Confirming this is acceptable.

---

## 17. Phased delivery

Mirrors the steps in the user's request; each phase ends with `npm run typecheck && npm test && npm run build` green and a separate commit so any phase can be reverted independently.

1. **Plan only** — this doc. Stop here for review. (current step)
2. Schema + migrations + `src/users.ts` + tests.
3. Bot wiring: `resolveUser`, per-user audit fields, per-chat command menus.
4. Downstream: `agent.ts`, `scheduler.ts`, `memory.ts`, `orchestrator.ts`, per-user CLAUDE.md.
5. New commands: `/invite`, `/users`, `/grant`, `/revoke`, `/role`, `/whoami`, `/lockout`, `/handoff`.
6. CLI + setup wizard.
7. Dashboard.
8. Tests + docs.
