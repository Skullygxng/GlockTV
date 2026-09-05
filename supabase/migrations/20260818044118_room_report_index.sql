create index if not exists message_reports_reporter_created_idx
on public.message_reports(reporter_user_id, created_at desc);
