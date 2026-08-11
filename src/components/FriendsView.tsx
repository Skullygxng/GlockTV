import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Copy, DoorOpen, LoaderCircle, MessageCircle, Play, Search, Send, Users, X } from 'lucide-react';
import { imageUrl, type MediaItem } from '../lib/media';
import type { TmdbClient } from '../lib/tmdb';
import type { PartyMember, PartyMessage, PartyRoom, PlaybackState, WatchPartyService } from '../lib/watchParty';
import { YouTubePartyPlayer } from './YouTubePartyPlayer';
import '../friends.css';

interface FriendsViewProps {
  client: TmdbClient;
  service: WatchPartyService | null;
  selectedTitle: MediaItem | null;
  trailerKey: string | null;
  initialRoomCode?: string;
}

function upsertMessage(messages: PartyMessage[], message: PartyMessage) {
  return messages.some((item) => item.id === message.id) ? messages : [...messages, message];
}

export function FriendsView({ client, service, selectedTitle, trailerKey, initialRoomCode = '' }: FriendsViewProps) {
  const [nickname, setNickname] = useState(() => sessionStorage.getItem('glocktv-nickname') ?? '');
  const [roomCode, setRoomCode] = useState(initialRoomCode.toUpperCase());
  const [room, setRoom] = useState<PartyRoom | null>(null);
  const [userId, setUserId] = useState('');
  const [members, setMembers] = useState<PartyMember[]>([]);
  const [messages, setMessages] = useState<PartyMessage[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [titlePickerOpen, setTitlePickerOpen] = useState(false);
  const [titleQuery, setTitleQuery] = useState('');
  const [titleResults, setTitleResults] = useState<MediaItem[]>([]);
  const [titleBusy, setTitleBusy] = useState(false);
  const messageEnd = useRef<HTMLDivElement>(null);

  const refreshMembers = useCallback(async (roomId: string) => {
    if (!service) return;
    setMembers(await service.getMembers(roomId));
  }, [service]);

  const refreshSnapshot = useCallback(async (roomId: string) => {
    if (!service) return;
    const [nextRoom, nextMembers, nextMessages] = await Promise.all([
      service.getRoom(roomId), service.getMembers(roomId), service.getMessages(roomId),
    ]);
    setRoom(nextRoom);
    setMembers(nextMembers);
    setMessages((previous) => nextMessages.reduce(upsertMessage, previous));
  }, [service]);

  const enterRoom = useCallback(async (nextRoom: PartyRoom, nextUserId: string) => {
    if (!service) return;
    const [nextMembers, nextMessages] = await Promise.all([
      service.getMembers(nextRoom.id),
      service.getMessages(nextRoom.id),
    ]);
    setRoom(nextRoom);
    setUserId(nextUserId);
    setMembers(nextMembers);
    setMessages(nextMessages);
    const url = new URL(window.location.href);
    url.searchParams.set('room', nextRoom.code);
    window.history.replaceState({}, '', url);
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
    const refreshRoom = () => { void service.getRoom(room.id).then(setRoom).catch(() => undefined); };
    const timer = window.setInterval(refreshRoom, 5000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshRoom();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [room?.id, service]);

  useEffect(() => { messageEnd.current?.scrollIntoView?.({ behavior: 'smooth' }); }, [messages.length]);

  const createParty = async () => {
    if (!service || !selectedTitle || !trailerKey || !nickname.trim()) return;
    setBusy(true); setError('');
    try {
      sessionStorage.setItem('glocktv-nickname', nickname.trim());
      const user = await service.ensureUser();
      const nextRoom = await service.createRoom({
        nickname: nickname.trim(),
        titleId: selectedTitle.id,
        mediaType: selectedTitle.mediaType,
        titleName: selectedTitle.title,
        trailerKey,
      });
      await enterRoom(nextRoom, user.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The party could not be created.'); }
    finally { setBusy(false); }
  };

  const joinParty = async () => {
    if (!service || !nickname.trim() || !roomCode.trim()) return;
    setBusy(true); setError('');
    try {
      const cleanCode = roomCode.trim().toUpperCase();
      sessionStorage.setItem('glocktv-nickname', nickname.trim());
      const user = await service.ensureUser();
      const nextRoom = await service.joinRoom(cleanCode, nickname.trim());
      await enterRoom(nextRoom, user.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'That room is unavailable.'); }
    finally { setBusy(false); }
  };

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    const cleanMessage = message.trim();
    if (!service || !room || !cleanMessage) return;
    setMessage('');
    try {
      const sent = await service.sendMessage(room.id, nickname.trim(), cleanMessage);
      setMessages((previous) => upsertMessage(previous, sent));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Message failed to send.'); setMessage(cleanMessage); }
  };

  const updatePlayback = async (state: PlaybackState, position = room?.playbackPosition ?? 0) => {
    if (!service || !room || room.hostId !== userId) return;
    setRoom({ ...room, playbackState: state, playbackPosition: position, playbackUpdatedAt: new Date().toISOString() });
    try { await service.updatePlayback(room.id, state, position); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Playback did not sync.'); }
  };

  const searchTitles = async (event: FormEvent) => {
    event.preventDefault();
    if (!titleQuery.trim()) return;
    setTitleBusy(true); setError('');
    try { setTitleResults(await client.search(titleQuery.trim())); }
    catch { setError('Title search is unavailable right now.'); }
    finally { setTitleBusy(false); }
  };

  const chooseTitle = async (item: MediaItem) => {
    if (!service || !room || room.hostId !== userId) return;
    setTitleBusy(true); setError('');
    try {
      const context = await client.getTitleContext(item);
      if (!context.trailer) throw new Error('That title does not have a playable trailer.');
      const nextRoom = await service.updateTitle(room.id, {
        titleId: context.details.id,
        mediaType: context.details.mediaType,
        titleName: context.details.title,
        trailerKey: context.trailer.key,
      });
      setRoom(nextRoom);
      setTitlePickerOpen(false);
      setTitleQuery('');
      setTitleResults([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The room title could not be changed.');
    } finally { setTitleBusy(false); }
  };

  const copyInvite = async () => {
    if (!room) return;
    const url = new URL(window.location.href);
    url.searchParams.set('room', room.code);
    await navigator.clipboard?.writeText(url.toString());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const leaveParty = async () => {
    if (service && room && userId) await service.leaveRoom(room.id, userId).catch(() => undefined);
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState({}, '', url);
    setRoom(null); setMembers([]); setMessages([]); setError('');
  };

  if (!room) return (
    <motion.section className="friends-lobby" aria-label="Friends watch party" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }}>
      <div className="friends-lobby__copy">
        <span><Users /> Friends</span>
        <h1>Watch together</h1>
        <p>Start a private room around the trailer in your feed, or join friends with their six-character code.</p>
      </div>
      <div className="friends-lobby__forms">
        <label>Your nickname<input aria-label="Your nickname" maxLength={24} value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="How friends see you" /></label>
        <div className="friends-lobby__actions">
          <section>
            <small>Now in your feed</small>
            <strong>{selectedTitle?.title ?? 'Choose a title in Discover'}</strong>
            <span>{trailerKey ? 'Official trailer ready' : 'This title has no trailer available'}</span>
            <button type="button" onClick={() => void createParty()} disabled={busy || !service || !nickname.trim() || !trailerKey}>
              {busy ? <LoaderCircle className="spin" /> : <Play fill="currentColor" />} Create party
            </button>
          </section>
          <i>or</i>
          <section>
            <small>Have an invite?</small>
            <label>Room code<input aria-label="Room code" maxLength={6} value={roomCode} onChange={(event) => setRoomCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="ABC123" /></label>
            <button type="button" onClick={() => void joinParty()} disabled={busy || !service || !nickname.trim() || roomCode.length !== 6}>
              <DoorOpen /> Join party
            </button>
          </section>
        </div>
        {!service && <p className="friends-error">Friends is not connected yet.</p>}
        {error && <p className="friends-error" role="alert">{error}</p>}
      </div>
    </motion.section>
  );

  const isHost = room.hostId === userId;
  return (
    <motion.section className="watch-party" aria-label={`Watch party ${room.code}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <header className="watch-party__header">
        <div><span className="live-dot" /> Live room <strong>{room.code}</strong></div>
        <div className="watch-party__header-actions">
          <button type="button" onClick={() => void copyInvite()}><Copy /> {copied ? 'Copied' : 'Copy invite'}</button>
          <button type="button" onClick={() => void leaveParty()}><DoorOpen /> Leave</button>
        </div>
      </header>

      <div className="watch-party__layout">
        <section className="party-screen">
          <YouTubePartyPlayer room={room} isHost={isHost} onHostCommand={(state, position) => void updatePlayback(state, position)} />
          <div className="party-title-row">
            <div><span>Now watching</span><h1>{room.titleName}</h1></div>
            <div className="party-title-actions">
              {isHost && <button type="button" onClick={() => setTitlePickerOpen(true)}><Search /> Change title</button>}
              <div className="party-sync"><span className="live-dot" /> {room.playbackState === 'playing' ? 'Playing' : 'Paused'} · synced</div>
            </div>
          </div>
          {error && <p className="friends-error" role="alert">{error}</p>}
        </section>

        <aside className="party-chat" aria-label="Audience chat">
          <header><div><MessageCircle /><strong>Audience chat</strong></div><span><Users /> {members.length}</span></header>
          <div className="party-members" aria-label="People in this room">
            {members.map((member) => <span key={member.userId} title={member.nickname}>{member.nickname.slice(0, 1).toUpperCase()}</span>)}
          </div>
          <div className="party-messages" aria-live="polite">
            {!messages.length && <div className="party-chat__empty"><MessageCircle /><strong>Start the conversation</strong><span>Everyone in this room will see messages live.</span></div>}
            {messages.map((item) => <article key={item.id} className={item.userId === userId ? 'mine' : ''}>
              <header><strong>{item.nickname}</strong><time>{new Date(item.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></header>
              <p>{item.body}</p>
            </article>)}
            <div ref={messageEnd} />
          </div>
          <form className="party-compose" onSubmit={(event) => void sendMessage(event)}>
            <input aria-label="Message the room" maxLength={500} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Message the room…" />
            <button type="submit" aria-label="Send message" disabled={!message.trim()}><Send /></button>
          </form>
        </aside>
      </div>

      {titlePickerOpen && <div className="party-picker-backdrop">
        <section className="party-picker" role="dialog" aria-modal="true" aria-label="Change watch party title">
          <header><div><span>Host controls</span><h2>Change what you're watching</h2></div><button type="button" aria-label="Close title picker" onClick={() => setTitlePickerOpen(false)}><X /></button></header>
          <form onSubmit={(event) => void searchTitles(event)}>
            <Search />
            <input autoFocus aria-label="Search watch party titles" value={titleQuery} onChange={(event) => setTitleQuery(event.target.value)} placeholder="Search movies and TV shows" />
            <button type="submit" aria-label="Search titles" disabled={titleBusy || !titleQuery.trim()}>{titleBusy ? <LoaderCircle className="spin" /> : 'Search'}</button>
          </form>
          <div className="party-picker__results">
            {titleResults.map((item) => <button type="button" key={`${item.mediaType}-${item.id}`} aria-label={`Choose ${item.title}`} onClick={() => void chooseTitle(item)} disabled={titleBusy}>
              {imageUrl(item.posterPath, 'w185') ? <img src={imageUrl(item.posterPath, 'w185')!} alt="" /> : <span className="party-picker__poster"><Play /></span>}
              <span><strong>{item.title}</strong><small>{item.year} · {item.mediaType === 'movie' ? 'Movie' : 'TV show'}</small></span>
            </button>)}
            {!titleBusy && titleQuery && !titleResults.length && <p>Search for the movie or show you want to watch together.</p>}
          </div>
        </section>
      </div>}
    </motion.section>
  );
}
