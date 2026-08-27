import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IPTV_ORG_US_PLAYLIST,
  cleanChannelName,
  clearIptvOrgCatalogCache,
  isBrowserSafeUrl,
  loadIptvOrgCatalog,
  normalizeCategories,
  parseIptvOrgPlaylist,
  pickPrimaryCategory,
} from '../src/lib/iptvOrg';

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
https://video.example/geo/index.m3u8
#EXTINF:-1 tvg-id="Compound.us" group-title="Music;Religious",Compound Channel
https://video.example/music/index.m3u8
#EXTINF:-1 tvg-id="KidsAnim.us" group-title="Animation;Kids;Religious",Kids Animation
https://video.example/kids/playlist.m3u8
#EXTINF:-1 tvg-id="Quality.us" group-title="News",ABC News Live 5 (720p)
https://video.example/abc/index.m3u8
#EXTINF:-1 tvg-id="Bracket.us" group-title="Sports",NBC Sports Boston (1080p) [Not 24/7]
https://video.example/nbc/index.m3u8
#EXTINF:-1 tvg-id="Pipe.us" group-title="General",Pipe Headers
https://video.example/pipe/index.m3u8|Referer=https://evil.example
#EXTINF:-1 tvg-id="Proxy.us" group-title="General",Cors Proxy
https://corsproxy.io/?https://video.example/stream.m3u8
#EXTINF:-1 tvg-id="QueryHls.us" group-title="Entertainment",Query HLS
https://cdn.example/live/master.m3u8?token=abc123
#EXTINF:-1 tvg-id="UserAgent.us" group-title="General",Needs UA
#EXTVLCOPT:http-user-agent=CustomAgent/1.0
https://video.example/ua/index.m3u8
`;

afterEach(() => {
  clearIptvOrgCatalogCache();
});

describe('IPTV-org catalog', () => {
  it('normalizes channels, merges backup streams, and excludes browser-unsafe entries', () => {
    const catalog = parseIptvOrgPlaylist(fixture);
    expect(catalog.source).toBe('iptv-org');
    const news = catalog.channels.find((c) => c.id === 'NewsOne.us');
    expect(news).toMatchObject({
      id: 'NewsOne.us',
      name: 'News One',
      displayName: 'News One',
      logo: 'https://img.example/news.png',
      category: 'News',
      country: 'US',
    });
    expect(news?.streams.map((stream) => stream.url)).toEqual([
      'https://video.example/news/index.m3u8',
      'https://backup.example/news/index.m3u8',
    ]);
    const ids = catalog.channels.map((c) => c.id);
    expect(ids).not.toContain('HeaderLocked.us');
    expect(ids).not.toContain('Insecure.us');
    expect(ids).not.toContain('Geo.us');
    expect(ids).not.toContain('Pipe.us');
    expect(ids).not.toContain('Proxy.us');
    expect(ids).not.toContain('UserAgent.us');
  });

  it('normalizes compound semicolon-delimited categories', () => {
    const catalog = parseIptvOrgPlaylist(fixture);
    const compound = catalog.channels.find((c) => c.id === 'Compound.us');
    expect(compound?.categories).toEqual(['Music', 'Religious']);
    expect(compound?.category).toBe('Music');
    const kids = catalog.channels.find((c) => c.id === 'KidsAnim.us');
    expect(kids?.categories).toEqual(['Animation', 'Kids', 'Religious']);
    expect(kids?.category).toBe('Kids');
  });

  it('cleans channel display names and extracts metadata', () => {
    const catalog = parseIptvOrgPlaylist(fixture);
    const quality = catalog.channels.find((c) => c.id === 'Quality.us');
    expect(quality?.displayName).toBe('ABC News Live 5');
    expect(quality?.metadata).toContain('720p');
    const bracket = catalog.channels.find((c) => c.id === 'Bracket.us');
    expect(bracket?.displayName).toBe('NBC Sports Boston');
    expect(bracket?.metadata).toEqual(expect.arrayContaining(['1080p', 'Not 24/7']));
  });

  it('accepts HLS URLs with query strings', () => {
    const catalog = parseIptvOrgPlaylist(fixture);
    const query = catalog.channels.find((c) => c.id === 'QueryHls.us');
    expect(query).toBeTruthy();
    expect(query?.streams[0].url).toContain('master.m3u8?token=');
  });

  it('loads the official US playlist endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, text: async () => fixture });
    const catalog = await loadIptvOrgCatalog(fetcher as never);
    expect(fetcher).toHaveBeenCalledWith(IPTV_ORG_US_PLAYLIST, expect.any(Object));
    expect(catalog.channels.find((c) => c.id === 'NewsOne.us')).toBeTruthy();
  });

  it('caches catalog and skips network on subsequent loads within TTL', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, text: async () => fixture });
    const first = await loadIptvOrgCatalog(fetcher as never);
    const second = await loadIptvOrgCatalog(fetcher as never);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second.channels.length).toBe(first.channels.length);
  });

  it('bypasses cache when requested', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, text: async () => fixture });
    await loadIptvOrgCatalog(fetcher as never);
    await loadIptvOrgCatalog(fetcher as never, IPTV_ORG_US_PLAYLIST, { bypassCache: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects empty catalog results', async () => {
    const empty = '#EXTM3U\n';
    const fetcher = vi.fn().mockResolvedValue({ ok: true, text: async () => empty });
    await expect(loadIptvOrgCatalog(fetcher as never)).rejects.toThrow(/No browser-compatible/);
  });
});

describe('normalizeCategories', () => {
  it('splits, trims, and deduplicates', () => {
    expect(normalizeCategories('Music;Religious')).toEqual(['Music', 'Religious']);
    expect(normalizeCategories('Animation;Kids;Religious')).toEqual(['Animation', 'Kids', 'Religious']);
    expect(normalizeCategories('News;News')).toEqual(['News']);
    expect(normalizeCategories('  Sports ;  Movies  ')).toEqual(['Sports', 'Movies']);
    expect(normalizeCategories(undefined)).toEqual(['General']);
    expect(normalizeCategories('')).toEqual(['General']);
  });
});

describe('pickPrimaryCategory', () => {
  it('prefers known GlockTV categories', () => {
    expect(pickPrimaryCategory(['Animation', 'Kids', 'Religious'])).toBe('Kids');
    expect(pickPrimaryCategory(['Religious', 'Music'])).toBe('Music');
    expect(pickPrimaryCategory(['WeirdCustom'])).toBe('WeirdCustom');
  });
});

describe('cleanChannelName', () => {
  it('strips quality and bracket metadata conservatively', () => {
    expect(cleanChannelName('ABC News Live 5 (720p)')).toMatchObject({
      displayName: 'ABC News Live 5',
      quality: '720p',
    });
    expect(cleanChannelName('NBC Sports Boston (1080p) [Not 24/7]')).toMatchObject({
      displayName: 'NBC Sports Boston',
    });
    expect(cleanChannelName('Example Channel [Geo-blocked]').displayName).toBe('Example Channel');
    expect(cleanChannelName('ESPN (Deportes)').displayName).toBe('ESPN (Deportes)');
  });
});

describe('isBrowserSafeUrl', () => {
  it('accepts HTTPS HLS and rejects unsafe URLs', () => {
    expect(isBrowserSafeUrl('https://cdn.example/live/index.m3u8')).toBe(true);
    expect(isBrowserSafeUrl('https://cdn.example/live/master.m3u8?token=x')).toBe(true);
    expect(isBrowserSafeUrl('https://cdn.example/hls/playlist')).toBe(true);
    expect(isBrowserSafeUrl('http://cdn.example/live/index.m3u8')).toBe(false);
    expect(isBrowserSafeUrl('https://cdn.example/live/index.m3u8|Referer=x')).toBe(false);
    expect(isBrowserSafeUrl('https://corsproxy.io/?https://x.m3u8')).toBe(false);
    expect(isBrowserSafeUrl('not-a-url')).toBe(false);
    expect(isBrowserSafeUrl('https://example.com/about')).toBe(false);
  });
});
