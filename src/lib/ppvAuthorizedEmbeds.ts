/*
 * Authorized first-party embeds: YouTube, Twitch, Kick, Rumble and Vimeo.
 *
 * These are the platforms' own documented embed endpoints, built from an
 * identifier a catalog provider supplied in a documented field, or one the
 * operator pasted from the platform's own public URL. Nothing here
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
  'player.kick.com',
  'rumble.com',
  'player.vimeo.com',
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

/* Hosts a documented Twitch channel link may come from. */
const TWITCH_SOURCE_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv']);

export function twitchChannelFrom(value: unknown): string {
  if (typeof value !== 'string') return '';
  const raw = value.trim().replace(/^@/, '');
  if (!raw) return '';
  if (TWITCH_CHANNEL.test(raw)) return raw;

  /* A channel link, so a pasted twitch.tv URL resolves like every other
     platform rather than being the one that only accepts a bare name. */
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  if (url.username || url.password) return '';
  if (!TWITCH_SOURCE_HOSTS.has(url.hostname.toLowerCase())) return '';
  const first = url.pathname.split('/').filter(Boolean)[0] ?? '';
  return TWITCH_CHANNEL.test(first) ? first : '';
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

/* ------------------------------------------------------------------------ *
 * Additional authorized platforms.
 *
 * Each entry is a platform's OWN documented iframe endpoint, built from an
 * identifier the platform itself puts in its public URLs. As above: nothing
 * scrapes, extracts a manifest, forges a token or works around an embedding
 * restriction. If a rights holder has disabled embedding, the platform's
 * player says so inside the frame and we report nothing about it.
 *
 * Sources for the formats used here:
 *   Kick    https://help.kick.com/en/articles/8010826  (player.kick.com/<user>)
 *   Rumble  https://help.rumble.com/Embed-Videos.html  (rumble.com/embed/<id>/)
 *   Vimeo   https://help.vimeo.com/hc/en-us/articles/12426260232977
 *
 * Dailymotion is deliberately ABSENT. Its current documented iframe endpoint
 * is geo.dailymotion.com/player/<Player ID>.html?video=<id> and requires an
 * account-specific Player ID this project does not have. Shipping the legacy
 * path instead would be a guess, and a guess does not belong in an allowlist.
 * ------------------------------------------------------------------------ */

const KICK_PLAYER_ORIGIN = 'https://player.kick.com';
const RUMBLE_EMBED_ORIGIN = 'https://rumble.com';
const VIMEO_PLAYER_ORIGIN = 'https://player.vimeo.com';

/* Kick channel slug: letters, digits, underscore and hyphen. */
const KICK_CHANNEL = /^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/;
/*
 * Rumble EMBED id, which is not the same string as the watch-page slug: a
 * watch URL looks like /v1a59rb-some-title.html and cannot be turned into an
 * embed id without asking Rumble. So only an explicit /embed/<id> link or a
 * bare id is accepted, and a watch-page URL is refused rather than guessed at.
 */
const RUMBLE_EMBED_ID = /^[A-Za-z0-9]{4,20}(\.[A-Za-z0-9]{4,20})?$/;
/* Vimeo video ids are numeric. */
const VIMEO_VIDEO_ID = /^[0-9]{6,12}$/;

const KICK_SOURCE_HOSTS = new Set(['kick.com', 'www.kick.com', 'player.kick.com']);
const RUMBLE_SOURCE_HOSTS = new Set(['rumble.com', 'www.rumble.com']);
const VIMEO_SOURCE_HOSTS = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);

function parsedHttpUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  return url;
}

export function kickChannelFrom(value: unknown): string {
  if (typeof value !== 'string') return '';
  const raw = value.trim().replace(/^@/, '');
  if (!raw) return '';
  if (KICK_CHANNEL.test(raw)) return raw;

  const url = parsedHttpUrl(raw);
  if (!url || !KICK_SOURCE_HOSTS.has(url.hostname.toLowerCase())) return '';
  const first = url.pathname.split('/').filter(Boolean)[0] ?? '';
  return KICK_CHANNEL.test(first) ? first : '';
}

