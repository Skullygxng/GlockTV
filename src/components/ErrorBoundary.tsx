import { Component, type ErrorInfo, type ReactNode } from 'react';

/*
 * The last line before a blank page.
 *
 * Without this, a render-time throw anywhere in the tree unmounts the whole
 * app and leaves an empty <div id="root">. The viewer sees a white screen,
 * cannot tell whether the site is down or their connection is, and nothing is
 * recorded anywhere. That is the single worst failure mode a live site can
 * have, because it is both total and silent.
 *
 * What this deliberately does NOT do:
 *
 *   - It does not report to a third party. There is no error-reporting service
 *     configured for this project, and inventing an endpoint here would send
 *     viewer data somewhere nobody chose. onError is the seam for that when a
 *     service is actually picked.
 *   - It does not show the viewer a stack trace or an error message from the
 *     exception. Those routinely carry URLs, ids and occasionally tokens, and
 *     the person reading it cannot act on any of it. The details go to the
 *     console, which is where someone debugging will look.
 *
 * React error boundaries only catch errors thrown while rendering, in
 * lifecycle methods, and in constructors below them. They do NOT catch errors
 * in event handlers, in async callbacks, or in the boundary itself - those
 * still reach window.onerror. This is a floor, not a net.
 */

interface ErrorBoundaryProps {
  children: ReactNode;
  /* Seam for a reporting service, once one is chosen. Never called with PII
     beyond whatever the thrown error itself carries. */
  onError?: (error: Error, info: ErrorInfo) => void;
  /* Injected in tests so a case can assert the fallback without a real crash. */
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  crashed: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { crashed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    /* eslint-disable-next-line no-console -- the console is the only reporting
       surface this project has until a service is configured. */
    console.error('GlockTV crashed while rendering:', error, info.componentStack);
    try {
      this.props.onError?.(error, info);
    } catch {
      /* A reporter that throws must not replace the crash it was reporting. */
    }
  }

  private reload = () => {
    /*
     * A full reload rather than clearing the flag. Whatever state produced the
     * throw is still in memory, so re-rendering the same tree usually just
     * throws again - and a button that visibly does nothing is worse than no
     * button.
     */
    window.location.reload();
  };

  render() {
    if (!this.state.crashed) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;

    return (
      <div className="app-crash" role="alert">
        <h1>GlockTV hit an error</h1>
        <p>
          Something on this page stopped working. Reloading usually clears it. If it keeps
          happening, it is our problem and not yours.
        </p>
        <button type="button" onClick={this.reload}>
          Reload GlockTV
        </button>
      </div>
    );
  }
}
