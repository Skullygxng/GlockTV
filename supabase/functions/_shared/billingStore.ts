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

  getSubscription(userId: string): Promise<{ providerUpdatedAt: string | null } | null>;
  saveSubscription(input: { userId: string; subscription: NormalizedSubscription }): Promise<void>;

  saveEntitlement(input: { userId: string; entitlement: EntitlementRecord }): Promise<void>;

  /* True when this event id was already recorded, i.e. this is a replay. */
  hasProcessedEvent(providerEventId: string): Promise<boolean>;
  markEventProcessed(input: {
    providerEventId: string;
    eventType: string;
    providerCreatedAt: string | null;
  }): Promise<void>;
}
