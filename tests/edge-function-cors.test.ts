import { describe, expect, it } from 'vitest';
import { allowedOrigin, corsHeaders } from '../supabase/functions/_shared/cors';
import checkoutSource from '../supabase/functions/create-checkout/index.ts?raw';
import portalSource from '../supabase/functions/create-billing-portal/index.ts?raw';
import sdkCorsSource from '../node_modules/@supabase/supabase-js/dist/cors.cjs?raw';

/*
 * The browser-only failure these cover.
 *
 * A preflight that is refused makes fetch reject rather than return a status,
 * and supabase-js reports that as FunctionsFetchError - "Failed to send a
 * request to the Edge Function" - with nothing in the function logs, because
 * the function never ran. curl cannot reproduce it: curl sends no preflight,
 * which is why an earlier probe of these same endpoints returned 401 and
 * looked healthy while every real browser call was being blocked.
 */

const PRODUCTION_ORIGIN = 'https://skullygxng.github.io';

/*
 * What a browser actually does with a preflight response, per Fetch: the
 * origin must be echoed exactly, the method must be listed, and every
 * requested header must appear in Access-Control-Allow-Headers. Header names
 * are case-insensitive.
 */
function preflight(origin: string, requestedHeaders: string[], method = 'POST') {
  const resolved = allowedOrigin(origin);
  if (!resolved) return { pass: false, reason: 'origin rejected', blocked: [] as string[] };

  const cors = corsHeaders(resolved);
  if (cors['Access-Control-Allow-Origin'] !== origin) {
    return { pass: false, reason: 'origin not echoed', blocked: [] as string[] };
  }

  const methods = (cors['Access-Control-Allow-Methods'] ?? '').split(',').map((m) => m.trim().toUpperCase());
  if (!methods.includes(method.toUpperCase())) return { pass: false, reason: 'method not allowed', blocked: [] };

  const allowed = (cors['Access-Control-Allow-Headers'] ?? '')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const blocked = requestedHeaders.map((h) => h.toLowerCase()).filter((h) => !allowed.includes(h));

  return { pass: blocked.length === 0, reason: blocked.length ? 'headers blocked' : 'ok', blocked };
}

/* Exactly what supabase-js 2.x sends for functions.invoke with a session. */
const SDK_REQUEST_HEADERS = ['apikey', 'authorization', 'content-type'];

describe('browser preflight against the production origin', () => {
  it('passes with the headers supabase-js actually sends', () => {
    const result = preflight(PRODUCTION_ORIGIN, SDK_REQUEST_HEADERS);
    expect(result.blocked).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it('allows apikey specifically - the header that was blocking every call', () => {
    expect(preflight(PRODUCTION_ORIGIN, ['apikey']).pass).toBe(true);
  });

  it('is case-insensitive about requested header names, as browsers are', () => {
    expect(preflight(PRODUCTION_ORIGIN, ['APIKey', 'Authorization', 'Content-Type']).pass).toBe(true);
  });

  it('permits the local dev origins too', () => {
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
      expect(preflight(origin, SDK_REQUEST_HEADERS).pass).toBe(true);
    }
  });
});

describe('the origin allowlist is unchanged by this fix', () => {
  it('still refuses an attacker origin outright', () => {
    const result = preflight('https://attacker.example', SDK_REQUEST_HEADERS);
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('origin rejected');
    /* And no CORS headers are emitted at all for it. */
    expect(corsHeaders(allowedOrigin('https://attacker.example'))).toEqual({});
  });

  it('refuses a lookalike origin', () => {
    for (const origin of [
      'https://skullygxng.github.io.attacker.example',
      'http://skullygxng.github.io',
      'https://evil.skullygxng.github.io',
    ]) {
      expect(allowedOrigin(origin)).toBeNull();
    }
  });

  it('never answers with a wildcard origin', () => {
    expect(corsHeaders(PRODUCTION_ORIGIN)['Access-Control-Allow-Origin']).toBe(PRODUCTION_ORIGIN);
    expect(corsHeaders(PRODUCTION_ORIGIN)['Access-Control-Allow-Origin']).not.toBe('*');
  });

  it('never answers with a wildcard header allowlist', () => {
    expect(corsHeaders(PRODUCTION_ORIGIN)['Access-Control-Allow-Headers']).not.toBe('*');
  });

  it('still varies on Origin so caches cannot share across origins', () => {
    expect(corsHeaders(PRODUCTION_ORIGIN).Vary).toBe('Origin');
  });
});

describe('the allowlist tracks the installed SDK', () => {
  /*
   * The Deno function cannot import @supabase/supabase-js/cors, so the list is
   * mirrored by hand. This reads the installed package's canonical set and
   * fails if the mirror stops covering it - an SDK upgrade that adds a header
   * breaks here rather than in a browser.
   */
  it('covers every header the installed @supabase/supabase-js/cors declares', () => {
    const match = /SUPABASE_HEADERS\s*=\s*\[([^\]]+)\]/.exec(sdkCorsSource);
    expect(match).not.toBeNull();

    const canonical = (match![1].match(/'[^']+'|"[^"]+"/g) ?? []).map((h) => h.replace(/['"]/g, '').toLowerCase());
    expect(canonical).toContain('apikey');

    const allowed = corsHeaders(PRODUCTION_ORIGIN)['Access-Control-Allow-Headers']
      .split(',').map((h) => h.trim().toLowerCase());

    expect(canonical.filter((h) => !allowed.includes(h))).toEqual([]);
  });
});

describe('authentication is untouched by the preflight change', () => {
  for (const [name, source] of [['create-checkout', checkoutSource], ['create-billing-portal', portalSource]] as const) {
    it(`${name} still rejects a disallowed origin before doing anything`, () => {
      expect(source).toContain("if (!origin) return new Response('Origin not allowed', { status: 403 });");
    });

    it(`${name} still requires a caller identity after the preflight`, () => {
      expect(source).toContain('authenticateRequest');
      expect(source).toMatch(/if \(!user\) return json\(\{ error: '[^']+' \}, 401, cors\)/);
    });

    it(`${name} answers the preflight without authenticating, and only for an allowed origin`, () => {
      /* OPTIONS carries no Authorization header - a browser never sends one on
         a preflight - so it must be answered before the auth check, but still
         gated on the origin. */
      const optionsBlock = source.slice(source.indexOf("request.method === 'OPTIONS'"));
      expect(optionsBlock.slice(0, 220)).toContain('status: 204');
      expect(optionsBlock.slice(0, 220)).toContain('status: 403');
      /* Compared against the call site, not the import at the top of the file. */
      expect(source.indexOf("request.method === 'OPTIONS'"))
        .toBeLessThan(source.indexOf('await authenticateRequest('));
    });
  }
});
