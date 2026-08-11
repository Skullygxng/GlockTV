import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { YouTubePartyPlayer, type PartyPlayer, type PartyPlayerFactory } from '../src/components/YouTubePartyPlayer';
import type { PartyRoom, PlaybackState } from '../src/lib/watchParty';

const room: PartyRoom = {
  id: 'room-1', code: 'HEAT95', hostId: 'host-1', titleId: 1, mediaType: 'movie', titleName: 'Heat',
  trailerKey: 'heat-trailer', playbackState: 'paused', playbackPosition: 0, playbackUpdatedAt: new Date().toISOString(),
};

describe('native YouTube playback sync', () => {
  it('broadcasts native player changes made by the host', () => {
    const player: PartyPlayer = { play: vi.fn(), pause: vi.fn(), seek: vi.fn(), getCurrentTime: vi.fn(() => 18), destroy: vi.fn() };
    let nativeChange: (state: PlaybackState, position: number) => void = () => undefined;
    const factory = vi.fn((...args: unknown[]) => {
      (args[2] as (ready: PartyPlayer) => void)(player);
      nativeChange = (args[3] as typeof nativeChange | undefined) ?? nativeChange;
      return player;
    });
    const onHostCommand = vi.fn();
    render(<YouTubePartyPlayer room={room} isHost factory={factory as PartyPlayerFactory} onHostCommand={onHostCommand} />);

    nativeChange('playing', 18);

    expect(onHostCommand).toHaveBeenCalledWith('playing', 18);
  });
});
