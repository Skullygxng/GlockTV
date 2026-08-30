/*
 * PPV provider abstractions.
 *
 * The feature is split into three independent layers:
 *
 *   catalog providers   answer "what events exist"
 *   playback providers  answer "how can this event be watched"
 *   the player          renders whatever sources it is handed
 *
 * They fail independently on purpose. A playback failure must never reduce the
 * event list to zero, a catalog failure must never destroy a catalog that
 * already loaded, and no single provider owns the feature: the entire PPV tab
 * went dark because one provider became unreachable cross-origin, and no layer
 * was able to carry on without it.
 */

import type { PpvCatalog, PpvEvent, PpvPlaybackSource } from './ppv';
import { inspectPpvEmbedUrl } from './ppvEmbedPolicy';
import { inspectAuthorizedEmbedUrl } from './ppvAuthorizedEmbeds';
import {
  emptyProviderDiagnostics,
  type PpvCatalogProviderDiagnostics,
  type PpvCatalogProviderId,
  type PpvPlaybackProviderId,
  type PpvProviderDiagnostics,
} from './ppvDiagnostics';

export type PpvFetchLike = typeof fetch;

export interface PpvCatalogProviderResult {
  /* Already normalized into PpvEvent and already combat-only. */
  events: PpvEvent[];
  diagnostics: PpvCatalogProviderDiagnostics;
}

export interface PpvCatalogProvider {
  id: PpvCatalogProviderId;
  /* Shown in diagnostics and in the provenance line. Never a URL. */
  label: string;
  /*
   * Must resolve, never reject. A provider that cannot answer reports its
   * failure in diagnostics and returns no events, so the aggregator can keep
   * going with whatever else answered.
   */
  load(request: PpvFetchLike, now?: number): Promise<PpvCatalogProviderResult>;
}

export interface PpvPlaybackResolution {
  sources: PpvPlaybackSource[];
  diagnostics: PpvProviderDiagnostics;
}

export interface PpvPlaybackProvider {
  id: PpvPlaybackProviderId;
  label: string;
  /*
   * Whether this provider has anything to work with for the event. A provider
   * that is not supported is not requested, and a skipped lookup is reported
   * as skipped - never as a provider failure.
   */
  supports(event: PpvEvent): boolean;
  /* Must resolve, never reject. */
  resolve(event: PpvEvent, request: PpvFetchLike): Promise<PpvPlaybackResolution>;
}

export function skippedPlaybackDiagnostics(
  id: PpvPlaybackProviderId,
  reason: 'not_attempted_unmapped' | 'not_attempted_unsupported',
): PpvProviderDiagnostics {
  const diagnostics = emptyProviderDiagnostics(id, id);
  diagnostics.lookupState = reason;
  diagnostics.providerNativeIdentityAvailable = false;
  return diagnostics;
}

/*
 * Wraps a provider so a thrown error becomes a reported failure instead of
 * taking the aggregate down. Providers are third-party code paths; one of them
 * throwing is exactly the case this architecture exists to survive.
 */
export async function settleCatalogProvider(
  provider: PpvCatalogProvider,
  request: PpvFetchLike,
  now: number,
  fallback: PpvCatalogProviderDiagnostics,
): Promise<PpvCatalogProviderResult> {
  try {
    return await provider.load(request, now);
  } catch {
    return { events: [], diagnostics: { ...fallback, status: 'network_or_cors_error' } };
  }
}

export async function settlePlaybackProvider(
  provider: PpvPlaybackProvider,
  event: PpvEvent,
  request: PpvFetchLike,
): Promise<PpvPlaybackResolution> {
  try {
    return await provider.resolve(event, request);
  } catch {
    const diagnostics = emptyProviderDiagnostics(provider.id, provider.id);
    diagnostics.lookupState = 'attempted';
    diagnostics.requestCount = 1;
    diagnostics.networkErrorCount = 1;
    return { sources: [], diagnostics };
  }
}

/* Convenience for callers that only need the events of a loaded catalog. */
export function ppvCatalogEventCount(catalog: PpvCatalog | null | undefined): number {
  return catalog?.events.length ?? 0;
}

/*
 * The single gate every source passes before it can be framed, whichever
 * resolver produced it. Each kind keeps its own allowlist: a hosted stream
 * provider cannot reach the authorized-platform hosts by relabelling itself,
 * and an authorized adapter cannot reach the hosted-embed hosts.
 */
export function inspectPpvPlaybackSource(source: PpvPlaybackSource): {
  allowed: boolean;
  reason: string;
  hostname: string;
} {
  return source.kind === 'authorized_embed'
    ? inspectAuthorizedEmbedUrl(source.url)
    : inspectPpvEmbedUrl(source.url);
}

export function isPlayablePpvSource(source: PpvPlaybackSource): boolean {
  return inspectPpvPlaybackSource(source).allowed;
}

/* Provider order, deduped on first occurrence. No quality ranking by name. */
export function mergePpvPlaybackSources(sources: PpvPlaybackSource[]): PpvPlaybackSource[] {
  const seen = new Set<string>();
  const next: PpvPlaybackSource[] = [];
  for (const source of sources) {
    if (!isPlayablePpvSource(source)) continue;
    const key = source.url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(source);
  }
  return next;
}
