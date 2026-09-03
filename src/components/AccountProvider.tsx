import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FREE_ENTITLEMENTS, type Entitlements, type GlockTvAccount } from '../lib/account';
import { createDefaultAccountService, type AccountService } from '../lib/accountService';

/*
 * The one owner of "who is this and what are they entitled to".
 *
 * Features read this instead of reaching for Supabase Auth themselves, so
 * there is a single answer on screen at any moment and a single place where
 * entitlements are decided.
 *
 * It deliberately never creates an account. GlockTV is guest-first: browsing,
 * Discover, playback and Live all work with no session at all, and the
 * anonymous user is still minted only at the moment a watch party needs one.
 * This provider reports the session that exists.
 */
export interface AccountState {
  account: GlockTvAccount | null;
  entitlements: Entitlements;
  loading: boolean;
  /* Non-blocking: a failure here still leaves a usable free account. */
  error: string;
  /* True once the first load has settled, however it settled. */
  ready: boolean;
  /*
   * A checkout has just returned and we are re-asking the server whether the
   * webhook has landed yet. Purely a display state - it never implies Premium,
   * and it gives up rather than polling forever.
   */
  confirmingMembership: boolean;
  /* True once confirmation ran to the end without Premium appearing. */
  confirmationTimedOut: boolean;
  refresh: () => Promise<void>;
  /* Begin the bounded post-checkout re-check. Safe to call more than once. */
  confirmMembership: () => Promise<void>;
  linkEmail: (email: string) => Promise<void>;
  sendSignInLink: (email: string) => Promise<void>;
}

/*
 * How long a returning member waits before we admit the webhook has not
 * arrived. Stripe usually delivers in seconds; this covers a slow delivery
 * without leaving a spinner up indefinitely, and the member stays free the
 * whole time.
 */
export const MEMBERSHIP_CONFIRM_ATTEMPTS = 6;
export const MEMBERSHIP_CONFIRM_INTERVAL_MS = 2500;

const AccountContext = createContext<AccountState | null>(null);

/* Everything an unknown visitor gets, and the floor every failure falls back to. */
const GUEST_STATE = {
  account: null,
  entitlements: FREE_ENTITLEMENTS,
  loading: false,
  error: '',
  ready: true,
  confirmingMembership: false,
  confirmationTimedOut: false,
} as const;

let defaultService: AccountService | null | undefined;
function getDefaultService(): AccountService | null {
  if (defaultService === undefined) defaultService = createDefaultAccountService();
  return defaultService;
}

export function AccountProvider({
  service: providedService,
  children,
}: {
  /* Omit to use the app's own service; pass null to run with no backend. */
  service?: AccountService | null;
  children: ReactNode;
}) {
  const service = providedService === undefined ? getDefaultService() : providedService;

  const [account, setAccount] = useState<GlockTvAccount | null>(null);
  const [entitlements, setEntitlements] = useState<Entitlements>(FREE_ENTITLEMENTS);
  const [loading, setLoading] = useState(service !== null);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(service === null);
  const [confirmingMembership, setConfirmingMembership] = useState(false);
  const [confirmationTimedOut, setConfirmationTimedOut] = useState(false);

  /* A slow earlier load must never overwrite a newer one - a sign-in that
     resolves before a stale guest read would otherwise be undone by it. */
  const version = useRef(0);

  /* Returns what it settled on, so the post-checkout re-check can tell whether
     the webhook has landed without reading back through React state. */
  const load = useCallback(async (): Promise<Entitlements> => {
    if (!service) {
      setAccount(null);
      setEntitlements(FREE_ENTITLEMENTS);
      setError('');
      setLoading(false);
      setReady(true);
      return FREE_ENTITLEMENTS;
    }

    const request = ++version.current;
    setLoading(true);

    let nextAccount: GlockTvAccount | null = null;
    let nextError = '';
    try {
      nextAccount = await service.loadAccount();
    } catch (reason) {
      nextError = reason instanceof Error ? reason.message : 'Your account could not be loaded.';
    }

    /*
     * Entitlements are only asked for once there is somebody to ask about.
     * With no session the answer is free by definition, and asking anyway
     * would be a request that can only fail.
     */
    let nextEntitlements = FREE_ENTITLEMENTS;
    if (nextAccount) {
      const result = await service.loadEntitlements();
      nextEntitlements = result.entitlements;
      if (result.error) nextError = result.error;
    }

    if (request !== version.current) return nextEntitlements;
    setAccount(nextAccount);
    setEntitlements(nextEntitlements);
    setError(nextError);
    setLoading(false);
    setReady(true);
    return nextEntitlements;
  }, [service]);

  /*
   * After a checkout returns, ask the server again for a bounded while.
   *
   * The redirect proves nothing - a member could type that URL - so this only
   * re-reads what the server says. If the verified webhook has not landed by
   * the end, the account stays free and says so, which is the correct outcome
   * rather than a failure to paper over.
   */
  const confirming = useRef(false);
  const confirmMembership = useCallback(async () => {
    if (!service || confirming.current) return;
    confirming.current = true;
    setConfirmingMembership(true);
    setConfirmationTimedOut(false);

    try {
      for (let attempt = 0; attempt < MEMBERSHIP_CONFIRM_ATTEMPTS; attempt += 1) {
        const settled = await load();
        if (settled.tier === 'premium') return;
        if (attempt < MEMBERSHIP_CONFIRM_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, MEMBERSHIP_CONFIRM_INTERVAL_MS));
        }
      }
      setConfirmationTimedOut(true);
    } finally {
      confirming.current = false;
      setConfirmingMembership(false);
    }
  }, [service, load]);

  useEffect(() => {
    void load();
  }, [load]);

  /* Sign-in, email linking and token refresh all arrive here, so the account
     surface updates without a reload. */
  useEffect(() => {
    if (!service) return;
    return service.onAuthChange(() => { void load(); });
  }, [service, load]);

  const linkEmail = useCallback(async (email: string) => {
    if (!service) throw new Error('Accounts are unavailable right now.');
    await service.linkEmail(email);
    await load();
  }, [service, load]);

  const sendSignInLink = useCallback(async (email: string) => {
    if (!service) throw new Error('Accounts are unavailable right now.');
    await service.sendSignInLink(email);
  }, [service]);

  const value = useMemo<AccountState>(() => ({
    account,
    entitlements,
    loading,
    error,
    ready,
    confirmingMembership,
    confirmationTimedOut,
    refresh: async () => { await load(); },
    confirmMembership,
    linkEmail,
    sendSignInLink,
  }), [
    account, entitlements, loading, error, ready,
    confirmingMembership, confirmationTimedOut,
    load, confirmMembership, linkEmail, sendSignInLink,
  ]);

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

/*
 * Outside a provider this reports a guest on the free tier rather than
 * throwing. A component rendered without the provider is a wiring mistake, but
 * the safe reading of "no account layer" is still guest and ads-on, and that is
 * a better failure than a blank screen.
 */
export function useAccount(): AccountState {
  const value = useContext(AccountContext);
  if (value) return value;
  return {
    ...GUEST_STATE,
    refresh: async () => {},
    confirmMembership: async () => {},
    linkEmail: async () => { throw new Error('Accounts are unavailable right now.'); },
    sendSignInLink: async () => { throw new Error('Accounts are unavailable right now.'); },
  };
}
