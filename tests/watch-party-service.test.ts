import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { createWatchPartyService } from '../src/lib/watchParty';

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}));

describe('Supabase watch party service', () => {
  const single = vi.fn();
  const rpc = vi.fn();

  beforeEach(() => {
    single.mockReset();
    rpc.mockReset();
    rpc.mockReturnValue({ single });
    vi.mocked(createClient).mockReturnValue({
      rpc,
      from: vi.fn(),
      auth: {},
      channel: vi.fn(),
    } as never);
  });

  it('propagates apply_official_lounge_title failure and does not fall back to updateTitle', async () => {
    single.mockResolvedValue({
      data: null,
      error: { message: 'The lounge just changed titles. Vote on the next one.' },
    });

    const service = createWatchPartyService({
      url: 'https://example.supabase.co',
      publishableKey: 'test-key',
    });
    expect(service).not.toBeNull();

    await expect(service!.applyOfficialLoungeTitle('public-1', {
      titleId: 603,
      mediaType: 'movie',
      titleName: 'The Matrix',
      backdropPath: '/matrix-backdrop.jpg',
      durationSeconds: 8100,
    })).rejects.toThrow('The lounge just changed titles. Vote on the next one.');

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('apply_official_lounge_title', {
      p_room_id: 'public-1',
      p_title_id: 603,
      p_media_type: 'movie',
      p_title_name: 'The Matrix',
      p_backdrop_path: '/matrix-backdrop.jpg',
      p_duration_seconds: 8100,
    });
    expect(rpc).not.toHaveBeenCalledWith('update_watch_room_title', expect.anything());
  });

  it('maps a successful official lounge title RPC without calling update_watch_room_title', async () => {
    single.mockResolvedValue({
      data: {
        id: 'public-1',
        code: 'GLOCK1',
        host_id: null,
        title_id: 603,
        media_type: 'movie',
        title_name: 'The Matrix',
        playback_state: 'playing',
        playback_position: 0,
        playback_updated_at: '2026-08-27T00:00:00.000Z',
        season_number: 1,
        episode_number: 1,
        backdrop_path: '/matrix-backdrop.jpg',
        duration_seconds: 8100,
        is_public: true,
        is_official: true,
        server_id: 'cinesrc',
        is_locked: false,
        slow_mode_seconds: 0,
      },
      error: null,
    });

    const service = createWatchPartyService({
      url: 'https://example.supabase.co',
      publishableKey: 'test-key',
    });

    await expect(service!.applyOfficialLoungeTitle('public-1', {
      titleId: 603,
      mediaType: 'movie',
      titleName: 'The Matrix',
      backdropPath: '/matrix-backdrop.jpg',
      durationSeconds: 8100,
    })).resolves.toEqual(expect.objectContaining({
      id: 'public-1',
      titleName: 'The Matrix',
      titleId: 603,
      isOfficial: true,
    }));

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe('apply_official_lounge_title');
  });
});
