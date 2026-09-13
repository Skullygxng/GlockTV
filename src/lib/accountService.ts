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
  /*
   * Attach an email to this visitor's identity, minting the anonymous account
   * first if they do not have one yet. An existing id is always kept.
   */
  linkEmail(email: string): Promise<void>;
  /* Send a returning sign-in link. */
  sendSignInLink(email: string): Promise<void>;
  /*
   * Create a brand new email/password account.
   *
   * Refuses outright when a session already exists. Supabase's signUp would
   * mint a SECOND user, and the guest's id - which their rooms, hosting,
   * watch history and any entitlement row are keyed to - would be silently
   * orphaned. A visitor in that state has to go through the upgrade path
   * instead, and the refusal is what makes sure they do.
   */
  signUpWithPassword(email: string, password: string): Promise<{ needsConfirmation: boolean }>;
  /* Sign in an existing email/password account. */
  signInWithPassword(email: string, password: string): Promise<void>;
  /*
   * Set a password on the signed-in account.
   *
   * Supabase requires the email identity to be verified before a password can
   * be attached to an account that started out anonymous, which is why this is
   * a separate step from linkEmail rather than one call with both fields.
   */
  setPassword(password: string): Promise<void>;
  /* Send a password reset email. */
  sendPasswordReset(email: string): Promise<void>;
  signOut(): Promise<void>;
  /* Fires whenever the session changes; returns an unsubscribe. */
  onAuthChange(listener: () => void): () => void;
}

/*
 * Thrown when signUpWithPassword is called with a session already in place.
 * Typed so the UI can route the visitor to the upgrade path rather than
 * showing a raw message and leaving them stuck.
 */
export const SIGN_UP_WOULD_ORPHAN =
  'You already have a guest account here. Add an email to that account instead, so your rooms and history come with you.';

/* Supabase's own floor is 6; this is the app's, and it is not lower. */
export const MIN_PASSWORD_LENGTH = 8;

export function validatePassword(password: string): string {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return '';
}

/*
 * The view, not the table.
 *
 * The stored row records what the last webhook decided. A membership set to
 * cancel stops being entitled when its period ends, and no webhook is
 * guaranteed to arrive at that moment - the view recomputes it against the
 * database clock on every read, so expiry does not depend on Stripe telling us
 * a second time.
 */
const ENTITLEMENTS_SOURCE = 'account_entitlements_effective';

/*
 * Where an emailed link lands. BASE_URL matters: GlockTV is served from a
 * project subpath on Pages, so the bare origin would drop the visitor outside
 * the app. Every email-bearing call routes through here so none of them can
 * disagree about it.
 */
function redirectUrl(): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}`;
}

export function createAccountService(client: SupabaseClient): AccountService {
  /*
   * Minting an anonymous identity, at most once and only when asked.
   *
   * This is deliberately not on the AccountService surface. Nothing should be
   * able to create a session as a side effect of rendering - GlockTV is
   * guest-first, and a visitor who only browses must never become a row in
   * auth.users. It is reachable solely from the actions that genuinely need an
   * authenticated identity, the same rule the watch party already follows when
   * it creates or joins a room.
   */
  let signingIn: Promise<string> | null = null;

  async function ensureUser(): Promise<string> {
    const { data: sessionData } = await client.auth.getSession();
    if (sessionData.session?.user) return sessionData.session.user.id;

    /* Two clicks that both find no session must still produce one user. */
    signingIn ??= client.auth.signInAnonymously().then(({ data, error }) => {
      if (error || !data.user) throw new Error(error?.message ?? 'Guest sign-in failed.');
      return data.user.id;
    }).finally(() => { signingIn = null; });

    return signingIn;
  }

  return {
    async loadAccount() {
      const { data, error } = await client.auth.getUser();
      if (error || !data.user) return null;
      const user = data.user as typeof data.user & { is_anonymous?: boolean };
      const identities = Array.isArray(user.identities) ? user.identities : [];
      return {
        id: user.id,
        email: user.email ?? null,
        isAnonymous: user.is_anonymous === true,
        createdAt: user.created_at ?? null,
        emailConfirmed: Boolean(user.email_confirmed_at),
        /*
         * Supabase does not expose "has a password" directly. An email
         * identity is the thing a password can be attached to, and it only
         * appears once the address is confirmed - so this reports what the
         * account can actually do (sign in again elsewhere) rather than
         * guessing at a stored credential.
         */
        hasPassword: identities.some((identity) => identity.provider === 'email'),
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
          .from(ENTITLEMENTS_SOURCE)
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
      /*
       * A first-time visitor can protect an identity before they have one:
       * they reached the account panel without ever opening a watch party, so
       * there is no session for updateUser to update yet. Minting here keeps
       * the id that everything else is keyed to - the anonymous user created
       * now is the same user the email lands on, and stays the same id
       * afterwards.
       */
      await ensureUser();
      const { error } = await client.auth.updateUser({ email: email.trim() });
      if (error) throw new Error(error.message);
    },

    async sendSignInLink(email: string) {
      const { error } = await client.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: redirectUrl() },
      });
      if (error) throw new Error(error.message);
    },

    async signUpWithPassword(email: string, password: string) {
      /*
       * The orphan guard. This is checked against the live session rather than
       * anything React is holding, because the question is whether Supabase
       * would create a second user - and only Supabase's own view of the
       * session answers that.
       */
      const { data: sessionData } = await client.auth.getSession();
      if (sessionData.session?.user) throw new Error(SIGN_UP_WOULD_ORPHAN);

      const invalid = validatePassword(password);
      if (invalid) throw new Error(invalid);

      const { data, error } = await client.auth.signUp({
        email: email.trim(),
        password,
        options: { emailRedirectTo: redirectUrl() },
      });
      if (error) throw new Error(error.message);
      /*
       * With confirmations on, signUp returns a user and no session. Reporting
       * which happened lets the panel say "check your email" only when that is
       * actually true, instead of always claiming it.
       */
      return { needsConfirmation: Boolean(data.user) && !data.session };
    },

    async signInWithPassword(email: string, password: string) {
      const { error } = await client.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) throw new Error(error.message);
    },

    async setPassword(password: string) {
      const invalid = validatePassword(password);
      if (invalid) throw new Error(invalid);
      const { error } = await client.auth.updateUser({ password });
      if (error) throw new Error(error.message);
    },

    async sendPasswordReset(email: string) {
      const { error } = await client.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: redirectUrl(),
      });
      if (error) throw new Error(error.message);
    },

    async signOut() {
      const { error } = await client.auth.signOut();
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
