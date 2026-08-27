import { useEffect, useState } from 'react';
import {
  LoaderCircle,
  LockKeyhole,
  Play,
} from 'lucide-react';
import { imageUrl } from '../lib/media';
import type {
  TmdbClient,
  TvEpisode,
  TvSeasonSummary,
} from '../lib/tmdb';
import '../premium.css';

interface EpisodeBrowserProps {
  client: TmdbClient;
  seriesId: number;
  activeSeason: number;
  activeEpisode: number;
  canSelect?: boolean;
  onSelect: (
    season: number,
    episode: number,
  ) => void;
  compact?: boolean;
}

export function EpisodeBrowser({
  client,
  seriesId,
  activeSeason,
  activeEpisode,
  canSelect = true,
  onSelect,
  compact = false,
}: EpisodeBrowserProps) {
  const [seasons, setSeasons] =
    useState<TvSeasonSummary[]>([]);

  const [shownSeason, setShownSeason] =
    useState(activeSeason);

  const [episodes, setEpisodes] =
    useState<TvEpisode[]>([]);

  const [seasonsLoading, setSeasonsLoading] =
    useState(true);

  const [episodesLoading, setEpisodesLoading] =
    useState(true);

  const [seasonError, setSeasonError] =
    useState('');

  const [episodeError, setEpisodeError] =
    useState('');

  useEffect(() => {
    setShownSeason(activeSeason);
  }, [activeSeason, seriesId]);

  useEffect(() => {
    let cancelled = false;

    setSeasons([]);
    setSeasonsLoading(true);
    setSeasonError('');

    const request =
      client.getTvSeriesGuide?.(seriesId)
      ?? Promise.resolve([]);

    void request
      .then((result) => {
        if (cancelled) return;

        setSeasons(result);

        setShownSeason((currentSeason) => {
          if (
            result.some(
              (season) =>
                season.seasonNumber === currentSeason,
            )
          ) {
            return currentSeason;
          }

          return (
            result[0]?.seasonNumber
            ?? activeSeason
          );
        });
      })
      .catch(() => {
        if (!cancelled) {
          setSeasonError(
            'Season guide is unavailable right now.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSeasonsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeSeason,
    client,
    seriesId,
  ]);

  useEffect(() => {
    let cancelled = false;

    setEpisodes([]);
    setEpisodesLoading(true);
    setEpisodeError('');

    const request =
      client.getTvSeason?.(
        seriesId,
        shownSeason,
      ) ?? Promise.resolve([]);

    void request
      .then((result) => {
        if (!cancelled) {
          setEpisodes(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEpisodeError(
            'Episodes are unavailable right now.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setEpisodesLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    client,
    seriesId,
    shownSeason,
  ]);

  const loading =
    seasonsLoading || episodesLoading;

  const error =
    episodeError || seasonError;

  return (
    <section
      className={`episode-browser ${
        compact
          ? 'episode-browser--compact'
          : ''
      }`}
      aria-label="Episode browser"
    >
      <header>
        <div>
          <span>Series guide</span>
          <h3>Episodes</h3>
        </div>

        {!canSelect && (
          <small>
            <LockKeyhole />
            Host chooses the episode
          </small>
        )}
      </header>

      <div
        className="season-pills"
        aria-label="Seasons"
      >
        {seasons.map((season) => (
          <button
            type="button"
            key={season.id}
            className={
              shownSeason ===
              season.seasonNumber
                ? 'active'
                : ''
            }
            aria-pressed={
              shownSeason ===
              season.seasonNumber
            }
            onClick={() =>
              setShownSeason(
                season.seasonNumber,
              )
            }
          >
            {season.name}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="episode-guide-state">
          <LoaderCircle className="spin" />
          Loading episodes
        </div>
      ) : error ? (
        <p className="episode-guide-state">
          {error}
        </p>
      ) : (
        <div className="episode-list">
          {episodes.map((episode) => {
            const active =
              shownSeason === activeSeason
              && episode.episodeNumber
                === activeEpisode;

            const still = imageUrl(
              episode.stillPath,
              'w500',
            );

            return (
              <button
                type="button"
                key={episode.id}
                className={
                  active ? 'active' : ''
                }
                aria-label={
                  `Play episode ${
                    episode.episodeNumber
                  } ${episode.name}`
                }
                disabled={
                  !canSelect && !active
                }
                onClick={() => {
                  if (canSelect) {
                    onSelect(
                      shownSeason,
                      episode.episodeNumber,
                    );
                  }
                }}
              >
                <span className="episode-still">
                  {still ? (
                    <img
                      src={still}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <Play />
                  )}

                  <b>
                    E{episode.episodeNumber}
                  </b>
                </span>

                <span className="episode-copy">
                  <strong>
                    {episode.name}
                  </strong>

                  <small>
                    {episode.overview
                      || 'Episode details are coming soon.'}
                  </small>

                  <em>
                    {episode.runtime
                      ? `${episode.runtime} min`
                      : episode.airDate.slice(
                          0,
                          4,
                        )}
                  </em>
                </span>

                {active && (
                  <span className="episode-now">
                    Now playing
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}