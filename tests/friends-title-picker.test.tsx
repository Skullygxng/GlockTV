import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { MediaItem } from '../src/lib/media';
import type { TmdbClient } from '../src/lib/tmdb';
import { item, matrix, partyPlaybackConfig, makePartyService } from './friends-party-harness';

/*
 * The watch-party "Change title" picker, which used to need an explicit Search
 * press before it would show anything. It now runs on the same as-you-type
 * controller Discover uses, so these cover the shared contract as the picker
 * expresses it - plus the dialog behaviour around it, which the old
 * search-on-submit flow never had to answer for.
 */

const spider = [
  { ...matrix, id: 634649, title: 'Spider-Man: No Way Home', year: '2021' },
  { ...matrix, id: 557, title: 'Spider-Man', year: '2002' },
];

/*
 * A client per test. The shared harness client is one module-level object with
 * shared mocks, and a picker suite that changes search behaviour cannot borrow
 * it without leaking into whatever runs next.
 */
function client(overrides: Partial<TmdbClient> = {}): TmdbClient {
  return {
    getTrending: vi.fn().mockResolvedValue([item]),
    discover: vi.fn().mockResolvedValue([item]),
    search: vi.fn().mockResolvedValue([matrix]),
    getTitleContext: vi.fn(async (picked: Pick<MediaItem, 'id' | 'mediaType'>) => ({
      trailer: null,
      providers: null,
      providerLink: null,
      details: [matrix, ...spider].find((entry) => entry.id === picked.id) ?? matrix,
    })),
    getPersonCredits: vi.fn().mockResolvedValue([item]),
    ...overrides,
  } as TmdbClient;
}

function titleBox(): HTMLElement {
  return screen.getByRole('combobox', { name: 'Search watch party titles' });
}

function picker(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Change watch party title' });
}

/* Host a room and open the title picker. */
async function openPicker(api: TmdbClient, service = makePartyService()) {
  render(<App client={api} partyService={service as never} partyPlaybackConfig={partyPlaybackConfig} />);
  await screen.findByRole('heading', { name: 'Heat' });
  fireEvent.click(
    within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }),
  );
  fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Change title' }));
  return service;
}

function resetBrowserState() {
  window.history.replaceState({}, '', '/');
  sessionStorage.clear();
  localStorage.clear();
}

