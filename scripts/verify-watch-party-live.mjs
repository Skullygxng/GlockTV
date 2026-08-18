import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  .split(/\r?\n/)
  .filter((line) => line && !line.startsWith('#') && line.includes('='))
  .map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));

const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!url || !key) throw new Error('Supabase environment is missing.');

const client = () => createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const host = client();
const guest = client();
const outsider = client();

const rpc = async (instance, name, args = {}) => {
  const { data, error } = await instance.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
};

const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

let room;
try {
  const identities = await Promise.all([host.auth.signInAnonymously(), guest.auth.signInAnonymously(), outsider.auth.signInAnonymously()]);
  identities.forEach(({ data, error }, index) => expect(!error && data.user?.is_anonymous, `anonymous user ${index + 1} failed`));
  const hostId = identities[0].data.user.id;
  const guestId = identities[1].data.user.id;
  const linkedEmail = `glocktv-qa+${Date.now()}@blackhole.postmarkapp.com`;
  const linkedAccount = await outsider.auth.updateUser({ email: linkedEmail });
  expect(!linkedAccount.error, `anonymous account linking failed: ${linkedAccount.error?.message}`);

  [room] = await rpc(host, 'create_watch_room', {
    p_nickname: 'QA Host', p_title_id: 550, p_media_type: 'movie', p_title_name: 'Fight Club',
    p_backdrop_path: null, p_duration_seconds: 8340,
  });
  expect(room?.code && room.host_id === hostId, 'host did not create the room');
  await rpc(guest, 'join_watch_room', { p_code: room.code, p_nickname: 'QA Guest' });

  await rpc(host, 'set_watch_room_controls', { p_room_id: room.id, p_is_locked: true, p_slow_mode_seconds: 3 });
  const lockedJoin = await outsider.rpc('join_watch_room', { p_code: room.code, p_nickname: 'QA Outsider' });
  expect(lockedJoin.error?.message.includes('locked'), 'locked room accepted a new viewer');
  await rpc(host, 'set_watch_room_controls', { p_room_id: room.id, p_is_locked: false, p_slow_mode_seconds: 0 });

  await rpc(host, 'heartbeat_watch_room', { p_room_id: room.id, p_sync_status: 'synced', p_sync_offset_seconds: 0, p_server_id: 'cinesrc' });
  await rpc(guest, 'heartbeat_watch_room', { p_room_id: room.id, p_sync_status: 'drifting', p_sync_offset_seconds: -4.5, p_server_id: 'vidcore' });
  let members = await rpc(host, 'get_active_watch_room_members', { p_room_id: room.id });
  expect(members.length === 2 && members.some((member) => member.sync_status === 'drifting'), 'presence or sync health was not stored');

  await rpc(host, 'set_watch_room_cohost', { p_room_id: room.id, p_target_user_id: guestId, p_enabled: true });
  await rpc(host, 'set_watch_room_server', { p_room_id: room.id, p_server_id: 'vidcore' });
  const [hostMessage] = await rpc(host, 'send_watch_room_message', { p_room_id: room.id, p_body: 'Live QA message' });
  await rpc(guest, 'report_watch_room_message', { p_message_id: hostMessage.id, p_reason: 'other' });
  await rpc(guest, 'set_watch_room_block', { p_room_id: room.id, p_target_user_id: hostId, p_blocked: true });
  const blocks = await rpc(guest, 'get_watch_room_blocks');
  expect(blocks.some((block) => block.blocked_user_id === hostId), 'personal block was not stored');
  await rpc(guest, 'set_watch_room_block', { p_room_id: room.id, p_target_user_id: hostId, p_blocked: false });

  await rpc(host, 'moderate_watch_room_member', { p_room_id: room.id, p_target_user_id: guestId, p_action: 'mute' });
  const mutedMessage = await guest.rpc('send_watch_room_message', { p_room_id: room.id, p_body: 'This must fail' });
  expect(mutedMessage.error?.message.includes('muted'), 'muted viewer could still chat');
  await rpc(host, 'moderate_watch_room_member', { p_room_id: room.id, p_target_user_id: guestId, p_action: 'unmute' });
  await rpc(host, 'moderate_watch_room_member', { p_room_id: room.id, p_target_user_id: guestId, p_action: 'kick' });
  const bans = await rpc(host, 'list_watch_room_bans', { p_room_id: room.id });
  expect(bans.some((ban) => ban.user_id === guestId && ban.nickname === 'QA Guest'), 'removed viewer was not listed');
  await rpc(host, 'unban_watch_room_member', { p_room_id: room.id, p_target_user_id: guestId });
  await rpc(guest, 'join_watch_room', { p_code: room.code, p_nickname: 'QA Guest' });
  await rpc(host, 'clear_watch_room_chat', { p_room_id: room.id });
  const messages = await rpc(host, 'get_watch_room_messages', { p_room_id: room.id });
  expect(messages.length === 0, 'clear chat did not remove the conversation');

  const [transferred] = await rpc(host, 'transfer_watch_room_host', { p_room_id: room.id, p_target_user_id: guestId });
  expect(transferred.host_id === guestId, 'manual host transfer failed');
  await rpc(host, 'leave_watch_room', { p_room_id: room.id });
  members = await rpc(guest, 'get_active_watch_room_members', { p_room_id: room.id });
  expect(members.length === 1 && members[0].user_id === guestId, 'departed viewer remained in the active audience');

  console.log(JSON.stringify({
    result: 'pass', roomCode: room.code, checks: [
      'anonymous accounts', 'optional account linking', 'lock', 'heartbeat', 'sync health', 'co-host', 'shared server',
      'report', 'block', 'mute', 'kick', 'unban', 'clear chat', 'host transfer', 'accurate presence',
    ],
  }, null, 2));
} finally {
  if (room) await guest.rpc('leave_watch_room', { p_room_id: room.id });
}
