import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, Radio, RotateCw, SkipForward, Tv } from 'lucide-react';
import type { PpvEmbed, PpvEvent } from '../lib/ppv';
import { formatPpvStart, loadPpvEmbeds } from '../lib/ppv';
import {
  PPV_IFRAME_ALLOW,
  PPV_IFRAME_REFERRER_POLICY,
  PPV_IFRAME_SANDBOX,
} from '../lib/ppvEmbedPolicy';

interface PpvPlayerProps {
  event: PpvEvent;
  loadEmbeds?: typeof loadPpvEmbeds;
}

export function PpvPlayer({ event, loadEmbeds = loadPpvEmbeds }: PpvPlayerProps) {
  const [embeds, setEmbeds] = useState<PpvEmbed[]>(event.embeds);
  const [loading, setLoading] = useState(!event.embeds.length);
  const [error, setError] = useState('');
  const [index, setIndex] = useState(0);

  /*
   * Every embed request carries a generation. Initial loads and Reload share
   * the counter, so a late result from a previous event or a superseded reload
   * can never commit state over the event the user is actually watching.
   */
  const generation = useRef(0);
  const eventRef = useRef(event);
  eventRef.current = event;
  const eventKey = `${event.provider}:${event.providerEventId}`;

  const runLoad = useCallback(
    (target: PpvEvent) => {
      const ticket = ++generation.current;
      setLoading(true);
      setError('');
      void loadEmbeds(target)
        .then((result) => {
          if (generation.current !== ticket) return;
          setEmbeds(result);
          setIndex(0);
          if (!result.length) setError('No hosted embed is available for this event yet.');
        })
        .catch((reason) => {
          if (generation.current !== ticket) return;
          setEmbeds([]);
          setError(reason instanceof Error ? reason.message : 'PPV embed could not load.');
        })
        .finally(() => {
          if (generation.current !== ticket) return;
          setLoading(false);
        });
    },
    [loadEmbeds],
  );

  useEffect(() => {
    const target = eventRef.current;
    // Drop the previous event's embeds immediately so its iframe can never be
    // shown underneath the new event's metadata.
    setIndex(0);
    setError('');
    if (target.embeds.length) {
      generation.current += 1;
      setEmbeds(target.embeds);
      setLoading(false);
      return;
    }
    setEmbeds([]);
    runLoad(target);
  }, [eventKey, runLoad]);

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
      {/* One aspect-ratio viewport. Loading and unavailable states render
          inside it rather than creating a second 16:9 box. */}
      <div className={`live-player__video${embed ? '' : ' live-player__video--idle'}`}>
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
          <div className="live-player__idle-message">
            {loading ? <LoaderCircle className="spin" /> : <Tv />}
            <strong>{loading ? 'Loading hosted embed' : 'Embed unavailable'}</strong>
            <span>{loading ? 'Asking Streamed and SportSRC for a player URL.' : error}</span>
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
          <button type="button" onClick={() => runLoad(eventRef.current)} aria-label="Reload PPV embeds">
            <RotateCw />
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}
