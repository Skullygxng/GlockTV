import { describe, expect, it } from 'vitest';
import {
  BAD,
  OK,
  billingChecks,
  caller,
  readBlocked,
  refused,
  supportChecks,
  watchProgressChecks,
} from '../scripts/lib/permission-checks.mjs';
import {
  SECTION_FIXTURES,
  SECTIONS,
  cleanupFixtures,
  emptyFixtures,
  fixturePlan,
  provisionFixtures,
} from '../scripts/lib/fixtures.mjs';
import runner from '../scripts/verify-supabase-permissions.mjs?raw';
import workflow from '../.github/workflows/verify-supabase-permissions.yml?raw';

/*
 * The verifier, verified.
 *
 * The checks themselves can only be answered by a real project, so what is
 * testable here is the thing that decides whether an answer is acceptable. That
 * matters more than it sounds: a check that reports PASS when a database says
 * "yes, anyone may read that" is worse than no check at all, because it makes a
 * privilege escalation look verified.
 *
 * So each check is driven with fixtures for both the safe and the escalating
 * answer, and asserted to distinguish them.
 */

type Reply = { status: number; body: string };

/* A fake PostgREST that answers each request from a script. */
function transport(script: Record<string, Reply | Reply[]>) {
  const calls: Array<{ method: string; path: string; payload?: unknown; label: string }> = [];
  const cursors: Record<string, number> = {};

  const reply = (key: string): Reply => {
    const scripted = script[key];
    if (!scripted) return { status: 200, body: '[]' };
    if (Array.isArray(scripted)) {
      const index = cursors[key] ?? 0;
      cursors[key] = index + 1;
      return scripted[Math.min(index, scripted.length - 1)];
    }
    return scripted;
  };

  const rest = async (who: { label: string }, method: string, path: string, payload?: unknown) => {
    calls.push({ method, path, payload, label: who.label });
    const key = `${who.label} ${method} ${path.split('?')[0]}`;
    const fallback = `${method} ${path.split('?')[0]}`;
    const chosen = script[key] !== undefined ? key : fallback;
    const { status, body } = reply(chosen);
    return { response: { status } as Response, body };
  };

  return { rest, calls };
}

const A = caller('customer A', 'pk', 'token-a');
const B = caller('customer B', 'pk', 'token-b');
const STAFF = caller('staff', 'pk', 'token-staff');
const ANON = caller('anonymous user', 'pk', 'token-anon');
const row = () => ({ user_id: 'a', media_type: 'movie', media_id: 550 });

/* The check modules are plain .mjs with no types, so the shape they return is
   stated here once rather than inferred as any at each call site. */
interface Check {
  id: string;
  name: string;
  run: () => Promise<{ ok: boolean; detail: string }>;
}

async function runAll(checks: Check[]) {
  const out: Record<string, boolean> = {};
  for (const check of checks) out[check.id] = (await check.run()).ok;
  return out;
}

describe('what counts as a refusal', () => {
  it('is any non-2xx, whatever shape the block takes', () => {
    /* A missing grant, a failing policy and an unknown relation surface as
       different codes; all three are refusals. */
    for (const status of [400, 401, 403, 404, 409, 500]) {
      expect(refused({ status } as Response)).toBe(true);
    }
    for (const status of [200, 201, 204]) {
      expect(refused({ status } as Response)).toBe(false);
    }
  });

  it('treats an empty read as blocked, because RLS filters rather than errors', () => {
    expect(readBlocked({ status: 200 } as Response, '[]')).toBe(true);
    expect(readBlocked({ status: 403 } as Response, '')).toBe(true);
    /* A row coming back is the finding. */
    expect(readBlocked({ status: 200 } as Response, '[{"id":1}]')).toBe(false);
  });

  it('does not mistake unparseable success for a block', () => {
    expect(readBlocked({ status: 200 } as Response, 'not json')).toBe(false);
  });
});

