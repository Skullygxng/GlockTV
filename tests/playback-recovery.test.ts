import { describe, expect, it } from 'vitest';
import type { PlaybackServer } from '../src/lib/playback';
import {
  nextPlaybackServerId,
  playbackSessionExhausted,
  providerEmitsPlaybackSignal,
} from '../src/lib/playbackRecovery';

const servers: PlaybackServer[] = [
  { id: 'cinesrc', label: 'CineSrc', description: '', movieUrlTemplate: 'https://cinesrc.st/embed/movie/{tmdb_id}', commandMode: 'cinesrc' },
  { id: 'auto', label: 'VidCore', description: '', movieUrlTemplate: 'https://www.vidcore.org/embed/movie/{tmdb_id}', tvUrlTemplate: 'https://www.vidcore.org/embed/tv/{tmdb_id}/{season_number}/{episode_number}' },
  { id: 'backup', label: 'VidZen', description: '', movieUrlTemplate: 'https://vidzen.fun/movie/{tmdb_id}', commandMode: 'vidzen' },
];

describe('playback provider recovery', () => {
  it('picks the next untried compatible server', () => {
    expect(nextPlaybackServerId(servers, 'movie', 'cinesrc', [])).toBe('auto');
    expect(nextPlaybackServerId(servers, 'movie', 'auto', ['cinesrc', 'auto'])).toBe('backup');
  });

  it('reports the session exhausted when every movie server has been tried', () => {
    expect(playbackSessionExhausted(servers, 'movie', ['cinesrc', 'auto', 'backup'])).toBe(true);
    expect(playbackSessionExhausted(servers, 'movie', ['cinesrc'])).toBe(false);
  });

  it('does not treat iframe-only providers as progress-signalling servers', () => {
    expect(providerEmitsPlaybackSignal(servers[0])).toBe(true);
    expect(providerEmitsPlaybackSignal(servers[1])).toBe(false);
    expect(providerEmitsPlaybackSignal(servers[2])).toBe(true);
  });
});
