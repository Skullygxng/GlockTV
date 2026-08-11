import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries((await readFile('.env.local', 'utf8'))
  .split(/\r?\n/)
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));

const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!url || !key) throw new Error('Supabase browser configuration is missing.');

const client = () => createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const host = client();
const guest = client();
let room;

function monitorChange(channel, predicate, label) {
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const event = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} realtime event timed out.`)), 12000);
    channel.on('postgres_changes', predicate, (payload) => {
      clearTimeout(timeout);
      resolve(payload.new);
    }).subscribe((status) => {
      if (status === 'SUBSCRIBED') resolveReady();
      if (status === 'CHANNEL_ERROR') {
        clearTimeout(timeout);
        rejectReady(new Error(`${label} realtime subscription failed.`));
        reject(new Error(`${label} realtime subscription failed.`));
      }
    });
  });
  return { ready, event };
}

try {
  const [{ data: hostAuth, error: hostAuthError }, { data: guestAuth, error: guestAuthError }] = await Promise.all([
    host.auth.signInAnonymously(),
    guest.auth.signInAnonymously(),
  ]);
  if (hostAuthError) throw hostAuthError;
  if (guestAuthError) throw guestAuthError;
  if (!hostAuth.user || !guestAuth.user || hostAuth.user.id === guestAuth.user.id) throw new Error('Distinct guest sessions were not created.');

  const { data: created, error: createError } = await host.rpc('create_watch_room', {
    p_nickname: 'Host Test', p_title_id: 949, p_media_type: 'movie', p_title_name: 'Heat', p_trailer_key: 'heatTrailer_1',
  }).single();
  if (createError) throw createError;
  room = created;

  const { error: joinError } = await guest.rpc('join_watch_room', { p_code: room.code, p_nickname: 'Guest Test' }).single();
  if (joinError) throw joinError;

  const roomChannel = guest.channel(`verify-room-${room.id}`);
  const playbackMonitor = monitorChange(roomChannel, { event: 'UPDATE', schema: 'public', table: 'watch_rooms', filter: `id=eq.${room.id}` }, 'Playback');
  const hostChatChannel = host.channel(`verify-chat-${room.id}`);
  const chatMonitor = monitorChange(hostChatChannel, { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `room_id=eq.${room.id}` }, 'Chat');
  await Promise.all([playbackMonitor.ready, chatMonitor.ready]);

  const { error: playbackError } = await host.from('watch_rooms').update({ playback_state: 'playing', playback_position: 37, playback_updated_at: new Date().toISOString() }).eq('id', room.id);
  if (playbackError) throw playbackError;
  const playback = await playbackMonitor.event;

  const { error: messageError } = await guest.from('chat_messages').insert({ room_id: room.id, user_id: guestAuth.user.id, nickname: 'Guest Test', body: 'Ready to watch.' });
  if (messageError) throw messageError;
  const message = await chatMonitor.event;

  const { data: members, error: membersError } = await host.from('room_members').select('user_id').eq('room_id', room.id);
  if (membersError) throw membersError;

  console.log(JSON.stringify({
    distinctGuests: true,
    roomCodeLength: room.code.length,
    memberCount: members.length,
    playbackReceived: playback.playback_state === 'playing' && Number(playback.playback_position) === 37,
    chatReceived: message.body === 'Ready to watch.',
  }, null, 2));
} finally {
  await Promise.allSettled([host.removeAllChannels(), guest.removeAllChannels()]);
  if (room?.id) await host.rpc('leave_watch_room', { p_room_id: room.id });
  await Promise.allSettled([host.auth.signOut(), guest.auth.signOut()]);
}
