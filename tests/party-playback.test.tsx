import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PartyPlaybackPlayer, buildPartyPlaybackUrl, buildPartyPlayerCommand, parsePartyPlayerEvent } from '../src/components/PartyPlaybackPlayer';
import type { PartyRoom } from '../src/lib/watchParty';

const config = {
  movieUrlTemplate: 'https://party.example/movie/{tmdb_id}',
  tvUrlTemplate: 'https://party.example/tv/{tmdb_id}/{season_number}/{episode_number}',
};

const multiServerConfig = {
  ...config,
  servers: [
    { id: 'sync', label: 'Room Sync', description: 'Synchronized controls', movieUrlTemplate: config.movieUrlTemplate, tvUrlTemplate: config.tvUrlTemplate, commandMode: 'vidzen' as const },
    { id: 'auto', label: 'Glock Auto', description: 'Automatic source fallback', movieUrlTemplate: 'https://www.vidcore.org/embed/movie/{tmdb_id}?autoPlay=true', tvUrlTemplate: 'https://www.vidcore.org/embed/tv/{tmdb_id}/{season_number}/{episode_number}?autoPlay=true', commandMode: 'none' as const },
  ],
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
    expect(screen.getByText(/Paused by the host/i)).toBeInTheDocument();
    expect(screen.queryByTitle('Heat full movie')).not.toBeInTheDocument();
  });

  it('hard-stops the cross-origin player while the room is paused and remounts it on play', () => {
    const { rerender } = render(<PartyPlaybackPlayer room={room} config={config} isHost={false} onHostCommand={vi.fn()} />);
    expect(screen.queryByTitle('Heat full movie')).not.toBeInTheDocument();
    expect(screen.getByText(/Paused by the host/i)).toBeInTheDocument();

    rerender(<PartyPlaybackPlayer room={{ ...room, playbackState: 'playing', playbackUpdatedAt: '2026-08-11T00:01:00.000Z' }} config={config} isHost={false} onHostCommand={vi.fn()} />);
    expect(screen.getByTitle('Heat full movie')).toHaveAttribute('src', 'https://party.example/movie/1');
    expect(screen.getByRole('button', { name: 'Enable video playback' })).toHaveTextContent(/host stays in control/i);
  });

  it('gives a private guest a brief browser-required playback activation window', () => {
    vi.useFakeTimers();
    render(<PartyPlaybackPlayer room={{ ...room, playbackState: 'playing' }} config={config} isHost={false} onHostCommand={vi.fn()} />);
    const player = screen.getByTitle('Heat full movie').parentElement!;
    const iframe = screen.getByTitle('Heat full movie') as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    fireEvent.click(screen.getByRole('button', { name: 'Enable video playback' }));
    expect(player).toHaveClass('is-guest-unlocked');
    expect(screen.getByText(/Tap play in the player/i)).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(800));
    expect(postMessage.mock.calls.some(([message]) => String(message).includes('"command":"seek"'))).toBe(true);

    act(() => vi.advanceTimersByTime(7200));
    expect(player).not.toHaveClass('is-guest-unlocked');
    vi.useRealTimers();
  });

  it('falls back to viewport fullscreen when native fullscreen is unavailable', async () => {
    render(<PartyPlaybackPlayer room={{ ...room, playbackState: 'playing' }} config={config} isHost onHostCommand={vi.fn()} />);
    const player = screen.getByTitle('Heat full movie').parentElement!;
    expect(player).not.toHaveClass('is-expanded');
    fireEvent.click(screen.getByRole('button', { name: 'Enter room fullscreen' }));
    await waitFor(() => expect(player).toHaveClass('is-expanded'));
    expect(document.body).toHaveClass('party-fullscreen-open');
  });

  it('retries room synchronization while a full-title source resolves', () => {
    vi.useFakeTimers();
    render(<PartyPlaybackPlayer room={{ ...room, playbackState: 'playing' }} config={config} isHost onHostCommand={vi.fn()} />);
    const player = screen.getByTitle('Heat full movie') as HTMLIFrameElement;
    const postMessage = vi.spyOn(player.contentWindow!, 'postMessage');
    act(() => fireEvent.load(player));
    const initialCommands = postMessage.mock.calls.length;
    expect(initialCommands).toBeGreaterThanOrEqual(4);
    expect(postMessage.mock.calls.every(([, targetOrigin]) => String(targetOrigin) === '*')).toBe(true);
    expect(postMessage.mock.calls.some(([message]) => typeof message === 'object' && message && (message as { command?: string }).command === 'play')).toBe(true);
    act(() => vi.advanceTimersByTime(500));
    const firstRetryCommands = postMessage.mock.calls.length;
    expect(firstRetryCommands).toBeGreaterThan(initialCommands);
    act(() => vi.advanceTimersByTime(3500));
    expect(postMessage.mock.calls.length).toBeGreaterThan(firstRetryCommands);
    vi.useRealTimers();
  });

  it('lets every viewer switch to a fallback server without exposing host playback controls', () => {
    render(<PartyPlaybackPlayer room={{ ...room, playbackState: 'playing' }} config={multiServerConfig} isHost={false} onHostCommand={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open room server list' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Glock Auto/i }));

    expect(screen.getByTitle('Heat full movie')).toHaveAttribute('src', expect.stringContaining('https://www.vidcore.org/embed/movie/1'));
    expect(screen.queryByRole('button', { name: 'Play room' })).not.toBeInTheDocument();
  });

  it('keeps the automated public lounge locally clickable for the browser play gesture', () => {
    const publicRoom = { ...room, isPublic: true, isOfficial: true, playbackState: 'playing' as const };
    render(<PartyPlaybackPlayer room={publicRoom} config={multiServerConfig} isHost={false} onHostCommand={vi.fn()} />);

    const player = screen.getByTitle('Heat full movie').parentElement!;
    expect(player).toHaveClass('is-official');
    expect(screen.queryByText('Host controls playback')).not.toBeInTheDocument();
    expect(screen.getByText(/Tap the player once/i)).toBeInTheDocument();
  });

  it('uses room state and clock when a non-command server reloads', () => {
    expect(buildPartyPlaybackUrl(room, multiServerConfig, 'auto', 42)).toContain('startAt=42');
    expect(buildPartyPlaybackUrl(room, multiServerConfig, 'auto', 42)).toContain('autoPlay=false');
    expect(buildPartyPlaybackUrl({ ...room, playbackState: 'playing' }, multiServerConfig, 'auto', 55)).toContain('autoPlay=true');
  });

  it('blocks provider popups in room playback', () => {
    render(<PartyPlaybackPlayer room={{ ...room, playbackState: 'playing' }} config={config} isHost onHostCommand={vi.fn()} />);
    const frame = screen.getByTitle('Heat full movie');
    expect(frame).toHaveAttribute('sandbox');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-popups');
  });
});
