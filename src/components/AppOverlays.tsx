import { ChevronRight, Clapperboard, Filter, Play, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { motion } from 'motion/react';
import { type DiscoveryFilters, type ReleaseEra, type RuntimeFilter } from '../lib/discovery';
import { imageUrl } from '../lib/media';
import type { TitleContext } from '../lib/tmdb';

const defaultFilters: DiscoveryFilters = {
  contentType: 'both',
  genreIds: [],
  releaseEra: 'any',
  rating: null,
  runtime: 'any',
  sort: 'popularity',
};

const genres = [
  [28, 'Action'], [35, 'Comedy'], [27, 'Horror'], [53, 'Thriller'], [878, 'Sci-Fi'],
  [80, 'Crime'], [10749, 'Romance'], [14, 'Fantasy'], [16, 'Animation'], [99, 'Documentary'],
] as const;

const vibes = [
  { name: 'Dark', copy: 'Crime, horror, and beautiful unease.', ids: [27, 53, 80] },
  { name: 'Funny', copy: 'Sharp comedy and easy energy.', ids: [35] },
  { name: 'Chill', copy: 'Warm stories and low-stakes escape.', ids: [10749, 10751] },
  { name: 'Epic', copy: 'Big worlds, action, and adventure.', ids: [28, 12, 14] },
  { name: 'Mind-Bending', copy: 'Science fiction, mystery, and twists.', ids: [878, 9648, 53] },
] as const;

function LoadingState() {
  return (
    <div className="state-panel">
      <strong>Loading</strong>
    </div>
  );
}

export function FilterPanel({
  filters,
  onChange,
  onClose,
  onApply,
}: {
  filters: DiscoveryFilters;
  onChange: (next: DiscoveryFilters) => void;
  onClose: () => void;
  onApply: () => void;
}) {
  const toggleGenre = (id: number) => onChange({
    ...filters,
    genreIds: filters.genreIds.includes(id)
      ? filters.genreIds.filter((genre) => genre !== id)
      : [...filters.genreIds, id],
  });

  return (
    <motion.div
      className="overlay overlay--right"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.aside
        className="filter-panel"
        role="dialog"
        aria-label="Filter your feed"
        initial={{ x: 80 }}
        animate={{ x: 0 }}
        exit={{ x: 80 }}
      >
        <header>
          <div><Filter /><h2>Filter your feed</h2></div>
          <button aria-label="Close filters" onClick={onClose}><X /></button>
        </header>

        <FilterGroup title="Content">
          {(['movies', 'tv', 'both'] as const).map((type) => (
            <button
              key={type}
              className={filters.contentType === type ? 'active' : ''}
              onClick={() => onChange({ ...filters, contentType: type })}
            >
              {type === 'tv' ? 'TV Shows' : type[0].toUpperCase() + type.slice(1)}
            </button>
          ))}
        </FilterGroup>

        <FilterGroup title="Genres">
          {genres.map(([id, name]) => (
            <button
              key={id}
              className={filters.genreIds.includes(id) ? 'active' : ''}
              onClick={() => toggleGenre(id)}
            >
              {name}
            </button>
          ))}
        </FilterGroup>

        <FilterGroup title="Release year">
          {([
            ['new', 'New'],
            ['2020s', '2020s'],
            ['2010s', '2010s'],
            ['2000s', '2000s'],
            ['90s', '90s'],
            ['classics', 'Classics'],
          ] as [ReleaseEra, string][]).map(([value, label]) => (
            <button
              key={value}
              className={filters.releaseEra === value ? 'active' : ''}
              onClick={() => onChange({ ...filters, releaseEra: value })}
            >
              {label}
            </button>
          ))}
        </FilterGroup>

        <FilterGroup title="Rating">
          {[null, 7, 8, 9].map((value) => (
            <button
              key={String(value)}
              className={filters.rating === value ? 'active' : ''}
              onClick={() => onChange({ ...filters, rating: value })}
            >
              {value ? `${value}+` : 'Any'}
            </button>
          ))}
        </FilterGroup>

        <FilterGroup title="Runtime">
          {([
            ['any', 'Any'],
            ['under-90', '< 90m'],
            ['90-120', '90–120m'],
            ['over-120', '2h+'],
          ] as [RuntimeFilter, string][]).map(([value, label]) => (
            <button
              key={value}
              className={filters.runtime === value ? 'active' : ''}
              onClick={() => onChange({ ...filters, runtime: value })}
            >
              {label}
            </button>
          ))}
        </FilterGroup>

        <button className="apply-button" onClick={onApply}>
          Apply filters <SlidersHorizontal />
        </button>
        <button className="clear-button" onClick={() => onChange(defaultFilters)}>
          Clear all
        </button>
      </motion.aside>
    </motion.div>
  );
}

export function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="filter-group">
      <p>{title}</p>
      <div>{children}</div>
    </section>
  );
}

