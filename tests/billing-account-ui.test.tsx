import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { MediaItem } from '../src/lib/media';
import type { TmdbClient } from '../src/lib/tmdb';
import type { AccountService } from '../src/lib/accountService';
import type { BillingService } from '../src/lib/billing';
import { FREE_ENTITLEMENTS, type Entitlements, type GlockTvAccount } from '../src/lib/account';
import { MEMBERSHIP_CONFIRM_ATTEMPTS, MEMBERSHIP_CONFIRM_INTERVAL_MS } from '../src/components/AccountProvider';
import deployWorkflow from '../.github/workflows/deploy-supabase-functions.yml?raw';
import prWorkflow from '../.github/workflows/pr-checks.yml?raw';
import pagesWorkflow from '../.github/workflows/deploy-pages.yml?raw';

/*
 * Premium as a member meets it: what each kind of account is offered, and the
 * one thing that must stay true throughout - coming back from Stripe never
 * makes anybody Premium by itself.
 */

const feedItem: MediaItem = {
  id: 1, mediaType: 'movie', title: 'Heat', overview: 'o', date: '1995-12-15', year: '1995',
  genreIds: [28], genres: ['Action'], rating: 8.3, voteCount: 7200, popularity: 90,
  runtime: 170, posterPath: '/heat.jpg', backdropPath: '/heat-backdrop.jpg',
};

function client(): TmdbClient {
  return {
    getTrending: vi.fn().mockResolvedValue([feedItem]),
    discover: vi.fn().mockResolvedValue([feedItem]),
    search: vi.fn().mockResolvedValue([feedItem]),
    getTitleContext: vi.fn().mockResolvedValue({ trailer: null, providers: null, providerLink: null, details: feedItem }),
    getPersonCredits: vi.fn().mockResolvedValue([feedItem]),
  } as TmdbClient;
}

const guest: GlockTvAccount = { id: 'user-1', email: null, isAnonymous: true, createdAt: null };
const member: GlockTvAccount = { id: 'user-1', email: 'viewer@example.com', isAnonymous: false, createdAt: null };
const PREMIUM: Entitlements = { tier: 'premium', adsEnabled: false };

function accountService(account: GlockTvAccount | null, entitlements: Entitlements = FREE_ENTITLEMENTS): AccountService {
  return {
    loadAccount: vi.fn(async () => account),
    loadEntitlements: vi.fn(async () => ({ entitlements, error: '' })),
    linkEmail: vi.fn(async (_email: string) => {}),
    sendSignInLink: vi.fn(async (_email: string) => {}),
    onAuthChange: () => () => {},
  };
}

function billingService(over: Partial<BillingService> = {}): BillingService {
  return {
    createCheckoutUrl: vi.fn(async () => 'https://checkout.stripe.com/c/pay/cs_test'),
    createPortalUrl: vi.fn(async () => 'https://billing.stripe.com/p/session/bps_test'),
    ...over,
  };
}

function topbar(): HTMLElement {
  return document.querySelector('header.topbar') as HTMLElement;
}

async function openAccount() {
  await screen.findByRole('heading', { name: 'Heat' });
  const trigger = await within(topbar()).findByRole('button', { name: /^Your account/ });
  trigger.focus();
  fireEvent.click(trigger);
  return screen.findByRole('dialog', { name: 'Your GlockTV account' });
}

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  sessionStorage.clear();
  localStorage.clear();
  assign = vi.fn();
  /*
   * jsdom cannot navigate, so location is stubbed to capture where the panel
   * tried to send the browser. Built from explicit values rather than spread
   * from the current one: a previous test's stub would otherwise carry its
   * ?billing marker into this one.
   */
  stubLocation('/');
});

