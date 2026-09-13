import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountProvider, useAccount } from '../src/components/AccountProvider';
import { passwordAuthStubs } from './support/accountStubs';
import type { AccountService } from '../src/lib/accountService';
import type { GlockTvAccount } from '../src/lib/account';
import {
  PLAYBACK_PROGRESS_KEY,
  clearLocalPlaybackProgress,
  localProgressEntries,
  savePlaybackProgress,
} from '../src/lib/playbackProgress';

/*
 * A shared browser is the ordinary case for this app, not an exotic one.
 *
 * Watch progress lives under one localStorage key that is NOT scoped to an
 * account, and WatchProgressProvider uploads whatever it finds locally to
 * whoever is signed in. Adding a sign-out button turned account switching on
 * one machine into a designed flow, so without clearing on the way out the
 * next person inherits the previous person's history and pushes it into their
 * own cloud account permanently.
 */

const member: GlockTvAccount = {
  id: 'user-1',
  email: 'first@example.com',
  isAnonymous: false,
  createdAt: null,
  emailConfirmed: true,
  hasPassword: true,
};

function seedProgress() {
  /* The real store shape: keyed by playbackProgressId, value is a
     PlaybackProgress record. Written through the module rather than by hand so
     the fixture cannot drift from the format the reader expects. */
  savePlaybackProgress(
    { id: 603, mediaType: 'movie' },
    { position: 1800, duration: 8100 },
  );
}

function service(account: GlockTvAccount | null): AccountService & { signOut: ReturnType<typeof vi.fn> } {
  let current = account;
  const stubs = passwordAuthStubs();
  return {
    ...stubs,
    loadAccount: vi.fn(async () => current),
    loadEntitlements: vi.fn(async () => ({ entitlements: { tier: 'free' as const, adsEnabled: true }, error: '' })),
    linkEmail: vi.fn(async () => {}),
    sendSignInLink: vi.fn(async () => {}),
    onAuthChange: () => () => {},
    signOut: vi.fn(async () => { current = null; }),
  } as never;
}

function Harness({ onReady }: { onReady: (state: ReturnType<typeof useAccount>) => void }) {
  const state = useAccount();
  onReady(state);
  return <span>{state.account?.email ?? 'guest'}</span>;
}

describe('signing out does not hand the next person your history', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('clears local watch progress when an account signs out', async () => {
    seedProgress();
    expect(localProgressEntries()).toHaveLength(1);

    let state: ReturnType<typeof useAccount> | null = null;
    const auth = service(member);
    render(
      <AccountProvider service={auth}>
        <Harness onReady={(value) => { state = value; }} />
      </AccountProvider>,
    );
    await screen.findByText('first@example.com');

    await act(async () => { await state!.signOut(); });

    expect(auth.signOut).toHaveBeenCalled();
    await waitFor(() => expect(localProgressEntries()).toHaveLength(0));
    expect(localStorage.getItem(PLAYBACK_PROGRESS_KEY)).toBeNull();
  });

  it('leaves progress alone while the account stays signed in', async () => {
    seedProgress();
    let state: ReturnType<typeof useAccount> | null = null;
    render(
      <AccountProvider service={service(member)}>
        <Harness onReady={(value) => { state = value; }} />
      </AccountProvider>,
    );
    await screen.findByText('first@example.com');

    await act(async () => { await state!.refresh(); });
    expect(localProgressEntries()).toHaveLength(1);
  });

  it('does not clear when sign-out fails, since the session is still that person', async () => {
    seedProgress();
    let state: ReturnType<typeof useAccount> | null = null;
    const auth = service(member);
    auth.signOut = vi.fn(async () => { throw new Error('network down'); });
    render(
      <AccountProvider service={auth}>
        <Harness onReady={(value) => { state = value; }} />
      </AccountProvider>,
    );
    await screen.findByText('first@example.com');

    await act(async () => {
      await expect(state!.signOut()).rejects.toThrow('network down');
    });
    expect(localProgressEntries()).toHaveLength(1);
  });
});

describe('the clear helper itself', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('removes the key rather than writing an empty object', () => {
    seedProgress();
    clearLocalPlaybackProgress();
    expect(localStorage.getItem(PLAYBACK_PROGRESS_KEY)).toBeNull();
  });

  it('is safe to call when there is nothing stored', () => {
    expect(() => clearLocalPlaybackProgress()).not.toThrow();
  });

  it('survives storage that throws', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new Error('blocked'); },
    });
    expect(() => clearLocalPlaybackProgress()).not.toThrow();
    if (original) Object.defineProperty(window, 'localStorage', original);
  });
});
