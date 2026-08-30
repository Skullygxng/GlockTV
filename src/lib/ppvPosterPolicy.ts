/*
 * PPV poster policy.
 *
 * A poster URL arrives verbatim from a third-party catalog response and ends
 * up in an <img src>, which the browser fetches automatically as soon as the
 * event list renders - before the viewer has chosen anything. That makes the
 * poster field a destination the *provider* picks for a request the *viewer*
 * makes, disclosing IP address, user agent and request timing to whatever host
 * the provider names.
 *
 * So a poster is loaded only when it resolves to an image origin GlockTV has
 * deliberately approved. "It is https" is not the test: an arbitrary HTTPS
 * tracker is exactly the case this exists to stop.
 *
 * The approved list holds one entry, Streamed's own origin, and it is approved
 * for a specific reason: opening the PPV tab already issues the Streamed
 * catalog requests from the same browser, so streamed.pk has already seen this
 * viewer's IP, user agent and timing before any poster is rendered. Loading an
 * image from that same origin discloses nothing new. Every other host - which
 * is every host the provider could otherwise nominate - is refused, and the
 * card falls back to its local icon.
 *
 * This is a rendering policy, not a fetch. Nothing here requests anything, and
 * no proxy, relay or replacement image service is involved: a refused poster is
 * simply not rendered.
 */

export const PPV_POSTER_HOSTS: readonly string[] = ['streamed.pk'];

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
 * Returns undefined for anything refused, so a caller that forgets to check
 * renders the local fallback rather than a tracker.
 */
export function safePpvPosterUrl(value: unknown): string | undefined {
  return isAllowedPpvPosterUrl(value) ? (value as string).trim() : undefined;
}
