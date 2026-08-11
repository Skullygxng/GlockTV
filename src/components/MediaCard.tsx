import { Bookmark, Heart, Info, Play, Plus, ThumbsDown, VolumeX } from 'lucide-react';
import { imageUrl, type MediaItem } from '../lib/media';

export interface MediaCardProps {
  item: MediaItem;
  match: number;
  saved: boolean;
  trailerKey?: string | null;
  onToggleList: (item: MediaItem) => void;
  onWatch: (item: MediaItem) => void;
  onTrailer: (item: MediaItem) => void;
  onLike: (item: MediaItem) => void;
  onSkip: (item: MediaItem) => void;
}

function formatRuntime(minutes: number | null): string {
  if (!minutes) return 'Runtime TBD';
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return hours ? `${hours}h ${remaining}m` : `${remaining}m`;
}

export function MediaCard({ item, match, saved, trailerKey = null, onToggleList, onWatch, onTrailer, onLike, onSkip }: MediaCardProps) {
  const artwork = imageUrl(item.posterPath ?? item.backdropPath, 'w780');
  return (
    <article className="media-card" aria-label={`${item.title} recommendation`}>
      <div className="media-card__image-wrap">
        {artwork ? <img className="media-card__image" src={artwork} alt="" /> : <div className="media-card__fallback" />}
        {trailerKey ? <div className="media-card__video" aria-hidden="true"><iframe
          title={`${item.title} autoplay trailer`}
          src={`https://www.youtube-nocookie.com/embed/${trailerKey}?autoplay=1&mute=1&controls=0&loop=1&playlist=${trailerKey}&playsinline=1&rel=0&disablekb=1`}
          allow="autoplay; encrypted-media; picture-in-picture"
        /></div> : null}
        <div className="media-card__shade" />
        <button className="media-card__mute" type="button" aria-label={trailerKey ? `Play ${item.title} trailer with sound` : 'Trailer preview unavailable'} disabled={!trailerKey} onClick={() => onTrailer(item)}><VolumeX size={17} /></button>
        <div className="media-card__actions" aria-label="Title actions">
          <button type="button" aria-label={`Like ${item.title}`} onClick={() => onLike(item)}><Heart /></button>
          <span>{item.voteCount > 999 ? `${Math.round(item.voteCount / 1000)}K` : item.voteCount}</span>
          <button type="button" aria-label={`Add ${item.title} to My List`} onClick={() => onToggleList(item)}>
            {saved ? <Bookmark fill="currentColor" /> : <Plus />}
          </button>
          <span>My List</span>
          <button type="button" aria-label={`Details for ${item.title}`} onClick={() => onWatch(item)}><Info /></button>
          <span>Details</span>
          <button type="button" aria-label="Not for me" onClick={() => onSkip(item)}><ThumbsDown /></button>
          <span>Skip</span>
        </div>
      </div>
      <div className="media-card__content">
        <p className="media-card__match">{match}% match for you</p>
        <h1>{item.title}</h1>
        <p className="media-card__meta">
          <span>{item.year}</span><i />
          <span>{item.genres.slice(0, 2).join(' · ') || (item.mediaType === 'movie' ? 'Movie' : 'TV')}</span><i />
          <span>{formatRuntime(item.runtime)}</span>
        </p>
        <p className="media-card__rating"><strong>★ {item.rating.toFixed(1)}</strong><span>/10</span></p>
        <p className="media-card__overview">{item.overview || 'Discover why this title belongs in your next watch.'}</p>
        <button className="media-card__watch" type="button" onClick={() => onWatch(item)}><Play size={18} fill="currentColor" /> Watch movie</button>
        <button className="media-card__trailer" type="button" onClick={() => onTrailer(item)}><VolumeX size={16} /> Play trailer</button>
      </div>
    </article>
  );
}