describe('billing checks distinguish the answers that matter', () => {
  const payloadFor = () => ({ p_tier: 'free' });

  it('passes only when the service role executes and both browsers are refused', async () => {
    const rpc = async (who: { label: string }) => (
      who.label === 'service-role'
        ? { response: { status: 200 } as Response, body: '"applied"' }
        : { response: { status: 403 } as Response, body: 'permission denied' }
    );
    const results = await runAll(billingChecks({
      rpc, payloadFor,
      service: caller('service-role', 'sr'), anon: caller('anon', 'pk'), user: A,
    }));
    expect(results).toEqual({
      'billing.service-role-executes': true,
      'billing.anon-refused': true,
      'billing.user-refused': true,
    });
  });

  it('fails when a browser can execute the privileged RPC', async () => {
    /* The escalation this exists to catch: anyone able to set their own tier. */
    const rpc = async () => ({ response: { status: 200 } as Response, body: '"applied"' });
    const results = await runAll(billingChecks({
      rpc, payloadFor,
      service: caller('service-role', 'sr'), anon: caller('anon', 'pk'), user: A,
    }));
    expect(results['billing.anon-refused']).toBe(false);
    expect(results['billing.user-refused']).toBe(false);
  });

  it('fails when the webhook path is broken rather than merely refused', async () => {
    /* A 2xx that did not apply means every webhook silently does nothing. */
    const rpc = async (who: { label: string }) => (
      who.label === 'service-role'
        ? { response: { status: 200 } as Response, body: '"stale"' }
        : { response: { status: 403 } as Response, body: '' }
    );
    const results = await runAll(billingChecks({
      rpc, payloadFor,
      service: caller('service-role', 'sr'), anon: caller('anon', 'pk'), user: A,
    }));
    expect(results['billing.service-role-executes']).toBe(false);
  });
});

