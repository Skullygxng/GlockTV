import { type FormEvent, useState } from 'react';
import { CreditCard, LoaderCircle, Mail, ShieldCheck, Sparkles, X } from 'lucide-react';
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
  billing: providedBilling,
}: {
  onClose: () => void;
  /* Omit for the app's own billing client; pass null to run with no backend. */
  billing?: BillingService | null;
}) {
  const {
    account, entitlements, loading, error,
    confirmingMembership, confirmationTimedOut,
    linkEmail, sendSignInLink,
  } = useAccount();
  const billing = providedBilling === undefined ? getDefaultBilling() : providedBilling;

  const [email, setEmail] = useState(account?.email ?? '');
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

  const run = async (action: () => Promise<void>, done: string) => {
    if (busy || !email.trim()) return;
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
    void run(() => linkEmail(email), 'Check your email to finish protecting this account.');
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

        <form onSubmit={protectAccount}>
          <p>
            {isGuest
              ? 'Add an email to keep this identity across devices. Your rooms, hosting and history stay with you.'
              : 'Need to sign in somewhere else? Send yourself a link.'}
          </p>
          <label>
            Account email
            <input
              type="email"
              aria-label="Account email"
              value={email}
              onChange={(event) => { setEmail(event.target.value); setStatus(''); setActionError(''); }}
              placeholder="you@example.com"
            />
          </label>
          <div className="account-panel__actions">
            {isGuest && (
              <button type="submit" disabled={busy || !email.trim()}>
                <ShieldCheck /> Protect guest account
              </button>
            )}
            <button
              type="button"
              disabled={busy || !email.trim()}
              onClick={() => void run(() => sendSignInLink(email), 'Sign-in link sent. Open it on this device.')}
            >
              <Mail /> Email sign-in link
            </button>
          </div>
          {status && <small role="status">{status}</small>}
          {actionError && <small className="account-panel__error" role="alert">{actionError}</small>}
        </form>
      </section>
    </div>
  );
}
