import { LoaderCircle } from 'lucide-react';
import type { MediaItem } from '../lib/media';

/*
 * As-you-type results for the Discover search box. Purely presentational: the
 * query, debounce and request race guard all live in App, so the desktop and
 * mobile search bars can share one list without duplicating that logic.
 */
interface SearchSuggestionsProps {
  id: string;
  items: MediaItem[];
  loading: boolean;
  /* -1 when nothing is keyboard-highlighted. */
  activeIndex: number;
  onPick: (item: MediaItem) => void;
  onHover: (index: number) => void;
}

export function optionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

export function SearchSuggestions({
  id,
  items,
  loading,
  activeIndex,
  onPick,
  onHover,
}: SearchSuggestionsProps) {
  if (!loading && !items.length) return null;

  return (
    <div className="search-suggestions" role="listbox" id={id} aria-label="Search suggestions">
      {loading && !items.length ? (
        <div className="search-suggestions__status">
          <LoaderCircle className="spin" />
          <span>Searching...</span>
        </div>
      ) : (
        items.map((item, index) => (
          <button
            key={`${item.mediaType}:${item.id}`}
            id={optionId(id, index)}
            type="button"
            // activedescendant model: the input keeps focus, so options must
            // stay out of the Tab order.
            tabIndex={-1}
            role="option"
            aria-selected={index === activeIndex}
            className={index === activeIndex ? 'active' : ''}
            // The input keeps focus, so the click must not blur it first.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onHover(index)}
            onClick={() => onPick(item)}
          >
            <span className="search-suggestions__art">
              {item.posterPath ? (
                <img src={`https://image.tmdb.org/t/p/w92${item.posterPath}`} alt="" loading="lazy" />
              ) : null}
            </span>
            <span className="search-suggestions__copy">
              <b>{item.title}</b>
              <small>
                {[item.mediaType === 'tv' ? 'TV' : 'Movie', item.year, item.genres[0]]
                  .filter(Boolean)
                  .join(' · ')}
              </small>
            </span>
          </button>
        ))
      )}
    </div>
  );
}
