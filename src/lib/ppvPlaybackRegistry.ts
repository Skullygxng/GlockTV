/*
 * PPV playback provider registry.
 *
 * The player asks the registry for sources and renders whatever comes back. It
 * does not know which resolver produced any entry, and no resolver is required
 * for the feature to work: an event with zero sources is still a complete
 * event, and the panel says so rather than reporting an error.
 *
 * Providers are consulted concurrently and each is bounded on its own. One
 * provider hanging, failing or being unsupported never discards the sources
 * another already returned.
 */

import {
  loadSportSrcEmbeds,
  loadStreamedEmbeds,
  type PpvEmbed,
  type PpvEvent,
  type PpvPlaybackSource,
} from './ppv';
import {
  emptyEventDiagnostics,
  emptyProviderDiagnostics,
  type PpvEventDiagnostics,
  type PpvProviderDiagnostics,
} from './ppvDiagnostics';
import {
  mergePpvPlaybackSources,
  settlePlaybackProvider,
  skippedPlaybackDiagnostics,
  type PpvFetchLike,
  type PpvPlaybackProvider,
  type PpvPlaybackResolution,
} from './ppvProviders';
import {
  currentTwitchParent,
  twitchChannelFrom,
  twitchEmbedUrl,
  youtubeEmbedUrl,
  youtubeVideoIdFrom,
} from './ppvAuthorizedEmbeds';

function labelFor(parts: Array<string | undefined | false>): string {
  return parts.filter(Boolean).join(' · ');
}

const PROVIDER_LABELS: Record<string, string> = {
  streamed: 'Streamed',
  sportsrc: 'SportSRC',
  youtube: 'YouTube',
  twitch: 'Twitch',
  thesportsdb: 'TheSportsDB',
};

/*
 * Adapts a raw provider embed row into the normalized shape the player reads.
 * Exported because inline embeds already carried on an event go through the
 * same normalization - the player must never special-case where a source came
 * from.
 */
export function ppvEmbedToPlaybackSource(embed: PpvEmbed): PpvPlaybackSource {
  return embedToSource(embed, PROVIDER_LABELS[embed.provider] ?? embed.provider);
}

function embedToSource(embed: PpvEmbed, providerLabel: string): PpvPlaybackSource {
  return {
    providerId: embed.provider,
    label: labelFor([providerLabel, embed.source, embed.hd ? 'HD' : '', embed.language]),
    kind: 'hosted_embed',
    url: embed.url,
    sourceName: embed.source,
    language: embed.language,
    hd: embed.hd,
  };
}

export const streamedPlaybackProvider: PpvPlaybackProvider = {
  id: 'streamed',
  label: 'Streamed',
  supports: (event) => event.sourceRefs.length > 0,
  async resolve(event, request): Promise<PpvPlaybackResolution> {
    const diagnostics = emptyProviderDiagnostics('streamed', 'streamed');
    if (!event.sourceRefs.length) {
      return { sources: [], diagnostics: skippedPlaybackDiagnostics('streamed', 'not_attempted_unmapped') };
    }
    diagnostics.lookupState = 'attempted';
    diagnostics.providerNativeIdentityAvailable = true;
    const embeds = await loadStreamedEmbeds(event, request, diagnostics);
    return { sources: embeds.map((embed) => embedToSource(embed, 'Streamed')), diagnostics };
  },
};

export const sportsrcPlaybackProvider: PpvPlaybackProvider = {
  id: 'sportsrc',
  label: 'SportSRC',
  supports: (event) => Boolean(event.providerRefs?.sportsrc?.eventId),
  async resolve(event, request): Promise<PpvPlaybackResolution> {
    const diagnostics = emptyProviderDiagnostics('sportsrc', 'sportsrc');
    const embeds = await loadSportSrcEmbeds(event, request, diagnostics);
    return { sources: embeds.map((embed) => embedToSource(embed, 'SportSRC')), diagnostics };
  },
};

/*
 * YouTube. Resolves only from a video identifier a catalog provider supplied in
 * a documented field, into YouTube's own documented embed URL. Nothing is
 * requested here: the platform's player decides whether the video is
 * embeddable, and we have no way to see inside a cross-origin frame, so no
 * embeddability claim is recorded either way.
 */
export const youtubePlaybackProvider: PpvPlaybackProvider = {
  id: 'youtube',
  label: 'YouTube',
  supports: (event) => Boolean(youtubeVideoIdFrom(event.providerRefs?.youtube?.videoId)),
  async resolve(event): Promise<PpvPlaybackResolution> {
    const videoId = youtubeVideoIdFrom(event.providerRefs?.youtube?.videoId);
    if (!videoId) {
      return {
        sources: [],
        diagnostics: skippedPlaybackDiagnostics('youtube', 'not_attempted_unmapped'),
      };
    }
    const url = youtubeEmbedUrl(videoId);
    const diagnostics = emptyProviderDiagnostics('youtube', 'youtube');
    diagnostics.lookupState = 'attempted';
    diagnostics.providerNativeIdentityAvailable = true;
    /* No network request: the identifier is already the answer. */
    diagnostics.requestCount = 0;
    diagnostics.returnedSourceCount = url ? 1 : 0;
    if (!url) return { sources: [], diagnostics };
    diagnostics.acceptedEmbedCount = 1;
    return {
      sources: [
        {
          providerId: 'youtube',
          label: 'YouTube',
          kind: 'authorized_embed',
          url,
          sourceName: 'youtube',
        },
      ],
      diagnostics,
    };
  },
};

