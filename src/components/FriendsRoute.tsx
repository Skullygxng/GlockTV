import type { MediaItem } from '../lib/media';
import type { TmdbClient } from '../lib/tmdb';
import { createWatchPartyService, type WatchPartyService } from '../lib/watchParty';
import { FriendsView } from './FriendsView';
import { getPartyPlaybackConfig, type PartyPlaybackConfig } from './PartyPlaybackPlayer';

interface FriendsRouteProps {
  client: TmdbClient;
  service?: WatchPartyService | null;
  selectedTitle: MediaItem | null;
  trailerKey: string | null;
  initialRoomCode?: string;
  partyPlaybackConfig?: PartyPlaybackConfig;
}

let defaultService: WatchPartyService | null | undefined;

function getDefaultService() {
  if (defaultService === undefined) defaultService = createWatchPartyService();
  return defaultService;
}

export function FriendsRoute({
  service: providedService,
  selectedTitle,
  client,
  trailerKey,
  initialRoomCode,
}: FriendsRouteProps) {
  const service = providedService === undefined ? getDefaultService() : providedService;
  void getPartyPlaybackConfig;
  return (
    <FriendsView
      service={service}
      selectedTitle={selectedTitle}
      client={client}
      trailerKey={trailerKey}
      initialRoomCode={initialRoomCode}
    />
  );
}