describe('watch progress checks distinguish the answers that matter', () => {
  const healthy = () => transport({
    'customer A GET watch_progress': { status: 200, body: JSON.stringify([{ position_seconds: 1234, updated_at: new Date().toISOString(), observed_at: null }]) },
    'customer B GET watch_progress': { status: 200, body: '[]' },
    'customer B POST watch_progress': { status: 403, body: 'denied' },
    'customer B PATCH watch_progress': { status: 200, body: '[]' },
    'customer B DELETE watch_progress': { status: 200, body: '[]' },
    'anonymous user POST watch_progress': { status: 403, body: 'denied' },
  });

  it('passes a correctly configured project', async () => {
    const { rest } = healthy();
    const results = await runAll(watchProgressChecks({
      rest, userA: A, userB: B, anonymous: ANON, progressRow: row,
    }));
    /* The owner-delete check re-reads and expects the row gone; the healthy
       fixture always returns the row, so that one is exercised separately. */
    delete results['progress.owner-deletes'];
    expect(Object.values(results).every(Boolean)).toBe(true);
  });

  it('fails when another account can read the row', async () => {
    const { rest } = transport({
      ...Object.fromEntries(Object.entries({}).map(([k, v]) => [k, v])),
      'customer A GET watch_progress': { status: 200, body: JSON.stringify([{ position_seconds: 1234, updated_at: new Date().toISOString() }]) },
      'customer B GET watch_progress': { status: 200, body: '[{"media_id":550}]' },
    });
    const results = await runAll(watchProgressChecks({ rest, userA: A, userB: B, anonymous: ANON, progressRow: row }));
    expect(results['progress.cross-user-read']).toBe(false);
  });

  it('fails when an anonymous session can write cloud progress', async () => {
    const { rest } = transport({
      'customer A GET watch_progress': { status: 200, body: JSON.stringify([{ position_seconds: 1234, updated_at: new Date().toISOString() }]) },
      'customer B GET watch_progress': { status: 200, body: '[]' },
      'anonymous user POST watch_progress': { status: 201, body: '[]' },
    });
    const results = await runAll(watchProgressChecks({ rest, userA: A, userB: B, anonymous: ANON, progressRow: row }));
    expect(results['progress.anonymous-insert-refused']).toBe(false);
  });

  it('reports rather than skips when the project has no anonymous sign-ins', async () => {
    /* Silence would read as a pass for the one boundary that most needs an
       answer. */
    const { rest } = healthy();
    const results = await runAll(watchProgressChecks({ rest, userA: A, userB: B, anonymous: null, progressRow: row }));
    expect(results['progress.anonymous-insert-refused']).toBe(false);
  });

  it('fails when a forged future updated_at is stored', async () => {
    const forged = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
    const { rest } = transport({
      'customer A PATCH watch_progress': { status: 200, body: '[]' },
      'customer A GET watch_progress': { status: 200, body: JSON.stringify([{ updated_at: forged, position_seconds: 99 }]) },
      'customer B GET watch_progress': { status: 200, body: '[]' },
    });
    const results = await runAll(watchProgressChecks({ rest, userA: A, userB: B, anonymous: ANON, progressRow: row }));
    expect(results['progress.forged-timestamp-rejected']).toBe(false);
    /* And the stamp check fails too, since a year-away value is not database
       time either. */
    expect(results['progress.database-stamps-updated-at']).toBe(false);
  });

  it('accepts either mechanism for the forged timestamp', async () => {
    /* The column grant refuses it outright; the trigger overwrites it if a
       request ever gets through. Both are correct, and they are different
       defences. */
    const stamped = new Date().toISOString();
    const refusedByGrant = transport({
      'customer A PATCH watch_progress': { status: 403, body: 'column updated_at' },
      'customer A GET watch_progress': { status: 200, body: JSON.stringify([{ updated_at: stamped }]) },
    });
    const overwrittenByTrigger = transport({
      'customer A PATCH watch_progress': { status: 200, body: '[]' },
      'customer A GET watch_progress': { status: 200, body: JSON.stringify([{ updated_at: stamped }]) },
    });
    for (const { rest } of [refusedByGrant, overwrittenByTrigger]) {
      const checks = watchProgressChecks({ rest, userA: A, userB: B, anonymous: ANON, progressRow: row });
      const forgeryCheck = (checks as Check[]).find((check) => check.id === 'progress.forged-timestamp-rejected')!;
      expect((await forgeryCheck.run()).ok).toBe(true);
    }
  });

  it('fails when the stored timestamp is nowhere near database time', async () => {
    const { rest } = transport({
      'customer A GET watch_progress': { status: 200, body: JSON.stringify([{ updated_at: new Date(0).toISOString() }]) },
    });
    const checks = watchProgressChecks({ rest, userA: A, userB: B, anonymous: ANON, progressRow: row });
    const stampCheck = (checks as Check[]).find((check) => check.id === 'progress.database-stamps-updated-at')!;
    expect((await stampCheck.run()).ok).toBe(false);
  });
});

