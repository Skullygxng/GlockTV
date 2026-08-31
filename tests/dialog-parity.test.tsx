import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { MediaItem } from '../src/lib/media';
import type { TmdbClient } from '../src/lib/tmdb';
import { item, matrix, partyPlaybackConfig, makePartyService } from './friends-party-harness';

/*
 * One contract, asked of every dialog-shaped surface the app actually renders.
 *
 * The split matters. A modal paints a backdrop over the page, so it claims
 * aria-modal and contains Tab. The watch-party room controls and roster are
 * anchored popovers with no backdrop - the room behind them stays visible and
 * clickable - so they must NOT claim aria-modal and must NOT trap Tab. They
 * owe Escape and focus handling; that is the whole difference, and it is
 * asserted rather than assumed.
 */

function media(id: number, title: string, over: Partial<MediaItem> = {}): MediaItem {
  return {
    id, mediaType: 'movie', title, overview: `${title} overview`, date: '2021-12-15',
    year: '2021', genreIds: [28], genres: ['Action'], rating: 7.9, voteCount: 1200,
    popularity: 90, runtime: 120, posterPath: '/p.jpg', backdropPath: '/b.jpg', ...over,
  };
}

const feedItem = media(1, 'Heat');

function client(overrides: Partial<TmdbClient> = {}): TmdbClient {
  return {
    getTrending: vi.fn().mockResolvedValue([feedItem]),
    discover: vi.fn().mockResolvedValue([feedItem]),
    search: vi.fn().mockResolvedValue([matrix]),
    getTitleContext: vi.fn().mockResolvedValue({
      trailer: null, providers: null, providerLink: null, details: feedItem,
    }),
    getPersonCredits: vi.fn().mockResolvedValue([feedItem]),
    ...overrides,
  } as TmdbClient;
}

/*
 * A real pointer click focuses the button it lands on; fireEvent.click does
 * not. Focusing first is what makes "focus returns to the opener" a test of
 * the dialog rather than a test of jsdom.
 */
function clickTrigger(button: HTMLElement) {
  button.focus();
  fireEvent.click(button);
}

function tabbable(dialog: HTMLElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getAttribute('tabindex') !== '-1');
}

async function ready() {
  await screen.findByRole('heading', { name: 'Heat' });
}

/* Host a private room, so the Friends surfaces are reachable. */
async function hostRoom(api: TmdbClient, service = makePartyService()) {
  render(<App client={api} partyService={service as never} partyPlaybackConfig={partyPlaybackConfig} />);
  await ready();
  fireEvent.click(
    within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }),
  );
  fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));
  await screen.findByRole('button', { name: 'Change title' });
  return service;
}

interface Surface {
  name: string;
  dialogName: string;
  modal: boolean;
  open: () => Promise<HTMLElement>;
}

const surfaces: Surface[] = [
  {
    name: 'Discover filter drawer',
    dialogName: 'Filter your feed',
    modal: true,
    open: async () => {
      render(<App client={client()} />);
      await ready();
      return screen.getByRole('button', { name: 'Open filters' });
    },
  },
  {
    name: 'Vibe picker',
    dialogName: 'Choose a vibe',
    modal: true,
    open: async () => {
      render(<App client={client()} />);
      await ready();
      return screen.getAllByRole('button', { name: 'Vibe' })[0];
    },
  },
  {
    name: 'Friends title picker',
    dialogName: 'Change watch party title',
    modal: true,
    open: async () => {
      await hostRoom(client());
      return screen.getByRole('button', { name: 'Change title' });
    },
  },
  {
    name: 'Friends room controls',
    dialogName: 'Room control panel',
    modal: false,
    open: async () => {
      await hostRoom(client());
      return screen.getByRole('button', { name: 'Room controls' });
    },
  },
  {
    name: 'Friends roster',
    dialogName: 'People in this room',
    modal: false,
    open: async () => {
      await hostRoom(client());
      return screen.getByRole('button', { name: 'Show people in this room' });
    },
  },
];

