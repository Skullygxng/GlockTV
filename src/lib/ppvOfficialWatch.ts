/*
 * Official watch destinations.
 *
 * Zero inline playback sources is not an error. Most fight cards are simply
 * not available as a hosted embed, and telling the viewer "Embed unavailable"
 * for a card that is on sale right now is both wrong and useless. When we can
 * name where the event is legitimately watchable, we link there instead.
 *
 * Rules, all enforced here rather than at call sites:
 *   - HTTPS only.
 *   - Host must be on the explicit allowlist below. No wildcards, no
 *     subdomain matching beyond an exact www. pairing.
 *   - No credentials, no local or private hosts.
 *   - Opening the link is always user initiated: this module only produces a
 *     validated href. Nothing here navigates, prefetches or auto-opens.
 *
 * This is a link to a provider's own public page. It is not a stream, not a
 * scrape and not a bypass of anything.
 */

const OFFICIAL_WATCH_HOSTS: readonly string[] = [
  'www.ufc.com',
  'ufc.com',
  'www.wwe.com',
  'wwe.com',
  'www.aew.com',
  'aew.com',
  'www.onefc.com',
  'onefc.com',
  'www.pflmma.com',
  'pflmma.com',
  'www.dazn.com',
  'dazn.com',
];

/*
 * Promotion -> the promotion's own public watch/events page. Keyed by the
 * promotion label inferPromotion already derives, so nothing new is parsed out
 * of provider free text.
 */
const OFFICIAL_WATCH_BY_PROMOTION: Readonly<Record<string, string>> = {
  UFC: 'https://www.ufc.com/events',
  WWE: 'https://www.wwe.com/superstars',
  AEW: 'https://www.aew.com/shows',
  ONE: 'https://www.onefc.com/events/',
  PFL: 'https://www.pflmma.com/watch',
  Boxing: 'https://www.dazn.com/',
};

const PRIVATE_IPV4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

export type PpvOfficialWatchDecision =
  | 'allowed'
  | 'empty'
  | 'malformed'
  | 'non_https'
  | 'credentials'
  | 'local_or_private'
  | 'host_not_allowlisted';

export interface PpvOfficialWatchInspection {
  allowed: boolean;
  reason: PpvOfficialWatchDecision;
  /* Hostname only - never the path or query. */
  hostname: string;
}

export function inspectOfficialWatchUrl(value: string): PpvOfficialWatchInspection {
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
  if (!host) return { allowed: false, reason: 'malformed', hostname: '' };
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    PRIVATE_IPV4.test(host)
  ) {
    return { allowed: false, reason: 'local_or_private', hostname: host };
  }
  if (!OFFICIAL_WATCH_HOSTS.includes(host)) {
    return { allowed: false, reason: 'host_not_allowlisted', hostname: host };
  }
  return { allowed: true, reason: 'allowed', hostname: host };
}

export function isAllowedOfficialWatchUrl(value: string): boolean {
  return inspectOfficialWatchUrl(value).allowed;
}

/*
 * Resolves the official destination for an event. A provider-supplied URL is
 * accepted only if it passes the same allowlist as a mapped one - being handed
 * a link by a third party is not a reason to trust it.
 */
export function officialWatchUrlFor(input: {
  promotion?: string;
  providedUrl?: string;
}): string | undefined {
  const provided = typeof input.providedUrl === 'string' ? input.providedUrl.trim() : '';
  if (provided && isAllowedOfficialWatchUrl(provided)) return provided;

  const promotion = typeof input.promotion === 'string' ? input.promotion.trim() : '';
  const mapped = promotion ? OFFICIAL_WATCH_BY_PROMOTION[promotion] : undefined;
  return mapped && isAllowedOfficialWatchUrl(mapped) ? mapped : undefined;
}

/* Exposed for tests and review; the map itself is the reviewed surface. */
export const PPV_OFFICIAL_WATCH_HOSTS = OFFICIAL_WATCH_HOSTS;
export const PPV_OFFICIAL_WATCH_BY_PROMOTION = OFFICIAL_WATCH_BY_PROMOTION;