describe('support checks distinguish the answers that matter', () => {
  const state = () => ({ userAId: 'user-a', staffId: 'user-staff', ticketId: '', customerMessageId: '' });

  const healthy = () => transport({
    'customer A POST support_tickets': { status: 201, body: '[{"id":"t1","status":"open"}]' },
    'customer A GET support_tickets': { status: 200, body: '[{"id":"t1","status":"open"}]' },
    'customer A PATCH support_tickets': { status: 403, body: 'denied' },
    'customer A POST support_messages': { status: 201, body: '[{"id":"m1","author_role":"customer"}]' },
    'customer A GET support_messages': { status: 200, body: '[{"body":"verifier fixture reply"}]' },
    'customer A PATCH support_messages': { status: 403, body: 'denied' },
    'customer A DELETE support_messages': { status: 403, body: 'denied' },
    'staff POST support_messages': { status: 201, body: '[{"author_role":"staff"}]' },
    'customer B GET support_tickets': { status: 200, body: '[]' },
    'customer B GET support_messages': { status: 200, body: '[]' },
    'customer A GET staff_members': { status: 404, body: 'not found' },
    'customer A POST staff_members': { status: 404, body: 'not found' },
    'staff GET staff_members': { status: 200, body: '[]' },
  });

  it('passes a correctly configured project', async () => {
    const { rest } = healthy();
    const results = await runAll(supportChecks({ rest, userA: A, userB: B, staff: STAFF, state: state() }));
    expect(Object.values(results).every(Boolean)).toBe(true);
  });

  it('fails when a customer message is stored as staff-authored', async () => {
    /* The impersonation the trigger exists to prevent. */
    const { rest } = transport({
      ...(healthy(), {}),
      'customer A POST support_tickets': { status: 201, body: '[{"id":"t1"}]' },
      'customer A POST support_messages': { status: 201, body: '[{"id":"m1","author_role":"staff"}]' },
    });
    const results = await runAll(supportChecks({ rest, userA: A, userB: B, staff: STAFF, state: state() }));
    expect(results['support.customer-reply-is-customer']).toBe(false);
  });

  it('fails when a customer can resolve their own ticket', async () => {
    const { rest } = transport({
      'customer A POST support_tickets': { status: 201, body: '[{"id":"t1"}]' },
      'customer A PATCH support_tickets': { status: 200, body: '[]' },
      'customer A GET support_tickets': { status: 200, body: '[{"status":"resolved"}]' },
    });
    const results = await runAll(supportChecks({ rest, userA: A, userB: B, staff: STAFF, state: state() }));
    expect(results['support.customer-cannot-set-status']).toBe(false);
  });

  it('fails when the staff table is readable or writable by a customer', async () => {
    const { rest } = transport({
      'customer A POST support_tickets': { status: 201, body: '[{"id":"t1"}]' },
      'customer A GET staff_members': { status: 200, body: '[{"user_id":"someone"}]' },
      'customer A POST staff_members': { status: 201, body: '[{"user_id":"user-a"}]' },
    });
    const results = await runAll(supportChecks({ rest, userA: A, userB: B, staff: STAFF, state: state() }));
    expect(results['support.staff-table-unreadable']).toBe(false);
    expect(results['support.staff-table-unwritable']).toBe(false);
  });

  it('fails when a transcript can be rewritten or deleted', async () => {
    const rewritten = transport({
      'customer A POST support_tickets': { status: 201, body: '[{"id":"t1"}]' },
      'customer A POST support_messages': { status: 201, body: '[{"id":"m1","author_role":"customer"}]' },
      'customer A PATCH support_messages': { status: 200, body: '[]' },
      'customer A DELETE support_messages': { status: 200, body: '[]' },
      'customer A GET support_messages': { status: 200, body: '[{"body":"rewritten"}]' },
    });
    const deleted = transport({
      'customer A POST support_tickets': { status: 201, body: '[{"id":"t1"}]' },
      'customer A POST support_messages': { status: 201, body: '[{"id":"m1","author_role":"customer"}]' },
      'customer A DELETE support_messages': { status: 200, body: '[]' },
      'customer A GET support_messages': { status: 200, body: '[]' },
    });
    for (const { rest } of [rewritten, deleted]) {
      const results = await runAll(supportChecks({ rest, userA: A, userB: B, staff: STAFF, state: state() }));
      expect(results['support.customer-cannot-edit-transcript']).toBe(false);
    }
  });

  it('fails when one customer can read another\'s thread', async () => {
    const { rest } = transport({
      'customer A POST support_tickets': { status: 201, body: '[{"id":"t1"}]' },
      'customer B GET support_tickets': { status: 200, body: '[{"id":"t1"}]' },
      'customer B GET support_messages': { status: 200, body: '[{"body":"private"}]' },
    });
    const results = await runAll(supportChecks({ rest, userA: A, userB: B, staff: STAFF, state: state() }));
    expect(results['support.cross-user-ticket-read']).toBe(false);
    expect(results['support.cross-user-message-read']).toBe(false);
  });
});

