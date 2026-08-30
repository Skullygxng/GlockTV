/*
 * Official destinations, in two strictly separate kinds.
 *
 * Zero inline playback sources is not an error. Most fight cards are simply
 * not available as a hosted embed, and telling the viewer "Embed unavailable"
 * for a card that is on sale right now is both wrong and useless. But the
 * opposite mistake is just as bad: calling a promotion's roster page or events
 * listing a place to *watch* overclaims what the link is.
 *
 *   officialWatchUrl - somewhere the source explicitly identifies as a place
 *                      to watch this event. Nothing is mapped here: no
 *                      configured provider tells us where an event can be
 *                      watched, so today this only ever comes from a provider
 *                      that says so, and it still has to pass the allowlist.
 *
 *   officialInfoUrl  - the promotion's own public page for finding out about
 *                      the event. An events listing, a shows page or a
 *                      promotion home page is information, not a broadcast.
 *
 * Rules, all enforced here rather than at call sites, and identical for both
 * kinds:
 *   - HTTPS only.
 *   - Host must be on the explicit allowlist below. No wildcards, no
 *     subdomain matching beyond an exact www. pairing.
 *   - No credentials, no local or private hosts.
 *   - Opening the link is always user initiated: this module only produces a
 *     validated href. Nothing here navigates, prefetches or auto-opens.
 *
 * These are links to a provider's own public pages. They are not streams, not
 * scrapes, and not a bypass of anything. No territorial broadcast rights are
 * guessed at, and no undocumented stream URL is hardcoded.
 */

const OFFICIAL_HOSTS: readonly string[] = [
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
 * Promotion -> the promotion's own public page. Keyed by the promotion label
 * inferPromotion already derives, so nothing new is parsed out of provider
 * free text.
 *
 * Every entry here is an INFORMATION destination. None of them is evidence
 * that a particular event can be watched there, which is exactly why none of
 * them may become an officialWatchUrl.
 */
const OFFICIAL_INFO_BY_PROMOTION: Readonly<Record<string, string>> = {
  UFC: 'https://www.ufc.com/events',
  WWE: 'https://www.wwe.com/',
  AEW: 'https://www.aew.com/',
  ONE: 'https://www.onefc.com/events/',
  PFL: 'https://www.pflmma.com/',
  Boxing: 'https://www.dazn.com/',
};

const PRIVATE_IPV4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

export type PpvOfficialDecision =
  | 'allowed'
  | 'empty'
  | 'malformed'
  | 'non_https'
  | 'credentials'
  | 'local_or_private'
  | 'host_not_allowlisted';

export interface PpvOfficialInspection {
  allowed: boolean;
  reason: PpvOfficialDecision;
  /* Hostname only - never the path or query. */
  hostname: string;
}

export function inspectOfficialUrl(value: string): PpvOfficialInspection {
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
  if (!OFFICIAL_HOSTS.includes(host)) {
    return { allowed: false, reason: 'host_not_allowlisted', hostname: host };
  }
  return { allowed: true, reason: 'allowed', hostname: host };
}

export function isAllowedOfficialUrl(value: string): boolean {
  return inspectOfficialUrl(value).allowed;
}

/*
 * A watch destination only ever comes from a provider that explicitly says the
 * event can be watched there, and it still has to pass the allowlist. There is
 * deliberately no promotion mapping: knowing an event is a UFC event tells us
 * nothing about where it can be watched, and pretending otherwise is what this
 * split exists to prevent.
 */
export function officialWatchUrlFor(input: { providedWatchUrl?: string }): string | undefined {
  const provided = typeof input.providedWatchUrl === 'string' ? input.providedWatchUrl.trim() : '';
  return provided && isAllowedOfficialUrl(provided) ? provided : undefined;
}

/*
 * An information destination may come from the promotion mapping or from a
 * provider, and either way passes the same allowlist - being handed a link by
 * a third party is not a reason to trust it.
 */
export function officialInfoUrlFor(input: {
  promotion?: string;
  providedInfoUrl?: string;
}): string | undefined {
  const provided = typeof input.providedInfoUrl === 'string' ? input.providedInfoUrl.trim() : '';
  if (provided && isAllowedOfficialUrl(provided)) return provided;

  const promotion = typeof input.promotion === 'string' ? input.promotion.trim() : '';
  const mapped = promotion ? OFFICIAL_INFO_BY_PROMOTION[promotion] : undefined;
  return mapped && isAllowedOfficialUrl(mapped) ? mapped : undefined;
}

/* Exposed for tests and review; the map itself is the reviewed surface. */
export const PPV_OFFICIAL_HOSTS = OFFICIAL_HOSTS;
export const PPV_OFFICIAL_INFO_BY_PROMOTION = OFFICIAL_INFO_BY_PROMOTION;