export function rumbleVideoIdFrom(value: unknown): string {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw) return '';
  if (RUMBLE_EMBED_ID.test(raw)) return raw;

  const url = parsedHttpUrl(raw);
  if (!url || !RUMBLE_SOURCE_HOSTS.has(url.hostname.toLowerCase())) return '';
  const segments = url.pathname.split('/').filter(Boolean);
  /* Only /embed/<id> - a watch-page slug is not an embed id. */
  if (segments[0] !== 'embed') return '';
  const id = segments[1] ?? '';
  return RUMBLE_EMBED_ID.test(id) ? id : '';
}

export function vimeoVideoIdFrom(value: unknown): string {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw) return '';
  if (VIMEO_VIDEO_ID.test(raw)) return raw;

  const url = parsedHttpUrl(raw);
  if (!url || !VIMEO_SOURCE_HOSTS.has(url.hostname.toLowerCase())) return '';
  const segments = url.pathname.split('/').filter(Boolean);
  const candidate = segments[0] === 'video' ? (segments[1] ?? '') : (segments[0] ?? '');
  return VIMEO_VIDEO_ID.test(candidate) ? candidate : '';
}

export function kickEmbedUrl(channel: string): string | undefined {
  if (!KICK_CHANNEL.test(channel)) return undefined;
  return `${KICK_PLAYER_ORIGIN}/${encodeURIComponent(channel)}`;
}

export function rumbleEmbedUrl(videoId: string): string | undefined {
  if (!RUMBLE_EMBED_ID.test(videoId)) return undefined;
  return `${RUMBLE_EMBED_ORIGIN}/embed/${encodeURIComponent(videoId)}/`;
}

export function vimeoEmbedUrl(videoId: string): string | undefined {
  if (!VIMEO_VIDEO_ID.test(videoId)) return undefined;
  return `${VIMEO_PLAYER_ORIGIN}/video/${encodeURIComponent(videoId)}`;
}

/* ------------------------------------------------------------------------ *
 * The platform table, and resolving a pasted link.
 *
 * Every authorized adapter and the operator-supplied link path read the same
 * table, so a platform is supported in exactly one place and adding one is a
 * single reviewed entry.
 *
 * Why the pasted-link path exists: no configured catalog provider populates a
 * YouTube video id, a Twitch channel or any other authorized identifier, so
 * every authorized adapter is dormant and the feature never produces a source
 * on its own. Letting the operator name a broadcast they are entitled to watch
 * turns the authorized path from an extension point into something that
 * actually plays.
 *
 * What it is NOT: a way in for anything else. A pasted value only becomes a
 * source if it parses to a platform identifier under this table and the
 * resulting URL is on PPV_AUTHORIZED_EMBED_HOSTS. Any other host - a hosted
 * aggregator, a manifest, a redirector, an arbitrary page - is refused with a
 * reason, and the hosted-embed allowlist in ppvEmbedPolicy is untouched.
 * ------------------------------------------------------------------------ */

export type PpvAuthorizedPlatformId = 'youtube' | 'twitch' | 'kick' | 'rumble' | 'vimeo';

export interface PpvAuthorizedPlatform {
  id: PpvAuthorizedPlatformId;
  label: string;
  /* What the operator would paste, for the empty-state hint. */
  example: string;
  identifierFrom: (value: unknown) => string;
  embedUrl: (identifier: string, hostname?: string) => string | undefined;
}