function stubLocation(url: string) {
  const parsed = new URL(url, 'http://localhost');
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      assign,
      href: parsed.href,
      origin: parsed.origin,
      pathname: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Premium in the account panel', () => {
  it('shows a guest the Premium card but no way to buy it', async () => {
    render(<App client={client()} accountService={accountService(guest)} billingService={billingService()} />);
    const dialog = await openAccount();
    const premium = within(dialog).getByRole('region', { name: 'GlockTV Premium' });

    expect(within(premium).getByText('Ad-free GlockTV')).toBeInTheDocument();
    expect(within(premium).getByText(/Protect your account with email first/)).toBeInTheDocument();
    /*
     * A membership bought against an anonymous account lives in one browser's
     * storage and is lost with it, so there is nothing to press.
     */
    expect(within(premium).queryByRole('button', { name: /Go Premium/ })).not.toBeInTheDocument();
    expect(within(premium).queryByRole('button', { name: /Manage membership/ })).not.toBeInTheDocument();
  });

  it('offers a linked free member Go Premium, and sends them to Stripe', async () => {
    const billing = billingService();
    render(<App client={client()} accountService={accountService(member)} billingService={billing} />);
    const dialog = await openAccount();

    const button = within(dialog).getByRole('button', { name: /Go Premium/ });
    fireEvent.click(button);

    await waitFor(() => expect(billing.createCheckoutUrl).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test'));
  });

  it('will not start a second checkout while the first is in flight', async () => {
    let release: (() => void) | undefined;
    const billing = billingService({
      createCheckoutUrl: vi.fn(() => new Promise<string>((resolve) => {
        release = () => resolve('https://checkout.stripe.com/c/pay/cs_test');
      })),
    });
    render(<App client={client()} accountService={accountService(member)} billingService={billing} />);
    const dialog = await openAccount();

    const button = within(dialog).getByRole('button', { name: /Go Premium/ });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    fireEvent.click(button);

    expect(billing.createCheckoutUrl).toHaveBeenCalledTimes(1);
    await act(async () => { release?.(); });
  });

  it('reports a checkout failure inside the panel and leaves the app alone', async () => {
    const billing = billingService({
      createCheckoutUrl: vi.fn(async () => { throw new Error('Protect your account with an email address before subscribing.'); }),
    });
    render(<App client={client()} accountService={accountService(member)} billingService={billing} />);
    const dialog = await openAccount();

    fireEvent.click(within(dialog).getByRole('button', { name: /Go Premium/ }));

    expect(await within(dialog).findByText(/Protect your account with an email address/)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Heat' })).toBeInTheDocument();
    // The button comes back so the member can retry.
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /Go Premium/ })).toBeEnabled());
  });

  it('gives a Premium member the portal instead of a purchase', async () => {
    const billing = billingService();
    render(<App client={client()} accountService={accountService(member, PREMIUM)} billingService={billing} />);
    const dialog = await openAccount();

    expect(within(dialog).getByText(/Premium · ad-free/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Go Premium/ })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: /Manage membership/ }));
    await waitFor(() => expect(billing.createPortalUrl).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://billing.stripe.com/p/session/bps_test'));
  });

  it('reports a portal failure inside the panel', async () => {
    const billing = billingService({
      createPortalUrl: vi.fn(async () => { throw new Error('The billing portal could not be opened.'); }),
    });
    render(<App client={client()} accountService={accountService(member, PREMIUM)} billingService={billing} />);
    const dialog = await openAccount();

    fireEvent.click(within(dialog).getByRole('button', { name: /Manage membership/ }));

    expect(await within(dialog).findByText('The billing portal could not be opened.')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('says Premium is unavailable rather than failing when billing is not configured', async () => {
    render(<App client={client()} accountService={accountService(member)} billingService={null} />);
    const dialog = await openAccount();

    fireEvent.click(within(dialog).getByRole('button', { name: /Go Premium/ }));

    expect(await within(dialog).findByText(/Checkout could not be started/)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('offers no control that could set a tier from the browser', async () => {
    render(<App client={client()} accountService={accountService(member)} billingService={billingService()} />);
    const dialog = await openAccount();

    const labels = within(dialog).getAllByRole('button')
      .map((button) => `${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`);
    for (const label of labels) {
      // Asking to be billed is fine; claiming a tier is not.
      expect(/set premium|make premium|activate premium|grant|unlock premium/i.test(label)).toBe(false);
    }
    expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();
  });
});

describe('returning from Stripe', () => {
  it('confirms with the server and does not grant Premium from the redirect alone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubLocation('/?billing=return');

    /* The server keeps saying free: the webhook never arrived. */
    const service = accountService(member);
    render(<App client={client()} accountService={service} billingService={billingService()} />);

    const dialog = await screen.findByRole('dialog', { name: 'Your GlockTV account' });
    expect(await within(dialog).findByText(/Confirming membership/)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEMBERSHIP_CONFIRM_INTERVAL_MS * (MEMBERSHIP_CONFIRM_ATTEMPTS + 1));
    });

    /* Bounded: it stops, and the member is still free because that is what the
       server said. Visiting the success URL is not proof of payment. */
    expect(within(dialog).queryByText(/Confirming membership/)).not.toBeInTheDocument();
    expect(within(dialog).getByText('Free')).toBeInTheDocument();
    expect(within(dialog).queryByText(/Premium · ad-free/)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/not had confirmation from the payment provider/)).toBeInTheDocument();
    expect(service.loadEntitlements).toHaveBeenCalledTimes(MEMBERSHIP_CONFIRM_ATTEMPTS + 1);
  });

  it('shows Premium once the server reports the webhook landed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubLocation('/?billing=return');

    let entitlements: Entitlements = FREE_ENTITLEMENTS;
    const service = accountService(member);
    service.loadEntitlements = vi.fn(async () => ({ entitlements, error: '' }));

    render(<App client={client()} accountService={service} billingService={billingService()} />);
    const dialog = await screen.findByRole('dialog', { name: 'Your GlockTV account' });
    expect(await within(dialog).findByText(/Confirming membership/)).toBeInTheDocument();

    /* The verified webhook applies server-side between polls. */
    entitlements = PREMIUM;
    await act(async () => { await vi.advanceTimersByTimeAsync(MEMBERSHIP_CONFIRM_INTERVAL_MS * 2); });

    expect(await within(dialog).findByText(/Premium · ad-free/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Manage membership/ })).toBeInTheDocument();
  });

  it('does not confirm anything on an ordinary visit', async () => {
    const service = accountService(member);
    render(<App client={client()} accountService={service} billingService={billingService()} />);
    await screen.findByRole('heading', { name: 'Heat' });

    // No marker, so no panel is forced open and no polling starts.
    expect(screen.queryByRole('dialog', { name: 'Your GlockTV account' })).not.toBeInTheDocument();
    await waitFor(() => expect(service.loadEntitlements).toHaveBeenCalledTimes(1));
  });
});

describe('function deployment', () => {
  it('deploys only from main, and only the three billing functions', () => {
    expect(deployWorkflow).toMatch(/on:[\s\S]*push:[\s\S]*branches: \[main\]/);
    for (const fn of ['create-checkout', 'create-billing-portal', 'stripe-webhook']) {
      expect(deployWorkflow).toContain(`supabase functions deploy ${fn}`);
    }
  });

  it('keeps deployment out of pull-request validation', () => {
    for (const workflow of [prWorkflow, pagesWorkflow]) {
      expect(workflow).not.toContain('functions deploy');
      expect(workflow).not.toContain('setup-cli');
    }
    expect(deployWorkflow).not.toMatch(/pull_request/);
  });

  it('never puts a billing secret into the Pages build', () => {
    /* The frontend bundle is public. Nothing that signs or authorizes may be
       compiled into it. */
    for (const secret of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SUPABASE_SERVICE_ROLE_KEY']) {
      expect(pagesWorkflow).not.toContain(secret);
      expect(prWorkflow).not.toContain(secret);
    }
  });
});
