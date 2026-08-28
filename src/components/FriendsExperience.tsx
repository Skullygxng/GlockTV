import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Ban, ChevronDown, Copy, Crown, DoorOpen, Flag, LoaderCircle, LockKeyhole, Mail, MessageCircle, Play, Radio, RefreshCw, Search, Send, Settings, ShieldCheck, Sparkles, Trash2, UserCheck, UserMinus, Users, Volume2, VolumeX, X } from 'lucide-react';
import { imageUrl, type MediaItem } from '../lib/media';
import type { TmdbClient } from '../lib/tmdb';
import type { BannedPartyMember, PartyAccount, PartyMember, PartyMessage, PartyPresence, PartyRoom, PlaybackState, PublicPartyRoom, WatchPartyService } from '../lib/watchParty';
import { encodeLoungeVote, isOfficialLounge, loungeBallot, loungeNextUp, loungeShouldAdvance, parseLoungeVote, tallyLoungeVotes, visibleRoomChat } from '../lib/lounge';
import { EpisodeBrowser } from './EpisodeBrowser';
import { InviteJoinCard } from './InviteJoinCard';
import { LoungeBallotPanel } from './LoungeBallotPanel';
import { PartyPlaybackPlayer, type PartyPlaybackConfig } from './PartyPlaybackPlayer';
import '../friends.css';

interface FriendsExperienceProps {
  client: TmdbClient;
  service: WatchPartyService | null;
  selectedTitle: MediaItem | null;
  initialRoomCode?: string;
  partyConfig: PartyPlaybackConfig;
}

const upsertMessage = (messages: PartyMessage[], message: PartyMessage) => messages.some((item) => item.id === message.id) ? messages : [...messages, message];

interface RecentRoom {
  code: string;
  titleName: string;
  wasHost: boolean;
}

const recentRoomKey = 'glocktv:recent-room:v1';

function readRecentRoom(): RecentRoom | null {
  try {
    const value = JSON.parse(localStorage.getItem(recentRoomKey) ?? 'null') as Partial<RecentRoom> | null;
    return value && typeof value.code === 'string' && typeof value.titleName === 'string'
      ? { code: value.code, titleName: value.titleName, wasHost: value.wasHost === true }
      : null;
  } catch {
    return null;
  }
}

function syncLabel(member: PartyMember) {
  if (member.syncStatus === 'synced') return 'Synced';
  if (member.syncStatus === 'limited') return 'Limited sync';
  if (member.syncStatus === 'drifting' && member.syncOffsetSeconds != null) {
    const seconds = Math.max(1, Math.round(Math.abs(member.syncOffsetSeconds)));
    return `${seconds}s ${member.syncOffsetSeconds < 0 ? 'behind' : 'ahead'}`;
  }
  return 'Connecting';
}

