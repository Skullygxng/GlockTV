import { useMemo } from 'react';
import { useAccount } from './AccountProvider';
import {
  AD_PLACEMENTS,
  adFrameDocument,
  parseAdConfig,
  shouldRenderAds,
  type AdConfig,
  type AdPlacementId,
} from '../lib/ads';
import '../ads.css';

/*
 * One advertising placement.
 *
 * The whole component is a decision and an iframe. There is no provider SDK,
 * no global script on the page, and nothing to tear down when somebody's tier
 * changes - React unmounting the frame is the teardown, and it takes the ad
 * script's execution context with it.
 *
 * Note what a Premium member's browser does here: it renders null. Not a
 * hidden div, not a loaded-then-hidden network - the script is never fetched,
 * because the element that would fetch it does not exist.
 */

/* Read once. import.meta.env is build-time, so re-parsing per render would be
   work with no possible change of answer. */
let cached: AdConfig | null | undefined;
function defaultConfig(): AdConfig | null {
  if (cached === undefined) cached = parseAdConfig(import.meta.env as Record<string, string | undefined>);
  return cached;
}

export interface AdSlotProps {
  placement: AdPlacementId;
  /* Omit for the app's own configuration; pass null to force the slot off. */
  config?: AdConfig | null;
}

export function AdSlot({ placement, config: providedConfig }: AdSlotProps) {
  const { entitlements, ready } = useAccount();
  const config = providedConfig === undefined ? defaultConfig() : providedConfig;

  const render = shouldRenderAds({ entitlements, ready, config });

  /*
   * Built only when it will be used. Composing the document for a Premium
   * member would be harmless but pointless, and keeping it inside the guard
   * makes it obvious that nothing about the ad network is touched on their
   * path through this component.
   */
  const document = useMemo(
    () => (render && config ? adFrameDocument(config, placement) : null),
    [render, config, placement],
  );

  /*
   * Nothing at all rather than an empty frame. An unconfigured build, a
   * Premium member and an account still loading all land here, and in every
   * one of those cases a bordered placeholder would be worse than absence.
   */
  if (!document) return null;

  const size = AD_PLACEMENTS[placement];
  return (
    <aside className={`ad-slot ad-slot--${placement}`} aria-label={size.label}>
      <small>{size.label}</small>
      <iframe
        title={`${size.label} ${placement}`}
        width={size.width}
        height={size.height}
        srcDoc={document}
        loading="lazy"
        /*
         * allow-scripts and nothing else. No allow-same-origin, so the frame
         * has a null origin and cannot reach this site's storage or session;
         * no allow-popups or allow-top-navigation, so a popunder or a forced
         * redirect cannot run even if the network serves one.
         */
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        scrolling="no"
      />
    </aside>
  );
}
