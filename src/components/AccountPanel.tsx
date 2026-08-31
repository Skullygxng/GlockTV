import { type FormEvent, useState } from 'react';
import { LoaderCircle, Mail, ShieldCheck, Sparkles, X } from 'lucide-react';
import { useAccount } from './AccountProvider';
import { useDialogBehavior } from '../hooks/useDialogBehavior';

/*
 * The GlockTV account surface. It reads the global account layer and offers
 * the two identity actions; it has no way to change a tier, because nothing in
 * the browser does.
 */
export function AccountPanel({ onClose }: { onClose: () => void }) {
  const { account, entitlements, loading, error, linkEmail, sendSignInLink } = useAccount();
  const [email, setEmail] = useState(account?.email ?? '');
  const [status, setStatus] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);

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
