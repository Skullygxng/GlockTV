import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { MediaItem } from '../src/lib/media';
import type { TmdbClient } from '../src/lib/tmdb';
import type { AccountService } from '../src/lib/accountService';
import { FREE_ENTITLEMENTS, type Entitlements, type GlockTvAccount } from '../src/lib/account';
import { partyPlaybackConfig, makePartyService } from './friends-party-harness';

/*
 * The global account layer as a user meets it: one entry point in the shell,
 * one answer about who they are, and Friends reading that answer rather than
 * asking Supabase again.
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

interface FakeAccountService extends AccountService {
  fire: () => void;
}

function accountService(
  account: GlockTvAccount | null,
  entitlements: Entitlements = FREE_ENTITLEMENTS,
  overrides: Partial<AccountService> = {},
): FakeAccountService {
  let listener: (() => void) | null = null;
  return {
    loadAccount: vi.fn(async () => account),
    loadEntitlements: vi.fn(async () => ({ entitlements, error: '' })),
    linkEmail: vi.fn(async (_email: string) => {}),
    sendSignInLink: vi.fn(async (_email: string) => {}),
    onAuthChange: (next: () => void) => { listener = next; return () => { listener = null; }; },
    ...overrides,
    /* Simulate Supabase reporting a session change. */
    fire: () => listener?.(),
  } as FakeAccountService;
}

async function ready() {
  await screen.findByRole('heading', { name: 'Heat' });
}

/*
 * The account is reachable from two places by design - the topbar on desktop
 * and the tab bar on phones - so a test that opens it has to say which.
 */
function topbar(): HTMLElement {
  return document.querySelector('header.topbar') as HTMLElement;
}

async function openAccount() {
  const trigger = await within(topbar()).findByRole('button', { name: /^Your account/ });
  trigger.focus();
  fireEvent.click(trigger);
  return screen.findByRole('dialog', { name: 'Your GlockTV account' });
}

