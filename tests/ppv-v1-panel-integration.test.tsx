import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PpvPanel } from '../src/components/PpvPanel';
import { PpvCatalogError, type PpvCatalog, type PpvEvent } from '../src/lib/ppv';
import type {
  PpvCatalogDiagnostics,
  PpvCatalogProviderDiagnostics,
} from '../src/lib/ppvDiagnostics';

const SOON = new Date(Date.now() + 3_600_000).toISOString();

function event(overrides: Partial<PpvEvent> = {}): PpvEvent {
  return {
    provider: 'thesportsdb',
    providerEventId: 'thesportsdb:2000001',
    title: 'UFC 400: Jones vs Aspinall',
    category: 'mma',
    startsAt: SOON,
    status: 'upcoming',
    sourceRefs: [],
    embeds: [],
    ...overrides,
  };
}

function providerDiagnostics(
  providerId: 'streamed' | 'thesportsdb',
  status: PpvCatalogProviderDiagnostics['status'],
  admitted = 0,
): PpvCatalogProviderDiagnostics {
  return {
    stage: 'catalog_provider',
    providerId,
    status,
    endpoints: [],
    requestCount: 1,
    completedRequests: status === 'success' ? 1 : 0,
    httpStatuses: [],
    returnedRowCount: admitted,
    admittedEvents: admitted,
    rejectedNonCombat: 0,
    malformedRowCount: 0,
  };
}

function diagnostics(overrides: Partial<PpvCatalogDiagnostics> = {}): PpvCatalogDiagnostics {
  const endpoint = { status: 'network_or_cors_error' as const, httpStatus: null, rowCount: 0 };
  return {
    stage: 'catalog',
    startedAt: Date.now(),
    completedAt: Date.now(),
    fight: endpoint,
    live: endpoint,
    today: endpoint,
    normalizedEvents: 1,
    overallStatus: 'success',
    providers: [
      providerDiagnostics('thesportsdb', 'success', 1),
      providerDiagnostics('streamed', 'network_or_cors_error'),
    ],
    contributingProviders: ['thesportsdb'],
    failedProviders: ['streamed'],
    mergedDuplicates: 0,
    fromCache: false,
    stale: false,
    cacheAgeMs: null,
    ...overrides,
  };
}

function catalog(overrides: Partial<PpvCatalog> = {}): PpvCatalog {
  return {
    events: [event()],
    source: 'thesportsdb',
    loadedAt: new Date().toISOString(),
    diagnostics: diagnostics(),
    ...overrides,
  };
}

describe('PPV panel over the provider platform', () => {
  it('renders the fight list when one catalog provider is unreachable', async () => {
    render(<PpvPanel loadCatalog={async () => catalog()} />);
    expect(await screen.findByText('UFC 400: Jones vs Aspinall')).toBeInTheDocument();
    expect(screen.queryByText('PPV could not load')).not.toBeInTheDocument();
    /* A provider failure is not a stale catalog. */
    expect(screen.queryByText(/Showing the last loaded fight cards/)).not.toBeInTheDocument();
  });

  it('names the failing provider in the diagnostics panel', async () => {
    render(<PpvPanel debug loadCatalog={async () => catalog()} />);
    await screen.findByText('UFC 400: Jones vs Aspinall');
    render(<PpvPanel debug loadCatalog={async () => Promise.reject(new PpvCatalogError(diagnostics({
      normalizedEvents: 0,
      overallStatus: 'network_or_cors_error',
      contributingProviders: [],
      failedProviders: ['thesportsdb', 'streamed'],
      providers: [
        providerDiagnostics('thesportsdb', 'network_or_cors_error'),
        providerDiagnostics('streamed', 'network_or_cors_error'),
      ],
    })))} />);

    const panels = await screen.findAllByLabelText('PPV runtime diagnostics');
    const text = panels.map((panel) => panel.textContent ?? '').join('\n');
    expect(text).toContain('thesportsdb');
    expect(text).toContain('streamed');
    expect(text).toMatch(/providers failed/i);
    expect(text).not.toContain('https://');
  });

  it('says the list came from cache when no provider answered', async () => {
    render(
      <PpvPanel
        loadCatalog={async () =>
          catalog({
            diagnostics: diagnostics({
              contributingProviders: [],
              failedProviders: ['thesportsdb', 'streamed'],
              fromCache: true,
              stale: true,
              cacheAgeMs: 5 * 60_000,
              overallStatus: 'network_or_cors_error',
            }),
          })
        }
      />,
    );
    expect(await screen.findByText(/No catalog provider answered/)).toBeInTheDocument();
    expect(screen.getByText(/from 5m ago/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    /* The events themselves are still on screen. */
    expect(screen.getByText('UFC 400: Jones vs Aspinall')).toBeInTheDocument();
  });

  it('keeps the existing failure UI when there is nothing at all to show', async () => {
    render(
      <PpvPanel
        loadCatalog={async () => {
          throw new PpvCatalogError(diagnostics({ normalizedEvents: 0 }));
        }}
      />,
    );
    expect(await screen.findByText('PPV could not load')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('keeps the tabs, filters, search and count exactly as they were', async () => {
    render(<PpvPanel loadCatalog={async () => catalog()} />);
    await screen.findByText('UFC 400: Jones vs Aspinall');
    for (const label of ['All', 'Live now', 'Upcoming', 'MMA', 'Boxing', 'Wrestling']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByLabelText('Search PPV events')).toBeInTheDocument();
    expect(screen.getByText('events')).toBeInTheDocument();
  });
});