export function VibePanel({
  onClose,
  onChoose,
}: {
  onClose: () => void;
  onChoose: (ids: readonly number[]) => void;
}) {
  return (
    <motion.div
      className="overlay"
      role="dialog"
      aria-label="Choose a vibe"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        className="vibe-panel"
        initial={{ y: 30, scale: .96 }}
        animate={{ y: 0, scale: 1 }}
        exit={{ y: 20, scale: .97 }}
      >
        <button className="modal-close" aria-label="Close vibe picker" onClick={onClose}>
          <X />
        </button>
        <Sparkles className="vibe-icon" />
        <span>Vibe mode</span>
        <h2>What are you in the mood for?</h2>
        <p>Pick a feeling. We’ll tune the feed around it.</p>
        <div>
          {vibes.map((vibe) => (
            <button key={vibe.name} aria-label={vibe.name} onClick={() => onChoose(vibe.ids)}>
              <b>{vibe.name}</b>
              <span>{vibe.copy}</span>
              <ChevronRight />
            </button>
          ))}
        </div>
      </motion.div>
    </motion.div>
  );
}

export function TitleModal({
  mode,
  context,
  onClose,
  onNext,
}: {
  mode: 'details' | 'trailer' | 'channel';
  context: TitleContext | null;
  onClose: () => void;
  onNext: () => void;
}) {
  const providers = context?.providers
    ? [
        ...(context.providers.flatrate ?? []),
        ...(context.providers.free ?? []),
        ...(context.providers.ads ?? []),
        ...(context.providers.rent ?? []),
      ].filter(
        (provider, index, all) =>
          all.findIndex((item) => item.provider_id === provider.provider_id) === index,
      )
    : [];

  return (
    <motion.div
      className="overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        className={`title-modal ${mode === 'channel' ? 'title-modal--channel' : ''}`}
        role="dialog"
        aria-label={
          mode === 'channel'
            ? 'Channel player'
            : mode === 'trailer'
              ? 'Trailer player'
              : 'Title details'
        }
        initial={{ y: 30, scale: .97 }}
        animate={{ y: 0, scale: 1 }}
        exit={{ y: 20, scale: .98 }}
      >
        <button className="modal-close" aria-label="Close player" onClick={onClose}>
          <X />
        </button>

        {!context ? (
          <LoadingState />
        ) : (
          <>
            {mode !== 'details' && context.trailer ? (
              <div className="video-frame">
                <iframe
                  title={`${context.details.title} trailer`}
                  src={`https://www.youtube-nocookie.com/embed/${context.trailer.key}?autoplay=1&playsinline=1&rel=0`}
                  allow="autoplay; encrypted-media; picture-in-picture"
                  allowFullScreen
                />
              </div>
            ) : mode !== 'details' ? (
              <div className="video-missing">
                <Clapperboard />
                <p>No official trailer is available for this title.</p>
              </div>
            ) : null}

            <div className="title-modal__body">
              <span>
                {mode === 'channel'
                  ? 'Now playing'
                  : context.details.mediaType === 'movie'
                    ? 'Movie'
                    : 'Series'}
              </span>
              <h2>{context.details.title}</h2>
              <p>{context.details.overview}</p>

              <div className="provider-list">
                {providers.length ? (
                  providers.slice(0, 6).map((provider) => {
                    const logo = imageUrl(provider.logo_path, 'w92');
                    return (
                      <span key={provider.provider_id}>
                        {logo && <img src={logo} alt="" />}
                        {provider.provider_name}
                      </span>
                    );
                  })
                ) : (
                  <small>No US streaming provider is currently listed.</small>
                )}
              </div>

              <div className="modal-actions">
                {context.providerLink && (
                  <a href={context.providerLink} target="_blank" rel="noreferrer">
                    <Play fill="currentColor" /> See where to watch
                  </a>
                )}
                {mode === 'channel' && (
                  <button onClick={onNext}>
                    Next trailer <ChevronRight />
                  </button>
                )}
              </div>

              {!!providers.length && <small>Streaming availability powered by JustWatch.</small>}
            </div>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}