describe('global account surface', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
    localStorage.clear();
  });

  it('lets a first-time visitor browse with no account and no sign-in wall', async () => {
    const service = accountService(null);
    render(<App client={client()} accountService={service} />);
    await ready();

    // The feed is there without anyone having signed in or been asked to.
    expect(screen.getByRole('heading', { name: 'Heat' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Your GlockTV account' })).not.toBeInTheDocument();
    expect(service.loadAccount).toHaveBeenCalled();
    // No session means nothing to ask about, so no entitlement request at all.
    expect(service.loadEntitlements).not.toHaveBeenCalled();
    /*
     * And nothing that could mint an identity ran. Rendering the app must
     * never turn a passer-by into a row in auth.users.
     */
    expect(service.linkEmail).not.toHaveBeenCalled();
    expect(service.sendSignInLink).not.toHaveBeenCalled();
  });

  it('does not go stale when auth events land during account protection', async () => {
    /*
     * Protecting an account fires SIGNED_IN from the anonymous sign-in and
     * USER_UPDATED from the email attach, so the provider reloads more than
     * once for one user action. The request-version guard has to leave the
     * newest answer standing rather than an in-flight older one.
     */
    let identity: GlockTvAccount | null = null;
    const service = accountService(null);
    service.loadAccount = vi.fn(async () => identity);
    service.linkEmail = vi.fn(async (email: string) => {
      identity = { id: 'anon-new', email: null, isAnonymous: true, createdAt: null };
      service.fire();                            // SIGNED_IN, still anonymous
      identity = { id: 'anon-new', email, isAnonymous: false, createdAt: null };
      service.fire();                            // USER_UPDATED, now linked
    });

    render(<App client={client()} accountService={service} />);
    await ready();
    const dialog = await openAccount();

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Account email' }), {
      target: { value: 'viewer@example.com' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /Protect guest account/ }));

    expect(await within(dialog).findByText('viewer@example.com')).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).queryByText('Guest')).not.toBeInTheDocument());
    expect(service.linkEmail).toHaveBeenCalledTimes(1);
  });

  it('shows a guest as a guest on the free tier', async () => {
    render(<App client={client()} accountService={accountService(guest)} />);
    await ready();
    const dialog = await openAccount();

    expect(within(dialog).getByText('Guest')).toBeInTheDocument();
    expect(within(dialog).getByText('Free')).toBeInTheDocument();
    /* The Premium card is on show for a free member - what must be absent is
       the entitled status, not the word. */
    expect(within(dialog).queryByText(/Premium · ad-free/)).not.toBeInTheDocument();
  });

  it('shows a linked email once the account is protected', async () => {
    render(<App client={client()} accountService={accountService(member)} />);
    await ready();
    const dialog = await openAccount();

    expect(within(dialog).getByText('viewer@example.com')).toBeInTheDocument();
    expect(within(dialog).getByText('Free')).toBeInTheDocument();
    expect(await within(topbar()).findByRole('button', { name: 'Your account, viewer@example.com' })).toBeInTheDocument();
  });

  it('shows Premium and ad-free for an entitled account fixture', async () => {
    render(<App client={client()} accountService={accountService(member, { tier: 'premium', adsEnabled: false })} />);
    await ready();
    const dialog = await openAccount();

    expect(within(dialog).getByText(/Premium · ad-free/)).toBeInTheDocument();
    expect(await within(topbar()).findByRole('button', { name: 'Your account, Premium' })).toBeInTheDocument();
  });

  it('offers no control that could change the tier', async () => {
    render(<App client={client()} accountService={accountService(guest)} />);
    await ready();
    const dialog = await openAccount();

    /*
     * There is no upgrade path yet, and more importantly no client-side one
     * ever. Every control in the panel is checked, not just the ones expected.
     */
    const controls = within(dialog).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
    for (const label of controls) {
      expect(/upgrade|premium|subscribe|checkout|pay|buy|plan/i.test(label)).toBe(false);
    }
    expect(within(dialog).queryByRole('textbox', { name: /tier/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('keeps the free tier and says so when entitlements cannot be read', async () => {
    const service = accountService(guest);
    service.loadEntitlements = vi.fn(async () => ({ entitlements: FREE_ENTITLEMENTS, error: 'network down' }));
    render(<App client={client()} accountService={service} />);
    await ready();
    const dialog = await openAccount();

    expect(within(dialog).getByText('Free')).toBeInTheDocument();
    expect(within(dialog).getByText(/Membership status is unavailable/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Premium · ad-free/)).not.toBeInTheDocument();
  });

  it('protects a guest account and requests a returning sign-in link', async () => {
    const service = accountService(guest);
    render(<App client={client()} accountService={service} />);
    await ready();
    const dialog = await openAccount();

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Account email' }), {
      target: { value: 'viewer@example.com' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /Protect guest account/ }));
    await waitFor(() => expect(service.linkEmail).toHaveBeenCalledWith('viewer@example.com'));
    expect(await within(dialog).findByText(/Check your email/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: /Email sign-in link/ }));
    await waitFor(() => expect(service.sendSignInLink).toHaveBeenCalledWith('viewer@example.com'));
    expect(await within(dialog).findByText(/Sign-in link sent/)).toBeInTheDocument();
  });

  it('reports a failed link attempt in the panel', async () => {
    const service = accountService(guest);
    service.linkEmail = vi.fn(async () => { throw new Error('That email is already in use.'); });
    render(<App client={client()} accountService={service} />);
    await ready();
    const dialog = await openAccount();

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Account email' }), { target: { value: 'taken@example.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Protect guest account/ }));

    expect(await within(dialog).findByText('That email is already in use.')).toBeInTheDocument();
    // The rest of the app is untouched by an account action failing.
    expect(screen.getByRole('heading', { name: 'Heat' })).toBeInTheDocument();
  });

  it('updates the account surface when the session changes, without a reload', async () => {
    let current: GlockTvAccount | null = guest;
    let tier: Entitlements = FREE_ENTITLEMENTS;
    const service = accountService(guest);
    service.loadAccount = vi.fn(async () => current);
    service.loadEntitlements = vi.fn(async () => ({ entitlements: tier, error: '' }));

    render(<App client={client()} accountService={service} />);
    await ready();
    const dialog = await openAccount();
    expect(within(dialog).getByText('Guest')).toBeInTheDocument();

    // A magic-link sign-in lands: Supabase reports it, the surface follows.
    current = member;
    tier = { tier: 'premium', adsEnabled: false };
    service.fire();

    expect(await within(dialog).findByText('viewer@example.com')).toBeInTheDocument();
    expect(within(dialog).getByText(/Premium · ad-free/)).toBeInTheDocument();
  });

  it('protects a first-time visitor who has never opened a watch party', async () => {
    /*
     * The path the red-team caught: this visitor reached the account panel
     * without ever creating or joining a room, so nothing has minted them an
     * identity yet. Protecting the account has to work anyway - that is the
     * whole reason the surface is global.
     */
    let identity: GlockTvAccount | null = null;
    const linked: string[] = [];
    const service = accountService(null);
    service.loadAccount = vi.fn(async () => identity);
    service.linkEmail = vi.fn(async (email: string) => {
      // What the real service does: mint the anonymous user, then attach.
      identity = { id: 'anon-new', email, isAnonymous: false, createdAt: null };
      linked.push(email);
    });

    render(<App client={client()} accountService={service} />);
    await ready();

    const dialog = await openAccount();
    expect(within(dialog).getByText('Guest')).toBeInTheDocument();

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Account email' }), {
      target: { value: 'viewer@example.com' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /Protect guest account/ }));

    await waitFor(() => expect(linked).toEqual(['viewer@example.com']));
    expect(await within(dialog).findByText(/Check your email/)).toBeInTheDocument();
    // The panel now reflects the identity that protecting it created.
    expect(await within(dialog).findByText('viewer@example.com')).toBeInTheDocument();
  });

  it('offers Protect guest account to a visitor with no session at all', async () => {
    // Never solved by hiding the control until Friends has made a session.
    render(<App client={client()} accountService={accountService(null)} />);
    await ready();
    const dialog = await openAccount();

    expect(within(dialog).getByText('Guest')).toBeInTheDocument();
    expect(within(dialog).getByText('Free')).toBeInTheDocument();
    const protect = within(dialog).getByRole('button', { name: /Protect guest account/ });
    expect(protect).toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Account email' }), {
      target: { value: 'viewer@example.com' },
    });
    expect(protect).toBeEnabled();
  });

  it('is reachable from the mobile tab bar, where the topbar is hidden', async () => {
    render(<App client={client()} accountService={accountService(guest)} />);
    await ready();

    /*
     * The topbar is display:none on phones. Without its own entry in the tab
     * bar the account would simply be unreachable below the breakpoint.
     */
    const bar = screen.getByRole('navigation', { name: 'Mobile navigation' });
    const trigger = within(bar).getByRole('button', { name: 'Your account, guest' });
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'Your GlockTV account' });
    expect(within(dialog).getByText('Guest')).toBeInTheDocument();
  });

  it('labels the mobile entry point by tier', async () => {
    render(<App client={client()} accountService={accountService(member, { tier: 'premium', adsEnabled: false })} />);
    await ready();

    const bar = screen.getByRole('navigation', { name: 'Mobile navigation' });
    expect(await within(bar).findByRole('button', { name: 'Your account, Premium' })).toBeInTheDocument();
  });

  it('runs as a guest when there is no account backend at all', async () => {
    render(<App client={client()} accountService={null} />);
    await ready();
    const dialog = await openAccount();

    expect(within(dialog).getByText('Guest')).toBeInTheDocument();
    expect(within(dialog).getByText('Free')).toBeInTheDocument();
  });
});

