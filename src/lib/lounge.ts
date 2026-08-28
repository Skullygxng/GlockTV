import type { MediaItem } from './media';
import { mediaKey } from './session';
import type { OfficialLoungeBallotEntry, PartyMessage } from './watchParty';

export const LOUNGE_VOTE_PREFIX = '\u2060VOTE|';
export const LOUNGE_CHAT_TTL_MS = 45 * 60 * 1000;

export interface LoungeVote {
  userId: string;
  titleId: number;
  mediaType: MediaItem['mediaType'];
  titleName: string;
}

export function encodeLoungeVote(item: Pick<MediaItem, 'id' | 'mediaType' | 'title'>) {
  return `${LOUNGE_VOTE_PREFIX}${item.mediaType}:${item.id}:${item.title.slice(0, 80)}`;
}

export function parseLoungeVote(message: PartyMessage): LoungeVote | null {
  if (!message.body.startsWith(LOUNGE_VOTE_PREFIX)) return null;
  const payload = message.body.slice(LOUNGE_VOTE_PREFIX.length);
  const [mediaType, idValue, ...nameParts] = payload.split(':');
  const titleId = Number(idValue);
  if ((mediaType !== 'movie' && mediaType !== 'tv') || !Number.isFinite(titleId) || !nameParts.length) {
    return null;
  }
  return {
    userId: message.userId,
    titleId,
    mediaType,
    titleName: nameParts.join(':'),
  };
}

export function visiblePartyMessages(
  messages: PartyMessage[],
  options: { titleChangedAt?: string; now?: number; ttlMs?: number } = {},
) {
  const now = options.now ?? Date.now();
  const applyTtl = options.ttlMs != null || Boolean(options.titleChangedAt);
  const ttlMs = options.ttlMs ?? LOUNGE_CHAT_TTL_MS;
  const titleChangedAt = options.titleChangedAt ? Date.parse(options.titleChangedAt) : Number.NaN;

  return messages.filter((message) => {
    if (parseLoungeVote(message)) return false;
    const created = Date.parse(message.createdAt);
    if (!Number.isFinite(created)) return true;
    if (Number.isFinite(titleChangedAt) && created < titleChangedAt) return false;
    if (applyTtl && now - created > ttlMs) return false;
    return true;
  });
}

export function tallyLoungeVotes(messages: PartyMessage[], since?: string) {
  const sinceMs = since ? Date.parse(since) : 0;
  const latestByUser = new Map<string, LoungeVote>();

  for (const message of messages) {
    const created = Date.parse(message.createdAt);
    if (Number.isFinite(created) && created < sinceMs) continue;
    const vote = parseLoungeVote(message);
    if (vote) latestByUser.set(vote.userId, vote);
  }

  const counts = new Map<string, { vote: LoungeVote; count: number }>();
  for (const vote of latestByUser.values()) {
    const key = `${vote.mediaType}:${vote.titleId}`;
    const current = counts.get(key);
    counts.set(key, { vote, count: (current?.count ?? 0) + 1 });
  }

  return [...counts.values()].sort((left, right) => right.count - left.count);
}

export function loungeShouldAdvance(options: {
  durationSeconds?: number | null;
  playbackPosition: number;
  playbackState: 'playing' | 'paused';
  playbackUpdatedAt: string;
  now?: number;
}) {
  const duration = options.durationSeconds ?? 0;
  if (duration <= 0) return false;
  const elapsed = options.playbackState === 'paused'
    ? options.playbackPosition
    : options.playbackPosition + Math.max(0, ((options.now ?? Date.now()) - Date.parse(options.playbackUpdatedAt)) / 1000);
  return elapsed >= Math.max(90, duration - 20);
}

export function loungeNextUp(pool: MediaItem[], currentTitleId?: number, votes: ReturnType<typeof tallyLoungeVotes> = []) {
  const winnerId = votes[0]?.vote.titleId;
  return pool.find((item) => item.id === winnerId && item.id !== currentTitleId)
    ?? pool.find((item) => item.id !== currentTitleId)
    ?? pool[0]
    ?? null;
}

export function loungeBallot(pool: MediaItem[], currentTitleId?: number, limit = 3) {
  const unique = new Map<string, MediaItem>();
  for (const item of pool) {
    if (item.id === currentTitleId) continue;
    unique.set(mediaKey(item), item);
    if (unique.size >= limit) break;
  }
  return [...unique.values()];
}

export function isOfficialLounge(room?: { isOfficial?: boolean; isPublic?: boolean } | null) {
  return Boolean(room?.isOfficial && room?.isPublic);
}

export function officialBallotCandidates(entries: OfficialLoungeBallotEntry[]): MediaItem[] {
  return entries.map((entry) => ({
    id: entry.titleId,
    mediaType: entry.mediaType,
    title: entry.titleName,
    overview: '',
    date: '',
    year: '',
    genreIds: [],
    genres: [],
    rating: 0,
    voteCount: entry.voteCount,
    popularity: 0,
    runtime: entry.durationSeconds ? Math.round(entry.durationSeconds / 60) : null,
    posterPath: null,
    backdropPath: entry.backdropPath,
  }));
}

export function officialBallotTallies(entries: OfficialLoungeBallotEntry[]) {
  return entries
    .filter((entry) => entry.voteCount > 0)
    .map((entry) => ({
      vote: {
        userId: entry.isMine ? 'mine' : 'field',
        titleId: entry.titleId,
        mediaType: entry.mediaType,
        titleName: entry.titleName,
      },
      count: entry.voteCount,
    }))
    .sort((left, right) => right.count - left.count);
}

export function officialBallotWinner(entries: OfficialLoungeBallotEntry[]) {
  return officialBallotTallies(entries)[0]?.vote ?? null;
}

export function visibleRoomChat(
  messages: PartyMessage[],
  room?: { isOfficial?: boolean; isPublic?: boolean; playbackUpdatedAt?: string } | null,
  options: { now?: number; ttlMs?: number } = {},
) {
  if (!isOfficialLounge(room)) return messages;
  return visiblePartyMessages(messages, {
    titleChangedAt: room?.playbackUpdatedAt,
    now: options.now,
    ttlMs: options.ttlMs ?? LOUNGE_CHAT_TTL_MS,
  });
}
