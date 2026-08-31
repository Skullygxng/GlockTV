/*
 * PPV poster policy.
 *
 * V1 policy: provider-controlled PPV poster images are not automatically
 * loaded. The event list uses a local fallback, so catalog functionality does
 * not depend on remote artwork.
 *
 * Why: a poster URL arrives verbatim from a third-party catalog response and
 * would end up in an <img src>, which the browser fetches on its own as soon
 * as the event list renders - before the viewer has chosen anything. That
 * makes the poster field a destination the *provider* picks for a request the
 * *viewer* makes.
 *
 * It is not enough to restrict this to a provider the app already talks to. A
 * catalog request and a poster request are not the same disclosure: the poster
 * additionally reveals per-card resource timing and exactly which image was
 * requested, which is a per-event signal the catalog fetch does not carry. So
 * no remote host is approved for automatic image loading, and the approved
 * list below is deliberately empty.
 *
 * The list is kept, rather than deleting the mechanism, so that approving a
 * host later is one reviewed line rather than a rewrite - and so that every
 * caller keeps going through a single decision point either way.
 *
 * This is a rendering policy, not a fetch. Nothing here requests anything, and
 * no proxy, relay or replacement image service is involved: a refused poster
 * is simply not rendered.
 */

/*
 * Hosts approved for automatic image loading. Empty in V1: no provider-
 * controlled poster is fetched. Adding an entry here is a deliberate,
 * reviewed privacy decision, not a convenience.
 */
export const PPV_POSTER_HOSTS: readonly string[] = [];

const PRIVATE_IPV4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

export type PpvPosterDecision =
  | 'accepted'
  | 'missing'
  | 'malformed'
  | 'non_https'
  | 'credentials'
  | 'local_or_private'
  | 'rejected_host';

export interface PpvPosterInspection {
  accepted: boolean;
  reason: PpvPosterDecision;
  /*
   * Hostname only, and '' when the value could not be parsed. The path and
   * query are never retained: a tracking URL carries its identifier there, and
   * copying it into diagnostics would leak exactly what this policy refuses to
   * request.
   */
  hostname: string;
}

export function inspectPpvPosterUrl(value: unknown): PpvPosterInspection {
  if (typeof value !== 'string' || !value.trim()) {
    return { accepted: false, reason: 'missing', hostname: '' };
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { accepted: false, reason: 'malformed', hostname: '' };
  }

  const host = url.hostname.toLowerCase();

  // https only, which also refuses javascript:, data:, blob: and http:.
  if (url.protocol !== 'https:') return { accepted: false, reason: 'non_https', hostname: host };
  if (url.username || url.password) {
    return { accepted: false, reason: 'credentials', hostname: host };
  }
  if (!host) return { accepted: false, reason: 'malformed', hostname: '' };
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    PRIVATE_IPV4.test(host)
  ) {
    return { accepted: false, reason: 'local_or_private', hostname: host };
  }
  if (!PPV_POSTER_HOSTS.includes(host)) {
    return { accepted: false, reason: 'rejected_host', hostname: host };
  }
  return { accepted: true, reason: 'accepted', hostname: host };
}

export function isAllowedPpvPosterUrl(value: unknown): boolean {
  return inspectPpvPosterUrl(value).accepted;
}

/*
 * The single gate every poster passes before it can reach an <img src>.
 * Returns undefined for anything refused - which in V1 is everything remote -
 * so a caller that forgets to check renders the local fallback rather than
 * making a request on the provider's behalf.
 */
export function safePpvPosterUrl(value: unknown): string | undefined {
  return isAllowedPpvPosterUrl(value) ? (value as string).trim() : undefined;
}