describe('Friends watch-party title picker suggests as you type', () => {
  beforeEach(resetBrowserState);
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('offers matching titles without the form ever being submitted', async () => {
    const api = client({ search: vi.fn().mockResolvedValue(spider) });
    await openPicker(api);

    fireEvent.change(titleBox(), { target: { value: 'spider' } });

    const list = await screen.findByRole('listbox', { name: 'Title suggestions' });
    expect(within(list).getAllByRole('option').map((option) => option.textContent)).toEqual([
      expect.stringContaining('Spider-Man: No Way Home'),
      expect.stringContaining('Spider-Man'),
    ]);
    expect(api.search).toHaveBeenCalledWith('spider');
    // Discovery must not depend on the button, which is still there for anyone
    // who reaches for it.
    expect(screen.getByRole('button', { name: 'Search titles' })).toBeInTheDocument();
  });

  it('leaves a one-character query alone', async () => {
    const api = client();
    await openPicker(api);

    fireEvent.change(titleBox(), { target: { value: 's' } });
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(api.search).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox', { name: 'Title suggestions' })).not.toBeInTheDocument();
  });

  it('debounces a burst of keystrokes into a single request', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = client();
    await openPicker(api);

    for (const value of ['ma', 'mat', 'matr', 'matri', 'matrix']) {
      fireEvent.change(titleBox(), { target: { value } });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(api.search).toHaveBeenCalledTimes(1);
    expect(api.search).toHaveBeenCalledWith('matrix');
  });

  it('lets the newest query win when an older response lands late', async () => {
    let resolveFirst: ((value: MediaItem[]) => void) | undefined;
    const api = client({
      search: vi.fn((term: string) => term === 'heat'
        ? new Promise<MediaItem[]>((resolve) => { resolveFirst = resolve; })
        : Promise.resolve(spider)),
    });
    await openPicker(api);

    fireEvent.change(titleBox(), { target: { value: 'heat' } });
    await waitFor(() => expect(resolveFirst).toBeDefined());
    fireEvent.change(titleBox(), { target: { value: 'spider' } });
    await screen.findByRole('option', { name: 'Choose Spider-Man: No Way Home' });

    // The abandoned query answers only now, and must not be able to reach the list.
    await act(async () => { resolveFirst?.([item]); });

    expect(screen.queryByRole('option', { name: 'Choose Heat' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Choose Spider-Man: No Way Home' })).toBeInTheDocument();
  });

  it('drops results of a previous query the moment the query changes', async () => {
    const api = client({ search: vi.fn().mockResolvedValue(spider) });
    await openPicker(api);

    fireEvent.change(titleBox(), { target: { value: 'spider' } });
    await screen.findByRole('option', { name: 'Choose Spider-Man' });

    fireEvent.change(titleBox(), { target: { value: 'spider m' } });

    // Stale results are gone the same tick, not once the new answer arrives.
    expect(screen.queryByRole('option', { name: 'Choose Spider-Man' })).not.toBeInTheDocument();
  });

  it('clears the list when the query drops below the minimum', async () => {
    await openPicker(client({ search: vi.fn().mockResolvedValue(spider) }));

    fireEvent.change(titleBox(), { target: { value: 'spider' } });
    await screen.findByRole('option', { name: 'Choose Spider-Man' });
    fireEvent.change(titleBox(), { target: { value: '' } });

    expect(screen.queryByRole('listbox', { name: 'Title suggestions' })).not.toBeInTheDocument();
    expect(screen.queryByText(/No titles match/)).not.toBeInTheDocument();
  });

  it('says it is searching while the lookup is in flight', async () => {
    const api = client({ search: vi.fn(() => new Promise<MediaItem[]>(() => {})) });
    await openPicker(api);

    fireEvent.change(titleBox(), { target: { value: 'matrix' } });

    expect(await screen.findByText('Searching titles...')).toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    await openPicker(client({ search: vi.fn().mockResolvedValue([]) }));

    fireEvent.change(titleBox(), { target: { value: 'zzzz' } });

    expect(await screen.findByText(/No titles match/)).toBeInTheDocument();
    expect(screen.queryByRole('listbox', { name: 'Title suggestions' })).not.toBeInTheDocument();
  });

  it('reports a failed lookup in the picker without tearing down the room', async () => {
    await openPicker(client({ search: vi.fn().mockRejectedValue(new Error('offline')) }));

    fireEvent.change(titleBox(), { target: { value: 'matrix' } });

    expect(await screen.findByText('Title search is unavailable right now.')).toBeInTheDocument();
    // The room, the chat and the picker all survive a search that failed.
    expect(picker()).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Heat' })).toBeInTheDocument();
  });
});

describe('Friends watch-party title picker selection', () => {
  beforeEach(resetBrowserState);
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('commits the title picked with the pointer', async () => {
    const service = await openPicker(client({ search: vi.fn().mockResolvedValue(spider) }));

    fireEvent.change(titleBox(), { target: { value: 'spider' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Choose Spider-Man: No Way Home' }));

    await waitFor(() => expect(service.updateTitle).toHaveBeenCalledWith('room-1', expect.objectContaining({
      titleId: 634649,
      titleName: 'Spider-Man: No Way Home',
    })));
    expect(await screen.findByRole('heading', { name: 'Spider-Man: No Way Home' })).toBeInTheDocument();
  });

  it('highlights with ArrowDown and commits with Enter', async () => {
    const service = await openPicker(client({ search: vi.fn().mockResolvedValue(spider) }));

    fireEvent.change(titleBox(), { target: { value: 'spider' } });
    await screen.findByRole('option', { name: 'Choose Spider-Man' });

    fireEvent.keyDown(titleBox(), { key: 'ArrowDown' });
    fireEvent.keyDown(titleBox(), { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'Choose Spider-Man' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(titleBox(), { key: 'Enter' });
    await waitFor(() => expect(service.updateTitle).toHaveBeenCalledWith('room-1', expect.objectContaining({ titleId: 557 })));
  });

  it('wraps ArrowUp to the end of the list', async () => {
    await openPicker(client({ search: vi.fn().mockResolvedValue(spider) }));

    fireEvent.change(titleBox(), { target: { value: 'spider' } });
    await screen.findByRole('option', { name: 'Choose Spider-Man' });

    fireEvent.keyDown(titleBox(), { key: 'ArrowUp' });
    expect(screen.getByRole('option', { name: 'Choose Spider-Man' })).toHaveAttribute('aria-selected', 'true');
  });

  it('takes one title even when the same option is clicked twice', async () => {
    let settle: ((value: unknown) => void) | undefined;
    const service = makePartyService();
    service.updateTitle.mockImplementation((async () => {
      await new Promise((resolve) => { settle = resolve; });
      return { ...matrix, id: 'room-1' } as never;
    }) as never);
    await openPicker(client({ search: vi.fn().mockResolvedValue(spider) }), service);

    fireEvent.change(titleBox(), { target: { value: 'spider' } });
    const option = await screen.findByRole('option', { name: 'Choose Spider-Man: No Way Home' });
    fireEvent.click(option);
    await waitFor(() => expect(service.updateTitle).toHaveBeenCalledTimes(1));
    fireEvent.click(option);
    fireEvent.click(screen.getByRole('option', { name: 'Choose Spider-Man' }));

    expect(service.updateTitle).toHaveBeenCalledTimes(1);
    settle?.(undefined);
  });

  it('still runs an explicit Search press', async () => {
    const api = client({ search: vi.fn().mockResolvedValue(spider) });
    await openPicker(api);

    fireEvent.change(titleBox(), { target: { value: 'spider' } });
    await screen.findByRole('option', { name: 'Choose Spider-Man' });
    fireEvent.click(screen.getByRole('button', { name: 'Search titles' }));

    // The button re-opens the list rather than issuing a second lookup of its own.
    expect(await screen.findByRole('option', { name: 'Choose Spider-Man' })).toBeInTheDocument();
    expect(api.search).toHaveBeenCalledTimes(1);
  });
});

describe('Friends watch-party title picker dialog', () => {
  beforeEach(resetBrowserState);
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('exposes a truthful combobox contract', async () => {
    await openPicker(client({ search: vi.fn().mockResolvedValue(spider) }));

    const input = titleBox();
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveAttribute('aria-controls');

    fireEvent.change(input, { target: { value: 'spider' } });
    const list = await screen.findByRole('listbox', { name: 'Title suggestions' });
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', list.id);
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    expect(input).not.toHaveAttribute('aria-activedescendant');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(
      within(list).getAllByRole('option')[0].id,
    );
  });

  it('keeps the options out of the tab order', async () => {
    await openPicker(client({ search: vi.fn().mockResolvedValue(spider) }));

    fireEvent.change(titleBox(), { target: { value: 'spider' } });
    const options = await screen.findAllByRole('option');

    expect(options.every((option) => option.getAttribute('tabindex') === '-1')).toBe(true);
  });

  it('closes the list on Escape, then the dialog on the next Escape', async () => {
    await openPicker(client({ search: vi.fn().mockResolvedValue(spider) }));

    fireEvent.change(titleBox(), { target: { value: 'spider' } });
    await screen.findByRole('option', { name: 'Choose Spider-Man' });

    fireEvent.keyDown(titleBox(), { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'Title suggestions' })).not.toBeInTheDocument();
    expect(picker()).toBeInTheDocument();

    fireEvent.keyDown(titleBox(), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Change watch party title' })).not.toBeInTheDocument();
    // Focus goes back to the control that opened the dialog.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Change title' }));
  });

  it('closes the dialog on Escape pressed away from the search box', async () => {
    await openPicker(client());

    fireEvent.keyDown(screen.getByRole('button', { name: 'Close title picker' }), { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Change watch party title' })).not.toBeInTheDocument();
  });

  it('closes the list on Tab without swallowing the keypress', async () => {
    await openPicker(client({ search: vi.fn().mockResolvedValue(spider) }));

    fireEvent.change(titleBox(), { target: { value: 'spider' } });
    await screen.findByRole('option', { name: 'Choose Spider-Man' });

    const tab = fireEvent.keyDown(titleBox(), { key: 'Tab' });

    expect(tab).toBe(true);
    expect(screen.queryByRole('listbox', { name: 'Title suggestions' })).not.toBeInTheDocument();
    expect(picker()).toBeInTheDocument();
  });

  it('keeps Tab inside the dialog', async () => {
    await openPicker(client());

    const close = screen.getByRole('button', { name: 'Close title picker' });
    const search = screen.getByRole('button', { name: 'Search titles' });
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });

    // Search is disabled on an empty query, so the last focusable control is the input.
    expect(search).toBeDisabled();
    expect(picker().contains(document.activeElement)).toBe(true);
  });

  it('abandons a lookup still in flight when the picker is closed', async () => {
    let resolveSearch: ((value: MediaItem[]) => void) | undefined;
    const api = client({ search: vi.fn(() => new Promise<MediaItem[]>((resolve) => { resolveSearch = resolve; })) });
    await openPicker(api);

    fireEvent.change(titleBox(), { target: { value: 'spider' } });
    await screen.findByText('Searching titles...');
    fireEvent.click(screen.getByRole('button', { name: 'Close title picker' }));

    await act(async () => { resolveSearch?.(spider); });

    // Nothing from the abandoned lookup survives into the reopened picker.
    fireEvent.click(screen.getByRole('button', { name: 'Change title' }));
    expect(titleBox()).toHaveValue('');
    expect(screen.queryByRole('listbox', { name: 'Title suggestions' })).not.toBeInTheDocument();
    expect(screen.queryByText('Searching titles...')).not.toBeInTheDocument();
  });

  it('reopens on an empty query rather than the last one', async () => {
    await openPicker(client({ search: vi.fn().mockResolvedValue(spider) }));

    fireEvent.change(titleBox(), { target: { value: 'spider' } });
    await screen.findByRole('option', { name: 'Choose Spider-Man' });
    fireEvent.click(screen.getByRole('button', { name: 'Close title picker' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change title' }));

    expect(titleBox()).toHaveValue('');
    expect(screen.queryByRole('option', { name: 'Choose Spider-Man' })).not.toBeInTheDocument();
  });

  it('clears a failed lookup message when the picker is reopened', async () => {
    await openPicker(client({ search: vi.fn().mockRejectedValue(new Error('offline')) }));

    fireEvent.change(titleBox(), { target: { value: 'matrix' } });
    await screen.findByText('Title search is unavailable right now.');
    fireEvent.click(screen.getByRole('button', { name: 'Close title picker' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change title' }));

    expect(screen.queryByText('Title search is unavailable right now.')).not.toBeInTheDocument();
  });
});
