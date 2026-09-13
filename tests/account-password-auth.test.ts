import { describe, expect, it, vi } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  SIGN_UP_WOULD_ORPHAN,
  createAccountService,
  validatePassword,
} from '../src/lib/accountService';

/*
 * Email/password accounts, and the one rule that shapes the whole design:
 *
 * Supabase cannot attach a password to an anonymous account until that
 * account's email identity is verified. So a guest upgrade is necessarily two
 * steps, and a guest must never be routed through signUp - that would mint a
 * second user and strand the anonymous id their rooms, hosting, watch history
 * and entitlement row are keyed to.
 */

function authStub(overrides: Record<string, unknown> = {}) {
  return {
    getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
    signUp: vi.fn(async () => ({ data: { user: { id: 'u1' }, session: null }, error: null })),
    signInWithPassword: vi.fn(async () => ({ data: {}, error: null })),
    signInWithOtp: vi.fn(async () => ({ data: {}, error: null })),
    signInAnonymously: vi.fn(async () => ({ data: { user: { id: 'anon' } }, error: null })),
    updateUser: vi.fn(async () => ({ data: {}, error: null })),
    resetPasswordForEmail: vi.fn(async (_email: string, _options?: { redirectTo?: string }) => ({
      data: {},
      error: null,
    })),
    signOut: vi.fn(async () => ({ error: null })),
    getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    ...overrides,
  };
}

function serviceWith(auth: ReturnType<typeof authStub>) {
  return createAccountService({
    auth,
    from: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
  } as never);
}

describe('the orphan guard', () => {
  it('refuses sign-up when any session already exists', async () => {
    const auth = authStub({
      getSession: vi.fn(async () => ({ data: { session: { user: { id: 'anon-1' } } }, error: null })),
    });
    const service = serviceWith(auth);

    await expect(service.signUpWithPassword('a@b.c', 'a-strong-password')).rejects.toThrow(
      SIGN_UP_WOULD_ORPHAN,
    );
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it('checks the live session, not anything the app is holding', async () => {
    const auth = authStub({
      getSession: vi.fn(async () => ({ data: { session: { user: { id: 'anon-1' } } }, error: null })),
    });
    await expect(serviceWith(auth).signUpWithPassword('a@b.c', 'a-strong-password')).rejects.toThrow();
    expect(auth.getSession).toHaveBeenCalled();
  });

  it('allows sign-up when there is genuinely nobody to orphan', async () => {
    const auth = authStub();
    await serviceWith(auth).signUpWithPassword('a@b.c', 'a-strong-password');
    expect(auth.signUp).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@b.c', password: 'a-strong-password' }),
    );
  });
});

describe('sign up', () => {
  it('reports that confirmation is pending when no session comes back', async () => {
    const auth = authStub({
      signUp: vi.fn(async () => ({ data: { user: { id: 'u1' }, session: null }, error: null })),
    });
    expect(await serviceWith(auth).signUpWithPassword('a@b.c', 'a-strong-password')).toEqual({
      needsConfirmation: true,
    });
  });

  it('reports no confirmation needed when a session comes back', async () => {
    const auth = authStub({
      signUp: vi.fn(async () => ({
        data: { user: { id: 'u1' }, session: { access_token: 't' } },
        error: null,
      })),
    });
    expect(await serviceWith(auth).signUpWithPassword('a@b.c', 'a-strong-password')).toEqual({
      needsConfirmation: false,
    });
  });

  it('trims the address but never the password', async () => {
    const auth = authStub();
    await serviceWith(auth).signUpWithPassword('  a@b.c  ', '  spaces  count  ');
    expect(auth.signUp).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@b.c', password: '  spaces  count  ' }),
    );
  });

  it('rejects a short password before any request is made', async () => {
    const auth = authStub();
    await expect(serviceWith(auth).signUpWithPassword('a@b.c', 'short')).rejects.toThrow(
      /at least 8 characters/i,
    );
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it('surfaces the provider error rather than swallowing it', async () => {
    const auth = authStub({
      signUp: vi.fn(async () => ({ data: {}, error: { message: 'User already registered' } })),
    });
    await expect(serviceWith(auth).signUpWithPassword('a@b.c', 'a-strong-password')).rejects.toThrow(
      'User already registered',
    );
  });
});

describe('sign in, reset and sign out', () => {
  it('signs in with the exact credentials given', async () => {
    const auth = authStub();
    await serviceWith(auth).signInWithPassword(' a@b.c ', 'a-strong-password');
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'a@b.c',
      password: 'a-strong-password',
    });
  });

  it('surfaces a failed sign-in', async () => {
    const auth = authStub({
      signInWithPassword: vi.fn(async () => ({ data: {}, error: { message: 'Invalid login credentials' } })),
    });
    await expect(serviceWith(auth).signInWithPassword('a@b.c', 'nope-nope-nope')).rejects.toThrow(
      'Invalid login credentials',
    );
  });

  it('sends a reset to a redirect inside the app, not the bare origin', async () => {
    const auth = authStub();
    await serviceWith(auth).sendPasswordReset('a@b.c');
    const [address, options] = auth.resetPasswordForEmail.mock.calls[0];
    expect(address).toBe('a@b.c');
    /* GlockTV is served from a project subpath, so the bare origin would land
       the visitor outside the app entirely. */
    expect(String(options?.redirectTo)).toContain(import.meta.env.BASE_URL);
  });

  it('signs out and surfaces a failure to do so', async () => {
    const ok = authStub();
    await serviceWith(ok).signOut();
    expect(ok.signOut).toHaveBeenCalled();

    const bad = authStub({ signOut: vi.fn(async () => ({ error: { message: 'network down' } })) });
    await expect(serviceWith(bad).signOut()).rejects.toThrow('network down');
  });
});