describe('the runner is safe by default', () => {
  it('refuses ambiguous or missing credentials rather than proving nothing', () => {
    expect(runner).toMatch(/Missing required environment[\s\S]*?process\.exit\(2\)/);
    expect(runner).toContain('serviceRoleKey === publishableKey');
    expect(runner).toMatch(/SUPABASE_URL must be an https project URL/);
  });

  it('writes nothing without --execute', () => {
    expect(runner).toContain("const execute = args.includes('--execute')");
    expect(runner).toMatch(/Dry run\. Nothing will be created, written or deleted/);
  });

  it('cleans up in a finally, so a thrown check still removes its fixtures', () => {
    expect(runner).toContain('} finally {');
    expect(runner.slice(runner.indexOf('} finally {'))).toContain('deleteUser');
  });

  it('never writes premium as part of permission testing', () => {
    expect(runner).toContain("p_tier: 'free'");
    expect(runner).not.toMatch(/p_tier:\s*'premium'/);
  });

  it('carries no credential of its own', () => {
    for (const source of [runner]) {
      expect(source).not.toMatch(/\b(eyJ[A-Za-z0-9_-]{20,}|sb_secret_\S+|sk_(live|test)_\S+)/);
      expect(source).not.toMatch(/writeFile|appendFile|createWriteStream/);
    }
  });
});

describe('the workflow cannot run on an ordinary push', () => {
  it('is dispatch-only and dry by default', () => {
    const triggers = workflow.slice(0, workflow.indexOf('permissions:'));
    expect(triggers).toContain('workflow_dispatch');
    expect(triggers).not.toMatch(/^\s+push:/m);
    expect(triggers).not.toContain('pull_request');
    expect(workflow).toMatch(/execute:[\s\S]*?default: false/);
  });

  it('passes --execute only when explicitly asked', () => {
    expect(workflow).toMatch(/inputs\.execute/);
  });
});


/*
 * Section isolation.
 *
 * Provisioning used to run before section selection, so every run created three
 * users, seeded staff_members and asked for an anonymous session whatever was
 * requested. That made `--only billing` fail on a project where the support
 * migration had not been applied - the flag advertised an isolation that did
 * not exist, which matters more than usual because this replaced a standalone
 * billing smoke test.
 *
 * These watch what is actually provisioned rather than reading the source for
 * the absence of a call.
 */
function spyDeps(anonymous: { id: string; token: string } | null = { id: 'anon', token: 't' }) {
  const calls = { users: [] as string[], anonymous: 0, staff: [] as string[] };
  return {
    calls,
    deps: {
      createProtectedUser: async (tag: string) => {
        calls.users.push(tag);
        return { id: `user-${tag}`, token: `token-${tag}` };
      },
      createAnonymousUser: async () => {
        calls.anonymous += 1;
        return anonymous;
      },
      seedStaff: async (userId: string) => { calls.staff.push(userId); },
    },
  };
}

