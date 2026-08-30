import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveTvRoute } from '../src/components/LiveTvRoute';
import { PpvPanel } from '../src/components/PpvPanel';
import { PpvCatalogError, type PpvCatalog } from '../src/lib/ppv';
import type { PpvCatalogDiagnostics } from '../src/lib/ppvDiagnostics';
import liveTvCss from '../src/live-tv.css?raw';

/*
 * The real-device failure: a catalog rejection leaves nothing selectable, so
 * the Live TV stage never enters watching mode, and below 900px CSS hides the
 * whole .live-tv-content column - taking the diagnostics panel that explains
 * the failure down with it.
 */
const catalogDiagnostics: PpvCatalogDiagnostics = {
  stage: 'catalog',
  startedAt: 0,
  completedAt: 1,
  fight: { status: 'network_or_cors_error', httpStatus: null, rowCount: 0 },
  live: { status: 'http_error', httpStatus: 503, rowCount: 0 },
  today: { status: 'timeout', httpStatus: null, rowCount: 0 },
  normalizedEvents: 0,
  overallStatus: 'network_or_cors_error',
};

const emptyCatalog: PpvCatalog = {
  source: 'streamed',
  loadedAt: '2026-08-30T12:00:00.000Z',
  events: [],
  diagnostics: { ...catalogDiagnostics, overallStatus: 'empty_success' },
};

const populated: PpvCatalog = {
  source: 'streamed',
  loadedAt: '2026-08-30T12:00:00.000Z',
  events: [
    {
      provider: 'streamed',
      providerEventId: 'ufc-320',
      providerRefs: { streamed: { eventId: 'ufc-320' } },
      catalogProvenance: { feeds: ['fight'], upstreamCategories: ['fight'] },
      title: 'UFC 320',
      category: 'mma',
      startsAt: '2026-08-31T22:00:00.000Z',
      status: 'live',
      sourceRefs: [],
      embeds: [{ provider: 'streamed', source: 'delta', url: 'https://embed.st/embed/delta/320/1?token=SECRET' }],
    },
  ],
  diagnostics: catalogDiagnostics,
};

const failingCatalog = () => Promise.reject(new PpvCatalogError(catalogDiagnostics));

function panels() {
  return screen.queryAllByLabelText('PPV runtime diagnostics');
}

describe('PPV catalog-failure diagnostics reachability', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the mobile hiding rule that caused the deadlock', () => {
    // Documents the constraint the fix has to live with rather than remove.
    expect(liveTvCss).toMatch(
      /\.live-tv-stage:not\(\.live-tv-stage--watching\) \.live-tv-content\{\s*display:none/,
    );
  });

  it('renders the unselected panel inside the browser column, not the hidden content column', async () => {
    render(<PpvPanel debug loadCatalog={failingCatalog as never} />);
    await screen.findByText('PPV could not load');

    const panel = screen.getByLabelText('PPV runtime diagnostics');
    expect(panel.closest('.live-tv-browser')).not.toBeNull();
    // .live-tv-content is display:none below 900px until an event is watched.
    expect(panel.closest('.live-tv-content')).toBeNull();
  });

  it('shows the failure, the diagnostics and Copy diagnostics together', async () => {
    render(<PpvPanel debug loadCatalog={failingCatalog as never} />);

    expect(await screen.findByText('PPV could not load')).toBeInTheDocument();
    const panel = screen.getByLabelText('PPV runtime diagnostics');
    expect(within(panel).getByRole('button', { name: 'Copy diagnostics' })).toBeInTheDocument();
    const text = panel.textContent ?? '';
    expect(text).toMatch(/fight status\s*network_or_cors_error/i);
    expect(text).toMatch(/live HTTP\s*503/i);
    expect(text).toMatch(/today status\s*timeout/i);
  });

  it('copies a sanitized catalog-only payload from the failure state', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

    render(<PpvPanel debug loadCatalog={failingCatalog as never} />);
    await screen.findByText('PPV could not load');
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));

    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = writeText.mock.calls[0][0];
    expect(payload).toContain('network_or_cors_error');
    expect(payload).toContain('503');
    expect(payload).not.toContain('https://');
    expect(payload).not.toContain('http://');
    expect(payload).not.toContain('token=');
    expect(payload).not.toContain('SECRET');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copy diagnostics' }).textContent).toContain('Copied'),
    );
  });

  it('exposes nothing extra when debug mode is off', async () => {
    render(<PpvPanel loadCatalog={failingCatalog as never} />);

    expect(await screen.findByText('PPV could not load')).toBeInTheDocument();
    expect(screen.getByText('PPV events could not load.')).toBeInTheDocument();
    expect(panels()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Copy diagnostics' })).not.toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain('network_or_cors_error');
  });

  it('mounts exactly one panel through the full Live TV stage, driven by ?ppvdebug=1', async () => {
    // LiveTvRoute passes no debug prop, so this exercises the real query-string
    // path the user actually used on the device.
    vi.stubGlobal('location', { ...window.location, search: '?ppvdebug=1' });
    render(
      <LiveTvRoute
        loadCatalog={() =>
          Promise.resolve({ source: 'iptv-org', loadedAt: '2026-08-30T12:00:00.000Z', channels: [] })
        }
        loadPpvCatalog={failingCatalog as never}
      />,
    );
    fireEvent.click(await screen.findByRole('tab', { name: 'PPV' }));

    await screen.findByText('PPV could not load');
    expect(panels()).toHaveLength(1);
    // The stage stays out of watching mode, which is what hides the content column.
    expect(screen.getByRole('main', { name: 'Live TV' }).className).not.toContain(
      'live-tv-stage--watching',
    );
  });

  it('shows the panel for a successful but empty catalog too', async () => {
    render(<PpvPanel debug loadCatalog={(() => Promise.resolve(emptyCatalog)) as never} />);

    await screen.findByText('No PPV events found');
    const panel = screen.getByLabelText('PPV runtime diagnostics');
    expect(panel.closest('.live-tv-browser')).not.toBeNull();
    expect(panel.textContent ?? '').toMatch(/overall\s*empty_success/i);
  });

  it('hands the panel back to the player once an event is selected', async () => {
    render(<PpvPanel debug loadCatalog={(() => Promise.resolve(populated)) as never} />);
    fireEvent.click(await screen.findByRole('button', { name: /Watch UFC 320/ }));

    // Exactly one panel, now the player's, carrying the playback sections.
    expect(panels()).toHaveLength(1);
    const panel = screen.getByLabelText('PPV runtime diagnostics');
    expect(panel.closest('.live-tv-content')).not.toBeNull();
    expect(panel.closest('.live-tv-browser')).toBeNull();
    const text = panel.textContent ?? '';
    expect(text).toMatch(/document load event/i);
    expect(text).toMatch(/catalog feeds\s*fight/i);
  });

  it('survives an untyped failure without inventing diagnostics', async () => {
    render(<PpvPanel debug loadCatalog={(() => Promise.reject(new Error('boom'))) as never} />);

    expect(await screen.findByText('PPV could not load')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
    // The panel still renders in debug mode, but reports pending rather than
    // fabricating per-endpoint results the error never carried.
    const panel = screen.getByLabelText('PPV runtime diagnostics');
    expect(panel.textContent ?? '').toMatch(/overall\s*pending/i);
    expect(panel.textContent ?? '').not.toContain('network_or_cors_error');
  });
});
