import type { MediaItem } from '../lib/media';
import type { TmdbClient } from '../lib/tmdb';
import { createWatchPartyService, type WatchPartyService } from '../lib/watchParty';
import { FriendsView } from './FriendsView';

interface FriendsRouteProps {
  client: TmdbClient;
  service?: WatchPartyService | null;
  selectedTitle: MediaItem | null;
  trailerKey: string | null;
  initialRoomCode?: string;
}

let defaultService: WatchPartyService | null | undefined;

function getDefaultService() {
  if (defaultService === undefined) defaultService = createWatchPartyService();
  return defaultService;
}

export function FriendsRoute({ service: providedService, ...props }: FriendsRouteProps) {
  const service = providedService === undefined ? getDefaultService() : providedService;
  return <FriendsView service={service} {...props} />;
}
