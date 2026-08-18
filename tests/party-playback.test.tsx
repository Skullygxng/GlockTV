import { act, fireEvent, render, screen } from '@testing-library/react';
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

const cineSrcConfig = {
  ...config,
  servers: [{
    id: 'cinesrc',
    label: 'CineSrc Sync',
    description: 'Documented room controls',
    movieUrlTemplate: 'https://cinesrc.st/embed/movie/{tmdb_id}?color=%238b24ed',
    tvUrlTemplate: 'https://cinesrc.st/embed/tv/{tmdb_id}?s={season_number}&e={episode_number}',
    commandMode: 'cinesrc',
  }],
} as never;

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

  it('parses CineSrc playback events with their documented current time', () => {
    expect(parsePartyPlayerEvent({ type: 'cinesrc:ready' })).toEqual({ event: 'ready', currentTime: 0 });
    expect(parsePartyPlayerEvent({ type: 'cinesrc:timeupdate', currentTime: 73.5, duration: 8880 })).toEqual({ event: 'timeupdate', currentTime: 73.5 });
    expect(parsePartyPlayerEvent({ type: 'cinesrc:pause', currentTime: 74 })).toEqual({ event: 'pause', currentTime: 74 });
  });

  it('uses the documented VidZen command envelope', () => {
    expect(buildPartyPlayerCommand('seek', { time: 91 })).toBe('{"command":"seek","time":91}');
    expect(buildPartyPlayerCommand('volume', { level: 1 })).toBe('{"command":"volume","level":1}');
  });

  it('uses the provider as the single host control surface', () => {
    const onHostCommand = vi.fn();
    render(<PartyPlaybackPlayer room={room} config={cineSrcConfig} isHost onHostCommand={onHostCommand} />);

    expect(screen.getByTitle('Heat full movie')).toBeInTheDocument();
    expect(screen.getByTitle('Heat full movie')).toHaveAttribute('src', expect.stringContaining('autoplay=false'));
    expect(screen.queryByRole('button', { name: 'Play room' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause room' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart room' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enter room fullscreen' })).not.toBeInTheDocument();
  });

  it('hard-stops the cross-origin player while the room is paused and remounts it on play', () => {
    const { rerender } = render(<PartyPlaybackPlayer room={room} config={config} isHost={false} onHostCommand={vi.fn()} />);
    expect(screen.queryByTitle('Heat full movie')).not.toBeInTheDocument();
    expect(screen.getByText(/Paused by the host/i)).toBeInTheDocument();

    rerender(<PartyPlaybackPlayer room={{ ...room, playbackState: 'playing', playbackUpdatedAt: '2026-08-11T00:01:00.000Z' }} config={config} isHost={false} onHostCommand={vi.fn()} />);
    expect(screen.getByTitle('Heat full movie')).toHaveAttribute('src', 'https://party.example/movie/1');
    expect(screen.getByRole('button', { name: 'Join playback' })).toHaveTextContent(/One tap unlocks video/i);
  });

  it('gives a private guest one clear browser-required playback activation', () => {
    vi.useFakeTimers();
    render(<PartyPlaybackPlayer room={{ ...room, playbackState: 'playing' }} config={cineSrcConfig} isHost={false} onHostCommand={vi.fn()} />);
    const player = screen.getByTitle('Heat full movie').parentElement!;
    const iframe = screen.getByTitle('Heat full movie') as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    fireEvent.click(screen.getByRole('button', { name: 'Join playback' }));
    expect(player).toHaveClass('is-guest-unlocked');
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'cinesrc:command', command: 'play', args: [] },
      'https://cinesrc.st',
    );

    act(() => vi.advanceTimersByTime(15000));
    expect(player).not.toHaveClass('is-guest-unlocked');
    vi.useRealTimers();
  });

  it('keeps a CineSrc guest activated across host pause and resume', () => {
    const { rerender } = render(<PartyPlaybackPlayer room={{ ...room, playbackState: 'playing' }} config={cineSrcConfig} isHost={false} onHostCommand={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Join playback' }));

    fireEvent(window, new MessageEvent('message', {
      origin: 'https://cinesrc.st',
      source: (screen.getByTitle('Heat full movie') as HTMLIFrameElement).contentWindow,
      data: { type: 'cinesrc:play', currentTime: 43 },
    }));
    expect(screen.queryByRole('button', { name: 'Join playback' })).not.toBeInTheDocument();

    rerender(<PartyPlaybackPlayer room={{ ...room, playbackState: 'paused', playbackPosition: 43 }} config={cineSrcConfig} isHost={false} onHostCommand={vi.fn()} />);
    expect(screen.getByTitle('Heat full movie')).toBeInTheDocument();
    expect(screen.getByText('Paused by host')).toBeInTheDocument();

    rerender(<PartyPlaybackPlayer room={{ ...room, playbackState: 'playing', playbackPosition: 43 }} config={cineSrcConfig} isHost={false} onHostCommand={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Join playback' })).not.toBeInTheDocument();
  });

  it('keeps the host authoritative when a CineSrc guest pauses locally', () => {
    render(<PartyPlaybackPlayer room={{ ...room, playbackState: 'playing' }} config={cineSrcConfig} isHost={false} onHostCommand={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Join playback' }));
    const iframe = screen.getByTitle('Heat full movie') as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    fireEvent(window, new MessageEvent('message', {
      origin: 'https://cinesrc.st',
      source: iframe.contentWindow,
      data: { type: 'cinesrc:pause', currentTime: 44 },
    }));

    expect(postMessage).toHaveBeenCalledWith(
      { type: 'cinesrc:command', command: 'play', args: [] },
      'https://cinesrc.st',
    );
  });

  it('does not add a duplicate fullscreen button over the provider player', () => {
    render(<PartyPlaybackPlayer room={{ ...room, playbackState: 'playing' }} config={config} isHost onHostCommand={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Enter room fullscreen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Exit room fullscreen' })).not.toBeInTheDocument();
  });

  it('turns a CineSrc native host play event into shared room state', () => {
    const onHostCommand = vi.fn();
    render(<PartyPlaybackPlayer room={room} config={cineSrcConfig} isHost onHostCommand={onHostCommand} />);
    const iframe = screen.getByTitle('Heat full movie') as HTMLIFrameElement;

    fireEvent(window, new MessageEvent('message', {
      origin: 'https://cinesrc.st',
      source: iframe.contentWindow,
      data: { type: 'cinesrc:play' },
    }));

    expect(onHostCommand).toHaveBeenCalledWith('playing', 0);
  });

  it('re-anchors an already-playing room to the host provider after refresh', () => {
    const onHostCommand = vi.fn();
    render(<PartyPlaybackPlayer room={{ ...room, playbackState: 'playing', playbackPosition: 120, playbackUpdatedAt: new Date(Date.now() - 10_000).toISOString() }} config={cineSrcConfig} isHost onHostCommand={onHostCommand} />);
    const iframe = screen.getByTitle('Heat full movie') as HTMLIFrameElement;

    fireEvent(window, new MessageEvent('message', {
      origin: 'https://cinesrc.st',
      source: iframe.contentWindow,
      data: { type: 'cinesrc:play', currentTime: 121 },
    }));

    expect(onHostCommand).toHaveBeenCalledWith('playing', 121);
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

  it('sends CineSrc commands using the documented envelope and exact origin', () => {
    vi.useFakeTimers();
    render(<PartyPlaybackPlayer room={{ ...room, playbackState: 'playing' }} config={cineSrcConfig} isHost onHostCommand={vi.fn()} />);
    const player = screen.getByTitle('Heat full movie') as HTMLIFrameElement;
    const postMessage = vi.spyOn(player.contentWindow!, 'postMessage');

    act(() => fireEvent.load(player));

    expect(postMessage).toHaveBeenCalledWith(
      { type: 'cinesrc:command', command: 'seek', args: [expect.any(Number)] },
      'https://cinesrc.st',
    );
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'cinesrc:command', command: 'play', args: [] },
      'https://cinesrc.st',
    );
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
