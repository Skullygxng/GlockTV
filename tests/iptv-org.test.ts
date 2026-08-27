import { describe, expect, it, vi } from 'vitest';
import { IPTV_ORG_US_PLAYLIST, loadIptvOrgCatalog, parseIptvOrgPlaylist } from '../src/lib/iptvOrg';

const fixture = `#EXTM3U
#EXTINF:-1 tvg-id="NewsOne.us" tvg-logo="https://img.example/news.png" group-title="News",News One
https://video.example/news/index.m3u8
#EXTINF:-1 tvg-id="NewsOne.us" tvg-logo="https://img.example/news.png" group-title="News",News One Backup
https://backup.example/news/index.m3u8
#EXTINF:-1 tvg-id="HeaderLocked.us" group-title="General",Header Locked
#EXTVLCOPT:http-referrer=https://locked.example/
https://video.example/locked/index.m3u8
#EXTINF:-1 tvg-id="Insecure.us" group-title="General",Insecure
http://video.example/insecure/index.m3u8
#EXTINF:-1 tvg-id="Geo.us" group-title="News [Geo-blocked]",Geo Channel
https://video.example/geo/index.m3u8`;

describe('IPTV-org catalog', () => {
  it('normalizes channels, merges backup streams, and excludes browser-unsafe entries', () => {
    const catalog = parseIptvOrgPlaylist(fixture);
    expect(catalog.source).toBe('iptv-org');
    expect(catalog.channels).toHaveLength(1);
    expect(catalog.channels[0]).toMatchObject({
      id: 'NewsOne.us',
      name: 'News One',
      logo: 'https://img.example/news.png',
      category: 'News',
      country: 'US',
    });
    expect(catalog.channels[0].streams.map((stream) => stream.url)).toEqual([
      'https://video.example/news/index.m3u8',
      'https://backup.example/news/index.m3u8',
    ]);
  });

  it('loads the official US playlist endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, text: async () => fixture });
    const catalog = await loadIptvOrgCatalog(fetcher as never);
    expect(fetcher).toHaveBeenCalledWith(IPTV_ORG_US_PLAYLIST, expect.any(Object));
    expect(catalog.channels[0].id).toBe('NewsOne.us');
  });
});
