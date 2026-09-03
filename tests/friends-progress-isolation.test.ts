import { describe, expect, it } from 'vitest';
import friendsExperience from '../src/components/FriendsExperience.tsx?raw';
import friendsRoute from '../src/components/FriendsRoute.tsx?raw';
import partyPlayback from '../src/components/PartyPlaybackPlayer.tsx?raw';
import youTubePartyPlayer from '../src/components/YouTubePartyPlayer.tsx?raw';
import loungeBallot from '../src/components/LoungeBallotPanel.tsx?raw';
import inviteJoin from '../src/components/InviteJoinCard.tsx?raw';
import watchParty from '../src/lib/watchParty.ts?raw';
import lounge from '../src/lib/lounge.ts?raw';
import watchProgressProvider from '../src/components/WatchProgressProvider.tsx?raw';
import watchProgressService from '../src/lib/watchProgressService.ts?raw';
import progressMigration from '../supabase/migrations/20260903190000_watch_progress.sql?raw';

/*
 * Two kinds of playback position, kept apart.
 *
 * A room's position belongs to the room: it is shared, the host moves it, and
 * every member follows it. A progress entry belongs to one viewer and follows
 * them between devices. Letting either write the other is how watching ten
 * minutes of a friend's film rewrites your own Continue Watching, and how
 * joining a party would seek everybody to wherever you last stopped.
 *
 * The seam is that neither side imports the other. That is a stronger and
 * cheaper guarantee than any single behavioural case, because it holds for the
 * cases nobody thought to write.
 */

const friendsSources: Array<[string, string]> = [
  ['FriendsExperience', friendsExperience],
  ['FriendsRoute', friendsRoute],
  ['PartyPlaybackPlayer', partyPlayback],
  ['YouTubePartyPlayer', youTubePartyPlayer],
  ['LoungeBallotPanel', loungeBallot],
  ['InviteJoinCard', inviteJoin],
  ['watchParty service', watchParty],
  ['lounge service', lounge],
];

describe('Friends does not record personal progress', () => {
  it.each(friendsSources)('%s reaches for no progress module', (_name, source) => {
    expect(source).not.toMatch(/from\s+['"][^'"]*watchProgress/);
    expect(source).not.toMatch(/from\s+['"][^'"]*playbackProgress/);
    expect(source).not.toMatch(/useWatchProgress|recordProgress|savePlaybackProgress/);
  });

  it.each(friendsSources)('%s never writes the progress table', (_name, source) => {
    expect(source).not.toContain('watch_progress');
  });
});

describe('personal progress does not touch rooms', () => {
  it('reads and writes one table, and it is not a room', () => {
    for (const source of [watchProgressProvider, watchProgressService]) {
      for (const roomTable of ['watch_rooms', 'room_members', 'chat_messages', 'room_bans']) {
        expect(source).not.toContain(roomTable);
      }
      expect(source).not.toMatch(/playback_position|playback_state|host_id/);
    }
  });

  it('does not subscribe to realtime, because progress is nobody else\'s business', () => {
    /* A room needs realtime so members stay in sync. A private resume point
       has exactly one reader, so a channel here would be a broadcast of one
       person's viewing to a subscription nobody needs. */
    for (const source of [watchProgressProvider, watchProgressService]) {
      expect(source).not.toMatch(/\.channel\(|postgres_changes|\.subscribe\(/);
    }
  });

  it('adds nothing to the watch-party schema', () => {
    const statements = progressMigration.replace(/^\s*--.*$/gm, '');
    expect(statements).not.toMatch(/watch_rooms|room_members|chat_messages/);
    expect(statements).not.toMatch(/alter table public\.(watch_rooms|room_members)/);
  });
});
