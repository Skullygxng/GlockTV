import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    play: vi.fn(), pause: vi.fn(), seek: vi.fn(), mute: vi.fn(), unmute: vi.fn(), getCurrentTime: vi.fn(() => 0), destroy: vi.fn(),
  };
  const factory: PartyPlayerFactory = vi.fn((_element, _videoId, onReady) => {
    onReady(player);
    return player;
  });
  return { player, factory };
}

describe('autoplay trailer preview', () => {
  beforeEach(() => sessionStorage.clear());

  it('renders the active TMDB YouTube trailer as a muted looping autoplay preview', () => {
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
        onTrailer={vi.fn()}
        onLike={vi.fn()}
        onSkip={vi.fn()}
        trailerPlayerFactory={factory}
      />,
    );

    expect(screen.getByTitle('Joker autoplay trailer')).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('button', { name: 'Play Joker trailer with sound' }));

    expect(onTrailer).not.toHaveBeenCalled();
    expect(player.unmute).toHaveBeenCalledOnce();
    expect(player.play).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Mute Joker trailer' })).toBeInTheDocument();
  });

  it('keeps trailer sound on when the viewer moves to the next recommendation', () => {
    const first = makePreviewPlayer();
    const firstCard = render(
      <MediaCard
        item={item}
        match={93}
        saved={false}
        trailerKey="joker-trailer"
        onToggleList={vi.fn()}
        onWatch={vi.fn()}
        onDetails={vi.fn()}
        onTrailer={vi.fn()}
        onLike={vi.fn()}
        onSkip={vi.fn()}
        trailerPlayerFactory={first.factory}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Play Joker trailer with sound' }));
    firstCard.unmount();

    const nextItem = { ...item, id: 603, title: 'The Matrix' };
    const next = makePreviewPlayer();
    render(
      <MediaCard
        item={nextItem}
        match={95}
        saved={false}
        trailerKey="matrix-trailer"
        onToggleList={vi.fn()}
        onWatch={vi.fn()}
        onDetails={vi.fn()}
        onTrailer={vi.fn()}
        onLike={vi.fn()}
        onSkip={vi.fn()}
        trailerPlayerFactory={next.factory}
      />,
    );

    expect(next.player.unmute).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Mute The Matrix trailer' })).toBeInTheDocument();
  });
});

