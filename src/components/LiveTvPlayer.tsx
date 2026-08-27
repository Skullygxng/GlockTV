import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, LoaderCircle, Radio, RotateCw, SkipForward, Play } from 'lucide-react';
import type { LiveChannel } from '../lib/iptvOrg';

const HLS_MODULE_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1.6.13/+esm';

type HlsInstance = {
  loadSource: (url: string) => void;
  attachMedia: (media: HTMLMediaElement) => void;
  on: (event: string, callback: (eventName: string, data: { fatal?: boolean }) => void) => void;
  destroy: () => void;
};

type HlsConstructor = {
  new (config?: Record<string, unknown>): HlsInstance;
  isSupported: () => boolean;
};

type PlayerState = 'loading' | 'ready' | 'tap-play' | 'live' | 'trying-source' | 'error';

interface LiveTvPlayerProps {
  channel: LiveChannel;
}

function isAutoplayBlocked(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? String((error as { name?: string }).name) : '';
  const message = 'message' in error ? String((error as { message?: string }).message) : '';
  return (
    name === 'NotAllowedError' ||
    /notallowed|user.*permission|autoplay|interact/i.test(message)
  );
}

export function LiveTvPlayer({ channel }: LiveTvPlayerProps) {
  const video = useRef<HTMLVideoElement>(null);
  const [streamIndex, setStreamIndex] = useState(0);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<PlayerState>('loading');
  const [message, setMessage] = useState('Connecting to live stream...');
  const attemptedRef = useRef<Set<number>>(new Set());

  const streams = useMemo(() => channel.streams, [channel.streams]);
  const stream = streams[Math.min(streamIndex, Math.max(0, streams.length - 1))];

  useEffect(() => {
    setStreamIndex(0);
    setRevision((value) => value + 1);
    attemptedRef.current = new Set();
    setState('loading');
    setMessage('Connecting to live stream...');
  }, [channel.id]);

  useEffect(() => {
    const element = video.current;
    if (!element || !stream) return;
    let disposed = false;
    let hls: HlsInstance | null = null;

    element.setAttribute('playsinline', 'true');
    element.setAttribute('webkit-playsinline', 'true');
    element.playsInline = true;

    const markAttempted = (index: number) => {
      attemptedRef.current.add(index);
    };

    const fail = (reason?: string) => {
      if (disposed) return;
      markAttempted(streamIndex);

      let next = -1;
      for (let i = 0; i < streams.length; i++) {
        if (!attemptedRef.current.has(i)) {
          next = i;
          break;
        }
      }

      if (next >= 0) {
        setState('trying-source');
        setMessage(reason || 'Trying another source...');
        setStreamIndex(next);
        return;
      }

      setState('error');
      setMessage('All sources unavailable for this channel right now.');
    };

    markAttempted(streamIndex);
    setState(streamIndex === 0 && attemptedRef.current.size <= 1 ? 'loading' : 'trying-source');
    setMessage(
      streamIndex === 0 && attemptedRef.current.size <= 1
        ? 'Connecting to live stream...'
        : `Trying source ${streamIndex + 1} of ${streams.length}...`,
    );
    element.removeAttribute('src');
    element.load();

    const onPlaying = () => {
      if (disposed) return;
      setState('live');
      setMessage('Live');
    };
    const onError = () => fail();
    const onCanPlay = () => {
      if (disposed) return;
      if (element.paused) tryPlay();
    };

    element.addEventListener('playing', onPlaying);
    element.addEventListener('error', onError);
    element.addEventListener('canplay', onCanPlay);

    const timeout = window.setTimeout(() => {
      if (!disposed && element.readyState < HTMLMediaElement.HAVE_FUTURE_DATA && element.paused) {
        if (element.networkState === HTMLMediaElement.NETWORK_NO_SOURCE || element.error) {
          fail('Stream timed out.');
        } else if (element.readyState === HTMLMediaElement.HAVE_NOTHING) {
          fail('Stream timed out.');
        }
      }
    }, 18000);

    const tryPlay = () => {
      const result = element.play();
      if (result && typeof result.catch === 'function') {
        void result.catch((error) => {
          if (disposed) return;
          if (isAutoplayBlocked(error)) {
            setState('tap-play');
            setMessage('Tap Play to start');
            return;
          }
          fail();
        });
      }
    };

    const nativeHls = Boolean(element.canPlayType('application/vnd.apple.mpegurl'));
    if (nativeHls) {
      element.src = stream.url;
      tryPlay();
    } else {
      void import(/* @vite-ignore */ HLS_MODULE_URL)
        .then((module) => {
          if (disposed) return;
          const Hls = (module.default ?? (module as { Hls?: HlsConstructor }).Hls) as
            | HlsConstructor
            | undefined;
          if (!Hls?.isSupported()) {
            element.src = stream.url;
            tryPlay();
            return;
          }
          hls = new Hls({ enableWorker: true, lowLatencyMode: true });
          hls.on('hlsError', (_event, data) => {
            if (data.fatal) fail();
          });
          hls.loadSource(stream.url);
          hls.attachMedia(element);
          tryPlay();
        })
        .catch(() => fail('Could not load stream player.'));
    }

    return () => {
      disposed = true;
      window.clearTimeout(timeout);
      element.removeEventListener('playing', onPlaying);
      element.removeEventListener('error', onError);
      element.removeEventListener('canplay', onCanPlay);
      hls?.destroy();
      element.removeAttribute('src');
      element.load();
    };
  }, [revision, stream?.url, streamIndex, streams.length]);

  const retry = () => {
    attemptedRef.current = new Set();
    setStreamIndex(0);
    setRevision((value) => value + 1);
  };

  const nextSource = () => {
    if (streams.length < 2) {
      retry();
      return;
    }
    attemptedRef.current.add(streamIndex);
    let next = -1;
    for (let i = 0; i < streams.length; i++) {
      const candidate = (streamIndex + 1 + i) % streams.length;
      if (!attemptedRef.current.has(candidate) || attemptedRef.current.size >= streams.length) {
        next = candidate;
        if (attemptedRef.current.size >= streams.length) {
          attemptedRef.current = new Set();
        }
        break;
      }
    }
    if (next < 0) next = (streamIndex + 1) % streams.length;
    setStreamIndex(next);
  };

  const showOverlay = state === 'loading' || state === 'trying-source' || state === 'error';
  const showTapHint = state === 'tap-play';
  const title = channel.displayName || channel.name;

  return (
    <section className="live-player" aria-label={`${title} live player`}>
      <div className="live-player__video">
        <video ref={video} controls playsInline preload="metadata" />
        {showOverlay && (
          <div className={`live-player__status live-player__status--${state === 'error' ? 'error' : 'loading'}`} role="status">
            {state === 'error' ? <AlertTriangle /> : <LoaderCircle className="spin" />}
            <strong>{message}</strong>
            {state === 'error' && (
              <div>
                <button type="button" onClick={retry}>
                  <RotateCw /> Retry
                </button>
                {streams.length > 1 && (
                  <button type="button" onClick={nextSource}>
                    <SkipForward /> Next source
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {showTapHint && (
          <div className="live-player__status live-player__status--tap-play" role="status">
            <Play />
            <strong>{message}</strong>
            <span className="live-player__tap-hint">Use the video controls to start playback</span>
          </div>
        )}
      </div>
      <div className="live-player__meta">
        <span className="live-badge">
          <Radio /> LIVE
        </span>
        <div>
          <h2>{title}</h2>
          <p>
            {channel.category}
            {streams.length > 0 ? ` · Source ${streamIndex + 1} of ${streams.length}` : ''}
            {channel.metadata.length ? ` · ${channel.metadata.join(', ')}` : ''}
          </p>
        </div>
      </div>
    </section>
  );
}