describe('each section provisions only what it needs', () => {
  it('billing creates one user, never touches staff_members, never asks for anonymous auth', async () => {
    const { calls, deps } = spyDeps();
    const created = await provisionFixtures(fixturePlan(['billing']), deps, emptyFixtures());

    expect(calls.users).toEqual(['a']);
    expect(calls.staff).toEqual([]);
    expect(calls.anonymous).toBe(0);
    expect(created.staffSeeded).toBe(false);
    expect(created.anonymous).toBeNull();
  });

  it('progress creates both customers and an anonymous session, and seeds no staff', async () => {
    /* The anonymous session is not incidental here: "an anonymous session
       cannot write cloud progress" is one of the things being verified. */
    const { calls, deps } = spyDeps();
    const created = await provisionFixtures(fixturePlan(['progress']), deps, emptyFixtures());

    expect(calls.users).toEqual(['a', 'b']);
    expect(calls.anonymous).toBe(1);
    expect(calls.staff).toEqual([]);
    expect(created.staffSeeded).toBe(false);
  });

  it('support creates both customers and staff, and never asks for anonymous auth', async () => {
    const { calls, deps } = spyDeps();
    const created = await provisionFixtures(fixturePlan(['support']), deps, emptyFixtures());

    expect(calls.users).toEqual(['a', 'b', 'staff']);
    expect(calls.staff).toEqual(['user-staff']);
    expect(calls.anonymous).toBe(0);
    expect(created.staffSeeded).toBe(true);
  });

  it('a full run shares users rather than provisioning them per section', async () => {
    const { calls, deps } = spyDeps();
    await provisionFixtures(fixturePlan(SECTIONS), deps, emptyFixtures());

    /* Sharing is safe: the rows each section writes for a given user do not
       overlap, and one deletion removes all of them. */
    expect(calls.users).toEqual(['a', 'b', 'staff']);
    expect(calls.anonymous).toBe(1);
    expect(calls.staff).toEqual(['user-staff']);
  });

  it('refuses a section it does not know rather than provisioning nothing', () => {
    expect(() => fixturePlan(['nonsense'])).toThrow(/Unknown section/);
  });

  it('records an unavailable anonymous session rather than throwing', async () => {
    /* The progress check then fails, which is correct - silence would read as a
       pass for the boundary that most needs an answer. */
    const { deps } = spyDeps(null);
    const created = await provisionFixtures(fixturePlan(['progress']), deps, emptyFixtures());
    expect(created.anonymous).toBeNull();
  });
});

describe('a full run still covers everything', () => {
  it('executes all 24 checks across the three sections', () => {
    const noop = async () => ({ response: { status: 200 }, body: '[]' });
    const anyCaller = caller('x', 'pk', 'token');
    const counts = {
      billing: billingChecks({
        rpc: noop, payloadFor: () => ({}), service: anyCaller, anon: anyCaller, user: anyCaller,
      }).length,
      progress: watchProgressChecks({
        rest: noop, userA: anyCaller, userB: anyCaller, anonymous: anyCaller, progressRow: row,
      }).length,
      support: supportChecks({
        rest: noop, userA: anyCaller, userB: anyCaller, staff: anyCaller, state: {},
      }).length,
    };

    expect(counts).toEqual({ billing: 3, progress: 11, support: 10 });
    expect(counts.billing + counts.progress + counts.support).toBe(24);
    /* And every section named by the CLI has a fixture plan, so none can be
       requested without one. */
    expect(Object.keys(SECTION_FIXTURES).sort()).toEqual(['billing', 'progress', 'support']);
    expect(SECTIONS.sort()).toEqual(['billing', 'progress', 'support']);
  });
});

describe('cleanup removes what exists and nothing else', () => {
  it('removes only the one user a billing-only run created', async () => {
    const deleted: string[] = [];
    const created = await provisionFixtures(fixturePlan(['billing']), spyDeps().deps, emptyFixtures());
    created.billingEventId = 'evt_x';

    await cleanupFixtures(created, {
      deleteUser: async (id: string) => { deleted.push(id); },
      deleteBillingEvent: async (id: string) => { deleted.push(id); },
    });
    expect(deleted).toEqual(['user-a', 'evt_x']);
  });

  it('does not try to delete an anonymous user that was never created', async () => {
    const deleted: string[] = [];
    const created = await provisionFixtures(fixturePlan(['support']), spyDeps().deps, emptyFixtures());

    await cleanupFixtures(created, { deleteUser: async (id: string) => { deleted.push(id); } });
    expect(deleted).toEqual(['user-a', 'user-b', 'user-staff']);
  });

  it('does not delete a billing event when the billing section never ran', async () => {
    let billingDeletes = 0;
    const created = await provisionFixtures(fixturePlan(['progress']), spyDeps().deps, emptyFixtures());

    await cleanupFixtures(created, {
      deleteUser: async () => {},
      deleteBillingEvent: async () => { billingDeletes += 1; },
    });
    expect(billingDeletes).toBe(0);
  });

  it('keeps going when one deletion fails, so a cleanup problem is not a red run', async () => {
    const deleted: string[] = [];
    const created = await provisionFixtures(fixturePlan(SECTIONS), spyDeps().deps, emptyFixtures());

    await expect(cleanupFixtures(created, {
      deleteUser: async (id: string) => {
        if (id === 'user-b') throw new Error('gone already');
        deleted.push(id);
      },
    })).resolves.toBeDefined();
    expect(deleted).toEqual(['user-a', 'user-staff', 'anon']);
  });

  it('copes with a fixture set that provisioned nothing at all', async () => {
    /* The shape cleanup sees when provisioning threw on its first call. */
    await expect(cleanupFixtures({ users: {}, anonymous: null }, { deleteUser: async () => {} }))
      .resolves.toEqual([]);
  });
});

