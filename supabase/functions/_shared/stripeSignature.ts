/*
 * Stripe webhook signature verification, on Web Crypto only, so the same code
 * runs in Deno on the edge and under the test runner.
 *
 * Stripe signs `${timestamp}.${rawBody}` with the endpoint secret. The raw
 * body matters: parsing and re-serializing JSON changes bytes and the
 * signature will not match, so callers must pass the body exactly as received.
 */

export interface SignatureVerification {
  ok: boolean;
  reason?: 'missing_header' | 'malformed_header' | 'timestamp_out_of_tolerance' | 'no_match';
}

/* Stripe's own default. An old capture cannot be replayed indefinitely. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

interface ParsedHeader {
  timestamp: number;
  signatures: string[];
}

function parseSignatureHeader(header: string): ParsedHeader | null {
  let timestamp = NaN;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === 't') timestamp = Number(value);
    // v1 is the current scheme. Other versions are ignored rather than
    // accepted, so a downgrade to a scheme we do not verify cannot pass.
    else if (key === 'v1' && value) signatures.push(value);
  }

  if (!Number.isFinite(timestamp) || !signatures.length) return null;
  return { timestamp, signatures };
}

/* Length-independent, value-independent comparison. */
function constantTimeEquals(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return diff === 0;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function verifyStripeSignature({
  rawBody,
  signatureHeader,
  secret,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  now = new Date(),
}: {
  rawBody: string;
  signatureHeader: string | null | undefined;
  secret: string;
  toleranceSeconds?: number;
  now?: Date;
}): Promise<SignatureVerification> {
  if (!signatureHeader) return { ok: false, reason: 'missing_header' };

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return { ok: false, reason: 'malformed_header' };

  const age = Math.abs(Math.floor(now.getTime() / 1000) - parsed.timestamp);
  if (age > toleranceSeconds) return { ok: false, reason: 'timestamp_out_of_tolerance' };

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`${parsed.timestamp}.${rawBody}`));
  const expected = toHex(digest);

  const matched = parsed.signatures.some((candidate) => constantTimeEquals(candidate, expected));
  return matched ? { ok: true } : { ok: false, reason: 'no_match' };
}

/* Produces a header the verifier accepts. Test fixtures only - it takes the
   same secret the verifier does, so it proves nothing on its own. */
export async function signStripePayload({
  rawBody,
  secret,
  timestamp,
}: {
  rawBody: string;
  secret: string;
  timestamp: number;
}): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`));
  return `t=${timestamp},v1=${toHex(digest)}`;
}
