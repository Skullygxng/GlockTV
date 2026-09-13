import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import mainSource from '../src/main.tsx?raw';
import styles from '../src/styles.css?raw';

/*
 * Before this, a render-time throw anywhere unmounted the whole tree and left
 * an empty #root: a white screen, no explanation, and nothing recorded. Total
 * and silent is the worst pair of properties a live site can have.
 */

function Boom(): never {
  throw new Error('kaboom at https://example.test/secret?token=SHOULD-NOT-RENDER');
}

describe('the render-crash boundary', () => {
  beforeEach(() => {
    /* React logs the caught error itself; silence it so a passing run is not
       full of red that means nothing. */
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the children when nothing throws', () => {
    render(<ErrorBoundary><p>all good</p></ErrorBoundary>);
    expect(screen.getByText('all good')).toBeInTheDocument();
  });

  it('replaces a crash with a fallback instead of an empty page', () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/GlockTV hit an error/i)).toBeInTheDocument();
    expect(document.body.textContent?.trim()).not.toBe('');
  });

  it('never shows the viewer the error text', () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    /* Thrown messages routinely carry URLs, ids and sometimes tokens, and the
       viewer cannot act on any of it. */
    expect(document.body.textContent).not.toContain('SHOULD-NOT-RENDER');
    expect(document.body.textContent).not.toContain('kaboom');
  });

  it('hands the error to a reporter, so a service can be wired in later', () => {
    const onError = vi.fn();
    render(<ErrorBoundary onError={onError}><Boom /></ErrorBoundary>);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('survives a reporter that throws, rather than replacing the crash', () => {
    const onError = vi.fn(() => { throw new Error('reporter down'); });
    render(<ErrorBoundary onError={onError}><Boom /></ErrorBoundary>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('offers a reload that actually reloads', () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    });
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    fireEvent.click(screen.getByRole('button', { name: /Reload GlockTV/i }));
    expect(reload).toHaveBeenCalled();
  });

  it('logs the details to the console, which is the only reporting surface there is', () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join(' ');
    expect(logged).toContain('GlockTV crashed while rendering');
  });
});

describe('the boundary is actually installed', () => {
  it('wraps the real app at the entry point', () => {
    /* A boundary that exists but is never mounted is worse than none, because
       it reads as covered. */
    expect(mainSource).toContain('<ErrorBoundary>');
    expect(mainSource.indexOf('<ErrorBoundary>')).toBeLessThan(mainSource.indexOf('<App />'));
  });

  it('covers the Live TV integration too, not just App', () => {
    const open = mainSource.indexOf('<ErrorBoundary>');
    const close = mainSource.indexOf('</ErrorBoundary>');
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    expect(mainSource.slice(open, close)).toContain('<LiveTvIntegration />');
  });

  it('styles the fallback, so it cannot render as invisible text', () => {
    expect(styles).toContain('.app-crash');
  });
});