export const PPV_AUTHORIZED_PLATFORMS: readonly PpvAuthorizedPlatform[] = [
  {
    id: 'youtube',
    label: 'YouTube',
    example: 'https://www.youtube.com/watch?v=...',
    identifierFrom: youtubeVideoIdFrom,
    embedUrl: (identifier) => youtubeEmbedUrl(identifier),
  },
  {
    id: 'twitch',
    label: 'Twitch',
    example: 'https://www.twitch.tv/<channel>',
    identifierFrom: twitchChannelFrom,
    embedUrl: (identifier, hostname) => twitchEmbedUrl(identifier, hostname),
  },
  {
    id: 'kick',
    label: 'Kick',
    example: 'https://kick.com/<channel>',
    identifierFrom: kickChannelFrom,
    embedUrl: (identifier) => kickEmbedUrl(identifier),
  },
  {
    id: 'rumble',
    label: 'Rumble',
    example: 'https://rumble.com/embed/<id>/',
    identifierFrom: rumbleVideoIdFrom,
    embedUrl: (identifier) => rumbleEmbedUrl(identifier),
  },
  {
    id: 'vimeo',
    label: 'Vimeo',
    example: 'https://vimeo.com/<id>',
    identifierFrom: vimeoVideoIdFrom,
    embedUrl: (identifier) => vimeoEmbedUrl(identifier),
  },
];

export type PpvLinkRejection =
  | 'empty'
  | 'unsupported_platform'
  /* Parsed to a platform, but that platform cannot build a URL here. The only
     live case is Twitch refusing when this origin is not a declared parent. */
  | 'platform_unavailable_here'
  /* Built a URL that is not on the authorized host list. Should be
     unreachable; kept because an allowlist that is never re-checked is not an
     allowlist. */
  | 'host_not_allowlisted';

export interface PpvAuthorizedLinkResult {
  ok: boolean;
  platform: PpvAuthorizedPlatform | null;
  url: string;
  reason: PpvLinkRejection | 'allowed';
}

/*
 * Resolve an operator-pasted value into an authorized embed URL.
 *
 * Twitch is tried only when this origin is a declared parent, so a fork served
 * elsewhere gets a clear refusal rather than a player that silently never
 * starts.
 */
export function authorizedEmbedFromLink(
  value: string,
  hostname?: string,
): PpvAuthorizedLinkResult {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { ok: false, platform: null, url: '', reason: 'empty' };

  /*
   * A full URL only. Several platforms accept a bare identifier for the
   * catalog adapters, and a bare word is genuinely ambiguous between them -
   * "garcia" is a valid Twitch login and a valid Kick slug, and whichever
   * entry sits earlier in the table would silently win. A pasted link carries
   * its own platform in the host, so requiring one removes the ambiguity
   * instead of resolving it by luck.
   */
  const parsed = parsedHttpUrl(raw);
  if (!parsed) return { ok: false, platform: null, url: '', reason: 'unsupported_platform' };

  for (const platform of PPV_AUTHORIZED_PLATFORMS) {
    const identifier = platform.identifierFrom(raw);
    if (!identifier) continue;
    const url = platform.embedUrl(identifier, hostname);
    if (!url) {
      return { ok: false, platform, url: '', reason: 'platform_unavailable_here' };
    }
    if (!isAllowedAuthorizedEmbedUrl(url)) {
      return { ok: false, platform, url: '', reason: 'host_not_allowlisted' };
    }
    return { ok: true, platform, url, reason: 'allowed' };
  }
  return { ok: false, platform: null, url: '', reason: 'unsupported_platform' };
}

/* Human-readable refusal. Never names an unsupported host back to the user -
   that would read as a hint about what to try next. */
export function describeLinkRejection(reason: PpvLinkRejection): string {
  switch (reason) {
    case 'empty':
      return 'Paste a link first.';
    case 'platform_unavailable_here':
      return 'That platform cannot be embedded from this site.';
    case 'host_not_allowlisted':
      return 'That link does not resolve to an approved player.';
    case 'unsupported_platform':
    default:
      return `Only official ${PPV_AUTHORIZED_PLATFORMS.map((entry) => entry.label).join(
        ', ',
      )} links can be added.`;
  }
}
