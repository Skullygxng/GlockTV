import { describe, expect, it } from 'vitest';
import {
  AD_PLACEMENTS,
  adFrameDocument,
  adsPermitted,
  isAllowedAdScriptUrl,
  isAllowedZoneId,
  parseAdConfig,
  shouldRenderAds,
  type AdConfig,
} from '../src/lib/ads';
import { FREE_ENTITLEMENTS, shouldShowAds, type Entitlements } from '../src/lib/account';

const PREMIUM: Entitlements = { tier: 'premium', adsEnabled: false };
const config: AdConfig = {
  provider: 'hilltopads',
  scriptUrl: 'https://ads.example.com/zone/abc.js',
  zones: { 'context-rail': 'zone_123' },
};

describe('who may be shown ads', () => {
  it('is the account layer\'s answer, not a second one', () => {
    /* One definition of "Premium means no ads" in the codebase. If these ever
       disagree, an ad policy has been restated somewhere it should not be. */
    for (const entitlements of [PREMIUM, FREE_ENTITLEMENTS, null, undefined]) {
      expect(adsPermitted(entitlements)).toBe(shouldShowAds(entitlements));
    }
  });

  it('fails closed on an entitlement it could not learn', () => {
    expect(adsPermitted(null)).toBe(true);
    expect(adsPermitted(undefined)).toBe(true);
    expect(adsPermitted(FREE_ENTITLEMENTS)).toBe(true);
    expect(adsPermitted(PREMIUM)).toBe(false);
  });
});

describe('when an ad may actually execute', () => {
  it('waits for the account to settle, even though policy already permits it', () => {
    /*
     * The distinction this module exists for. Security says an unresolved
     * account is free and may see ads; UX says do not run a third party's
     * script before we know, or a Premium member gets a flash of the thing
     * they paid to remove on every load.
     */
    expect(adsPermitted(null)).toBe(true);
    expect(shouldRenderAds({ entitlements: null, ready: false, config })).toBe(false);
    expect(shouldRenderAds({ entitlements: null, ready: true, config })).toBe(true);
  });

  it('never renders for a resolved Premium member', () => {
    expect(shouldRenderAds({ entitlements: PREMIUM, ready: true, config })).toBe(false);
    expect(shouldRenderAds({ entitlements: PREMIUM, ready: false, config })).toBe(false);
  });

  it('renders nothing when no network is configured', () => {
    expect(shouldRenderAds({ entitlements: FREE_ENTITLEMENTS, ready: true, config: null })).toBe(false);
  });
});

describe('the configured script is treated as input', () => {
  it('accepts an ordinary https snippet URL', () => {
    expect(isAllowedAdScriptUrl('https://ads.example.com/zone/abc.js')).toBe(true);
  });

  it('refuses anything that would turn configuration into arbitrary code', () => {
    for (const value of [
      'javascript:alert(1)',
      'data:text/javascript,alert(1)',
      'blob:https://ads.example.com/abc',
      /* Executed code must not be interceptable. */
      'http://ads.example.com/zone/abc.js',
      /* Credentials in a script URL are never legitimate. */
      'https://user:pass@ads.example.com/abc.js',
      /* Not a host. */
      'https://localhost/abc.js',
      'not a url',
      '',
    ]) {
      expect(isAllowedAdScriptUrl(value)).toBe(false);
    }
  });

  it('constrains a zone id to something that cannot carry markup', () => {
    expect(isAllowedZoneId('zone_123')).toBe(true);
    expect(isAllowedZoneId('a-b-C-9')).toBe(true);
    for (const value of ['', '"><script>x</script>', 'a b', 'a/b', "a'b", 'x'.repeat(65)]) {
      expect(isAllowedZoneId(value)).toBe(false);
    }
  });
});

