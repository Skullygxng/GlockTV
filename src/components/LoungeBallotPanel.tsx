import type { MediaItem } from '../lib/media';
import type { LoungeVote } from '../lib/lounge';

interface LoungeBallotPanelProps {
  candidates: MediaItem[];
  tallies: Array<{ vote: LoungeVote; count: number }>;
  currentVoteTitleId?: number;
  disabled?: boolean;
  onVote: (item: MediaItem) => void;
}

export function LoungeBallotPanel({
  candidates,
  tallies,
  currentVoteTitleId,
  disabled,
  onVote,
}: LoungeBallotPanelProps) {
  if (!candidates.length) return null;

  const countFor = (item: MediaItem) =>
    tallies.find((entry) => entry.vote.titleId === item.id && entry.vote.mediaType === item.mediaType)?.count ?? 0;

  return (
    <section className="lounge-nextup" aria-label="Lounge next up ballot">
      <header>
        <small>Next up</small>
        <strong>Vote the next lounge title</strong>
      </header>
      <ul>
        {candidates.map((item) => {
          const selected = currentVoteTitleId === item.id;
          return (
            <li key={`${item.mediaType}-${item.id}`}>
              <button
                type="button"
                aria-label={`Vote for ${item.title}`}
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => onVote(item)}
              >
                <span>
                  <strong>{item.title}</strong>
                  <small>{countFor(item)} {countFor(item) === 1 ? 'vote' : 'votes'}</small>
                </span>
                <em>{selected ? 'Your vote' : 'Vote'}</em>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
