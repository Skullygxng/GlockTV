import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient, type SupabaseConfig } from './supabaseClient';

/*
 * The browser half of billing: ask the server for a hosted Stripe URL, then
 * go there. That is the whole surface.
 *
 * There is no method here that changes a tier, and there cannot be - the
 * browser holds a publishable key, so anything it could call, anyone could
 * call. Checkout requests billing; only a signed Stripe webhook grants
 * Premium.
 */
export interface BillingService {
  /* Hosted Stripe Checkout URL for the signed-in caller. */
  createCheckoutUrl(): Promise<string>;
  /* Hosted Stripe billing portal URL for the signed-in caller. */
  createPortalUrl(): Promise<string>;
}

/*
 * Marker the hosted pages come back to. It says "a checkout just finished",
 * which is a reason to re-ask the server what this account is entitled to -
 * and nothing more. Seeing it never changes the tier on its own.
 */
export const BILLING_RETURN_PARAM = 'billing';
export const BILLING_RETURN_VALUES = ['return', 'portal-return'] as const;

export function billingReturnKind(search: string): 'checkout' | 'portal' | null {
  const value = new URLSearchParams(search).get(BILLING_RETURN_PARAM);
  if (value === 'return') return 'checkout';
  if (value === 'portal-return') return 'portal';
  return null;
}

function messageFor(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

export function createBillingService(client: SupabaseClient): BillingService {
  async function invoke(name: string, fallback: string): Promise<string> {
    const { data, error } = await client.functions.invoke<{ url?: string; error?: string }>(name, { body: {} });
    /*
     * A non-2xx from the function arrives as an error whose body carries the
     * real reason - "protect your account first" is worth showing, so it is
     * read out rather than replaced with something generic.
     */
    if (error) {
      const detail = await readFunctionError(error);
      throw new Error(detail ?? messageFor(error, fallback));
    }
    if (data?.error) throw new Error(data.error);
    if (!data?.url) throw new Error(fallback);
    return data.url;
  }

  return {
    createCheckoutUrl: () => invoke('create-checkout', 'Checkout could not be started.'),
    createPortalUrl: () => invoke('create-billing-portal', 'The billing portal could not be opened.'),
  };
}

/* supabase-js wraps a failed function response; the body holds the message. */
async function readFunctionError(error: unknown): Promise<string | null> {
  const context = (error as { context?: unknown })?.context;
  if (!context || typeof context !== 'object') return null;
  const response = context as { json?: () => Promise<unknown> };
  if (typeof response.json !== 'function') return null;
  try {
    const body = await response.json() as { error?: unknown } | null;
    return typeof body?.error === 'string' && body.error ? body.error : null;
  } catch {
    return null;
  }
}

/* Null when Supabase is not configured; the account panel then offers no
   membership actions rather than failing when one is pressed. */
export function createDefaultBillingService(config: SupabaseConfig = {}): BillingService | null {
  const client = getSupabaseClient(config);
  return client ? createBillingService(client) : null;
}
