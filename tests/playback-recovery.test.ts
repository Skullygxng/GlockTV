import { describe, expect, it } from 'vitest';
import {
  isProviderPlaybackSignal,
  nextPlaybackServerId,
  playbackSessionExhausted,
  providerEmitsPlaybackSignal,
} from '../src/lib/playbackRecovery';
import { buildPlaybackUrl, type PlaybackServer } from '../src/lib/playback';

const servers: PlaybackServer[] = [
  { id: 'cinesrc', label: 'CineSrc', description: '', movieUrlTemplate: 'https://cinesrc.st/embed/movie/{tmdb_id}', tvUrlTemplate: 'https://cinesrc.st/embed/tv/{tmdb_id}?s={season_number}&e={episode_number}', commandMode: 'cinesrc' },
  { id: 'auto', label: 'VidCore', description: '', movieUrlTemplate: 'https://www.vidcore.org/embed/movie/{tmdb_id}', tvUrlTemplate: 'https://www.vidcore.org/embed/tv/{tmdb_id}/{season_number}/{episode_number}' },
  { id: 'backup', label: 'VidZen', description: '', movieUrlTemplate: 'https://vidzen.fun/movie/{tmdb_id}', tvUrlTemplate: 'https://vidzen.fun/tv/{tmdb_id}/{season_number}/{episode_number}', commandMode: 'vidzen' },
];

describe('playback recovery helpers', () => {
  it('walks unattempted servers and exhausts a session without looping', () => {
    expect(nextPlaybackServerId(servers, 'movie', 'cinesrc', [])).toBe('auto');
    expect(nextPlaybackServerId(servers, 'movie', 'auto', ['cinesrc'])).toBe('backup');
    expect(nextPlaybackServerId(servers, 'movie', 'backup', ['cinesrc', 'auto'])).toBeNull();
    expect(playbackSessionExhausted(servers, 'movie', ['cinesrc', 'auto', 'backup'])).toBe(true);
  });

  it('keeps TV episode placeholders intact on every configured server', () => {
    const config = { servers };
    expect(buildPlaybackUrl({ id: 1396, mediaType: 'tv' }, config, { season: 3, episode: 7 }, 'auto'))
      .toBe('https://www.vidcore.org/embed/tv/1396/3/7');
    expect(buildPlaybackUrl({ id: 1396, mediaType: 'tv' }, config, { season: 3, episode: 7 }, 'backup'))
      .toBe('https://vidzen.fun/tv/1396/3/7');
  });

  it('treats provider playback events as readiness, not iframe load', () => {
    expect(providerEmitsPlaybackSignal(servers[0])).toBe(true);
    expect(providerEmitsPlaybackSignal(servers[1])).toBe(false);
    expect(isProviderPlaybackSignal({ type: 'cinesrc:timeupdate', currentTime: 12 })).toBe(true);
    expect(isProviderPlaybackSignal({ type: 'PLAYER_EVENT', data: { event: 'ready', currentTime: 0 } })).toBe(true);
    expect(isProviderPlaybackSignal({ type: 'iframe-load' })).toBe(false);
  });
});
