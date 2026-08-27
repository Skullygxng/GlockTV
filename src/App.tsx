import { FormEvent, lazy, Suspense, type TouchEvent, type WheelEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Bell, Bookmark, ChevronDown, ChevronUp, Compass, Film, Filter, LoaderCircle, Play, Search, SlidersHorizontal, Sparkles, Star, Users, X, Zap } from 'lucide-react';
import { FilterPanel, TitleModal, VibePanel } from './components/AppOverlays';
import { MediaCard } from './components/MediaCard';
import { PlaybackModal } from './components/PlaybackModal';
import { type DiscoveryFilters } from './lib/discovery';
import { composeDiscoverFeed, mergeFeed, sessionFeedSeed } from './lib/feed';
import { imageUrl, scoreMatch, type MediaItem } from './lib/media';
import { getPlaybackConfig, type PlaybackConfig } from './lib/playback';
import { initialSessionState, mediaKey, sanitizeSessionState, sessionReducer } from './lib/session';
import { createTmdbClient, type PreviewContext, type TitleContext, type TmdbClient } from './lib/tmdb';
import type { PartyPlaybackConfig } from './components/PartyPlaybackPlayer';
import type { WatchPartyService } from './lib/watchParty';

export interface AppProps {
  client?: TmdbClient;
  partyService?: WatchPartyService | null;
  playbackConfig?: PlaybackConfig;
  partyPlaybackConfig?: PartyPlaybackConfig;
}

type View = 'discover' | 'friends' | 'vibe' | 'list';
const FriendsRoute = lazy(() => import('./components/FriendsRoute').then((module) => ({ default: module.FriendsRoute })));
const defaultFilters: DiscoveryFilters = { contentType: 'both', genreIds: [], releaseEra: 'any', rating: null, runtime: 'any', sort: 'popularity' };
const genres = [[28, 'Action'], [35, 'Comedy'], [27, 'Horror'], [53, 'Thriller'], [878, 'Sci-Fi'], [80, 'Crime'], [10749, 'Romance'], [14, 'Fantasy']] as const;

function loadSession() {
  try {
    const saved = sessionStorage.getItem('glocktv-session');
    return saved ? sanitizeSessionState(JSON.parse(saved)) : initialSessionState;
  } catch {
    return initialSessionState;
  }
}

function Logo() {
  return <div className="logo" aria-label="GlockTV"><span><Play fill="currentColor" /></span><b>GLOCKTV</b></div>;
}

function LoadingState() {
  return <div className="state-panel"><LoaderCircle className="spin" /><strong>Loading your feed</strong><span>Finding something worth watching.</span></div>;
}
