import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AccountProvider } from '../src/components/AccountProvider';
import { AdSlot } from '../src/components/AdSlot';
import type { AccountService } from '../src/lib/accountService';
import type { AdConfig } from '../src/lib/ads';
import { FREE_ENTITLEMENTS, type Entitlements } from '../src/lib/account';
import adSlotSource from '../src/components/AdSlot.tsx?raw';
import adsSource from '../src/lib/ads.ts?raw';
import adsCss from '../src/ads.css?raw';
import playbackModalSource from '../src/components/PlaybackModal.tsx?raw';
import appSource from '../src/App.tsx?raw';
import friendsSource from '../src/components/FriendsExperience.tsx?raw';

const PREMIUM: Entitlements = { tier: 'premium', adsEnabled: false };
const config: AdConfig = {
  provider: 'hilltopads',
  scriptUrl: 'https://ads.example.com/zone/abc.js',
  zones: { 'context-rail': 'zone_123' },
};

/* Resolves entitlements only when released, so the loading window is a real
   state to assert against rather than a race. */
function deferredService(entitlements: Entitlements) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const service: AccountService = {
    loadAccount: async () => ({ id: 'user-a', email: 'a@example.com', isAnonymous: false, createdAt: null }),
    loadEntitlements: async () => { await gate; return { entitlements, error: '' }; },
    linkEmail: async () => {},
    sendSignInLink: async () => {},
    onAuthChange: () => () => {},
  };
  return { service, release: () => release() };
}

function settledService(entitlements: Entitlements): AccountService {
  return {
    loadAccount: async () => ({ id: 'user-a', email: 'a@example.com', isAnonymous: false, createdAt: null }),
    loadEntitlements: async () => ({ entitlements, error: '' }),
    linkEmail: async () => {},
    sendSignInLink: async () => {},
    onAuthChange: () => () => {},
  };
}

function mount(service: AccountService | null, slotConfig: AdConfig | null = config) {
  return render(
    <AccountProvider service={service}>
      <AdSlot placement="context-rail" config={slotConfig} />
    </AccountProvider>,
  );
}

const frame = () => document.querySelector('iframe');

describe('a Premium member executes no ad code', () => {
  it('renders no frame at all, rather than hiding one', () => {
    /*
     * The requirement is zero execution, not zero visibility. A hidden iframe
     * would still have fetched and run the network's script, so this asserts
     * the element does not exist - there is nothing to fetch it.
     */
    mount(settledService(PREMIUM));
    return waitFor(() => {
      expect(frame()).toBeNull();
      expect(document.querySelector('.ad-slot')).toBeNull();
      expect(document.body.innerHTML).not.toContain('ads.example.com');
    });
  });

  it('stops executing when a free account becomes Premium', async () => {
    /* Teardown is the frame unmounting, which takes the script's whole
       execution context with it - there is no provider SDK left running. */
    let entitlements = FREE_ENTITLEMENTS;
    let notify = () => {};
    const service: AccountService = {
      loadAccount: async () => ({ id: 'user-a', email: 'a@example.com', isAnonymous: false, createdAt: null }),
      loadEntitlements: async () => ({ entitlements, error: '' }),
      linkEmail: async () => {},
      sendSignInLink: async () => {},
      onAuthChange: (listener) => { notify = listener; return () => {}; },
    };
    mount(service);
    await waitFor(() => expect(frame()).not.toBeNull());

    entitlements = PREMIUM;
    notify();
    await waitFor(() => expect(frame()).toBeNull());
  });
});

describe('nothing runs before the account settles', () => {
  it('waits, even though policy would already permit ads', async () => {
    const { service, release } = deferredService(FREE_ENTITLEMENTS);
    mount(service);

    /* Entitlements are still in flight: fail-closed says "free, ads allowed",
       and this is the moment that must still render nothing. */
    await Promise.resolve();
    expect(frame()).toBeNull();

    release();
    await waitFor(() => expect(frame()).not.toBeNull());
  });

  it('never shows a member their ad slot while confirming their membership', async () => {
    const { service, release } = deferredService(PREMIUM);
    mount(service);
    await Promise.resolve();
    expect(frame()).toBeNull();

    release();
    /* And it stays absent once the answer arrives. */
    await waitFor(() => expect(document.querySelector('.ad-slot')).toBeNull());
  });
});

