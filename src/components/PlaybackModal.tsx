import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Film, Maximize, Minimize, RotateCw, X } from 'lucide-react';
import type { MediaItem } from '../lib/media';
import { buildPlaybackUrl, type PlaybackConfig } from '../lib/playback';
import '../playback.css';

interface PlaybackModalProps {
  item: MediaItem;
  config: PlaybackConfig;
  onClose: () => void;
}

const normalizeSelection = (value: string) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

export function PlaybackModal({ item, config, onClose }: PlaybackModalProps) {
  const [season, setSeason] = useState(1);
  const [episode, setEpisode] = useState(1);
  const [playerRevision, setPlayerRevision] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const playerFrame = useRef<HTMLDivElement>(null);
  const playbackUrl = buildPlaybackUrl(item, config, { season, episode });
  const playerName = item.mediaType === 'movie' ? 'Movie player' : 'TV player';

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);


  useEffect(() => {
    const updateFullscreen = () => setFullscreen(document.fullscreenElement === playerFrame.current);
    document.addEventListener('fullscreenchange', updateFullscreen);
    return () => document.removeEventListener('fullscreenchange', updateFullscreen);
  }, []);

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen?.();
      return;
    }
    const target = playerFrame.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null;
    if (target?.requestFullscreen) await target.requestFullscreen();
    else target?.webkitRequestFullscreen?.();
  };
  return <motion.div className="overlay playback-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
    <motion.section className="playback-modal" role="dialog" aria-label={playerName} aria-modal="true" initial={{ y: 26, scale: .985 }} animate={{ y: 0, scale: 1 }} exit={{ y: 18, scale: .99 }}>
      <header className="playback-modal__header">
        <div><span>{item.mediaType === 'movie' ? 'Now playing' : `Season ${season} · Episode ${episode}`}</span><h2>{item.title}</h2></div>
        <div className="playback-modal__actions">
          <button type="button" className="playback-retry" aria-label="Retry player" onClick={() => setPlayerRevision((revision) => revision + 1)}><RotateCw /><span>Retry</span></button>
          <button type="button" aria-label="Close player" onClick={onClose}><X /></button>
        </div>
      </header>
      {playbackUrl ? <div className="playback-frame" data-testid="playback-frame" ref={playerFrame}>
        <iframe
          key={`${playbackUrl}-${playerRevision}`}
          title={`${item.title} playback`}
          src={playbackUrl}
          allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
        <button type="button" className="playback-fullscreen" aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize /> : <Maximize />}</button>
      </div> : <div className="playback-unconfigured">
        <Film />
        <strong>Playback source not connected</strong>
        <p>Add your authorized {item.mediaType === 'movie' ? 'movie' : 'TV'} embed URL template to the GlockTV environment configuration.</p>
      </div>}
      <footer className="playback-modal__footer">
        <div><span>{item.mediaType === 'movie' ? 'Feature presentation' : 'Episode playback'}</span><strong>{item.year} · {item.genres.slice(0, 2).join(' · ') || (item.mediaType === 'movie' ? 'Movie' : 'Series')}</strong></div>
        {item.mediaType === 'tv' && <div className="episode-controls">
          <label>Season<input aria-label="Season" type="number" min="1" step="1" value={season} onChange={(event) => setSeason(normalizeSelection(event.target.value))} /></label>
          <label>Episode<input aria-label="Episode" type="number" min="1" step="1" value={episode} onChange={(event) => setEpisode(normalizeSelection(event.target.value))} /></label>
        </div>}
      </footer>
    </motion.section>
  </motion.div>;
}