export function FriendsExperience({ client, service, selectedTitle, initialRoomCode = '', partyConfig }: FriendsExperienceProps) {
  const [nickname, setNickname] = useState(() => sessionStorage.getItem('glocktv-nickname') ?? '');
  const [roomCode, setRoomCode] = useState(initialRoomCode.toUpperCase());
  const [room, setRoom] = useState<PartyRoom | null>(null);
  const [publicRooms, setPublicRooms] = useState<PublicPartyRoom[]>([]);
  const [userId, setUserId] = useState('');
  const [members, setMembers] = useState<PartyMember[]>([]);
  const [messages, setMessages] = useState<PartyMessage[]>([]);
  const [message, setMessage] = useState('');
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MediaItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [recentRoom, setRecentRoom] = useState<RecentRoom | null>(readRecentRoom);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [removeConfirmId, setRemoveConfirmId] = useState('');
  const [transferConfirmId, setTransferConfirmId] = useState('');
  const [moderatingMemberId, setModeratingMemberId] = useState('');
  const [controlsOpen, setControlsOpen] = useState(false);
  const [clearChatConfirm, setClearChatConfirm] = useState(false);
  const [bannedMembers, setBannedMembers] = useState<BannedPartyMember[]>([]);
  const [blockedUsers, setBlockedUsers] = useState<string[]>([]);
  const [resyncToken, setResyncToken] = useState(0);
  const [resyncNotice, setResyncNotice] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);
  const [account, setAccount] = useState<PartyAccount | null>(null);
  const [accountEmail, setAccountEmail] = useState('');
  const [accountStatus, setAccountStatus] = useState('');
  const [loungePool, setLoungePool] = useState<MediaItem[]>(selectedTitle ? [selectedTitle] : []);
  const loungeAdvanceKey = useRef('');
  const messageList = useRef<HTMLDivElement>(null);
  const chatAtBottom = useRef(true);
  const previousMessageCount = useRef(0);
  const presence = useRef<PartyPresence>({ syncStatus: 'connecting', syncOffsetSeconds: null, serverId: null });
  const activeRoomId = useRef('');
  const messageMutationVersion = useRef(0);
  const snapshotVersion = useRef(0);
  const blockedUsersRef = useRef<string[]>([]);

  useEffect(() => {
    blockedUsersRef.current = blockedUsers;
  }, [blockedUsers]);

  useEffect(() => {
    if (!service) return;
    service.getAccount?.().then((nextAccount) => {
      setAccount(nextAccount);
      if (nextAccount?.email) setAccountEmail(nextAccount.email);
    }).catch(() => undefined);
  }, [service]);

  useEffect(() => {
    if (!service?.listPublicRooms || room) return;

    let active = true;
    const refreshPublicRooms = async () => {
      try {
        const nextRooms = await service.listPublicRooms();
        if (active) setPublicRooms(nextRooms);
      } catch {
        // Public room discovery is non-critical and retries on the next refresh.
      }
    };

    void refreshPublicRooms();
    const timer = window.setInterval(() => { void refreshPublicRooms(); }, 60_000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refreshPublicRooms();
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [room, service]);

  const exitRemovedRoom = useCallback((code: string) => {
    activeRoomId.current = '';
    snapshotVersion.current += 1;
    messageMutationVersion.current += 1;
    const url = new URL(window.location.href); url.searchParams.delete('room'); window.history.replaceState({}, '', url);
    const savedRoom = readRecentRoom();
    if (savedRoom?.code === code) { localStorage.removeItem(recentRoomKey); setRecentRoom(null); }
    setRoom(null); setMembers([]); setMessages([]); setRosterOpen(false); setControlsOpen(false); setRemoveConfirmId(''); setTransferConfirmId('');
    setError('The host removed you from this room.');
  }, []);

  const refreshMembers = useCallback(async (roomId: string) => {
    if (!service || activeRoomId.current !== roomId) return;
    const nextMembers = await service.getMembers(roomId);
    if (activeRoomId.current !== roomId) return;

    if (room?.id === roomId && userId && !room.isOfficial && !nextMembers.some((member) => member.userId === userId)) {
      exitRemovedRoom(room.code);
      return;
    }

    setMembers(nextMembers);
  }, [exitRemovedRoom, room?.code, room?.id, room?.isOfficial, service, userId]);

  const refreshSnapshot = useCallback(async (roomId: string) => {
    if (!service || activeRoomId.current !== roomId) return;

    const requestVersion = ++snapshotVersion.current;
    const messageVersionAtStart = messageMutationVersion.current;

    const [nextRoom, nextMembers, nextMessages, nextBlocked] = await Promise.all([
      service.getRoom(roomId),
      service.getMembers(roomId),
      service.getMessages(roomId),
      service.getBlockedUsers?.() ?? Promise.resolve([]),
    ]);

    if (
      activeRoomId.current !== roomId
      || requestVersion !== snapshotVersion.current
    ) {
      return;
    }

    if (
      userId
      && !nextRoom.isOfficial
      && !nextMembers.some((member) => member.userId === userId)
    ) {
      exitRemovedRoom(nextRoom.code);
      return;
    }

    setRoom(nextRoom);
    setMembers(nextMembers);
    blockedUsersRef.current = nextBlocked;
    setBlockedUsers(nextBlocked);

    if (messageMutationVersion.current === messageVersionAtStart) {
      setMessages(nextMessages.filter((item) => !nextBlocked.includes(item.userId)));
    }
  }, [exitRemovedRoom, service, userId]);

  const enterRoom = useCallback(async (nextRoom: PartyRoom, nextUserId: string) => {
    if (!service) return;

    activeRoomId.current = nextRoom.id;
    snapshotVersion.current += 1;
    messageMutationVersion.current += 1;

    const [nextMembers, nextMessages, nextBlocked] = await Promise.all([
      service.getMembers(nextRoom.id), service.getMessages(nextRoom.id), service.getBlockedUsers?.() ?? Promise.resolve([]),
    ]);

    if (activeRoomId.current !== nextRoom.id) return;

    chatAtBottom.current = true; previousMessageCount.current = 0; setUnreadMessages(0);
    blockedUsersRef.current = nextBlocked;
    setRoom(nextRoom); setUserId(nextUserId); setMembers(nextMembers); setBlockedUsers(nextBlocked);
    setMessages(nextMessages.filter((item) => !nextBlocked.includes(item.userId)));
    setLeaveConfirm(false); setRosterOpen(false);
    if (!nextRoom.isOfficial) {
      const nextRecentRoom = { code: nextRoom.code, titleName: nextRoom.titleName, wasHost: nextRoom.hostId === nextUserId };
      setRecentRoom(nextRecentRoom);
      localStorage.setItem(recentRoomKey, JSON.stringify(nextRecentRoom));
    }
    const url = new URL(window.location.href); url.searchParams.set('room', nextRoom.code); window.history.replaceState({}, '', url);
  }, [service]);

  useEffect(() => {
    if (!room || !isOfficialLounge(room)) return;
    let active = true;
    client.getTrending().then((items) => {
      if (!active) return;
      const seed = selectedTitle ? [selectedTitle, ...items] : items;
      const unique = new Map(seed.map((item) => [`${item.mediaType}:${item.id}`, item]));
      setLoungePool([...unique.values()]);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [client, room?.id, room?.isOfficial, room?.isPublic, selectedTitle]);

  useEffect(() => {
    if (!service || !room) return;

    return service.subscribe(room.id, {
      onRoom: (nextRoom) => {
        if (activeRoomId.current === nextRoom.id) setRoom(nextRoom);
      },
      onMessage: (next) => {
        messageMutationVersion.current += 1;
        if (!blockedUsersRef.current.includes(next.userId)) {
          setMessages((previous) => upsertMessage(previous, next));
        }
      },
      onMembersChanged: () => {
        if (activeRoomId.current !== room.id) return;
        void refreshMembers(room.id);
      },
      onChatCleared: () => {
        if (activeRoomId.current !== room.id) return;
        void refreshSnapshot(room.id);
      },
      onReady: () => {
        if (activeRoomId.current !== room.id) return;
        void refreshSnapshot(room.id);
      },
    });
  }, [refreshMembers, refreshSnapshot, room?.id, service]);

  useEffect(() => {
    if (!service || !room || !service.heartbeatRoom) return;
    let active = true;
    const heartbeat = async () => {
      if (!active || activeRoomId.current !== room.id) return;
      try {
        const nextRoom = await service.heartbeatRoom(room.id, presence.current);
        if (active && activeRoomId.current === room.id) setRoom(nextRoom);
      } catch {
        // Realtime and the recovery snapshot handle transient network loss/removal.
      }
    };
    void heartbeat();
    const timer = window.setInterval(() => { void heartbeat(); }, 20_000);
    const onVisibility = () => { if (document.visibilityState === 'visible') void heartbeat(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [room?.id, service]);

  useEffect(() => {
    if (!service || !room) return;

    const roomId = room.id;
    let active = true;

    const checkRoomState = async () => {
      if (!active || activeRoomId.current !== roomId) return;
      try {
        if (!room.isOfficial) {
          const membership = await service.getMembershipStatus(roomId);
          if (membership === 'removed') {
            if (active && activeRoomId.current === roomId) exitRemovedRoom(room.code);
            return;
          }
        }

        if (activeRoomId.current !== roomId) return;
        const nextRoom = await service.getRoom(roomId);
        if (active && activeRoomId.current === roomId) setRoom(nextRoom);
      } catch {
        // Realtime remains primary; the recovery pass handles transient failures.
      }
    };

    const recover = async () => {
      if (!active || activeRoomId.current !== roomId) return;
      try {
        if (!room.isOfficial) {
          const membership = await service.getMembershipStatus(roomId);
          if (membership === 'removed') {
            if (active && activeRoomId.current === roomId) exitRemovedRoom(room.code);
            return;
          }
        }

        if (active && activeRoomId.current === roomId) await refreshSnapshot(roomId);
      } catch {
        // A later heartbeat/recovery pass can repair a transient network failure.
      }
    };

    // One lightweight entry check preserves resilience if Realtime is slow to connect.
    void checkRoomState();

    const recoveryTimer = window.setInterval(() => { void recover(); }, 45_000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void recover();
    };

    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      active = false;
      window.clearInterval(recoveryTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [exitRemovedRoom, refreshSnapshot, room?.code, room?.id, room?.isOfficial, service]);

  useEffect(() => {
    const addedMessages = Math.max(0, messages.length - previousMessageCount.current);
    previousMessageCount.current = messages.length;
    if (!messages.length) { setUnreadMessages(0); return; }
    const latestMessage = messages[messages.length - 1];
    if (chatAtBottom.current || latestMessage.userId === userId) {
      setUnreadMessages(0);
      const list = messageList.current;
      if (list) list.scrollTop = list.scrollHeight;
    } else if (addedMessages) {
      setUnreadMessages((count) => count + addedMessages);
    }
  }, [messages.length, userId]);

  const handleChatScroll = () => {
    const list = messageList.current;
    if (!list) return;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= 48;
    chatAtBottom.current = atBottom;
    if (atBottom) setUnreadMessages(0);
  };

  const jumpToLatestMessage = () => {
    chatAtBottom.current = true;
    setUnreadMessages(0);
    const list = messageList.current;
    if (list) list.scrollTop = list.scrollHeight;
  };

  const rememberNickname = () => sessionStorage.setItem('glocktv-nickname', nickname.trim());

  const createParty = async () => {
    if (!service || !selectedTitle || !nickname.trim()) return;
    setBusy(true); setError('');
    try {
      rememberNickname();
      const user = await service.ensureUser();
      const nextRoom = await service.createRoom({
        nickname: nickname.trim(), titleId: selectedTitle.id, mediaType: selectedTitle.mediaType, titleName: selectedTitle.title,
        backdropPath: selectedTitle.backdropPath, durationSeconds: selectedTitle.runtime ? selectedTitle.runtime * 60 : null,
      });
      await enterRoom(nextRoom, user.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The room could not be created.'); }
    finally { setBusy(false); }
  };

  const joinCode = async (code: string) => {
    if (!service || !nickname.trim() || !code.trim()) return;
    setBusy(true); setError('');
    try {
      rememberNickname();
      const user = await service.ensureUser();
      const nextRoom = await service.joinRoom(code.trim().toUpperCase(), nickname.trim());
      await enterRoom(nextRoom, user.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'That room is unavailable.'); }
    finally { setBusy(false); }
  };

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    if (!service || !room || !message.trim() || members.find((member) => member.userId === userId)?.isMuted) return;
    const body = message.trim(); setMessage('');
    try {
      const sent = await service.sendMessage(room.id, nickname.trim(), body);
      messageMutationVersion.current += 1;
      setMessages((previous) => upsertMessage(previous, sent));
    }
    catch (reason) { setMessage(body); setError(reason instanceof Error ? reason.message : 'Message failed to send.'); }
  };

  const setMemberMuted = async (member: PartyMember) => {
    if (!service || !room || room.hostId !== userId || member.userId === userId) return;
    setModeratingMemberId(member.userId); setError('');
    try {
      await service.setMemberMuted(room.id, member.userId, !member.isMuted);
      setMembers((current) => current.map((item) => item.userId === member.userId ? { ...item, isMuted: !member.isMuted } : item));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'That member could not be muted.'); }
    finally { setModeratingMemberId(''); }
  };

  const removeMember = async (member: PartyMember) => {
    if (!service || !room || room.hostId !== userId || member.userId === userId) return;
    setModeratingMemberId(member.userId); setError('');
    try {
      await service.removeMember(room.id, member.userId);
      setMembers((current) => current.filter((item) => item.userId !== member.userId));
      setRemoveConfirmId('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'That member could not be removed.'); }
    finally { setModeratingMemberId(''); }
  };

  const setCohost = async (member: PartyMember) => {
    if (!service || !room || room.hostId !== userId) return;
    setModeratingMemberId(member.userId); setError('');
    try {
      await service.setCohost(room.id, member.userId, !member.isCohost);
      setMembers((current) => current.map((item) => item.userId === member.userId ? { ...item, isCohost: !member.isCohost } : item));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Co-host could not be changed.'); }
    finally { setModeratingMemberId(''); }
  };

  const transferHost = async (member: PartyMember) => {
    if (!service || !room || room.hostId !== userId) return;
    setModeratingMemberId(member.userId); setError('');
    try {
      setRoom(await service.transferHost(room.id, member.userId));
      setMembers((current) => current.map((item) => item.userId === userId ? { ...item, isCohost: true } : item.userId === member.userId ? { ...item, isCohost: false } : item));
      setTransferConfirmId('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Host control could not be transferred.'); }
    finally { setModeratingMemberId(''); }
  };

  const openRoomControls = async () => {
    if (!service || !room || room.hostId !== userId) return;
    setControlsOpen(true); setError('');
    try { setBannedMembers(await service.getBannedMembers(room.id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Removed people could not be loaded.'); }
  };

  const changeRoomControls = async (isLocked: boolean, slowModeSeconds: number) => {
    if (!service || !room || room.hostId !== userId) return;
    const optimistic = { ...room, isLocked, slowModeSeconds }; setRoom(optimistic);
    try { setRoom(await service.setRoomControls(room.id, { isLocked, slowModeSeconds })); }
    catch (reason) { setRoom(room); setError(reason instanceof Error ? reason.message : 'Room controls could not be changed.'); }
  };

  const clearRoomChat = async () => {
    if (!service || !room || room.hostId !== userId) return;
    try {
      await service.clearChat(room.id);
      messageMutationVersion.current += 1;
      setMessages([]);
      setClearChatConfirm(false);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Room chat could not be cleared.'); }
  };

  const unbanMember = async (member: BannedPartyMember) => {
    if (!service || !room || room.hostId !== userId) return;
    try { await service.unbanMember(room.id, member.userId); setBannedMembers((current) => current.filter((item) => item.userId !== member.userId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'That person could not be allowed back.'); }
  };

  const blockMember = async (member: PartyMember) => {
    if (!service || !room || member.userId === userId) return;
    const blocked = !blockedUsers.includes(member.userId);
    try {
      await service.blockUser(room.id, member.userId, blocked);
      setBlockedUsers((current) => blocked ? [...new Set([...current, member.userId])] : current.filter((id) => id !== member.userId));
      if (blocked) setMessages((current) => current.filter((item) => item.userId !== member.userId));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Block setting could not be changed.'); }
  };

  const reportMessage = async (item: PartyMessage) => {
    if (!service || item.userId === userId) return;
    try { await service.reportMessage(item.id, 'spam'); setResyncNotice('Report sent privately to GlockTV.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The message could not be reported.'); }
  };

  const changeRoomServer = async (serverId: string) => {
    if (!service || !room || room.hostId !== userId) return;
    try { setRoom(await service.setRoomServer(room.id, serverId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Room server could not be changed.'); }
  };

  const updateSyncHealth = (health: { status: PartyPresence['syncStatus']; offsetSeconds: number | null; serverId: string }) => {
    presence.current = { syncStatus: health.status, syncOffsetSeconds: health.offsetSeconds, serverId: health.serverId };
  };

  const requestResync = () => {
    setResyncToken((value) => value + 1);
    setResyncNotice(room?.hostId === userId ? 'Room resync sent to everyone.' : 'Resync requested from the room clock.');
    if (room) void refreshSnapshot(room.id);
    if (room?.hostId === userId) void updatePlayback(room.playbackState, room.playbackPosition);
    window.setTimeout(() => setResyncNotice(''), 2400);
  };

  const protectAccount = async () => {
    if (!service || !accountEmail.trim()) return;
    setAccountStatus(''); setError('');
    try { await service.linkEmail(accountEmail.trim()); setAccountStatus('Check your email to finish protecting this account.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Account email could not be linked.'); }
  };

  const emailSignInLink = async () => {
    if (!service || !accountEmail.trim()) return;
    setAccountStatus(''); setError('');
    try { await service.sendSignInLink(accountEmail.trim()); setAccountStatus('Sign-in link sent. Open it on this device.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Sign-in link could not be sent.'); }
  };

  const updatePlayback = async (state: PlaybackState, position: number) => {
    if (!service || !room || room.hostId !== userId) return;
    const optimistic = { ...room, playbackState: state, playbackPosition: Math.max(0, position), playbackUpdatedAt: new Date().toISOString() };
    setRoom(optimistic);
    try { await service.updatePlayback(room.id, state, position); } catch { setError('Playback did not sync.'); }
  };

  const searchTitles = async (event: FormEvent) => {
    event.preventDefault(); if (!query.trim()) return;
    setSearching(true); setError('');
    try { setResults(await client.search(query.trim())); } catch { setError('Title search is unavailable right now.'); }
    finally { setSearching(false); }
  };

  const chooseTitle = async (item: MediaItem) => {
    if (!service || !room || room.hostId !== userId) return;
    setSearching(true); setError('');
    try {
      const context = await client.getTitleContext(item);
      const nextRoom = await service.updateTitle(room.id, {
        titleId: context.details.id, mediaType: context.details.mediaType, titleName: context.details.title,
        backdropPath: context.details.backdropPath, durationSeconds: context.details.runtime ? context.details.runtime * 60 : null,
      });
      setRoom(nextRoom);
      const nextRecentRoom = { code: nextRoom.code, titleName: nextRoom.titleName, wasHost: nextRoom.hostId === userId };
      setRecentRoom(nextRecentRoom); localStorage.setItem(recentRoomKey, JSON.stringify(nextRecentRoom));
      setPickerOpen(false); setQuery(''); setResults([]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The room title could not be changed.'); }
    finally { setSearching(false); }
  };

  const chooseEpisode = async (seasonNumber: number, episodeNumber: number) => {
    if (!service || !room || room.hostId !== userId) return;
    try { setRoom(await service.updateEpisode(room.id, seasonNumber, episodeNumber)); }
    catch { setError('The episode could not be changed.'); }
  };

  const inviteUrl = (code: string) => {
    const url = new URL(window.location.href); url.searchParams.set('room', code);
    return url.toString();
  };

  const copyInvite = async () => {
    if (!room) return;
    await navigator.clipboard?.writeText(inviteUrl(room.code)); setCopied(true); window.setTimeout(() => setCopied(false), 1400);
  };

  const shareInvite = async () => {
    if (!room) return;
    const url = inviteUrl(room.code);
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: `GlockTV room ${room.code}`, text: `Join ${room.titleName} on GlockTV`, url });
        return;
      }
    } catch {
      // Fall through to clipboard when share is cancelled or unavailable.
    }
    await navigator.clipboard?.writeText(url); setCopied(true); window.setTimeout(() => setCopied(false), 1400);
  };

  const voteLoungeTitle = async (item: MediaItem) => {
    if (!service || !room || !isOfficialLounge(room)) return;
    try {
      const sent = await service.sendMessage(room.id, nickname.trim() || 'Guest', encodeLoungeVote(item));
      messageMutationVersion.current += 1;
      setMessages((previous) => upsertMessage(previous, sent));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Vote failed to send.'); }
  };

  const confirmLeaveRoom = async () => {
    const leaving = room;
    activeRoomId.current = '';
    snapshotVersion.current += 1;
    messageMutationVersion.current += 1;
    const url = new URL(window.location.href); url.searchParams.delete('room'); window.history.replaceState({}, '', url);
    setRoom(null); setMembers([]); setMessages([]); setError(''); setLeaveConfirm(false); setRosterOpen(false); setControlsOpen(false); setRemoveConfirmId(''); setTransferConfirmId('');
    if (service && leaving) await service.leaveRoom(leaving.id, userId).catch(() => undefined);
    if (service?.listPublicRooms) service.listPublicRooms().then(setPublicRooms).catch(() => undefined);
  };

  useEffect(() => {
    if (!service || !room || !isOfficialLounge(room)) return;
    if (!loungeShouldAdvance({
      durationSeconds: room.durationSeconds,
      playbackPosition: room.playbackPosition,
      playbackState: room.playbackState,
      playbackUpdatedAt: room.playbackUpdatedAt,
    })) return;
    const next = loungeNextUp(loungePool, room.titleId, tallyLoungeVotes(messages, room.playbackUpdatedAt));
    if (!next || next.id === room.titleId) return;
    const advanceKey = `${room.id}:${room.titleId}:${next.id}`;
    if (loungeAdvanceKey.current === advanceKey) return;
    loungeAdvanceKey.current = advanceKey;
    let cancelled = false;
    void (async () => {
      try {
        const context = await client.getTitleContext(next);
        if (cancelled || activeRoomId.current !== room.id) return;
        const nextRoom = await service.applyOfficialLoungeTitle(room.id, {
          titleId: context.details.id, mediaType: context.details.mediaType, titleName: context.details.title,
          backdropPath: context.details.backdropPath, durationSeconds: context.details.runtime ? context.details.runtime * 60 : null,
        });
        if (!cancelled && activeRoomId.current === room.id) setRoom(nextRoom);
      } catch {
        loungeAdvanceKey.current = '';
      }
    })();
    return () => { cancelled = true; };
  }, [client, loungePool, messages, room, service]);

  if (!room) {
    const heroImage = imageUrl(selectedTitle?.backdropPath ?? null, 'w1280');
    return <motion.section className="friends-lobby friends-lobby--cinematic" aria-label="Friends watch party" initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={heroImage ? { '--room-backdrop': `url(${heroImage})` } as React.CSSProperties : undefined}>
      <div className="friends-hero">
        <span><Users /> Friends</span><h1>Movie night,<br />together.</h1>
        <p>Watch the full movie or episode in sync. The host controls playback while everyone shares the moment.</p>
      </div>
      <div className="friends-entry">
        <div className="friends-identity-row"><label>Your nickname<input aria-label="Your nickname" maxLength={24} value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="How people see you" /></label><button type="button" aria-label="Open account" onClick={() => setAccountOpen((open) => !open)}><ShieldCheck /> {account?.email ? 'Account saved' : 'Protect account'}</button></div>
        {accountOpen && <section className="friends-account" aria-label="Optional account">
          <header><div><Mail /><span>Optional account</span></div><button type="button" aria-label="Close account" onClick={() => setAccountOpen(false)}><X /></button></header>
          <strong>Keep the same identity across devices</strong>
          <p>Your rooms stay guest-friendly. Adding email protects this anonymous identity and makes bans, hosting, and future watch history persistent.</p>
          <input type="email" aria-label="Account email" value={accountEmail} onChange={(event) => setAccountEmail(event.target.value)} placeholder="you@example.com" />
          <div><button type="button" onClick={() => void protectAccount()} disabled={!accountEmail.trim()}><ShieldCheck /> Protect guest account</button><button type="button" onClick={() => void emailSignInLink()} disabled={!accountEmail.trim()}><Mail /> Email sign-in link</button></div>
          {accountStatus && <small>{accountStatus}</small>}
        </section>}
        {recentRoom && <section className="resume-room-card" aria-label="Recent watch party">
          <div><small>{recentRoom.wasHost ? 'Your private room' : 'Recent room'}</small><strong>{recentRoom.titleName}</strong><span>Room {recentRoom.code} · pick up where you left off</span></div>
          <button type="button" aria-label={`${recentRoom.wasHost ? 'Resume hosting' : 'Rejoin'} ${recentRoom.titleName}`} onClick={() => void joinCode(recentRoom.code)} disabled={busy || !service || !nickname.trim()}><Play fill="currentColor" /> {recentRoom.wasHost ? 'Resume hosting' : 'Rejoin room'}</button>
        </section>}
        <section className="public-rooms" aria-label="Public rooms">
          <header><div><Radio /><span>Public now</span></div><small>Open to everyone</small></header>
          {publicRooms.length ? publicRooms.map((publicRoom) => <article key={publicRoom.id} className="public-room-card" style={imageUrl(publicRoom.backdropPath, 'w780') ? { '--public-backdrop': `url(${imageUrl(publicRoom.backdropPath, 'w780')})` } as React.CSSProperties : undefined}>
            <div><span><i /> GlockTV Lounge</span><strong>{publicRoom.titleName}</strong><small>{publicRoom.mediaType === 'tv' ? `Season ${publicRoom.seasonNumber} · Episode ${publicRoom.episodeNumber}` : 'Full movie'} · {Math.max(1, publicRoom.audienceCount)} watching</small></div>
            <button type="button" onClick={() => void joinCode(publicRoom.code)} disabled={busy || !nickname.trim()}><Play fill="currentColor" /> Join room</button>
          </article>) : <div className="public-room-card public-room-card--loading"><LoaderCircle className="spin" /><span>Finding the public lounge...</span></div>}
        </section>
        <section className="private-room-entry">
          <header><div><LockKeyhole /><span>Private room</span></div><small>Invite-only</small></header>
          <div className="private-room-entry__actions">
            <div><small>From your Discover feed</small><strong>{selectedTitle?.title ?? 'Choose a title first'}</strong><span>{selectedTitle ? (selectedTitle.mediaType === 'movie' ? 'Full movie ready' : 'Season 1 · Episode 1 ready') : 'Return to Discover and pick what to watch'}</span></div>
            <button type="button" onClick={() => void createParty()} disabled={busy || !service || !nickname.trim() || !selectedTitle}><Sparkles /> Create private room</button>
          </div>
          {initialRoomCode && <p className="invite-ready"><span className="live-dot" /> Invite ready · finish your nickname, then join.</p>}
          <div className="room-code-row"><input aria-label="Room code" maxLength={6} value={roomCode} onChange={(event) => setRoomCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="ENTER CODE" /><button type="button" aria-label={initialRoomCode ? 'Join invite' : 'Join'} onClick={() => void joinCode(roomCode)} disabled={busy || !service || !nickname.trim() || roomCode.length !== 6}><DoorOpen /> {initialRoomCode ? 'Join invite' : 'Join'}</button></div>
        </section>
        {!service && <p className="friends-error">Friends is not connected yet.</p>}{error && <p className="friends-error" role="alert">{error}</p>}
      </div>
    </motion.section>;
  }

  const isHost = room.hostId === userId;
  const currentMember = members.find((member) => member.userId === userId);
  const chatMuted = currentMember?.isMuted === true;
  const officialLounge = isOfficialLounge(room);
  const visibleMessages = visibleRoomChat(
    messages.filter((item) => !blockedUsers.includes(item.userId)),
    officialLounge ? room : null,
  );
  const loungeVotes = officialLounge ? tallyLoungeVotes(messages, room.playbackUpdatedAt) : [];
  const loungeCandidates = officialLounge ? loungeBallot(loungePool, room.titleId) : [];
  const currentLoungeVote = officialLounge ? [...messages].reverse().map(parseLoungeVote).find((vote) => vote?.userId === userId) : null;

  const latestVisibleMessage = visibleMessages[visibleMessages.length - 1];
  return <motion.section className="watch-party watch-party--cinematic" aria-label={`Watch party ${room.code}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
    <header className="watch-party__header">
      <div><span className="live-dot" /> {room.isPublic ? 'Public lounge' : 'Private room'} <strong>{room.code}</strong>{isHost && <em>Host</em>}</div>
      <div className="watch-party__header-actions">
        {isHost && <button type="button" aria-label="Room controls" onClick={() => void openRoomControls()}><Settings /> Room controls</button>}
        <button type="button" onClick={() => void copyInvite()}><Copy /> {copied ? 'Copied' : 'Copy invite'}</button>
        {leaveConfirm ? <div className="leave-room-confirm"><button type="button" aria-label="Stay in room" onClick={() => setLeaveConfirm(false)}>Stay</button><button type="button" aria-label="Confirm leave room" onClick={() => void confirmLeaveRoom()}><DoorOpen /> {isHost ? 'Transfer or close' : 'Leave room'}</button></div> : <button type="button" onClick={() => setLeaveConfirm(true)}><DoorOpen /> Leave</button>}
      </div>
    </header>
    <div className="watch-party__layout">
      <section className="party-screen">
        <PartyPlaybackPlayer room={room} config={partyConfig} isHost={isHost} onHostCommand={(state, position) => void updatePlayback(state, position)} onHostServerChange={(serverId) => void changeRoomServer(serverId)} onSyncHealth={updateSyncHealth} resyncToken={resyncToken} />
        <div className="party-title-row"><div><span>{room.mediaType === 'tv' ? `Season ${room.seasonNumber} · Episode ${room.episodeNumber}` : 'Now watching'}</span><h1>{room.titleName}</h1>{room.isOfficial && <p className="official-room-note"><Radio /> Automated GlockTV host keeps the public lounge on one shared timeline.</p>}</div><div className="party-title-actions">{isHost && <button type="button" onClick={() => setPickerOpen(true)}><Search /> Change title</button>}<button type="button" aria-label={isHost ? 'Resync everyone' : 'Resync me'} onClick={requestResync}><RefreshCw /> {isHost ? 'Resync everyone' : 'Resync me'}</button><div className="party-sync"><span className="live-dot" /> {room.playbackState === 'playing' ? 'Playing' : 'Paused'} · room clock</div></div></div>
        {room.mediaType === 'tv' && <EpisodeBrowser compact client={client} seriesId={room.titleId} activeSeason={room.seasonNumber ?? 1} activeEpisode={room.episodeNumber ?? 1} canSelect={isHost} onSelect={(season, episode) => void chooseEpisode(season, episode)} />}
        {resyncNotice && <p className="party-notice" role="status">{resyncNotice}</p>}{error && <p className="friends-error" role="alert">{error}</p>}
      </section>
      <aside className="party-chat" aria-label="Audience chat">
        <header><div><MessageCircle /><strong>Audience chat</strong></div>{unreadMessages > 0 && latestVisibleMessage && <button className="party-chat-latest" type="button" aria-label="Jump to latest message" title={`${latestVisibleMessage.nickname}: ${latestVisibleMessage.body}`} onClick={jumpToLatestMessage}><span className="party-chat-latest__pulse" /><strong>{unreadMessages} new</strong><ChevronDown /></button>}<button className="party-audience-button" type="button" aria-label={rosterOpen ? 'Hide people in this room' : 'Show people in this room'} aria-expanded={rosterOpen} onClick={() => setRosterOpen((open) => !open)}><Users /> {members.length}</button></header>
        <InviteJoinCard code={room.code} titleName={room.titleName} copied={copied} onCopy={() => void copyInvite()} onShare={() => void shareInvite()} />
        {officialLounge && <LoungeBallotPanel candidates={loungeCandidates} tallies={loungeVotes} currentVoteTitleId={currentLoungeVote?.titleId} disabled={chatMuted} onVote={(item) => void voteLoungeTitle(item)} />}
        {controlsOpen && isHost && <section className="party-controls" role="dialog" aria-label="Room control panel">
          <header><div><Settings /><strong>Room controls</strong></div><button type="button" aria-label="Close room controls" onClick={() => setControlsOpen(false)}><X /></button></header>
          <button type="button" aria-label={room.isLocked ? 'Unlock new joins' : 'Lock new joins'} onClick={() => void changeRoomControls(!room.isLocked, room.slowModeSeconds ?? 0)}>{room.isLocked ? <LockKeyhole /> : <ShieldCheck />}<span><strong>{room.isLocked ? 'Room locked' : 'Lock new joins'}</strong><small>{room.isLocked ? 'Only existing members can return' : 'Stop anyone new from entering'}</small></span></button>
          <label>Chat slow mode<select aria-label="Chat slow mode" value={room.slowModeSeconds ?? 0} onChange={(event) => void changeRoomControls(room.isLocked ?? false, Number(event.target.value))}><option value="0">Off</option><option value="3">3 seconds</option><option value="5">5 seconds</option><option value="10">10 seconds</option><option value="15">15 seconds</option><option value="30">30 seconds</option></select></label>
          {clearChatConfirm ? <div className="party-controls__confirm"><span>Clear every message?</span><button type="button" aria-label="Cancel clear room chat" onClick={() => setClearChatConfirm(false)}>Cancel</button><button type="button" aria-label="Confirm clear room chat" onClick={() => void clearRoomChat()}>Clear</button></div> : <button type="button" aria-label="Clear room chat" onClick={() => setClearChatConfirm(true)}><Trash2 /><span><strong>Clear chat</strong><small>Remove the room conversation</small></span></button>}
          <div className="party-controls__bans"><small>Removed people</small>{bannedMembers.length ? bannedMembers.map((member) => <div key={member.userId}><span><strong>{member.nickname}</strong><small>Blocked from this room</small></span><button type="button" aria-label={`Allow ${member.nickname} to rejoin`} onClick={() => void unbanMember(member)}>Allow back</button></div>) : <p>No one is currently removed.</p>}</div>
        </section>}
        {rosterOpen && <section className="party-roster" role="dialog" aria-label="People in this room">
          <header><div><small>Watching now</small><strong>{members.length} {members.length === 1 ? 'person' : 'people'}</strong></div><button type="button" aria-label="Close people list" onClick={() => setRosterOpen(false)}><X /></button></header>
          <ul>{members.map((member) => <li key={member.userId} className={member.isMuted ? 'is-muted' : ''}>
            <span>{member.nickname.slice(0, 1).toUpperCase()}</span>
            <div className="party-roster__identity"><strong>{member.nickname}</strong><small>{member.userId === userId ? 'You · ' : ''}{syncLabel(member)}</small>{member.isMuted && <small>Muted</small>}</div>
            <div className="party-roster__badges">{member.userId === room.hostId && <em>Host</em>}{member.isCohost && <em>Co-host</em>}</div>
            {member.userId !== userId && <div className="party-roster__actions">
              <button type="button" aria-label={`${blockedUsers.includes(member.userId) ? 'Unblock' : 'Block'} ${member.nickname}`} title="Personal block" onClick={() => void blockMember(member)}>{blockedUsers.includes(member.userId) ? <UserCheck /> : <Ban />}</button>
              {isHost && member.userId !== room.hostId && <>
                <button type="button" aria-label={`${member.isCohost ? 'Remove' : 'Make'} ${member.nickname} co-host`} title="Co-host" onClick={() => void setCohost(member)} disabled={moderatingMemberId === member.userId}><Crown /></button>
                <button type="button" aria-label={`Transfer host to ${member.nickname}`} title="Transfer host" onClick={() => setTransferConfirmId(member.userId)}><UserCheck /></button>
                <button type="button" aria-label={`${member.isMuted ? 'Unmute' : 'Mute'} ${member.nickname}`} title={member.isMuted ? 'Unmute chat' : 'Mute chat'} onClick={() => void setMemberMuted(member)} disabled={moderatingMemberId === member.userId}>{member.isMuted ? <Volume2 /> : <VolumeX />}</button>
                <button type="button" aria-label={`Remove ${member.nickname}`} title="Remove from room" onClick={() => setRemoveConfirmId(member.userId)}><UserMinus /></button>
              </>}
            </div>}
            {transferConfirmId === member.userId && <div className="party-roster__confirm"><small>Make host?</small><button type="button" aria-label={`Cancel transfer host to ${member.nickname}`} onClick={() => setTransferConfirmId('')}>No</button><button type="button" aria-label={`Confirm transfer host to ${member.nickname}`} onClick={() => void transferHost(member)} disabled={moderatingMemberId === member.userId}>Yes</button></div>}
            {removeConfirmId === member.userId && <div className="party-roster__confirm"><small>Remove?</small><button type="button" aria-label={`Cancel remove ${member.nickname}`} onClick={() => setRemoveConfirmId('')}>No</button><button type="button" aria-label={`Confirm remove ${member.nickname}`} onClick={() => void removeMember(member)} disabled={moderatingMemberId === member.userId}>Yes</button></div>}
          </li>)}</ul>
        </section>}
        <div className="party-members" aria-label="People in this room">{members.map((member) => <span key={member.userId} title={member.nickname}>{member.nickname.slice(0, 1).toUpperCase()}</span>)}</div>
        <div className="party-messages-shell">
          <div ref={messageList} className="party-messages" role="log" aria-label="Chat messages" aria-live="polite" onScroll={handleChatScroll}>{!visibleMessages.length && <div className="party-chat__empty"><MessageCircle /><strong>The room is quiet</strong><span>Say hello to everyone watching.</span></div>}{visibleMessages.map((item) => <article key={item.id} className={item.userId === userId ? 'mine' : ''}><header><strong>{item.nickname}</strong><span><time>{new Date(item.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>{item.userId !== userId && <button type="button" aria-label={`Report message from ${item.nickname}`} title="Report privately" onClick={() => void reportMessage(item)}><Flag /></button>}</span></header><p>{item.body}</p></article>)}</div>
        </div>
        <form className={`party-compose${chatMuted ? ' party-compose--muted' : ''}`} onSubmit={(event) => void sendMessage(event)}><input aria-label="Message the room" maxLength={500} value={message} onChange={(event) => setMessage(event.target.value)} placeholder={chatMuted ? 'Chat muted by host' : room.slowModeSeconds ? `Slow mode · ${room.slowModeSeconds}s` : 'Message the room...'} disabled={chatMuted} /><button type="submit" aria-label="Send message" disabled={chatMuted || !message.trim()}><Send /></button>{chatMuted && <span><VolumeX /> Muted by host</span>}{room.isOfficial && !chatMuted && <span><ShieldCheck /> Public chat blocks spam and links</span>}</form>
      </aside>
    </div>
    {pickerOpen && <div className="party-picker-backdrop"><section className="party-picker" role="dialog" aria-modal="true" aria-label="Change watch party title"><header><div><span>Host controls</span><h2>Choose the full title</h2></div><button type="button" aria-label="Close title picker" onClick={() => setPickerOpen(false)}><X /></button></header><form onSubmit={(event) => void searchTitles(event)}><Search /><input autoFocus aria-label="Search watch party titles" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search movies and TV shows" /><button type="submit" aria-label="Search titles" disabled={searching || !query.trim()}>{searching ? <LoaderCircle className="spin" /> : 'Search'}</button></form><div className="party-picker__results">{results.map((item) => <button type="button" key={`${item.mediaType}-${item.id}`} aria-label={`Choose ${item.title}`} onClick={() => void chooseTitle(item)} disabled={searching}>{imageUrl(item.posterPath, 'w185') ? <img src={imageUrl(item.posterPath, 'w185')!} alt="" /> : <span className="party-picker__poster"><Play /></span>}<span><strong>{item.title}</strong><small>{item.year} · {item.mediaType === 'movie' ? 'Movie' : 'TV show'}</small></span></button>)}</div></section></div>}
  </motion.section>;
}
