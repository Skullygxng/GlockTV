import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Copy, DoorOpen, LoaderCircle, LockKeyhole, MessageCircle, Play, Radio, Search, Send, Sparkles, Users, X } from 'lucide-react';
import { imageUrl, type MediaItem } from '../lib/media';
import type { TmdbClient } from '../lib/tmdb';
import type { PartyMember, PartyMessage, PartyRoom, PlaybackState, PublicPartyRoom, WatchPartyService } from '../lib/watchParty';
import { EpisodeBrowser } from './EpisodeBrowser';
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

export function FriendsExperience({ client, service, selectedTitle, initialRoomCode = '', partyConfig }: FriendsExperienceProps) {
  const [nickname, setNickname] = useState(() => sessionStorage.getItem('glocktv-nickname') ?? '');
  const [roomCode, setRoomCode] = useState(initialRoomCode.toUpperCase());
  const [room, setRoom] = useState<PartyRoom | null>(null);
  const [publicRooms, setPublicRooms] = useState<PublicPartyRoom[]>([]);
  const [userId, setUserId] = useState('');
  const [members, setMembers] = useState<PartyMember[]>([]);
  const [messages, setMessages] = useState<PartyMessage[]>([]);
  const [message, setMessage] = useState('');
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
  const messageEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!service?.listPublicRooms) return;
    service.listPublicRooms().then(setPublicRooms).catch(() => undefined);
  }, [service]);

  const refreshMembers = useCallback(async (roomId: string) => { if (service) setMembers(await service.getMembers(roomId)); }, [service]);
  const refreshSnapshot = useCallback(async (roomId: string) => {
    if (!service) return;
    const [nextRoom, nextMembers, nextMessages] = await Promise.all([service.getRoom(roomId), service.getMembers(roomId), service.getMessages(roomId)]);
    setRoom(nextRoom); setMembers(nextMembers); setMessages((previous) => nextMessages.reduce(upsertMessage, previous));
  }, [service]);

  const enterRoom = useCallback(async (nextRoom: PartyRoom, nextUserId: string) => {
    if (!service) return;
    const [nextMembers, nextMessages] = await Promise.all([service.getMembers(nextRoom.id), service.getMessages(nextRoom.id)]);
    setRoom(nextRoom); setUserId(nextUserId); setMembers(nextMembers); setMessages(nextMessages);
    setLeaveConfirm(false); setRosterOpen(false);
    if (!nextRoom.isOfficial) {
      const nextRecentRoom = { code: nextRoom.code, titleName: nextRoom.titleName, wasHost: nextRoom.hostId === nextUserId };
      setRecentRoom(nextRecentRoom);
      localStorage.setItem(recentRoomKey, JSON.stringify(nextRecentRoom));
    }
    const url = new URL(window.location.href); url.searchParams.set('room', nextRoom.code); window.history.replaceState({}, '', url);
  }, [service]);

  useEffect(() => {
    if (!service || !room) return;
    return service.subscribe(room.id, {
      onRoom: setRoom,
      onMessage: (next) => setMessages((previous) => upsertMessage(previous, next)),
      onMembersChanged: () => { void refreshMembers(room.id); },
      onReady: () => { void refreshSnapshot(room.id); },
    });
  }, [refreshMembers, refreshSnapshot, room?.id, service]);

  useEffect(() => {
    if (!service || !room) return;
    const roomId = room.id;
    let active = true;
    const pollRoom = async () => {
      try {
        const nextRoom = await service.getRoom(roomId);
        if (active) setRoom(nextRoom);
      } catch {
        // Realtime remains primary; the next poll can recover from a transient request failure.
      }
    };
    void pollRoom();
    const roomTimer = window.setInterval(() => { void pollRoom(); }, 2000);
    const snapshotTimer = window.setInterval(() => { void refreshSnapshot(roomId); }, 6000);
    return () => {
      active = false;
      window.clearInterval(roomTimer);
      window.clearInterval(snapshotTimer);
    };
  }, [refreshSnapshot, room?.id, service]);

  useEffect(() => { messageEnd.current?.scrollIntoView?.({ behavior: 'smooth' }); }, [messages.length]);

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
    if (!service || !room || !message.trim()) return;
    const body = message.trim(); setMessage('');
    try {
      const sent = await service.sendMessage(room.id, nickname.trim(), body);
      setMessages((previous) => upsertMessage(previous, sent));
    }
    catch { setMessage(body); setError('Message failed to send.'); }
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

  const copyInvite = async () => {
    if (!room) return;
    const url = new URL(window.location.href); url.searchParams.set('room', room.code);
    await navigator.clipboard?.writeText(url.toString()); setCopied(true); window.setTimeout(() => setCopied(false), 1400);
  };

  const confirmLeaveRoom = async () => {
    if (service && room) await service.leaveRoom(room.id, userId).catch(() => undefined);
    const url = new URL(window.location.href); url.searchParams.delete('room'); window.history.replaceState({}, '', url);
    setRoom(null); setMembers([]); setMessages([]); setError(''); setLeaveConfirm(false); setRosterOpen(false);
    if (service?.listPublicRooms) service.listPublicRooms().then(setPublicRooms).catch(() => undefined);
  };

  if (!room) {
    const heroImage = imageUrl(selectedTitle?.backdropPath ?? null, 'original');
    return <motion.section className="friends-lobby friends-lobby--cinematic" aria-label="Friends watch party" initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={heroImage ? { '--room-backdrop': `url(${heroImage})` } as React.CSSProperties : undefined}>
      <div className="friends-hero">
        <span><Users /> Friends</span><h1>Movie night,<br />together.</h1>
        <p>Watch the full movie or episode in sync. The host controls playback while everyone shares the moment.</p>
      </div>
      <div className="friends-entry">
        <label>Your nickname<input aria-label="Your nickname" maxLength={24} value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="How people see you" /></label>
        {recentRoom && <section className="resume-room-card" aria-label="Recent watch party">
          <div><small>{recentRoom.wasHost ? 'Your private room' : 'Recent room'}</small><strong>{recentRoom.titleName}</strong><span>Room {recentRoom.code} · pick up where you left off</span></div>
          <button type="button" aria-label={`${recentRoom.wasHost ? 'Resume hosting' : 'Rejoin'} ${recentRoom.titleName}`} onClick={() => void joinCode(recentRoom.code)} disabled={busy || !service || !nickname.trim()}><Play fill="currentColor" /> {recentRoom.wasHost ? 'Resume hosting' : 'Rejoin room'}</button>
        </section>}
        <section className="public-rooms" aria-label="Public rooms">
          <header><div><Radio /><span>Public now</span></div><small>Open to everyone</small></header>
          {publicRooms.length ? publicRooms.map((publicRoom) => <article key={publicRoom.id} className="public-room-card" style={imageUrl(publicRoom.backdropPath, 'w780') ? { '--public-backdrop': `url(${imageUrl(publicRoom.backdropPath, 'w780')})` } as React.CSSProperties : undefined}>
            <div><span><i /> GlockTV Lounge</span><strong>{publicRoom.titleName}</strong><small>{publicRoom.mediaType === 'tv' ? `Season ${publicRoom.seasonNumber} · Episode ${publicRoom.episodeNumber}` : 'Full movie'} · {Math.max(1, publicRoom.audienceCount)} watching</small></div>
            <button type="button" onClick={() => void joinCode(publicRoom.code)} disabled={busy || !nickname.trim()}><Play fill="currentColor" /> Join room</button>
          </article>) : <div className="public-room-card public-room-card--loading"><LoaderCircle className="spin" /><span>Finding the public lounge…</span></div>}
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
  return <motion.section className="watch-party watch-party--cinematic" aria-label={`Watch party ${room.code}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
    <header className="watch-party__header">
      <div><span className="live-dot" /> {room.isPublic ? 'Public lounge' : 'Private room'} <strong>{room.code}</strong>{isHost && <em>Host</em>}</div>
      <div className="watch-party__header-actions"><button type="button" onClick={() => void copyInvite()}><Copy /> {copied ? 'Copied' : 'Copy invite'}</button>{leaveConfirm ? <div className="leave-room-confirm"><button type="button" aria-label="Stay in room" onClick={() => setLeaveConfirm(false)}>Stay</button><button type="button" aria-label="Confirm leave room" onClick={() => void confirmLeaveRoom()}><DoorOpen /> {isHost ? 'Exit to lobby' : 'Leave room'}</button></div> : <button type="button" onClick={() => setLeaveConfirm(true)}><DoorOpen /> Leave</button>}</div>
    </header>
    <div className="watch-party__layout">
      <section className="party-screen">
        <PartyPlaybackPlayer room={room} config={partyConfig} isHost={isHost} onHostCommand={(state, position) => void updatePlayback(state, position)} />
        <div className="party-title-row"><div><span>{room.mediaType === 'tv' ? `Season ${room.seasonNumber} · Episode ${room.episodeNumber}` : 'Now watching'}</span><h1>{room.titleName}</h1>{room.isOfficial && <p className="official-room-note"><Radio /> Automated GlockTV host keeps the public lounge on one shared timeline.</p>}</div><div className="party-title-actions">{isHost && <button type="button" onClick={() => setPickerOpen(true)}><Search /> Change title</button>}<div className="party-sync"><span className="live-dot" /> {room.playbackState === 'playing' ? 'Playing' : 'Paused'} · room clock</div></div></div>
        {room.mediaType === 'tv' && <EpisodeBrowser compact client={client} seriesId={room.titleId} activeSeason={room.seasonNumber ?? 1} activeEpisode={room.episodeNumber ?? 1} canSelect={isHost} onSelect={(season, episode) => void chooseEpisode(season, episode)} />}
        {error && <p className="friends-error" role="alert">{error}</p>}
      </section>
      <aside className="party-chat" aria-label="Audience chat">
        <header><div><MessageCircle /><strong>Audience chat</strong></div><button className="party-audience-button" type="button" aria-label={rosterOpen ? 'Hide people in this room' : 'Show people in this room'} aria-expanded={rosterOpen} onClick={() => setRosterOpen((open) => !open)}><Users /> {members.length}</button></header>
        {rosterOpen && <section className="party-roster" role="dialog" aria-label="People in this room">
          <header><div><small>Watching now</small><strong>{members.length} {members.length === 1 ? 'person' : 'people'}</strong></div><button type="button" aria-label="Close people list" onClick={() => setRosterOpen(false)}><X /></button></header>
          <ul>{members.map((member) => <li key={member.userId}><span>{member.nickname.slice(0, 1).toUpperCase()}</span><div><strong>{member.nickname}</strong>{member.userId === userId && <small>You</small>}</div>{member.userId === room.hostId && <em>Host</em>}</li>)}</ul>
        </section>}
        <div className="party-members" aria-label="People in this room">{members.map((member) => <span key={member.userId} title={member.nickname}>{member.nickname.slice(0, 1).toUpperCase()}</span>)}</div>
        <div className="party-messages" aria-live="polite">{!messages.length && <div className="party-chat__empty"><MessageCircle /><strong>The room is quiet</strong><span>Say hello to everyone watching.</span></div>}{messages.map((item) => <article key={item.id} className={item.userId === userId ? 'mine' : ''}><header><strong>{item.nickname}</strong><time>{new Date(item.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></header><p>{item.body}</p></article>)}<div ref={messageEnd} /></div>
        <form className="party-compose" onSubmit={(event) => void sendMessage(event)}><input aria-label="Message the room" maxLength={500} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Message the room…" /><button type="submit" aria-label="Send message" disabled={!message.trim()}><Send /></button></form>
      </aside>
    </div>
    {pickerOpen && <div className="party-picker-backdrop"><section className="party-picker" role="dialog" aria-modal="true" aria-label="Change watch party title"><header><div><span>Host controls</span><h2>Choose the full title</h2></div><button type="button" aria-label="Close title picker" onClick={() => setPickerOpen(false)}><X /></button></header><form onSubmit={(event) => void searchTitles(event)}><Search /><input autoFocus aria-label="Search watch party titles" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search movies and TV shows" /><button type="submit" aria-label="Search titles" disabled={searching || !query.trim()}>{searching ? <LoaderCircle className="spin" /> : 'Search'}</button></form><div className="party-picker__results">{results.map((item) => <button type="button" key={`${item.mediaType}-${item.id}`} aria-label={`Choose ${item.title}`} onClick={() => void chooseTitle(item)} disabled={searching}>{imageUrl(item.posterPath, 'w185') ? <img src={imageUrl(item.posterPath, 'w185')!} alt="" /> : <span className="party-picker__poster"><Play /></span>}<span><strong>{item.title}</strong><small>{item.year} · {item.mediaType === 'movie' ? 'Movie' : 'TV show'}</small></span></button>)}</div></section></div>}
  </motion.section>;
}
