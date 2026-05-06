/**
 * Step-4 orchestrator permission gate. delegateToAgent enforces
 * can(actor, 'agent.delegate', { agent }) when the caller passes a
 * user; returns PermissionDeniedError otherwise. Specialist agents
 * require explicit grants for non-owner actors.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from './db.js';
import { createUser, grantAgent, getUserById } from './users.js';
import { delegateToAgent } from './orchestrator.js';
import { PermissionDeniedError } from './users.js';

describe('delegateToAgent permission gate (step 4)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('throws PermissionDeniedError when staff tries to delegate to a specialist without grant', async () => {
    const id = createUser({
      platform: 'telegram', platform_user_id: '1',
      display_name: 'Staff', role: 'staff',
    });
    const staff = getUserById(id)!;
    await expect(
      delegateToAgent('comms', 'do something', '1', 'main', undefined, undefined, staff),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('throws when restricted tries to delegate even to main without grant', async () => {
    const id = createUser({
      platform: 'telegram', platform_user_id: '1',
      display_name: 'Restricted', role: 'restricted',
    });
    const restricted = getUserById(id)!;
    await expect(
      delegateToAgent('main', 'hello', '1', 'main', undefined, undefined, restricted),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('does not throw the permission error when no actor is supplied (back-compat)', async () => {
    // Without actor we should NOT see PermissionDeniedError. The call
    // may still fail later (registry miss etc.) but we want to confirm
    // the gate is the only thing that distinguishes the actor-less
    // legacy path from the actor-supplied gated path.
    let err: unknown;
    try {
      await delegateToAgent('comms', 'x', '1', 'main', undefined, undefined);
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeInstanceOf(PermissionDeniedError);
  });

  it('does not throw the permission error when staff has the grant', async () => {
    const id = createUser({
      platform: 'telegram', platform_user_id: '1',
      display_name: 'Staff', role: 'staff',
    });
    grantAgent(id, 'comms');
    const staff = getUserById(id)!;
    let err: unknown;
    try {
      await delegateToAgent('comms', 'x', '1', 'main', undefined, undefined, staff);
    } catch (e) {
      err = e;
    }
    // The call may still fail because the comms agent's config isn't
    // present in tests — but it must NOT be a PermissionDeniedError.
    expect(err).not.toBeInstanceOf(PermissionDeniedError);
  });
});
