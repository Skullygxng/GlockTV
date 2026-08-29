/*
 * Central PPV embed policy.
 *
 * Every PPV embed URL must pass isAllowedPpvEmbedUrl before it can reach an
 * iframe. Embed URLs arrive verbatim from third-party provider APIs, so this
 * is the only thing standing between a compromised or hostile provider
 * response and an arbitrary page framed inside GlockTV. Keep the host rules
 * here; do not re-derive them in components.
 */

/*
 * The hosted players need their own origin to initialise (storage, cookies,
 * EME). This matches the sandbox the working movie/TV players already use.
 * Because the allowlist below can never resolve to GlockTV's own origin,
 * allow-same-origin here only restores the embed's own origin - it does not
 * grant access to the GlockTV document.
 *
 * Deliberately withheld: allow-popups, allow-popups-to-escape-sandbox,
 * allow-top-navigation(-by-user-activation), allow-downloads, allow-modals.
 */
export const PPV_IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-presentation';
export const PPV_IFRAME_REFERRER_POLICY = 'strict-origin-when-cross-origin';
export const PPV_IFRAME_ALLOW = 'autoplay; fullscreen; encrypted-media; picture-in-picture';

/*
 * Exact embed hosts returned by the currently supported provider adapters.
 * No wildcards: adding an embed host is a deliberate, reviewed change.
 *
 *   streamed -> embed.st            (Streamed stream rows)
 *   sportsrc -> embed.streamapi.cc  (SportSRC detail sources)
 *
 * Provider API origins (streamed.pk, api.sportsrc.org) are intentionally
 * absent: they serve JSON, not embeds.
 *
 * DaddyLive is not currently supported because no approved embed origin is
 * configured. Supporting it again means adding its verified embed host here
 * and restoring a discovery path for it; nothing requests it today.
 */
export const PPV_EMBED_HOSTS: readonly string[] = ['embed.st', 'embed.streamapi.cc'];

const PRIVATE_IPV4 =
  /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value).toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  return PRIVATE_IPV4.test(host);
}

/* Hosted players are pages, never media playlists. */
function isMediaPlaylistUrl(url: URL): boolean {
  const path = decodeSafely(url.pathname).replace(/\/+$/, '');
  if (/\.(m3u8|m3u|mpd)$/.test(path)) return true;
  const search = decodeSafely(url.search);
  return search.includes('.m3u8') || search.includes('.m3u') || search.includes('.mpd');
}

function currentOriginHostname(): string {
  if (typeof globalThis === 'undefined') return '';
  const location = (globalThis as { location?: { hostname?: string } }).location;
  return location?.hostname?.toLowerCase() ?? '';
}

export type PpvEmbedDecision =
  | 'allowed'
  | 'empty'
  | 'malformed'
  | 'non_https'
  | 'credentials'
  | 'local_or_private'
  | 'own_origin'
  | 'media_playlist'
  | 'host_not_allowlisted';

export interface PpvEmbedInspection {
  allowed: boolean;
  reason: PpvEmbedDecision;
  /*
   * Hostname only, and '' when the URL could not be parsed. The path and query
   * are deliberately never retained: they can carry tokens or signatures.
   */
  hostname: string;
}

/*
 * Same rules as before, but reports why a URL was refused so runtime
 * diagnostics can distinguish "provider returned nothing" from "provider
 * returned embeds we refuse to frame". The allowlist itself is unchanged.
 */
export function inspectPpvEmbedUrl(value: string): PpvEmbedInspection {
  if (!value) return { allowed: false, reason: 'empty', hostname: '' };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { allowed: false, reason: 'malformed', hostname: '' };
  }

  const host = url.hostname.toLowerCase();

  // https only, which also rejects javascript:, data:, blob: and http:.
  if (url.protocol !== 'https:') return { allowed: false, reason: 'non_https', hostname: host };
  if (url.username || url.password) return { allowed: false, reason: 'credentials', hostname: host };
  if (!host) return { allowed: false, reason: 'malformed', hostname: '' };
  if (isLocalHostname(host)) return { allowed: false, reason: 'local_or_private', hostname: host };

  // Never frame GlockTV itself: same-origin plus allow-same-origin would be a
  // real sandbox escape.
  const ownHost = currentOriginHostname();
  if (ownHost && host === ownHost) return { allowed: false, reason: 'own_origin', hostname: host };

  if (isMediaPlaylistUrl(url)) return { allowed: false, reason: 'media_playlist', hostname: host };

  if (!PPV_EMBED_HOSTS.includes(host)) {
    return { allowed: false, reason: 'host_not_allowlisted', hostname: host };
  }
  return { allowed: true, reason: 'allowed', hostname: host };
}

export function isAllowedPpvEmbedUrl(value: string): boolean {
  return inspectPpvEmbedUrl(value).allowed;
}
