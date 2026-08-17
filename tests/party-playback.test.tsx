import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PartyPlaybackPlayer, buildPartyPlaybackUrl, buildPartyPlayerCommand, parsePartyPlayerEvent } from '../src/components/PartyPlaybackPlayer';
import type { PartyRoom } from '../src/lib/watchParty';

const config = {
  movieUrlTemplate: 'https://party.example/movie/{tmdb_id}',
  tvUrlTemplate: 'https://party.example/tv/{tmdb_id}/{season_number}/{episode_number}',
};

const room: PartyRoom = {
  id: 'room-1', code: 'HEAT95', hostId: 'host-1', titleId: 1, mediaType: 'movie', titleName: 'Heat',
  playbackState: 'paused', playbackPosition: 42, playbackUpdatedAt: '2026-08-11T00:00:00.000Z',
  seasonNumber: 1, episodeNumber: 1, backdropPath: '/heat.jpg', durationSeconds: 10200, isPublic: false, isOfficial: false,
};

describe('full-title party playback', () => {
  it('builds movie and TV episode URLs from room metadata', () => {
    expect(buildPartyPlaybackUrl(room, config)).toBe('https://party.example/movie/1');
    expect(buildPartyPlaybackUrl({ ...room, mediaType: 'tv', titleId: 1396, seasonNumber: 3, episodeNumber: 7 }, config)).toBe('https://party.example/tv/1396/3/7');
  });

  it('parses documented player events defensively', () => {
    expect(parsePartyPlayerEvent(JSON.stringify({ type: 'PLAYER_EVENT', data: { event: 'pause', currentTime: 55 } }))).toEqual({ event: 'pause', currentTime: 55 });
    expect(parsePartyPlayerEvent({ type: 'not-a-player', data: {} })).toBeNull();
  });

  it('uses the documented VidZen command envelope', () => {
    expect(buildPartyPlayerCommand('seek', { time: 91 })).toBe('{"command":"seek","time":91}');
    expect(buildPartyPlayerCommand('volume', { level: 1 })).toBe('{"command":"volume","level":1}');
  });

  it('only exposes playback controls to the host', () => {
    const onHostCommand = vi.fn();
    const { rerender } = render(<PartyPlaybackPlayer room={room} config={config} isHost onHostCommand={onHostCommand} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play room' }));
    expect(onHostCommand).toHaveBeenCalledWith('playing', 42);

    rerender(<PartyPlaybackPlayer room={room} config={config} isHost={false} onHostCommand={onHostCommand} />);
    expect(screen.queryByRole('button', { name: 'Play room' })).not.toBeInTheDocument();
    expect(screen.getByText('Host controls playback')).toBeInTheDocument();
    expect(screen.getByTitle('Heat full movie')).toHaveAttribute('src', 'https://party.example/movie/1');
  });

  it('falls back to viewport fullscreen when native fullscreen is unavailable', async () => {
    render(<PartyPlaybackPlayer room={room} config={config} isHost onHostCommand={vi.fn()} />);
    const player = screen.getByTitle('Heat full movie').parentElement!;
    expect(player).not.toHaveClass('is-expanded');
    fireEvent.click(screen.getByRole('button', { name: 'Enter room fullscreen' }));
    await waitFor(() => expect(player).toHaveClass('is-expanded'));
    expect(document.body).toHaveClass('party-fullscreen-open');
  });

  it('retries room synchronization while a full-title source resolves', () => {
    vi.useFakeTimers();
    render(<PartyPlaybackPlayer room={room} config={config} isHost onHostCommand={vi.fn()} />);
    const player = screen.getByTitle('Heat full movie') as HTMLIFrameElement;
    const postMessage = vi.spyOn(player.contentWindow!, 'postMessage');
    act(() => fireEvent.load(player));
    const initialCommands = postMessage.mock.calls.length;
    expect(initialCommands).toBeGreaterThanOrEqual(2);
    act(() => vi.advanceTimersByTime(500));
    const firstRetryCommands = postMessage.mock.calls.length;
    expect(firstRetryCommands).toBeGreaterThan(initialCommands);
    act(() => vi.advanceTimersByTime(3500));
    expect(postMessage.mock.calls.length).toBeGreaterThan(firstRetryCommands);
    vi.useRealTimers();
  });
});
