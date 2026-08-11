create index chat_messages_user_id_idx on public.chat_messages(user_id);
create index watch_rooms_host_id_idx on public.watch_rooms(host_id);

drop policy "Hosts can synchronize playback" on public.watch_rooms;
create policy "Hosts can synchronize playback"
on public.watch_rooms for update to authenticated
using (host_id = (select auth.uid()) and public.is_room_member(id))
with check (host_id = (select auth.uid()) and public.is_room_member(id));

drop policy "Members can leave rooms" on public.room_members;
create policy "Members can leave rooms"
on public.room_members for delete to authenticated
using (user_id = (select auth.uid()));

drop policy "Members can send as themselves" on public.chat_messages;
create policy "Members can send as themselves"
on public.chat_messages for insert to authenticated
with check (
  user_id = (select auth.uid())
  and public.is_room_member(room_id)
  and nickname = public.current_room_nickname(room_id)
);

drop policy "Members can delete their messages" on public.chat_messages;
create policy "Members can delete their messages"
on public.chat_messages for delete to authenticated
using (user_id = (select auth.uid()));
