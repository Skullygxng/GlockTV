/*
 * The advertising boundary.
 *
 * Pure - no React, no network, no provider SDK - so the two decisions that
 * matter can be read and tested on their own:
 *
 *   1. Is this account permitted to be shown ads?
 *   2. Is it yet time to execute a third party's script?
 *
 * Those are deliberately not the same question, and collapsing them is the bug
 * this module exists to prevent. The first fails closed: an account whose tier
 * we could not learn is treated as free, because the alternative is giving away
 * ad-free GlockTV to every request that fails. The second waits: rendering an
 * ad while entitlements are still loading would flash an ad at a confirmed
 * Premium member during ordinary start-up - correct by the first rule, and
 * exactly what they paid not to see.
 */

import { shouldShowAds, type Entitlements } from './account';

/* Where an ad may appear. Deliberately short, and deliberately nowhere near
   the player or the navigation. */
export type AdPlacementId = 'context-rail' | 'details-panel';

export const AD_PLACEMENTS: Record<AdPlacementId, { width: number; height: number; label: string }> = {
  /* The desktop context column. Already hidden below 980px by the layout, so
     this placement is desktop-only without needing to know that itself. */
  'context-rail': { width: 300, height: 250, label: 'Sponsored' },
  /* Inside the title details overlay, below the actions. Present on both
     platforms and the one surface with natural vertical room to spare. */
  'details-panel': { width: 300, height: 250, label: 'Sponsored' },
};

export interface AdConfig {
  /* Which network. One today; named so a second does not have to be threaded
     through every call site. */
  provider: 'hilltopads';
  /*
   * The per-zone script the publisher dashboard generates. There is no
   * hard-coded URL anywhere in this repository on purpose: the snippet is
   * account-specific, and inventing a plausible one would be a guess that
   * either silently fails or loads something nobody chose.
   */
  scriptUrl: string;
  /* Optional per-placement zone override, when a publisher runs one zone per
     slot rather than one for the site. */
  zones: Partial<Record<AdPlacementId, string>>;
}

/*
 * What a configured script URL must satisfy before anything will load it.
 *
 * The ad script is the one piece of third-party code GlockTV executes, so the
 * value that names it is treated as input rather than as trusted configuration:
 * a typo, a copied-wrong snippet or any future path where this string is not
 * purely build-time should fail to load rather than fetch something arbitrary.
 */
export function isAllowedAdScriptUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  /* https only: an ad script is executed, so it must not be interceptable.
     This also excludes javascript:, data: and blob:, each of which would turn
     a configuration string into arbitrary inline code. */
  if (url.protocol !== 'https:') return false;
  /* Credentials in a script URL are never legitimate here. */
  if (url.username || url.password) return false;
  if (!url.hostname.includes('.')) return false;
  return true;
}

/* Zone identifiers are public publisher ids, not secrets - but they are
   interpolated into a document, so they are constrained to a shape that cannot
   carry markup. */
export function isAllowedZoneId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

type EnvRecord = Record<string, string | undefined>;

/*
 * Read the configuration, or decide there is none.
 *
 * Null is a supported, silent state: no ad network configured means no slots,
 * no placeholders and no empty boxes. Development and CI run this way, and so
 * does production until somebody sets the values.
 */
export function parseAdConfig(env: EnvRecord): AdConfig | null {
  const scriptUrl = env.VITE_ADS_SCRIPT_URL?.trim();
  if (!scriptUrl || !isAllowedAdScriptUrl(scriptUrl)) return null;

  const zones: Partial<Record<AdPlacementId, string>> = {};
  const candidates: Array<[AdPlacementId, string | undefined]> = [
    ['context-rail', env.VITE_ADS_ZONE_CONTEXT_RAIL],
    ['details-panel', env.VITE_ADS_ZONE_DETAILS_PANEL],
  ];
  for (const [placement, raw] of candidates) {
    const zone = raw?.trim();
    if (zone && isAllowedZoneId(zone)) zones[placement] = zone;
  }

  return { provider: 'hilltopads', scriptUrl, zones };
}

/*
 * Rule 1, fail closed.
 *
 * Delegates to the account layer rather than restating it, so there is one
 * definition of "Premium means no ads" in the codebase and one place to audit.
 */
export function adsPermitted(entitlements: Entitlements | null | undefined): boolean {
  return shouldShowAds(entitlements);
}

/*
 * Rule 2, the rendering moment.
 *
 * `ready` is the account layer reporting that its first load has settled,
 * however it settled. Waiting for it is not a security condition - an
 * unresolved account is still treated as free - it is the difference between a
 * member seeing an ad for 300ms on every page load and never seeing one.
 *
 * A failed lookup settles too, and settles to free. That is the documented
 * trade: a member whose entitlement request failed is shown ads, because the
 * reverse gives away Premium on every transient error.
 */
export function shouldRenderAds(input: {
  entitlements: Entitlements | null | undefined;
  ready: boolean;
  config: AdConfig | null;
}): boolean {
  if (!input.config) return false;
  if (!input.ready) return false;
  return adsPermitted(input.entitlements);
}

/*
 * The document an ad slot runs.
 *
 * It is built for a sandboxed, null-origin iframe, which is what makes the
 * privacy claims structural rather than a promise:
 *
 *   - the ad script cannot read this site's localStorage or its Supabase
 *     session, because it is not running on this origin;
 *   - it is passed no account identifier, email, customer id or room code -
 *     only a zone id, and the caller has none of those to give it;
 *   - without allow-popups and allow-top-navigation in the sandbox, a popunder
 *     or a forced redirect cannot execute even if the network serves one.
 *
 * The last point is why the zone chosen in the dashboard still matters: a
 * format that depends on opening a window will render nothing here rather than
 * hijacking the page. That is the intended failure direction.
 */
export function adFrameDocument(config: AdConfig, placement: AdPlacementId): string {
  const zone = config.zones[placement];
  const size = AD_PLACEMENTS[placement];
  /* Neither value reaches here unvalidated - parseAdConfig rejects a script URL
     that is not https and a zone id that is not [A-Za-z0-9_-]. Encoding again
     is belt and braces for a future caller that builds a config by hand. */
  const src = encodeURI(config.scriptUrl);
  const zoneAttribute = zone ? `<div id="${encodeURIComponent(zone)}" data-zone="${encodeURIComponent(zone)}"></div>` : '';

  /*
   * The frame paints its own canvas, and an empty one is white.
   *
   * On a black product that is a glaring rectangle every time the network has
   * nothing to serve - which is most of the time on low fill. Painting the
   * panel colour inside the frame means an unfilled slot reads as a dark
   * surface rather than a hole in the page. It cannot be hidden outright: the
   * frame is null-origin by design, so nothing here can ask whether an ad
   * actually rendered.
   */
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="color-scheme" content="dark">',
    `<style>html,body{margin:0;padding:0;overflow:hidden;background:#0b0b10;color-scheme:dark;width:${size.width}px;height:${size.height}px}</style>`,
    '</head><body>',
    zoneAttribute,
    `<script src="${src}" async referrerpolicy="no-referrer"><\/script>`,
    '</body></html>',
  ].join('');
}
