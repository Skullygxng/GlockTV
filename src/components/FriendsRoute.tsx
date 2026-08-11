import { useMemo } from 'react';
import type { MediaItem } from '../lib/media';
import { createWatchPartyService, type WatchPartyService } from '../lib/watchParty';
import { FriendsView } from './FriendsView';

interface FriendsRouteProps {
  service?: WatchPartyService | null;
  selectedTitle: MediaItem | null;
  trailerKey: string | null;
  initialRoomCode?: string;
}

export function FriendsRoute({ service: providedService, ...props }: FriendsRouteProps) {
  const service = useMemo(
    () => providedService === undefined ? createWatchPartyService() : providedService,
    [providedService],
  );
  return <FriendsView service={service} {...props} />;
}