/*
 * Twitch. Same shape as YouTube, plus Twitch's parent requirement: the player
 * only runs when the embedding page's host is one we actually ship on, so a
 * copy served from anywhere else gets no Twitch source rather than a spoofed
 * parent. No configured catalog provider supplies a Twitch channel today, so
 * this adapter is registered and dormant - it is the extension point, not a
 * claim that Twitch sources exist.
 */
export const twitchPlaybackProvider: PpvPlaybackProvider = {
  id: 'twitch',
  label: 'Twitch',
  supports: (event) =>
    Boolean(twitchChannelFrom(event.providerRefs?.twitch?.channel)) && Boolean(currentTwitchParent()),
  async resolve(event): Promise<PpvPlaybackResolution> {
    const channel = twitchChannelFrom(event.providerRefs?.twitch?.channel);
    if (!channel) {
      return {
        sources: [],
        diagnostics: skippedPlaybackDiagnostics('twitch', 'not_attempted_unmapped'),
      };
    }
    const url = twitchEmbedUrl(channel);
    const diagnostics = emptyProviderDiagnostics('twitch', 'twitch');
    diagnostics.providerNativeIdentityAvailable = true;
    if (!url) {
      /* Not a failure: this origin is not a declared Twitch parent. */
      diagnostics.lookupState = 'not_attempted_unsupported';
      return { sources: [], diagnostics };
    }
    diagnostics.lookupState = 'attempted';
    diagnostics.requestCount = 0;
    diagnostics.returnedSourceCount = 1;
    diagnostics.acceptedEmbedCount = 1;
    return {
      sources: [
        {
          providerId: 'twitch',
          label: 'Twitch',
          kind: 'authorized_embed',
          url,
          sourceName: 'twitch',
        },
      ],
      diagnostics,
    };
  },
};

/*
 * Registry order is the source order the viewer sees. There is no quality
 * ranking: a real-device run showed provider source names carrying no health
 * signal, so ordering is a stable, documented convention only.
 */
export const PPV_PLAYBACK_PROVIDERS: readonly PpvPlaybackProvider[] = [
  streamedPlaybackProvider,
  sportsrcPlaybackProvider,
  youtubePlaybackProvider,
  twitchPlaybackProvider,
];

export interface PpvPlaybackResult {
  sources: PpvPlaybackSource[];
  diagnostics: PpvEventDiagnostics;
}

/*
 * Only providers we actually asked can have failed. A provider skipped for
 * want of a native identity, or because this origin cannot host it, is a
 * skipped lookup - reporting it as a provider failure is how "no sources exist
 * for this event" got mistaken for "the backup is broken".
 */
export function finalPlaybackState(
  diagnostics: PpvEventDiagnostics,
  officialWatchAvailable: boolean,
): PpvEventDiagnostics['finalState'] {
  if (diagnostics.acceptedEmbedCount > 0) return 'playable_candidate';
  const providers = diagnostics.providers ?? [diagnostics.streamed, diagnostics.sportsrc];
  if (providers.some((entry) => entry.rejectedEmbedCount > 0)) return 'policy_rejected';
  if (providers.some((entry) => entry.malformedResponseCount > 0 || entry.malformedRowCount > 0)) {
    return 'malformed';
  }
  const attempted = providers.filter((entry) => entry.requestCount > 0);
  if (attempted.some((entry) => entry.timeoutCount > 0)) return 'timeout';
  if (attempted.some((entry) => entry.httpErrorCount > 0 || entry.networkErrorCount > 0)) {
    return 'provider_failure';
  }
  /* Nothing inline, but a validated official destination is a real outcome. */
  if (officialWatchAvailable) return 'official_only';
  return 'unavailable';
}

export async function resolvePpvPlayback(
  event: PpvEvent,
  request: PpvFetchLike = fetch,
  providers: readonly PpvPlaybackProvider[] = PPV_PLAYBACK_PROVIDERS,
): Promise<PpvPlaybackResult> {
  const diagnostics = emptyEventDiagnostics(event.providerEventId);
  const officialWatchAvailable = Boolean(event.officialWatchUrl);

  const resolutions = await Promise.all(
    providers.map(async (provider) => {
      if (!provider.supports(event)) {
        return {
          sources: [] as PpvPlaybackSource[],
          diagnostics: skippedPlaybackDiagnostics(provider.id, 'not_attempted_unsupported'),
        };
      }
      return settlePlaybackProvider(provider, event, request);
    }),
  );

  const perProvider: PpvProviderDiagnostics[] = resolutions.map((entry) => entry.diagnostics);
  diagnostics.providers = perProvider;
  /* Named fields stay populated for the existing panel and callers. */
  diagnostics.streamed = perProvider.find((entry) => entry.stage === 'streamed') ?? diagnostics.streamed;
  diagnostics.sportsrc = perProvider.find((entry) => entry.stage === 'sportsrc') ?? diagnostics.sportsrc;

  const inline = event.playbackSources ?? [];
  const sources = mergePpvPlaybackSources([
    ...inline,
    ...resolutions.flatMap((entry) => entry.sources),
  ]);
  diagnostics.acceptedEmbedCount = sources.length;
  diagnostics.officialWatchAvailable = officialWatchAvailable;
  diagnostics.finalState = finalPlaybackState(diagnostics, officialWatchAvailable);
  return { sources, diagnostics };
}
