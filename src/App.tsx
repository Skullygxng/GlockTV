import { FormEvent, lazy, Suspense, type TouchEvent, type WheelEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Bell, Bookmark, ChevronDown, ChevronRight, ChevronUp, Clapperboard,
  Compass, Film, Filter, LoaderCircle, Play, Search,
  SlidersHorizontal, Sparkles, Star, Users, X, Zap,
} from 'lucide-react';
import { MediaCard } from './components/MediaCard';
import { PlaybackModal } from './components/PlaybackModal';
import { type DiscoveryFilters, type ReleaseEra, type RuntimeFilter } from './lib/discovery';
import { imageUrl, scoreMatch, type MediaItem } from './lib/media';
import { getPlaybackConfig, type PlaybackConfig } from './lib/playback';
import {
  initialSessionState,
  mediaKey,
  sanitizeSessionState,
  sessionReducer,
} from './lib/session';
import {
  createTmdbClient,
  type PreviewContext,
  type TitleContext,
  type TmdbClient,
} from './lib/tmdb';
import type { PartyPlaybackConfig } from './components/PartyPlaybackPlayer';
import type { WatchPartyService } from './lib/watchParty';

export interface AppProps {
  client?: TmdbClient;
  partyService?: WatchPartyService | null;
  playbackConfig?: PlaybackConfig;
  partyPlaybackConfig?: PartyPlaybackConfig;
}
