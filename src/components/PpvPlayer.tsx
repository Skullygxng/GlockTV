import { useEffect, useMemo, useState } from 'react';
import { LoaderCircle, Radio, RotateCw, SkipForward, Tv } from 'lucide-react';
import type { PpvEmbed, PpvEvent } from '../lib/ppv';
import {
  formatPpvStart,
  loadPpvEmbeds,
  PPV_IFRAME_ALLOW,
  PPV_IFRAME_REFERRER_POLICY,
  PPV_IFRAME_SANDBOX,
} from '../lib/ppv';

interface PpvPlayerProps {
  event: PpvEvent;
  loadEmbeds?: typeof loadPpvEmbeds;
}

export function PpvPlayer({ event, loadEmbeds = loadPpvEmbeds }: PpvPlayerProps) {
  const [embeds, setEmbeds] = useState<PpvEmbed[]>(event.embeds);
  const [loading, setLoading] = useState(!event.embeds.length);
  const [error, setError] = useState('');
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIndex(0);
    setError('');
    if (event.embeds.length) {
      setEmbeds(event.embeds);
      setLoading(false);
      return;
    }
    setLoading(true);
    void loadEmbeds(event)
      .then((result) => {
        if (cancelled) return;
        setEmbeds(result);
        if (!result.length) setError('No hosted embed is available for this event yet.');
      })
      .catch((reason) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : 'PPV embed could not load.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [event, loadEmbeds]);

  const embed = embeds[Math.min(index, Math.max(0, embeds.length - 1))];
  const sourceLabel = useMemo(() => {
    if (!embed) return '';
    return [embed.provider, embed.source, embed.hd ? 'HD' : '', embed.language].filter(Boolean).join(' · ');
  }, [embed]);

  const nextSource = () => {
    if (embeds.length < 2) return;
    setIndex((current) => (current + 1) % embeds.length);
  };

  return (
    <div className="live-player" aria-label="PPV player">
      <div className="live-player__video">
        {embed ? (
          <iframe
            key={embed.url}
            className="ppv-player__frame"
            src={embed.url}
            title={event.title}
            sandbox={PPV_IFRAME_SANDBOX}
            allow={PPV_IFRAME_ALLOW}
            allowFullScreen
            referrerPolicy={PPV_IFRAME_REFERRER_POLICY}
          />
        ) : (
          <div className="live-player__video live-player__video--idle">
            <div className="live-player__idle-message">
              {loading ? <LoaderCircle className="spin" /> : <Tv />}
              <strong>{loading ? 'Loading hosted embed' : 'Embed unavailable'}</strong>
              <span>{loading ? 'Asking Streamed and SportSRC for a player URL.' : error}</span>
            </div>
          </div>
        )}
      </div>
      <div className="live-player__meta">
        <span className={`live-badge${event.status === 'live' ? '' : ' live-badge--idle'}`}>
          <Radio />
          {event.status === 'live' ? 'LIVE' : event.category.toUpperCase()}
        </span>
        <div>
          <h2>{event.title}</h2>
          <p>
            {formatPpvStart(event.startsAt)}
            {sourceLabel ? ` · ${sourceLabel}` : ''}
            {embeds.length > 1 ? ` · ${embeds.length} sources` : ''}
          </p>
        </div>
        <div className="ppv-player__actions">
          {embeds.length > 1 && (
            <button type="button" onClick={nextSource} aria-label="Next PPV source">
              <SkipForward />
              Source {index + 1}/{embeds.length}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              setError('');
              void loadEmbeds(event)
                .then((result) => {
                  setEmbeds(result);
                  setIndex(0);
                  if (!result.length) setError('No hosted embed is available for this event yet.');
                })
                .catch((reason) => setError(reason instanceof Error ? reason.message : 'PPV embed could not load.'))
                .finally(() => setLoading(false));
            }}
            aria-label="Reload PPV embeds"
          >
            <RotateCw />
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}
