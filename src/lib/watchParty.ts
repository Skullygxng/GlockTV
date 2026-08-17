import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';

export type PlaybackState = 'playing' | 'paused';

export interface PartyRoom {
  id: string;
  code: string;
  hostId: string | null;
  titleId: number;
  mediaType: 'movie' | 'tv';
  titleName: string;
  trailerKey?: string | null;
  playbackState: PlaybackState;
  playbackPosition: number;
  playbackUpdatedAt: string;
  seasonNumber?: number;
  episodeNumber?: number;
  backdropPath?: string | null;
  durationSeconds?: number | null;
  isPublic?: boolean;
  isOfficial?: boolean;
}

export interface PublicPartyRoom extends PartyRoom { audienceCount: number }
export interface PartyMember {
  userId: string;
  nickname: string;
  joinedAt: string;
}

export interface PartyMessage {
  id: string;
  roomId: string;
  userId: string;
  nickname: string;
  body: string;
  createdAt: string;
}

export interface CreateRoomInput {
  nickname: string;
  titleId: number;
  mediaType: 'movie' | 'tv';
  titleName: string;
  backdropPath?: string | null;
  durationSeconds?: number | null;
  trailerKey?: string | null;
}

export type UpdateRoomTitleInput = Omit<CreateRoomInput, 'nickname'>;

export interface PartySubscriptionHandlers {
  onRoom: (room: PartyRoom) => void;
  onMessage: (message: PartyMessage) => void;
  onMembersChanged: () => void;
  onReady: () => void;

}

export interface WatchPartyService {
  ensureUser(): Promise<{ id: string }>;
  createRoom(input: CreateRoomInput): Promise<PartyRoom>;
  joinRoom(code: string, nickname: string): Promise<PartyRoom>;
  getRoom(roomId: string): Promise<PartyRoom>;
  listPublicRooms(): Promise<PublicPartyRoom[]>;
  getMembers(roomId: string): Promise<PartyMember[]>;
  getMessages(roomId: string): Promise<PartyMessage[]>;
  sendMessage(roomId: string, nickname: string, body: string): Promise<PartyMessage>;
  updatePlayback(roomId: string, state: PlaybackState, position: number): Promise<void>;
  updateTitle(roomId: string, input: UpdateRoomTitleInput): Promise<PartyRoom>;
  subscribe(roomId: string, handlers: PartySubscriptionHandlers): () => void;
  updateEpisode(roomId: string, seasonNumber: number, episodeNumber: number): Promise<PartyRoom>;
  leaveRoom(roomId: string, userId: string): Promise<void>;
}

interface RoomRow {
  id: string;
  code: string;
  host_id: string | null;
  title_id: number;
  media_type: 'movie' | 'tv';
  title_name: string;
  playback_state: PlaybackState;
  playback_position: number;
  playback_updated_at: string;

  season_number: number;
  episode_number: number;
  backdrop_path: string | null;
  duration_seconds: number | null;
  is_public: boolean;
  is_official: boolean;
}
interface MemberRow { user_id: string; nickname: string; joined_at: string }
interface MessageRow { id: string; room_id: string; user_id: string; nickname: string; body: string; created_at: string }
interface PublicRoomRow extends RoomRow { audience_count: number }

const mapRoom = (row: RoomRow): PartyRoom => ({
  id: row.id,
  code: row.code,
  hostId: row.host_id,
  titleId: row.title_id,
  mediaType: row.media_type,
  titleName: row.title_name,
  playbackState: row.playback_state,
  playbackPosition: Number(row.playback_position),
  playbackUpdatedAt: row.playback_updated_at,
  seasonNumber: row.season_number ?? 1,
  episodeNumber: row.episode_number ?? 1,
  backdropPath: row.backdrop_path ?? null,
  durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
  isPublic: row.is_public ?? false,
  isOfficial: row.is_official ?? false,
});

const mapMember = (row: MemberRow): PartyMember => ({ userId: row.user_id, nickname: row.nickname, joinedAt: row.joined_at });
const mapMessage = (row: MessageRow): PartyMessage => ({ id: row.id, roomId: row.room_id, userId: row.user_id, nickname: row.nickname, body: row.body, createdAt: row.created_at });
const mapPublicRoom = (row: PublicRoomRow): PublicPartyRoom => ({ ...mapRoom(row), audienceCount: Number(row.audience_count ?? 0) });

class SupabaseWatchPartyService implements WatchPartyService {
  constructor(private readonly client: SupabaseClient) {}

  async ensureUser() {
    const { data: sessionData } = await this.client.auth.getSession();
    if (sessionData.session?.user) return { id: sessionData.session.user.id };
    const { data, error } = await this.client.auth.signInAnonymously();
    if (error || !data.user) throw new Error(error?.message ?? 'Guest sign-in failed.');
    return { id: data.user.id };
  }

