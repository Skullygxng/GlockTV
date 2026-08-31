import type { SupabaseClient } from '@supabase/supabase-js';
import {
  FREE_ENTITLEMENTS,
  entitlementsFromRow,
  type Entitlements,
  type GlockTvAccount,
} from './account';
import { getSupabaseClient, type SupabaseConfig } from './supabaseClient';

/*
 * The app's account layer.
 *
 * Note what is absent: there is no method that writes an entitlement. That is
 * not an oversight to be filled in later from the UI - the browser holds the
 * publishable key, so anything reachable from here is reachable from a console.
 * Premium is granted server-side, by a trusted caller this client cannot be.
 */
export interface AccountService {
  /* The current account, or null when nobody has signed in yet. */
  loadAccount(): Promise<GlockTvAccount | null>;
  /* Always resolves. Never rejects, and never resolves to premium on failure. */
  loadEntitlements(): Promise<{ entitlements: Entitlements; error: string }>;
  /* Attach an email to the account that is already signed in, keeping its id. */
  linkEmail(email: string): Promise<void>;
  /* Send a returning sign-in link. */
  sendSignInLink(email: string): Promise<void>;
  /* Fires whenever the session changes; returns an unsubscribe. */
  onAuthChange(listener: () => void): () => void;
}

const ENTITLEMENTS_TABLE = 'account_entitlements';

export function createAccountService(client: SupabaseClient): AccountService {
  return {
    async loadAccount() {
      const { data, error } = await client.auth.getUser();
      if (error || !data.user) return null;
      const user = data.user as typeof data.user & { is_anonymous?: boolean };
      return {
        id: user.id,
        email: user.email ?? null,
        isAnonymous: user.is_anonymous === true,
        createdAt: user.created_at ?? null,
      };
    },

    async loadEntitlements() {
      try {
        /*
         * No user id filter is needed or wanted: RLS returns only the caller's
         * own row, so asking for "the row" is asking for theirs. Filtering by a
         * client-held id would imply the id is what protects the row.
         */
        const { data, error } = await client
          .from(ENTITLEMENTS_TABLE)
          .select('tier, ads_enabled')
          .maybeSingle();

        // A reachable server that reports a problem is still a failure to
        // learn the tier, so it fails closed exactly like an unreachable one.
        if (error) return { entitlements: FREE_ENTITLEMENTS, error: error.message };
        return { entitlements: entitlementsFromRow(data), error: '' };
      } catch (reason) {
        return {
          entitlements: FREE_ENTITLEMENTS,
          error: reason instanceof Error ? reason.message : 'Membership status is unavailable.',
        };
      }
    },

    async linkEmail(email: string) {
      const { error } = await client.auth.updateUser({ email: email.trim() });
      if (error) throw new Error(error.message);
    },

    async sendSignInLink(email: string) {
      const redirect = `${window.location.origin}${import.meta.env.BASE_URL}`;
      const { error } = await client.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: redirect },
      });
      if (error) throw new Error(error.message);
    },

    onAuthChange(listener: () => void) {
      const { data } = client.auth.onAuthStateChange(() => listener());
      return () => data.subscription.unsubscribe();
    },
  };
}

/* Null when Supabase is not configured; the app then runs as a pure guest. */
export function createDefaultAccountService(config: SupabaseConfig = {}): AccountService | null {
  const client = getSupabaseClient(config);
  return client ? createAccountService(client) : null;
}