describe('setting a password on an existing account', () => {
  it('updates only the password, leaving the identity alone', async () => {
    const auth = authStub();
    await serviceWith(auth).setPassword('a-strong-password');
    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'a-strong-password' });
  });

  it('applies the same length floor as sign-up', async () => {
    const auth = authStub();
    await expect(serviceWith(auth).setPassword('short')).rejects.toThrow(/at least 8/i);
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('never mints a user - a password needs an account that already exists', async () => {
    const auth = authStub();
    await serviceWith(auth).setPassword('a-strong-password');
    expect(auth.signInAnonymously).not.toHaveBeenCalled();
  });
});

describe('what loadAccount reports', () => {
  it('reads confirmation and password state from the user, not from guesses', async () => {
    const auth = authStub({
      getUser: vi.fn(async () => ({
        data: {
          user: {
            id: 'u1',
            email: 'a@b.c',
            is_anonymous: false,
            created_at: '2026-01-01T00:00:00Z',
            email_confirmed_at: '2026-01-02T00:00:00Z',
            identities: [{ provider: 'email' }],
          },
        },
        error: null,
      })),
    });
    expect(await serviceWith(auth).loadAccount()).toEqual({
      id: 'u1',
      email: 'a@b.c',
      isAnonymous: false,
      createdAt: '2026-01-01T00:00:00Z',
      emailConfirmed: true,
      hasPassword: true,
    });
  });

  it('reports an unconfirmed anonymous account as neither confirmed nor password-capable', async () => {
    const auth = authStub({
      getUser: vi.fn(async () => ({
        data: { user: { id: 'anon', is_anonymous: true, identities: [] } },
        error: null,
      })),
    });
    const account = await serviceWith(auth).loadAccount();
    expect(account?.isAnonymous).toBe(true);
    expect(account?.emailConfirmed).toBe(false);
    expect(account?.hasPassword).toBe(false);
  });

  it('does not mistake an anonymous identity for an email one', async () => {
    const auth = authStub({
      getUser: vi.fn(async () => ({
        data: { user: { id: 'anon', is_anonymous: true, identities: [{ provider: 'anonymous' }] } },
        error: null,
      })),
    });
    expect((await serviceWith(auth).loadAccount())?.hasPassword).toBe(false);
  });
});

describe('the password rule', () => {
  it('states the floor rather than hinting at it', () => {
    expect(validatePassword('x'.repeat(MIN_PASSWORD_LENGTH - 1))).toMatch(/at least 8/i);
    expect(validatePassword('x'.repeat(MIN_PASSWORD_LENGTH))).toBe('');
  });

  it('is not below Supabase own floor of six', () => {
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(6);
  });
});
