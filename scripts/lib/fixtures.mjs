/*
 * What each section of the verifier actually needs, and nothing more.
 *
 * Provisioning used to run before section selection: every run created three
 * users, seeded staff_members and attempted an anonymous sign-in whatever was
 * asked for. That made `--only billing` depend on the support schema being
 * applied and on staff seeding succeeding, so a project with billing configured
 * correctly and support not yet migrated would report a billing failure. The
 * section flags advertised an isolation that did not exist.
 *
 * Fixtures are therefore derived from the requested sections, provisioned
 * lazily, and cleaned up by what was actually created rather than by what a
 * full run would have created.
 *
 * The deps are injected so this is testable without a project - which matters,
 * because "billing never touches staff_members" is a claim about behaviour, and
 * reading the source for the absence of a call proves much less than watching
 * it not be made.
 */

/*
 * Per section: which protected users, whether an anonymous session is needed,
 * and whether staff membership must be seeded.
 *
 *  - billing needs one protected user, because the third question is whether an
 *    ordinary authenticated caller can execute the privileged RPC, and the
 *    payload keys its write to a real auth.uid(). It needs no second customer,
 *    no staff and no anonymous session.
 *  - progress needs two customers to test cross-account isolation, and an
 *    anonymous session because "an anonymous session cannot write cloud
 *    progress" is one of the things being verified.
 *  - support needs two customers and a staff member, and no anonymous session:
 *    nothing in the support model turns on anonymity.
 */
export const SECTION_FIXTURES = {
  billing: { users: ['a'], anonymous: false, staff: false },
  progress: { users: ['a', 'b'], anonymous: true, staff: false },
  support: { users: ['a', 'b', 'staff'], anonymous: false, staff: true },
};

export const SECTIONS = Object.keys(SECTION_FIXTURES);

/*
 * The union of what the requested sections need.
 *
 * Sharing users across sections in a full run is safe and deliberate: the rows
 * each section writes for a given user do not overlap, and one cleanup removes
 * all of them. Coverage is unchanged - every check still runs against a caller
 * with exactly the standing it is meant to have.
 */
export function fixturePlan(sections) {
  const plan = { users: [], anonymous: false, staff: false };
  for (const section of sections) {
    const needs = SECTION_FIXTURES[section];
    if (!needs) throw new Error(`Unknown section: ${section}`);
    for (const user of needs.users) {
      if (!plan.users.includes(user)) plan.users.push(user);
    }
    plan.anonymous = plan.anonymous || needs.anonymous;
    plan.staff = plan.staff || needs.staff;
  }
  return plan;
}

/*
 * Create exactly what the plan asks for.
 *
 * Returns what was created, not what was wanted, so cleanup can be honest about
 * it. An unavailable anonymous session is recorded as null rather than throwing:
 * the progress check reports that as a failure, which is the right outcome -
 * silence would read as a pass for the one boundary that most needs an answer.
 */
export async function provisionFixtures(plan, deps) {
  const created = { users: {}, anonymous: null, staffSeeded: false };

  for (const tag of plan.users) {
    created.users[tag] = await deps.createProtectedUser(tag);
  }

  if (plan.staff) {
    const staff = created.users.staff;
    if (!staff) throw new Error('The plan asks to seed staff but did not provision a staff user.');
    await deps.seedStaff(staff.id);
    created.staffSeeded = true;
  }

  if (plan.anonymous) {
    created.anonymous = await deps.createAnonymousUser();
  }

  return created;
}

/*
 * Remove only what exists.
 *
 * Deleting a user cascades every row it owns - progress, tickets, messages,
 * entitlements, staff membership - so the users are the whole cleanup, bar the
 * one webhook event row that belongs to no user. Each deletion is independent
 * and best effort: a cleanup failure must not turn a clean verification red,
 * and anything left behind carries the run's namespace.
 */
export async function cleanupFixtures(created, deps) {
  const removed = [];

  for (const user of Object.values(created.users ?? {})) {
    if (!user?.id) continue;
    await deps.deleteUser(user.id).then(() => removed.push(user.id), () => undefined);
  }

  if (created.anonymous?.id) {
    await deps.deleteUser(created.anonymous.id).then(() => removed.push(created.anonymous.id), () => undefined);
  }

  /* Only if the section that writes it ran. */
  if (created.billingEventId && deps.deleteBillingEvent) {
    await deps.deleteBillingEvent(created.billingEventId).then(() => removed.push(created.billingEventId), () => undefined);
  }

  return removed;
}