describe('a free account with a configured network', () => {
  it('renders one sandboxed frame carrying the configured script', async () => {
    mount(settledService(FREE_ENTITLEMENTS));
    await waitFor(() => expect(frame()).not.toBeNull());

    const element = frame()!;
    expect(element.getAttribute('srcdoc')).toContain('https://ads.example.com/zone/abc.js');
    expect(screen.getByLabelText('Sponsored')).toBeInTheDocument();
  });

  it('sandboxes so a popunder or a redirect cannot run even if served', async () => {
    /*
     * allow-scripts and nothing else. Without allow-same-origin the frame has
     * a null origin and cannot reach this site's storage or Supabase session;
     * without allow-popups or allow-top-navigation, the formats this product
     * refuses to ship cannot execute at all.
     */
    mount(settledService(FREE_ENTITLEMENTS));
    await waitFor(() => expect(frame()).not.toBeNull());

    expect(frame()!.getAttribute('sandbox')).toBe('allow-scripts');
    for (const capability of ['allow-same-origin', 'allow-popups', 'allow-top-navigation', 'allow-modals', 'allow-downloads']) {
      expect(frame()!.getAttribute('sandbox')).not.toContain(capability);
    }
  });

  it('hands the frame no account identifier', async () => {
    mount(settledService(FREE_ENTITLEMENTS));
    await waitFor(() => expect(frame()).not.toBeNull());
    const srcdoc = frame()!.getAttribute('srcdoc')!.toLowerCase();
    /* The signed-in fixture's own address, specifically. */
    expect(srcdoc).not.toContain('a@example.com');
    expect(srcdoc).not.toContain('user-a');
  });
});

describe('an unconfigured build', () => {
  it('shows no slot, no placeholder and no empty box', async () => {
    mount(settledService(FREE_ENTITLEMENTS), null);
    await Promise.resolve();
    expect(document.querySelector('.ad-slot')).toBeNull();
    expect(frame()).toBeNull();
  });

  it('still works with no account layer at all', async () => {
    mount(null, config);
    /* No backend means guest, which means ads are permitted - and the account
       layer reports ready immediately, so the slot renders. */
    await waitFor(() => expect(frame()).not.toBeNull());
  });
});

describe('the decision is not scattered', () => {
  it('is asked once, through the account layer', () => {
    /* No component re-derives an ad rule from a tier. If a second
       `tier === 'premium'` appears in ad code, there are two policies to keep
       in step and one of them will drift. */
    expect(adSlotSource).not.toMatch(/tier\s*===\s*['"]premium['"]/);
    expect(adsSource).toContain("from './account'");
    expect((adsSource.match(/tier\s*===\s*['"]premium['"]/g) ?? [])).toHaveLength(0);
  });

  it('keeps ads out of the player and away from Friends', () => {
    expect(playbackModalSource).not.toContain('AdSlot');
    expect(friendsSource).not.toContain('AdSlot');
    /* And the two places it is used are the two documented placements. */
    const uses = [...appSource.matchAll(/<AdSlot placement="([a-z-]+)"/g)].map((match) => match[1]);
    expect(uses.sort()).toEqual(['context-rail', 'details-panel']);
  });

  it('never places a slot inside the navigation', () => {
    const nav = appSource.slice(
      appSource.indexOf('<nav className="bottom-nav"'),
      appSource.indexOf('</nav>', appSource.indexOf('<nav className="bottom-nav"')),
    );
    expect(nav).not.toContain('AdSlot');
  });

  it('cannot stack above a dialog or the navigation', () => {
    /* Dialogs sit at 80 and the bottom navigation at 40. An ad that could
       cover either is the failure mode this rule exists to prevent. */
    const zIndex = Number(/\.ad-slot\s*\{[^}]*z-index:\s*(\d+)/.exec(adsCss)?.[1]);
    expect(zIndex).toBeLessThan(40);
    expect(adsCss).not.toMatch(/\.ad-slot[^{]*\{[^}]*position:\s*(fixed|sticky)/);
  });
});
