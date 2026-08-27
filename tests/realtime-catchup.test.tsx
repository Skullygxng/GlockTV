import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { MediaItem } from '../src/lib/media';

const item: MediaItem = {
  id: 1, mediaType: 'movie', title: 'Heat', overview: 'Crime drama.', date: '1995-12-15', year: '1995',
  genreIds: [80], genres: ['Crime'], rating: 8.3, voteCount: 7200, popularity: 90, runtime: 170,
  posterPath: '/heat.jpg', backdropPath: '/heat-backdrop.jpg',
};

const room = {
  id: 'room-1', code: 'HEAT95', hostId: 'user-1', titleId: 1, mediaType: 'movie' as const,
  titleName: 'Heat', trailerKey: 'heat-trailer', playbackState: 'paused' as const, playbackPosition: 0,
  playbackUpdatedAt: '2026-08-11T00:00:00.000Z',
};

describe('watch-party realtime readiness', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
  });

  it('catches up on messages after the realtime channel becomes ready', async () => {
    let onReady: () => void = () => undefined;
    const client = {
      getTrending: vi.fn().mockResolvedValue([item]), discover: vi.fn().mockResolvedValue([item]), search: vi.fn().mockResolvedValue([item]),
      getTitleContext: vi.fn().mockResolvedValue({ trailer: { key: 'heat-trailer' }, providers: null, providerLink: null, details: item }),
      getPersonCredits: vi.fn().mockResolvedValue([item]),
    };
    const service = {
      ensureUser: vi.fn().mockResolvedValue({ id: 'user-1' }), createRoom: vi.fn().mockResolvedValue(room), joinRoom: vi.fn().mockResolvedValue(room),
      getRoom: vi.fn().mockResolvedValue(room),
      getMembers: vi.fn().mockResolvedValue([{ userId: 'user-1', nickname: 'Skully', joinedAt: '2026-08-11T00:00:00.000Z' }]),
      getMessages: vi.fn().mockResolvedValue([]), sendMessage: vi.fn(), updatePlayback: vi.fn(), leaveRoom: vi.fn(),
      subscribe: vi.fn((_roomId: string, handlers: { onReady?: () => void }) => { onReady = handlers.onReady ?? (() => undefined); return () => undefined; }),
    };

    render(<App client={client as never} partyService={service as never} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));
    await screen.findByRole('region', { name: 'Watch party HEAT95' });
    await waitFor(() => expect(service.subscribe).toHaveBeenCalledTimes(1));

    service.getMessages.mockResolvedValueOnce([{ id: 'message-catchup', roomId: 'room-1', userId: 'user-2', nickname: 'Guest', body: 'Did you miss me?', createdAt: '2026-08-11T00:00:01.000Z' }]);
    onReady();

    await waitFor(() => expect(service.getMessages).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Did you miss me?')).toBeInTheDocument();
  });
});
