import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Ban, ChevronDown, Copy, Crown, DoorOpen, Flag, LoaderCircle, LockKeyhole, Mail, MessageCircle, Play, Radio, RefreshCw, Search, Send, Settings, ShieldCheck, Sparkles, Trash2, UserCheck, UserMinus, Users, Volume2, VolumeX, X } from 'lucide-react';
import {
  encodeLoungeVote,
  loungeBallot,
  loungeNextUp,
  loungeShouldAdvance,
  tallyLoungeVotes,
  visiblePartyMessages,
} from '../lib/lounge';
import { imageUrl, type MediaItem } from '../lib/media';
import type { TmdbClient } from '../lib/tmdb';
import type { BannedPartyMember, PartyAccount, PartyMember, PartyMessage, PartyPresence, PartyRoom, PlaybackState, PublicPartyRoom, WatchPartyService } from '../lib/watchParty';
import { EpisodeBrowser } from './EpisodeBrowser';
import { PartyPlaybackPlayer, type PartyPlaybackConfig } from './PartyPlaybackPlayer';
import '../friends.css';
