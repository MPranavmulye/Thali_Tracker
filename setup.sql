-- Thali sync — run this once in Supabase: SQL Editor → New query → paste → Run.
-- Safe to run again.

-- 1. One table holds everything (meals, workouts, goals, body data, settings), one row per record.
create table if not exists public.docs (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  col        text        not null,
  id         text        not null,
  data       jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, col, id)
);
create index if not exists docs_user_updated on public.docs (user_id, updated_at);

-- 2. The server stamps every change, so phones can ask "what changed since…?"
create or replace function public.thali_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before insert or update on public.docs
  for each row execute function public.thali_touch();

-- 3. Only you can see or change your rows.
alter table public.docs enable row level security;
grant select, insert, update, delete on public.docs to authenticated;
drop policy if exists "thali own select" on public.docs;
drop policy if exists "thali own insert" on public.docs;
drop policy if exists "thali own update" on public.docs;
drop policy if exists "thali own delete" on public.docs;
create policy "thali own select" on public.docs for select to authenticated using (auth.uid() = user_id);
create policy "thali own insert" on public.docs for insert to authenticated with check (auth.uid() = user_id);
create policy "thali own update" on public.docs for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "thali own delete" on public.docs for delete to authenticated using (auth.uid() = user_id);

-- 4. Live updates: the other phone hears about changes instantly.
do $$
begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null;
end $$;

-- 5. Private photo storage: each person can only reach files in their own folder.
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;
drop policy if exists "thali photos read" on storage.objects;
drop policy if exists "thali photos write" on storage.objects;
drop policy if exists "thali photos update" on storage.objects;
drop policy if exists "thali photos delete" on storage.objects;
create policy "thali photos read" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "thali photos write" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "thali photos update" on storage.objects for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "thali photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
