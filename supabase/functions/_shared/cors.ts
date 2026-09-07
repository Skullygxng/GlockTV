/*
 * Origin policy for the browser-callable billing functions.
 *
 * These endpoints act on the caller's authenticated identity, so the origin
 * allowlist is exact. Reflecting whatever Origin arrives would let any page a
 * signed-in member visits start a checkout or open their billing portal.
 *
 * The webhook has no browser caller and gets none of this.
 */

const ALLOWED_ORIGINS = [
  'https://skullygxng.github.io',
  /* Vite dev server, for local development against a test-mode project. */
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

export function allowedOrigin(origin: string | null | undefined, extra: string[] = []): string | null {
  if (!origin) return null;
  const allowed = [...ALLOWED_ORIGINS, ...extra.filter(Boolean)];
  return allowed.includes(origin) ? origin : null;
}

/*
 * Every header @supabase/supabase-js puts on a browser request.
 *
 * A preflight fails outright if the response omits one of these, and the
 * failure is a rejected fetch rather than an HTTP status - which surfaces as
 * "Failed to send a request to the Edge Function" with nothing in the function
 * logs, because the function never ran.
 *
 * apikey is the one that was missing. The SDK sets it unconditionally on every
 * request (index.cjs: `if (!headers.has("apikey")) headers.set("apikey", ...)`),
 * so every browser call was blocked before it reached the origin check, let
 * alone authentication. curl never showed it: curl sends no preflight.
 *
 * This mirrors the canonical list the SDK ships at @supabase/supabase-js/cors,
 * which cannot be imported here - this module runs in Deno, where that package
 * does not exist. A test reads the installed package's list and fails if this
 * one stops covering it, so an SDK upgrade that adds a header is caught before
 * it reaches a browser.
 *
 * Listing a header only permits it; it requires nothing and grants no
 * authority. apikey carries the publishable key, which already ships in the
 * browser bundle.
 */
const SUPABASE_BROWSER_HEADERS = 'authorization, x-client-info, apikey, content-type, x-retry-count';

export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};
  return {
    /* Still the exact caller's origin, never a wildcard. */
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': SUPABASE_BROWSER_HEADERS,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    /* The response body differs per origin, so caches must not share it. */
    Vary: 'Origin',
  };
}
