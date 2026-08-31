import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { MediaItem } from '../src/lib/media';
import type { TmdbClient } from '../src/lib/tmdb';
import { SUGGEST_DEBOUNCE_MS, SUGGEST_LIMIT, SUGGEST_MIN_CHARS } from '../src/hooks/useMediaSearchSuggestions';
import { item, matrix, partyPlaybackConfig, makePartyService } from './friends-party-harness';
import appSource from '../src/App.tsx?raw';
import friendsSource from '../src/components/FriendsExperience.tsx?raw';

/*
 * Discover and the watch-party title picker are the same search, so they run on
 * the same controller. These are the tests that keep it that way: the two
 * surfaces are asked the same questions side by side, and the sources are
 * checked for a second private copy of the timing logic growing back.
 */

const results = Array.from({ length: 9 }, (_, index) => ({
  ...matrix,
  id: 900 + index,
  title: `Spider Result ${index}`,
}));

function client(overrides: Partial<TmdbClient> = {}): TmdbClient {
  return {
    getTrending: vi.fn().mockResolvedValue([item]),
    discover: vi.fn().mockResolvedValue([item]),
    search: vi.fn().mockResolvedValue(results),
    getTitleContext: vi
      .fn()
      .mockResolvedValue({ trailer: null, providers: null, providerLink: null, details: item }),
    getPersonCredits: vi.fn().mockResolvedValue([item]),
    ...overrides,
  } as TmdbClient;
}

/* Render Discover and return its search box. */
async function discoverBox(api: TmdbClient): Promise<HTMLElement> {
  render(<App client={api} />);
  await screen.findByRole('heading', { name: 'Heat' });
  return screen.getByRole('combobox', { name: 'Search' });
}

/* Render Friends, host a room, open the picker, return its search box. */
async function partyBox(api: TmdbClient): Promise<HTMLElement> {
  render(
    <App client={api} partyService={makePartyService() as never} partyPlaybackConfig={partyPlaybackConfig} />,
  );
  await screen.findByRole('heading', { name: 'Heat' });
  fireEvent.click(
    within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }),
  );
  fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Change title' }));
  return screen.getByRole('combobox', { name: 'Search watch party titles' });
}

const surfaces: [string, (api: TmdbClient) => Promise<HTMLElement>][] = [
  ['Discover', discoverBox],
  ['the watch-party title picker', partyBox],
];

describe('shared media search controller', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('is the only implementation either surface imports', () => {
    for (const source of [appSource, friendsSource]) {
      expect(source).toContain('useMediaSearchSuggestions');
      /*
       * A private debounce or generation counter next to the shared one is how
       * the two surfaces drifted apart in the first place.
       */
      expect(source).not.toMatch(/SUGGEST_DEBOUNCE_MS\s*=/);
      expect(source).not.toMatch(/setTimeout\([^)]*\)[\s\S]{0,80}search\(/);
    }
  });

  it.each(surfaces)('waits for the minimum character count on %s', async (_name, open) => {
    const api = client();
    const box = await open(api);

    fireEvent.change(box, { target: { value: 'x'.repeat(SUGGEST_MIN_CHARS - 1) } });
    await new Promise((resolve) => setTimeout(resolve, SUGGEST_DEBOUNCE_MS + 150));
    expect(api.search).not.toHaveBeenCalled();

    fireEvent.change(box, { target: { value: 'x'.repeat(SUGGEST_MIN_CHARS) } });
    await screen.findAllByRole('option');
    expect(api.search).toHaveBeenCalledTimes(1);
  });

  it.each(surfaces)('collapses a keystroke burst into one request on %s', async (_name, open) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = client();
    const box = await open(api);

    for (const value of ['sp', 'spi', 'spid', 'spide', 'spider']) {
      fireEvent.change(box, { target: { value } });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS + 150); });

    /* One request for the whole burst, for the term that was left in the box. */
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(api.search).toHaveBeenCalledWith('spider');
  });

  it.each(surfaces)('caps the list at the shared limit on %s', async (_name, open) => {
    const box = await open(client());

    fireEvent.change(box, { target: { value: 'spider' } });

    const options = await screen.findAllByRole('option');
    expect(results.length).toBeGreaterThan(SUGGEST_LIMIT);
    expect(options).toHaveLength(SUGGEST_LIMIT);
  });

  it.each(surfaces)('never shows results belonging to an older query on %s', async (_name, open) => {
    let resolveFirst: ((value: MediaItem[]) => void) | undefined;
    const box = await open(client({
      search: vi.fn((term: string) => term === 'heat'
        ? new Promise<MediaItem[]>((resolve) => { resolveFirst = resolve; })
        : Promise.resolve(results)),
    }));

    fireEvent.change(box, { target: { value: 'heat' } });
    await new Promise((resolve) => setTimeout(resolve, SUGGEST_DEBOUNCE_MS + 60));
    fireEvent.change(box, { target: { value: 'spider' } });
    await screen.findAllByRole('option');

    await act(async () => { resolveFirst?.([{ ...item, title: 'Stale Heat' }]); });

    expect(screen.queryByText('Stale Heat')).not.toBeInTheDocument();
    expect(screen.getAllByRole('option')[0].textContent).toContain('Spider Result 0');
  });

  it.each(surfaces)('dismisses the list on Escape on %s', async (_name, open) => {
    const box = await open(client());

    fireEvent.change(box, { target: { value: 'spider' } });
    await screen.findAllByRole('option');
    fireEvent.keyDown(box, { key: 'Escape' });

    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it.each(surfaces)('moves the highlight with the arrow keys on %s', async (_name, open) => {
    const box = await open(client());

    fireEvent.change(box, { target: { value: 'spider' } });
    await screen.findAllByRole('option');

    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    expect(box).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0].id);

    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'false');
    /* Wraps to the end rather than falling off the top. */
    expect(screen.getAllByRole('option').at(-1)).toHaveAttribute('aria-selected', 'true');
  });
});