describe('dialog contract', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(surfaces.map((surface) => [surface.name, surface] as const))(
    '%s has an accessible name and a truthful aria-modal',
    async (_name, surface) => {
      clickTrigger(await surface.open());
      const dialog = await screen.findByRole('dialog', { name: surface.dialogName });

      /*
       * aria-modal must describe what the user sees. A popover that leaves the
       * page interactive claiming aria-modal would tell a screen reader the
       * rest of the app is inert when it is not.
       */
      expect(dialog.getAttribute('aria-modal')).toBe(surface.modal ? 'true' : null);
    },
  );

  it.each(surfaces.map((surface) => [surface.name, surface] as const))(
    '%s closes on Escape and returns focus to the control that opened it',
    async (_name, surface) => {
      const trigger = await surface.open();
      clickTrigger(trigger);
      await screen.findByRole('dialog', { name: surface.dialogName });

      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: surface.dialogName })).not.toBeInTheDocument(),
      );
      /*
       * Against the exact node that opened it: some trigger labels appear on
       * more than one control, and re-querying could pick the other one.
       * Awaited because restoration lands when the dialog finishes animating
       * out, which is a frame later than the dialog leaving the document.
       */
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    },
  );

  it.each(surfaces.map((surface) => [surface.name, surface] as const))(
    '%s puts focus inside itself on open',
    async (_name, surface) => {
      clickTrigger(await surface.open());
      const dialog = await screen.findByRole('dialog', { name: surface.dialogName });

      expect(dialog.contains(document.activeElement)).toBe(true);
    },
  );

  it.each(surfaces.filter((surface) => surface.modal).map((surface) => [surface.name, surface] as const))(
    '%s wraps Tab and Shift+Tab inside itself',
    async (_name, surface) => {
      clickTrigger(await surface.open());
      const dialog = await screen.findByRole('dialog', { name: surface.dialogName });

      const stops = tabbable(dialog);
      expect(stops.length).toBeGreaterThan(0);
      const first = stops[0];
      const last = stops[stops.length - 1];

      last.focus();
      fireEvent.keyDown(last, { key: 'Tab' });
      expect(document.activeElement).toBe(first);

      first.focus();
      fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(last);
    },
  );

  it.each(surfaces.filter((surface) => !surface.modal).map((surface) => [surface.name, surface] as const))(
    '%s is an anchored popover, so Tab is left alone',
    async (_name, surface) => {
      clickTrigger(await surface.open());
      const dialog = await screen.findByRole('dialog', { name: surface.dialogName });

      const stops = tabbable(dialog);
      const last = stops[stops.length - 1];
      last.focus();
      const notSwallowed = fireEvent.keyDown(last, { key: 'Tab' });

      // The browser moves focus onward; the popover neither blocks it nor
      // yanks it back to its own first control.
      expect(notSwallowed).toBe(true);
      expect(document.activeElement).toBe(last);
    },
  );
});

describe('dialog contract does not disturb what the dialogs do', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
    localStorage.clear();
  });

  it('keeps filter values and Apply working', async () => {
    const api = client();
    render(<App client={api} />);
    await ready();

    clickTrigger(screen.getByRole('button', { name: 'Open filters' }));
    const dialog = await screen.findByRole('dialog', { name: 'Filter your feed' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'TV Shows' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply filters' }));

    await waitFor(() => expect(api.discover).toHaveBeenCalled());
    const last = vi.mocked(api.discover).mock.calls.at(-1)?.[0];
    expect(last).toMatchObject({ contentType: 'tv' });
  });

  it('keeps a vibe choice reloading the feed', async () => {
    const api = client();
    render(<App client={api} />);
    await ready();

    clickTrigger(screen.getAllByRole('button', { name: 'Vibe' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Choose a vibe' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dark' }));

    await waitFor(() => expect(api.discover).toHaveBeenCalled());
    // The panel animates out, so it leaves the DOM a frame after the choice.
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Choose a vibe' })).not.toBeInTheDocument(),
    );
  });

  it('keeps room controls driving the room, not just the keyboard', async () => {
    const service = await hostRoom(client());

    clickTrigger(screen.getByRole('button', { name: 'Room controls' }));
    await screen.findByRole('dialog', { name: 'Room control panel' });
    fireEvent.click(screen.getByRole('button', { name: 'Lock new joins' }));

    await waitFor(() => expect(service.setRoomControls).toHaveBeenCalledWith('room-1', {
      isLocked: true,
      slowModeSeconds: 0,
    }));
  });

  it('leaves the room reachable behind an open popover', async () => {
    await hostRoom(client());

    clickTrigger(screen.getByRole('button', { name: 'Show people in this room' }));
    await screen.findByRole('dialog', { name: 'People in this room' });

    // Nothing was made inert: the room's own controls still respond.
    expect(screen.getByRole('button', { name: 'Change title' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Hide people in this room' }));
    expect(screen.queryByRole('dialog', { name: 'People in this room' })).not.toBeInTheDocument();
  });

  it('still closes the title picker suggestions before the picker itself', async () => {
    await hostRoom(client({ search: vi.fn().mockResolvedValue([matrix]) }));

    clickTrigger(screen.getByRole('button', { name: 'Change title' }));
    const input = screen.getByRole('combobox', { name: 'Search watch party titles' });
    fireEvent.change(input, { target: { value: 'matrix' } });
    await screen.findByRole('option', { name: 'Choose The Matrix' });

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('option', { name: 'Choose The Matrix' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Change watch party title' })).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Change watch party title' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Change title' })),
    );
  });

  it('keeps the player modal closing on Escape with focus returned', async () => {
    render(<App client={client()} playbackConfig={{ movieUrlTemplate: 'https://player.example/{tmdb_id}' }} />);
    await ready();

    const play = screen.getAllByRole('button', { name: /^Play / })[0];
    clickTrigger(play);
    await screen.findByRole('dialog', { name: /player/i });

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /player/i })).not.toBeInTheDocument());
  });
});

describe('layering between a modal and the anchored popovers', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
    localStorage.clear();
  });

  it('closes an open popover when the title picker takes over', async () => {
    await hostRoom(client());

    clickTrigger(screen.getByRole('button', { name: 'Show people in this room' }));
    await screen.findByRole('dialog', { name: 'People in this room' });

    clickTrigger(screen.getByRole('button', { name: 'Change title' }));
    await screen.findByRole('dialog', { name: 'Change watch party title' });

    // Otherwise two surfaces would both be listening, and Escape would reach
    // whichever opened first rather than the one on top.
    expect(screen.queryByRole('dialog', { name: 'People in this room' })).not.toBeInTheDocument();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Change watch party title' })).not.toBeInTheDocument(),
    );
  });
});