describe('reading the configuration', () => {
  it('is silent and complete when nothing is set', () => {
    /* An unconfigured build is a supported state, not a broken one. */
    expect(parseAdConfig({})).toBeNull();
    expect(parseAdConfig({ VITE_ADS_ZONE_CONTEXT_RAIL: 'zone_1' })).toBeNull();
  });

  it('refuses a configuration it cannot trust rather than half-loading it', () => {
    expect(parseAdConfig({ VITE_ADS_SCRIPT_URL: 'http://ads.example.com/a.js' })).toBeNull();
    expect(parseAdConfig({ VITE_ADS_SCRIPT_URL: 'javascript:alert(1)' })).toBeNull();
  });

  it('drops a malformed zone without dropping the network', () => {
    const parsed = parseAdConfig({
      VITE_ADS_SCRIPT_URL: 'https://ads.example.com/a.js',
      VITE_ADS_ZONE_CONTEXT_RAIL: '"><img src=x>',
      VITE_ADS_ZONE_DETAILS_PANEL: 'zone_ok',
    })!;
    expect(parsed.zones['context-rail']).toBeUndefined();
    expect(parsed.zones['details-panel']).toBe('zone_ok');
  });

  it('invents no identifier of its own', () => {
    /* Nothing in this repository may carry a real zone id or a real script
       host. Both come from the publisher dashboard, and a plausible-looking
       default would either fail silently or load something nobody chose. */
    const parsed = parseAdConfig({ VITE_ADS_SCRIPT_URL: 'https://ads.example.com/a.js' })!;
    expect(parsed.zones).toEqual({});
  });
});

describe('the document an ad runs in', () => {
  const document = adFrameDocument(config, 'context-rail');

  it('carries the configured script and nothing else executable', () => {
    expect(document).toContain('src="https://ads.example.com/zone/abc.js"');
    /* One script element, and it is the configured one - no inline code. */
    expect(document.match(/<script/g)).toHaveLength(1);
    expect(document).not.toMatch(/<script(?![^>]*\bsrc=)/);
  });

  it('is given no account identifier to leak', () => {
    /*
     * The privacy claim, asserted against the actual document rather than
     * against intent. There is nowhere for these to come from - the caller
     * takes only a config and a placement - and this fails if that ever
     * changes.
     */
    for (const forbidden of ['email', 'user_id', 'userId', 'auth', 'token', 'access_token', 'customer', 'subscription', 'room', 'supabase']) {
      expect(document.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('asks for no referrer, so the network is not handed the page URL', () => {
    expect(document).toContain('name="referrer" content="no-referrer"');
    expect(document).toContain('referrerpolicy="no-referrer"');
  });

  it('paints the panel colour, so an unfilled slot is not a white rectangle', () => {
    /*
     * A frame paints its own canvas and an empty one is white. On a black
     * product that is a glaring hole in the page every time the network has
     * nothing to serve, which on low fill is most of the time. This cannot be
     * solved by hiding the slot: the frame is null-origin by design, so nothing
     * outside it can ask whether an ad rendered.
     */
    expect(document).toContain('background:#0b0b10');
    expect(document).not.toContain('background:transparent');
    expect(document).toContain('content="dark"');
  });

  it('sizes itself to the placement rather than growing', () => {
    const size = AD_PLACEMENTS['context-rail'];
    expect(document).toContain(`width:${size.width}px`);
    expect(document).toContain(`height:${size.height}px`);
    expect(document).toContain('overflow:hidden');
  });

  it('works without a zone, for a publisher running one zone per site', () => {
    const withoutZone = adFrameDocument({ ...config, zones: {} }, 'details-panel');
    expect(withoutZone).toContain('src="https://ads.example.com/zone/abc.js"');
    expect(withoutZone).not.toContain('data-zone');
  });
});

describe('placements stay away from the product', () => {
  it('are only the two surfaces with room to spare', () => {
    expect(Object.keys(AD_PLACEMENTS).sort()).toEqual(['context-rail', 'details-panel']);
  });
});
