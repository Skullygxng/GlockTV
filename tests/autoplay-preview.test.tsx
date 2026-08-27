import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaCard } from '../src/components/MediaCard';
import type { PartyPlayer, PartyPlayerFactory } from '../src/components/YouTubePartyPlayer';
import type { MediaItem } from '../src/lib/media';

const item: MediaItem = {
  id: 475557,
  mediaType: 'movie',
  title: 'Joker',
  overview: 'A failed comedian descends into madness.',
  date: '2019-10-01',
  year: '2019',
  genreIds: [80, 18],
  genres: ['Crime', 'Drama'],
  rating: 8.2,
  voteCount: 25000,
  popularity: 98,
  runtime: 122,
  posterPath: '/poster.jpg',
  backdropPath: '/backdrop.jpg',
};

function makePreviewPlayer() {
  const player: PartyPlayer = {
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    mute: vi.fn(),
    unmute: vi.fn(),
    getCurrentTime: vi.fn(() => 0),
    destroy: vi.fn(),
  };

  const factory: PartyPlayerFactory = vi.fn((_element, _videoId, onReady) => {
    onReady(player);
    return player;
  });

  return { player, factory };
}

function renderCard(factory: PartyPlayerFactory, trailerKey = 'official-trailer-key', nextItem = item) {
  return render(
    <MediaCard
      item={nextItem}
      match={93}
      saved={false}
      trailerKey={trailerKey}
      onToggleList={vi.fn()}
      onWatch={vi.fn()}
      onDetails={vi.fn()}
      onTrailer={vi.fn()}
      onLike={vi.fn()}
      onSkip={vi.fn()}
      trailerPlayerFactory={factory}
    />,
  );
}

describe('autoplay trailer preview', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('waits for the dwell period before creating the muted looping autoplay preview', () => {
    const { player, factory } = makePreviewPlayer();
    renderCard(factory);

    expect(screen.getByTitle('Joker autoplay trailer')).toBeInTheDocument();
    expect(factory).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(799);
    });
    expect(factory).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(factory).toHaveBeenCalledWith(
      expect.any(HTMLDivElement),
      'official-trailer-key',
      expect.any(Function),
      expect.any(Function),
      { autoplay: true, controls: false, loop: true, disableKeyboard: true },
    );
    expect(player.mute).toHaveBeenCalledOnce();
    expect(player.play).toHaveBeenCalledOnce();
  });

  it('does not create a discarded player when the viewer leaves before the dwell period', () => {
    const { factory } = makePreviewPlayer();
    const card = renderCard(factory);

    card.unmount();

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(factory).not.toHaveBeenCalled();
  });

  it('uses the preview speaker to turn sound on without opening the trailer modal', () => {
    const onTrailer = vi.fn();
    const { player, factory } = makePreviewPlayer();

    render(
      <MediaCard
        item={item}
        match={93}
        saved={false}
        trailerKey="official-trailer-key"
        onToggleList={vi.fn()}
        onWatch={vi.fn()}
        onDetails={vi.fn()}
        onTrailer={onTrailer}
        onLike={vi.fn()}
        onSkip={vi.fn()}
        trailerPlayerFactory={factory}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(800);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Play Joker trailer with sound' }));

    expect(onTrailer).not.toHaveBeenCalled();
    expect(player.unmute).toHaveBeenCalledOnce();
    expect(player.play).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Mute Joker trailer' })).toBeInTheDocument();
  });

  it('keeps trailer sound on when the viewer moves to the next recommendation', () => {
    const first = makePreviewPlayer();
    const firstCard = renderCard(first.factory, 'joker-trailer');

    act(() => {
      vi.advanceTimersByTime(800);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Play Joker trailer with sound' }));
    firstCard.unmount();

    const nextItem = { ...item, id: 603, title: 'The Matrix' };
    const next = makePreviewPlayer();

    renderCard(next.factory, 'matrix-trailer', nextItem);

    act(() => {
      vi.advanceTimersByTime(800);
    });

    expect(next.player.unmute).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Mute The Matrix trailer' })).toBeInTheDocument();
  });
});