describe('Friends consumes the global account', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
    localStorage.clear();
  });

  async function openFriends(service: AccountService | null, partyService = makePartyService()) {
    render(
      <App
        client={client()}
        accountService={service}
        partyService={partyService as never}
        partyPlaybackConfig={partyPlaybackConfig}
      />,
    );
    await ready();
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }),
    );
    await screen.findByLabelText('Your nickname');
    return partyService;
  }

  it('shows the guest identity from the global account, not its own fetch', async () => {
    const service = accountService(guest);
    await openFriends(service);

    expect(screen.getByText(/Playing as a guest/)).toBeInTheDocument();
    // Friends no longer owns account identity, so it has no account API to call.
    expect(service.loadAccount).toHaveBeenCalled();
  });

  it('shows the linked email from the global account', async () => {
    await openFriends(accountService(member));

    expect(await screen.findByText(/Saved to viewer@example.com/)).toBeInTheDocument();
  });

  it('no longer carries its own account panel', async () => {
    await openFriends(accountService(guest));

    expect(screen.queryByRole('button', { name: 'Open account' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Optional account')).not.toBeInTheDocument();
    // The one account surface is the shell's, reachable from either nav.
    expect(screen.getAllByRole('button', { name: /^Your account/ }).length).toBeGreaterThan(0);
  });

  it('still hosts a room as an anonymous guest', async () => {
    const partyService = await openFriends(accountService(guest));

    fireEvent.change(screen.getByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));

    await waitFor(() => expect(partyService.createRoom).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Change title' })).toBeInTheDocument();
  });

  it('still hosts a room when there is no account backend', async () => {
    const partyService = await openFriends(null);

    fireEvent.change(screen.getByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));

    await waitFor(() => expect(partyService.createRoom).toHaveBeenCalled());
  });
});
