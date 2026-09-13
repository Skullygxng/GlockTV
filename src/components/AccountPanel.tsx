import { type FormEvent, useState } from 'react';
import {
  CreditCard,
  KeyRound,
  LifeBuoy,
  LoaderCircle,
  LogOut,
  Mail,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { useAccount } from './AccountProvider';
import { useDialogBehavior } from '../hooks/useDialogBehavior';
import { createDefaultBillingService, type BillingService } from '../lib/billing';

/*
 * The GlockTV account surface. It reads the global account layer and offers
 * the two identity actions; it has no way to change a tier, because nothing in
 * the browser does.
 */
let defaultBilling: BillingService | null | undefined;
function getDefaultBilling(): BillingService | null {
  if (defaultBilling === undefined) defaultBilling = createDefaultBillingService();
  return defaultBilling;
}

export function AccountPanel({
  onClose,
  onOpenSupport,
  billing: providedBilling,
}: {
  onClose: () => void;
  /* Support is part of the account surface rather than a sixth destination. */
  onOpenSupport?: () => void;
  /* Omit for the app's own billing client; pass null to run with no backend. */
  billing?: BillingService | null;
}) {
  const {
    account, entitlements, loading, error,
    confirmingMembership, confirmationTimedOut,
    linkEmail, sendSignInLink,
    signUpWithPassword, signInWithPassword, setPassword, sendPasswordReset, signOut,
  } = useAccount();
  const billing = providedBilling === undefined ? getDefaultBilling() : providedBilling;

  const [email, setEmail] = useState(account?.email ?? '');
  const [password, setPasswordDraft] = useState('');
  /*
   * Which form a visitor with no session sees. Signing in is the default
   * because most people opening this panel already have an account; creating
   * one is the deliberate choice.
   */
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [status, setStatus] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  /* Separate from the identity actions: a checkout in flight must not be
     restartable by a second click while the first is still going. */
  const [billingBusy, setBillingBusy] = useState(false);
  const [billingError, setBillingError] = useState('');

  const dialog = useDialogBehavior<HTMLElement>({ onClose });

  const isGuest = !account || account.isAnonymous;
  const isPremium = entitlements.tier === 'premium';

  /*
   * One runner for every identity action. `done` may be empty for actions
   * whose result is the changed panel itself - saying "signed in" under a
   * panel that now shows the account would be noise.
   */
  const run = async (action: () => Promise<void>, done: string, needsEmail = true) => {
    if (busy || (needsEmail && !email.trim())) return;
    setBusy(true); setStatus(''); setActionError('');
    try {
      await action();
      setStatus(done);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const protectAccount = (event: FormEvent) => {
    event.preventDefault();
    void run(() => linkEmail(email), 'Check your email to confirm the address.');
  };

  const submitCredentials = (event: FormEvent) => {
    event.preventDefault();
    if (mode === 'signin') {
      void run(async () => {
        await signInWithPassword(email, password);
        setPasswordDraft('');
      }, '');
      return;
    }
    void run(async () => {
      const { needsConfirmation } = await signUpWithPassword(email, password);
      setPasswordDraft('');
      /*
       * Only claim an email was sent when one was. With confirmations off the
       * account is usable immediately, and telling someone to check their
       * inbox would send them looking for a message that never arrives.
       */
      setStatus(needsConfirmation ? 'Check your email to confirm your account.' : '');
    }, '');
  };

  const submitNewPassword = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await setPassword(password);
      setPasswordDraft('');
    }, 'Password set. You can sign in with it anywhere.', false);
  };

  /*
   * Both membership actions do the same thing: ask the server for a hosted
   * Stripe URL and go there. The browser never creates a Stripe object, and
   * nothing here can change a tier - only the verified webhook does that.
   */
  const goToStripe = async (request: () => Promise<string>, unavailable: string) => {
    if (billingBusy) return;
    if (!billing) { setBillingError(unavailable); return; }
    setBillingBusy(true); setBillingError('');
    try {
      window.location.assign(await request());
    } catch (reason) {
      setBillingError(reason instanceof Error ? reason.message : unavailable);
      /* Only cleared on failure: on success the page is navigating away, and
         re-enabling the button first would invite a second checkout. */
      setBillingBusy(false);
    }
  };

  return (
    <div className="overlay account-overlay">
      <section
        ref={dialog}
        className="account-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Your GlockTV account"
      >
        <header>
          <div><ShieldCheck /><h2>Your account</h2></div>
          <button type="button" aria-label="Close account" onClick={onClose}><X /></button>
        </header>

        <dl className="account-panel__status">
          <div>
            <dt>Signed in as</dt>
            <dd>
              {loading
                ? <span className="account-panel__pending"><LoaderCircle className="spin" /> Checking…</span>
                : isGuest ? 'Guest' : (account?.email ?? 'Signed in')}
            </dd>
          </div>
          <div>
            <dt>Membership</dt>
            {/* Free is what an account is until a server says otherwise, so it
                is stated plainly rather than as a downgrade. */}
            <dd className={isPremium ? 'account-panel__tier--premium' : undefined}>
              {isPremium ? <><Sparkles /> Premium · ad-free</> : 'Free'}
            </dd>
          </div>
        </dl>

        {error && <p className="account-panel__note" role="status">Membership status is unavailable right now, so this account is on the free tier.</p>}

        {/*
          * The membership card. Its state comes from the server's answer, never
          * from having just been through checkout.
          */}
        <section className="account-premium" aria-label="GlockTV Premium">
          <header>
            <div><Sparkles /><strong>GlockTV Premium</strong></div>
            <span>Ad-free GlockTV</span>
          </header>

          {confirmingMembership && (
            <p className="account-premium__pending" role="status">
              <LoaderCircle className="spin" /> Confirming membership…
            </p>
          )}

          {confirmationTimedOut && !isPremium && !confirmingMembership && (
            <p className="account-premium__pending" role="status">
              We have not had confirmation from the payment provider yet. Nothing is lost - this
              updates by itself once it arrives, and you can reopen this panel to check.
            </p>
          )}

          {isPremium ? (
            <div className="account-premium__actions">
              <button
                type="button"
                disabled={billingBusy}
                onClick={() => void goToStripe(
                  () => billing!.createPortalUrl(),
                  'The billing portal could not be opened.',
                )}
              >
                {billingBusy ? <LoaderCircle className="spin" /> : <CreditCard />} Manage membership
              </button>
            </div>
          ) : isGuest ? (
            /* No checkout for an anonymous account: it lives in one browser's
               storage, so a membership bought against it could be lost with a
               cleared cache and never recovered. */
            <p className="account-premium__gate" role="status">
              Protect your account with email first, then you can go Premium.
            </p>
          ) : (
            <div className="account-premium__actions">
              <button
                type="button"
                disabled={billingBusy}
                onClick={() => void goToStripe(
                  () => billing!.createCheckoutUrl(),
                  'Checkout could not be started.',
                )}
              >
                {billingBusy ? <LoaderCircle className="spin" /> : <Sparkles />} Go Premium
              </button>
            </div>
          )}

          {billingError && <small className="account-panel__error" role="alert">{billingError}</small>}
        </section>

        {/*
          * Three genuinely different situations, not one form with branches.
          *
          *  - Nobody signed in: an ordinary sign in / create account pair.
          *  - A guest with data: an UPGRADE, never a sign-up. Supabase's signUp
          *    would mint a second user and strand the guest's id, which their
          *    rooms, hosting and history are keyed to. And because a password
          *    can only be attached once the email is verified, the upgrade is
          *    necessarily two steps - that is Supabase's rule, not a choice.
          *  - Signed in for real: manage the account.
          */}
        {!account ? (
          <form onSubmit={submitCredentials} aria-label={mode === 'signin' ? 'Sign in' : 'Create account'}>
            <div className="account-panel__tabs" role="tablist" aria-label="Account access">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'signin'}
                onClick={() => { setMode('signin'); setStatus(''); setActionError(''); }}
              >
                Sign in
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'signup'}
                onClick={() => { setMode('signup'); setStatus(''); setActionError(''); }}
              >
                Create account
              </button>
            </div>
            <label>
              Email
              <input
                type="email"
                aria-label="Account email"
                autoComplete="email"
                value={email}
                onChange={(event) => { setEmail(event.target.value); setStatus(''); setActionError(''); }}
                placeholder="you@example.com"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                aria-label="Password"
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(event) => { setPasswordDraft(event.target.value); setStatus(''); setActionError(''); }}
              />
            </label>
            <div className="account-panel__actions">
              <button type="submit" disabled={busy || !email.trim() || !password}>
                {busy ? <LoaderCircle className="spin" /> : <ShieldCheck />}
                {mode === 'signin' ? 'Sign in' : 'Create account'}
              </button>
              {mode === 'signin' && (
                <button
                  type="button"
                  disabled={busy || !email.trim()}
                  onClick={() => void run(
                    () => sendPasswordReset(email),
                    'If that address has an account, a reset link is on its way.',
                  )}
                >
                  <KeyRound /> Forgot password
                </button>
              )}
            </div>
            {mode === 'signin' && (
              <button
                type="button"
                className="account-panel__link"
                disabled={busy || !email.trim()}
                onClick={() => void run(() => sendSignInLink(email), 'Sign-in link sent. Open it on this device.')}
              >
                <Mail /> Email me a sign-in link instead
              </button>
            )}
            {status && <small role="status">{status}</small>}
            {actionError && <small className="account-panel__error" role="alert">{actionError}</small>}
          </form>
        ) : account.isAnonymous ? (
          <form onSubmit={protectAccount} aria-label="Protect guest account">
            <p>
              You are browsing as a guest. Add an email to keep this identity - your rooms,
              hosting and history stay with you, on the same account.
            </p>
            <label>
              Email
              <input
                type="email"
                aria-label="Account email"
                autoComplete="email"
                value={email}
                onChange={(event) => { setEmail(event.target.value); setStatus(''); setActionError(''); }}
                placeholder="you@example.com"
              />
            </label>
            <div className="account-panel__actions">
              <button type="submit" disabled={busy || !email.trim()}>
                {busy ? <LoaderCircle className="spin" /> : <ShieldCheck />} Add email
              </button>
            </div>
            <p className="account-panel__note">
              You will set a password after confirming the address — a password can only be
              added to a guest account once its email is verified.
            </p>
            {status && <small role="status">{status}</small>}
            {actionError && <small className="account-panel__error" role="alert">{actionError}</small>}
          </form>
        ) : (
          <div className="account-panel__manage">
            {!account.hasPassword || !account.emailConfirmed ? (
              account.emailConfirmed ? (
                <form onSubmit={submitNewPassword} aria-label="Set a password">
                  <p>Set a password so you can sign in on another device.</p>
                  <label>
                    New password
                    <input
                      type="password"
                      aria-label="New password"
                      autoComplete="new-password"
                      value={password}
                      onChange={(event) => { setPasswordDraft(event.target.value); setStatus(''); setActionError(''); }}
                    />
                  </label>
                  <div className="account-panel__actions">
                    <button type="submit" disabled={busy || !password}>
                      {busy ? <LoaderCircle className="spin" /> : <KeyRound />} Set password
                    </button>
                  </div>
                </form>
              ) : (
                <p className="account-panel__note" role="status">
                  Confirm {account.email ?? 'your email'} from the message we sent, then reopen
                  this panel to set a password.
                </p>
              )
            ) : (
              <p>Signed in as {account.email}.</p>
            )}
            <div className="account-panel__actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => sendPasswordReset(account.email ?? email), 'Reset link sent.')}
              >
                <KeyRound /> Change password
              </button>
              <button type="button" disabled={busy} onClick={() => void run(signOut, '', false)}>
                <LogOut /> Sign out
              </button>
            </div>
            {status && <small role="status">{status}</small>}
            {actionError && <small className="account-panel__error" role="alert">{actionError}</small>}
          </div>
        )}

        {onOpenSupport && (
          <div className="account-panel__actions">
            <button type="button" onClick={onOpenSupport}>
              <LifeBuoy /> Contact support
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
