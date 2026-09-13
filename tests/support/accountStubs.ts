import { vi } from 'vitest';
import type { AccountService } from '../../src/lib/accountService';

/*
 * The password half of AccountService, stubbed.
 *
 * Tests that only care about entitlements, ads or watch progress still have to
 * satisfy the full interface. Keeping the stubs here means adding a method to
 * the service is one edit rather than eight, and means those tests never
 * quietly assert anything about auth they did not intend to.
 */
export function passwordAuthStubs(): Pick<
  AccountService,
  'signUpWithPassword' | 'signInWithPassword' | 'setPassword' | 'sendPasswordReset' | 'signOut'
> {
  return {
    signUpWithPassword: vi.fn(async () => ({ needsConfirmation: false })),
    signInWithPassword: vi.fn(async () => {}),
    setPassword: vi.fn(async () => {}),
    sendPasswordReset: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
  };
}
