import type { EntitlementRecord, NormalizedSubscription } from './entitlements.ts';

/*
 * The trusted writes billing needs, behind one interface.
 *
 * Every method here runs as the service role on the server. Nothing in this
 * file is reachable from a browser, and the browser has no grant that would
 * let it perform any of these writes directly.
 */
export interface BillingStore {
  getCustomerByUser(userId: string): Promise<{ providerCustomerId: string } | null>;
  getUserByCustomer(providerCustomerId: string): Promise<{ userId: string } | null>;
  saveCustomer(input: { userId: string; providerCustomerId: string }): Promise<void>;

  /*
   * Claim the event, apply the subscription and write the entitlement as one
   * atomic database operation.
   *
   * This is deliberately not three calls. Reading the stored timestamp,
   * comparing it here and then writing lets two Edge Function invocations both
   * decide they are newer and commit in the wrong order - and Edge Functions
   * are distributed, so no in-process lock can prevent it. The comparison
   * belongs where the row lock is.
   *
   * 'replay'  - this event id was already recorded; nothing was written.
   * 'stale'   - older than the committed provider state; nothing was written.
   * 'applied' - subscription and entitlement both written.
   */
  applyProviderState(input: {
    userId: string;
    subscription: NormalizedSubscription;
    entitlement: EntitlementRecord;
    event: { providerEventId: string; eventType: string; providerCreatedAt: string | null };
  }): Promise<'applied' | 'replay' | 'stale'>;

  /*
   * Records an event that needs no state change - an event type this build
   * does not act on, or one whose customer maps to no account.
   */
  markEventProcessed(input: {
    providerEventId: string;
    eventType: string;
    providerCreatedAt: string | null;
  }): Promise<void>;
}
