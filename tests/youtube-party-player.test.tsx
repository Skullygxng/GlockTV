import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { YouTubePartyPlayer, type PartyPlayer, type PartyPlayerFactory } from '../src/components/YouTubePartyPlayer';
import type { PartyRoom } from '../src/lib/watchParty';

const room: PartyRoom = {
  id: 'room-1', code: 'HEAT95', hostId: 'host-1', titleId: 1, mediaType: 'movie',
  titleName: 'Heat', trailerKey: 'heat-trailer', playbackState: 'paused', playbackPosition: 42,
  playbackUpdatedAt: new Date().toISOString(),
};

function makePlayer() {
  const player: PartyPlayer = {
    play: vi.fn(), pause: vi.fn(), seek: vi.fn(), mute: vi.fn(), getCurrentTime: vi.fn(() => 42), destroy: vi.fn(),
  };
  const factory: PartyPlayerFactory = vi.fn((_element, _videoId, onReady) => {
    onReady(player);
    return player;
  });
  return { player, factory };
}

describe('YouTubePartyPlayer', () => {
  it('lets the host play and restart the room from the current position', () => {
    const { player, factory } = makePlayer();
    const onHostCommand = vi.fn();
    render(<YouTubePartyPlayer room={room} isHost factory={factory} onHostCommand={onHostCommand} />);

    fireEvent.click(screen.getByRole('button', { name: 'Play for everyone' }));
    expect(player.play).toHaveBeenCalled();
    expect(onHostCommand).toHaveBeenCalledWith('playing', 42);

    fireEvent.click(screen.getByRole('button', { name: 'Restart for everyone' }));
    expect(player.seek).toHaveBeenCalledWith(0);
    expect(onHostCommand).toHaveBeenCalledWith('playing', 0);
  });

  it('applies a host update to a guest player', () => {
    const { player, factory } = makePlayer();
    const { rerender } = render(<YouTubePartyPlayer room={room} isHost={false} factory={factory} onHostCommand={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Join synced playback' }));

    rerender(<YouTubePartyPlayer room={{ ...room, playbackState: 'playing', playbackPosition: 64 }} isHost={false} factory={factory} onHostCommand={vi.fn()} />);
    expect(player.seek).toHaveBeenLastCalledWith(expect.closeTo(64, 0));
    expect(player.play).toHaveBeenCalled();

    rerender(<YouTubePartyPlayer room={{ ...room, playbackState: 'paused', playbackPosition: 70 }} isHost={false} factory={factory} onHostCommand={vi.fn()} />);
    expect(player.seek).toHaveBeenLastCalledWith(expect.closeTo(70, 1));
    expect(player.pause).toHaveBeenCalled();
  });

  it('requires a guest gesture once before applying synchronized playback', () => {
    const { player, factory } = makePlayer();
    render(<YouTubePartyPlayer room={{ ...room, playbackState: 'playing' }} isHost={false} factory={factory} onHostCommand={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Join synced playback' }));

    expect(player.play).toHaveBeenCalled();
    expect(screen.getByText(/Synced to the host/)).toBeInTheDocument();
  });
});
