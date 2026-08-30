/*
 * Authorized first-party embeds: YouTube and Twitch.
 *
 * These are the platforms' own documented embed endpoints, built from an
 * identifier a catalog provider supplied in a documented field. Nothing here
 * scrapes a page, extracts a manifest, forges a token, or works around an
 * embedding restriction. If a rights holder has disabled embedding for a
 * video, the platform's own player says so inside the frame and we report
 * nothing about it - we have no way to see into a cross-origin frame and must
 * not pretend otherwise.
 *
 * This policy is deliberately separate from ppvEmbedPolicy. The hosted-stream
 * allowlist there is unchanged and is NOT widened to include these platforms:
 * a hosted stream provider handing back a youtube.com URL is not the same
 * event as our own catalog naming a YouTube video id, and only the second is
 * trusted here.
 */

const YOUTUBE_EMBED_ORIGIN = 'https://www.youtube-nocookie.com';
const TWITCH_PLAYER_ORIGIN = 'https://player.twitch.tv';

/*
 * Exact hosts an authorized embed may resolve to. Separate list, separate
 * review: adding one is a deliberate change, exactly as with the hosted-embed
 * allowlist.
 */
export const PPV_AUTHORIZED_EMBED_HOSTS: readonly string[] = [
  'www.youtube-nocookie.com',
  'player.twitch.tv',
];

/* Documented YouTube video id shape. */
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/* Documented Twitch login/channel name shape. */
const TWITCH_CHANNEL = /^[A-Za-z0-9][A-Za-z0-9_]{2,24}$/;

/* Hosts a documented YouTube video link may come from. */
const YOUTUBE_SOURCE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
]);

/*
 * Twitch refuses to play unless the embedding page's host is declared as a
 * parent. We only ever declare a host we actually ship on, so a fork served
 * from somewhere else gets no Twitch source rather than a broken player or a
 * spoofed parent.
 */
export const PPV_TWITCH_PARENT_HOSTS: readonly string[] = [
  'skullygxng.github.io',
  'localhost',
  '127.0.0.1',
];

export function youtubeVideoIdFrom(value: unknown): string {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw) return '';
  if (YOUTUBE_VIDEO_ID.test(raw)) return raw;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  if (!YOUTUBE_SOURCE_HOSTS.has(url.hostname.toLowerCase())) return '';

  const fromQuery = url.searchParams.get('v') ?? '';
  if (YOUTUBE_VIDEO_ID.test(fromQuery)) return fromQuery;

  const segments = url.pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  return YOUTUBE_VIDEO_ID.test(last) ? last : '';
}

export function twitchChannelFrom(value: unknown): string {
  if (typeof value !== 'string') return '';
  const raw = value.trim().replace(/^@/, '');
  return TWITCH_CHANNEL.test(raw) ? raw : '';
}

export function youtubeEmbedUrl(videoId: string): string | undefined {
  if (!YOUTUBE_VIDEO_ID.test(videoId)) return undefined;
  /* rel=0 keeps the end screen on the same channel; no tracking parameters. */
  return `${YOUTUBE_EMBED_ORIGIN}/embed/${encodeURIComponent(videoId)}?rel=0`;
}

/* Returns '' when the page is not served from a declared parent host. */
export function currentTwitchParent(hostname?: string): string {
  const host = (
    hostname ??
    (typeof globalThis === 'undefined'
      ? ''
      : ((globalThis as { location?: { hostname?: string } }).location?.hostname ?? ''))
  )
    .toLowerCase()
    .trim();
  return PPV_TWITCH_PARENT_HOSTS.includes(host) ? host : '';
}

export function twitchEmbedUrl(channel: string, hostname?: string): string | undefined {
  if (!TWITCH_CHANNEL.test(channel)) return undefined;
  const parent = currentTwitchParent(hostname);
  if (!parent) return undefined;
  return `${TWITCH_PLAYER_ORIGIN}/?channel=${encodeURIComponent(channel)}&parent=${encodeURIComponent(
    parent,
  )}&autoplay=false`;
}

export type PpvAuthorizedEmbedDecision =
  | 'allowed'
  | 'empty'
  | 'malformed'
  | 'non_https'
  | 'credentials'
  | 'host_not_allowlisted';

export interface PpvAuthorizedEmbedInspection {
  allowed: boolean;
  reason: PpvAuthorizedEmbedDecision;
  hostname: string;
}

export function inspectAuthorizedEmbedUrl(value: string): PpvAuthorizedEmbedInspection {
  if (!value) return { allowed: false, reason: 'empty', hostname: '' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { allowed: false, reason: 'malformed', hostname: '' };
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') return { allowed: false, reason: 'non_https', hostname: host };
  if (url.username || url.password) {
    return { allowed: false, reason: 'credentials', hostname: host };
  }
  if (!PPV_AUTHORIZED_EMBED_HOSTS.includes(host)) {
    return { allowed: false, reason: 'host_not_allowlisted', hostname: host };
  }
  return { allowed: true, reason: 'allowed', hostname: host };
}

export function isAllowedAuthorizedEmbedUrl(value: string): boolean {
  return inspectAuthorizedEmbedUrl(value).allowed;
}
