/* Types for the fixture planner. See permission-checks.d.mts for why these
   live beside plain .mjs rather than in it. */

export interface ProvisionedUser {
  id: string;
  token: string;
}

export interface FixturePlan {
  users: string[];
  anonymous: boolean;
  staff: boolean;
}

export interface ProvisionedFixtures {
  users: Record<string, ProvisionedUser>;
  anonymous: ProvisionedUser | null;
  staffSeeded: boolean;
  billingEventId?: string;
}

export interface ProvisionDeps {
  createProtectedUser: (tag: string) => Promise<ProvisionedUser>;
  createAnonymousUser: () => Promise<ProvisionedUser | null>;
  seedStaff: (userId: string) => Promise<void>;
}

export interface CleanupDeps {
  deleteUser: (id: string) => Promise<unknown>;
  deleteBillingEvent?: (id: string) => Promise<unknown>;
}

export const SECTION_FIXTURES: Record<string, FixturePlan>;
export const SECTIONS: string[];
export function fixturePlan(sections: string[]): FixturePlan;
export function provisionFixtures(plan: FixturePlan, deps: ProvisionDeps): Promise<ProvisionedFixtures>;
export function cleanupFixtures(created: Partial<ProvisionedFixtures>, deps: CleanupDeps): Promise<string[]>;