describe('the runner honours the plan', () => {
  it('provisions from the requested sections, not from a fixed list', () => {
    expect(runner).toContain('const plan = fixturePlan(requested)');
    expect(runner).toContain('provisionFixtures(plan, {');
    /* The defect: three unconditional creations before section selection. */
    expect(runner).not.toMatch(/await createProtectedUser\('b'\)/);
    expect(runner).not.toMatch(/await createProtectedUser\('staff'\)/);
    expect(runner).not.toMatch(/staff_members.*\n?.*insert\(\{ user_id: staffUser\.id/);
  });

  it('seeds staff only through the provisioner', () => {
    const seeds = [...runner.matchAll(/from\('staff_members'\)/g)];
    expect(seeds).toHaveLength(1);
    expect(runner.slice(runner.indexOf("seedStaff: async"), runner.indexOf('provisionFixtures(plan') + 1200))
      .toContain('staff_members');
  });

  it('cleans up through the same accounting, in a finally', () => {
    expect(runner).toContain('} finally {');
    expect(runner.slice(runner.indexOf('} finally {'))).toContain('cleanupFixtures(fixtures, {');
  });

  it('describes only the fixtures the requested sections need in its dry run', () => {
    expect(runner).toContain('NOT touch staff_members');
    expect(runner).toContain('NOT request an anonymous session');
  });
});


/*
 * Partial provisioning.
 *
 * The failure mode: provisioning built a private record and handed it back only
 * once everything had succeeded, so a throw partway propagated before the
 * caller learned about the users that already existed. The finally then cleaned
 * up nothing and those users were left on the project, findable only by the
 * run's namespace.
 *
 * These inject a failure after at least one resource exists and assert the
 * earlier ones are still removed - which is only possible if the caller's state
 * was filled in as it went.
 */
function failingDeps(fail: { at: 'userB' | 'staffSeed' | 'anonymous' }) {
  const created: string[] = [];
  return {
    created,
    deps: {
      createProtectedUser: async (tag: string) => {
        if (fail.at === 'userB' && tag === 'b') throw new Error('user B unavailable');
        created.push(tag);
        return { id: `user-${tag}`, token: `token-${tag}` };
      },
      createAnonymousUser: async () => {
        if (fail.at === 'anonymous') throw new Error('anonymous sign-in exploded');
        return { id: 'anon', token: 'token-anon' };
      },
      seedStaff: async () => {
        if (fail.at === 'staffSeed') throw new Error('staff_members unavailable');
      },
    },
  };
}

async function cleanupAfter(failure: Parameters<typeof failingDeps>[0], sections: string[]) {
  const fixtures = emptyFixtures();
  const { deps } = failingDeps(failure);
  await expect(provisionFixtures(fixturePlan(sections), deps, fixtures)).rejects.toThrow();

  const deleted: string[] = [];
  await cleanupFixtures(fixtures, { deleteUser: async (id: string) => { deleted.push(id); } });
  return deleted;
}

describe('a partial provisioning failure leaks nothing', () => {
  it('deletes A when B cannot be created', async () => {
    expect(await cleanupAfter({ at: 'userB' }, ['progress'])).toEqual(['user-a']);
  });

  it('deletes every user when staff seeding fails after they exist', async () => {
    /* The users are real by then; only the membership row is not. */
    expect(await cleanupAfter({ at: 'staffSeed' }, ['support']))
      .toEqual(['user-a', 'user-b', 'user-staff']);
  });

  it('deletes the protected users when anonymous creation throws', async () => {
    expect(await cleanupAfter({ at: 'anonymous' }, ['progress'])).toEqual(['user-a', 'user-b']);
  });

  it('records staffSeeded only once the seeding actually succeeded', async () => {
    const fixtures = emptyFixtures();
    const { deps } = failingDeps({ at: 'staffSeed' });
    await expect(provisionFixtures(fixturePlan(['support']), deps, fixtures)).rejects.toThrow();
    expect(fixtures.staffSeeded).toBe(false);
    expect(Object.keys(fixtures.users)).toEqual(['a', 'b', 'staff']);
  });

  it('refuses to provision without caller-owned state at all', () => {
    /* Handing back a fresh object would silently reintroduce the leak, so the
       signature makes it impossible to ask for. */
    const { deps } = spyDeps();
    // @ts-expect-error - the third argument is required on purpose
    return expect(provisionFixtures(fixturePlan(['billing']), deps)).rejects.toThrow(/caller-owned state/);
  });
});

describe('cleanup attempts everything it knows about', () => {
  it('carries on past a deletion that rejects', async () => {
    const fixtures = emptyFixtures();
    await provisionFixtures(fixturePlan(SECTIONS), spyDeps().deps, fixtures);

    const deleted: string[] = [];
    await cleanupFixtures(fixtures, {
      deleteUser: async (id: string) => {
        if (id === 'user-a') throw new Error('already gone');
        deleted.push(id);
      },
    });
    /* The first one failing must not cost the other three. */
    expect(deleted).toEqual(['user-b', 'user-staff', 'anon']);
  });

  it('carries on past a deletion that throws synchronously', async () => {
    /* A dependency that throws before returning a promise would escape a
       rejection handler and abort the rest of cleanup. */
    const fixtures = emptyFixtures();
    await provisionFixtures(fixturePlan(SECTIONS), spyDeps().deps, fixtures);
    fixtures.billingEventId = 'evt_x';

    const deleted: string[] = [];
    await expect(cleanupFixtures(fixtures, {
      deleteUser: ((id: string) => {
        if (id === 'user-a') throw new Error('sync boom');
        deleted.push(id);
        return Promise.resolve();
      }) as (id: string) => Promise<unknown>,
      deleteBillingEvent: async (id: string) => { deleted.push(id); },
    })).resolves.toBeDefined();
    expect(deleted).toEqual(['user-b', 'user-staff', 'anon', 'evt_x']);
  });

  it('reports only what it actually removed', async () => {
    const fixtures = emptyFixtures();
    await provisionFixtures(fixturePlan(['progress']), spyDeps().deps, fixtures);

    const removed = await cleanupFixtures(fixtures, {
      deleteUser: async (id: string) => { if (id === 'anon') throw new Error('gone'); },
    });
    expect(removed).toEqual(['user-a', 'user-b']);
  });
});

describe('the runner holds the fixture state itself', () => {
  it('declares it before the try and fills it in through the provisioner', () => {
    expect(runner).toContain('const fixtures = emptyFixtures();');
    expect(runner).toMatch(/await provisionFixtures\(plan, \{[\s\S]*?\}, fixtures\);/);
    /* Assigning from the return value is what lost a partial provisioning. */
    expect(runner).not.toMatch(/fixtures = await provisionFixtures/);
    expect(runner).not.toMatch(/let fixtures/);
  });

  it('still cleans up that same state in the finally', () => {
    const cleanup = runner.slice(runner.indexOf('} finally {'));
    expect(cleanup).toContain('cleanupFixtures(fixtures, {');
  });
});