  async createRoom(input: CreateRoomInput) {
    await this.ensureUser();
    const { data, error } = await this.client.rpc('create_watch_room', {
      p_nickname: input.nickname,
      p_title_id: input.titleId,
      p_media_type: input.mediaType,
      p_title_name: input.titleName,
      p_backdrop_path: input.backdropPath,
      p_duration_seconds: input.durationSeconds,
    }).single();
    if (error || !data) throw new Error(error?.message ?? 'The room could not be created.');
    return mapRoom(data as RoomRow);
  }

  async joinRoom(code: string, nickname: string) {
    await this.ensureUser();
    const { data, error } = await this.client.rpc('join_watch_room', { p_code: code.toUpperCase(), p_nickname: nickname }).single();
    if (error || !data) throw new Error(error?.message ?? 'That room could not be joined.');
    return mapRoom(data as RoomRow);
  }

  async getRoom(roomId: string) {
    const { data, error } = await this.client.from('watch_rooms').select('*').eq('id', roomId).single();
    if (error || !data) throw new Error(error?.message ?? 'The room is unavailable.');
    return mapRoom(data as RoomRow);
  }
  async listPublicRooms() {
    const { data, error } = await this.client.rpc('list_public_watch_rooms');
    if (error) throw new Error(error.message);
    return ((data ?? []) as PublicRoomRow[]).map(mapPublicRoom);
  }



  async getMembers(roomId: string) {
    const { data, error } = await this.client.from('room_members').select('user_id,nickname,joined_at').eq('room_id', roomId).order('joined_at');
    if (error) throw new Error(error.message);
    return (data as MemberRow[]).map(mapMember);
  }

  async getMessages(roomId: string) {
    const { data, error } = await this.client.from('chat_messages').select('id,room_id,user_id,nickname,body,created_at').eq('room_id', roomId).order('created_at').limit(100);
    if (error) throw new Error(error.message);
    return (data as MessageRow[]).map(mapMessage);
  }

  async sendMessage(roomId: string, nickname: string, body: string) {
    const user = await this.ensureUser();
    const { data, error } = await this.client.from('chat_messages').insert({ room_id: roomId, user_id: user.id, nickname, body: body.trim() }).select('id,room_id,user_id,nickname,body,created_at').single();
    if (error || !data) throw new Error(error?.message ?? 'Message failed to send.');
    return mapMessage(data as MessageRow);
  }

  async updatePlayback(roomId: string, state: PlaybackState, position: number) {
    const { error } = await this.client.from('watch_rooms').update({ playback_state: state, playback_position: Math.max(0, position), playback_updated_at: new Date().toISOString() }).eq('id', roomId);
    if (error) throw new Error(error.message);
  }

  async updateTitle(roomId: string, input: UpdateRoomTitleInput) {
    const { data, error } = await this.client.rpc('update_watch_room_title', {
      p_room_id: roomId,
      p_title_id: input.titleId,
      p_media_type: input.mediaType,
      p_title_name: input.titleName,
      p_backdrop_path: input.backdropPath,
      p_duration_seconds: input.durationSeconds,
    }).single();
    if (error || !data) throw new Error(error?.message ?? 'The room title could not be changed.');
    return mapRoom(data as RoomRow);
  }

  async updateEpisode(roomId: string, seasonNumber: number, episodeNumber: number) {
    const { data, error } = await this.client.rpc('update_watch_room_episode', {
      p_room_id: roomId,
      p_season_number: seasonNumber,
      p_episode_number: episodeNumber,
    }).single();
    if (error || !data) throw new Error(error?.message ?? 'The room episode could not be changed.');
    return mapRoom(data as RoomRow);
  }

  subscribe(roomId: string, handlers: PartySubscriptionHandlers) {
    const channel: RealtimeChannel = this.client.channel(`watch-party:${roomId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'watch_rooms', filter: `id=eq.${roomId}` }, (payload) => handlers.onRoom(mapRoom(payload.new as RoomRow)))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `room_id=eq.${roomId}` }, (payload) => handlers.onMessage(mapMessage(payload.new as MessageRow)))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_members', filter: `room_id=eq.${roomId}` }, handlers.onMembersChanged)
      .subscribe((status) => { if (status === 'SUBSCRIBED') handlers.onReady(); });
    return () => { void this.client.removeChannel(channel); };
  }

  async leaveRoom(roomId: string) {
    const { error } = await this.client.rpc('leave_watch_room', { p_room_id: roomId });
    if (error) throw new Error(error.message);
  }
}

export function createWatchPartyService(config: { url?: string; publishableKey?: string } = {}): WatchPartyService | null {
  const url = config.url ?? import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = config.publishableKey ?? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) return null;
  return new SupabaseWatchPartyService(createClient(url, publishableKey));
}
