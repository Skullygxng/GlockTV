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

export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    /* The response body differs per origin, so caches must not share it. */
    Vary: 'Origin',
  };
}
