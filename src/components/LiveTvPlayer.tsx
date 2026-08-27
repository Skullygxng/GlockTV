import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, LoaderCircle, Radio, RotateCw, SkipForward } from 'lucide-react';
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

interface LiveTvPlayerProps {
  channel: LiveChannel;
}

export function LiveTvPlayer({ channel }: LiveTvPlayerProps) {
  const video = useRef<HTMLVideoElement>(null);
  const [streamIndex, setStreamIndex] = useState(0);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('Connecting to live stream...');
  const streams = useMemo(() => channel.streams, [channel.streams]);
  const stream = streams[Math.min(streamIndex, Math.max(0, streams.length - 1))];

  useEffect(() => {
    setStreamIndex(0);
    setRevision((value) => value + 1);
  }, [channel.id]);

  useEffect(() => {
    const element = video.current;
    if (!element || !stream) return;
    let disposed = false;
    let hls: HlsInstance | null = null;

    const fail = () => {
      if (disposed) return;
      if (streamIndex + 1 < streams.length) {
        setMessage('Trying another source...');
        setStreamIndex((value) => value + 1);
        return;
      }
      setState('error');
      setMessage('This channel is not playable in this browser right now.');
    };

    setState('loading');
    setMessage('Connecting to live stream...');
    element.removeAttribute('src');
    element.load();

    const nativeHls = Boolean(element.canPlayType('application/vnd.apple.mpegurl'));
    if (nativeHls) {
      element.src = stream.url;
      void element.play().catch(() => {
        if (!disposed) {
          setState('ready');
          setMessage('Ready');
        }
      });
    } else {
      void import(/* @vite-ignore */ HLS_MODULE_URL)
        .then((module) => {
          if (disposed) return;
          const Hls = (module.default ?? (module as { Hls?: HlsConstructor }).Hls) as HlsConstructor | undefined;
          if (!Hls?.isSupported()) {
            element.src = stream.url;
            return;
          }
          hls = new Hls({ enableWorker: true, lowLatencyMode: true });
          hls.on('hlsError', (_event, data) => {
            if (data.fatal) fail();
          });
          hls.loadSource(stream.url);
          hls.attachMedia(element);
          void element.play().catch(() => {
            if (!disposed) {
              setState('ready');
              setMessage('Ready');
            }
          });
        })
        .catch(fail);
    }

    const onPlaying = () => {
      if (disposed) return;
      setState('ready');
      setMessage('Live');
    };
    const onError = () => fail();
    element.addEventListener('playing', onPlaying);
    element.addEventListener('error', onError);

    const timeout = window.setTimeout(() => {
      if (!disposed && element.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) fail();
    }, 15000);

    return () => {
      disposed = true;
      window.clearTimeout(timeout);
      element.removeEventListener('playing', onPlaying);
      element.removeEventListener('error', onError);
      hls?.destroy();
      element.removeAttribute('src');
      element.load();
    };
  }, [revision, stream?.url, streamIndex, streams.length]);

  const retry = () => {
    setStreamIndex(0);
    setRevision((value) => value + 1);
  };

  const nextSource = () => {
    if (streams.length < 2) {
      retry();
      return;
    }
    setStreamIndex((value) => (value + 1) % streams.length);
  };

  return (
    <section className="live-player" aria-label={`${channel.name} live player`}>
      <div className="live-player__video">
        <video ref={video} controls playsInline preload="metadata" />
        {state !== 'ready' && (
          <div className={`live-player__status live-player__status--${state}`} role="status">
            {state === 'loading' ? <LoaderCircle className="spin" /> : <AlertTriangle />}
            <strong>{message}</strong>
            {state === 'error' && (
              <div>
                <button type="button" onClick={retry}><RotateCw /> Retry</button>
                {streams.length > 1 && <button type="button" onClick={nextSource}><SkipForward /> Next source</button>}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="live-player__meta">
        <span className="live-badge"><Radio /> LIVE</span>
        <div>
          <h2>{channel.name}</h2>
          <p>{channel.category} - Source {streamIndex + 1} of {streams.length}</p>
        </div>
      </div>
    </section>
  );
}
