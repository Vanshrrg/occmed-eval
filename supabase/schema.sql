-- Run once in Supabase: Dashboard → SQL Editor → New query → paste → Run

-- 1) Answers: one row per item (part = 'p1' | 'p2', item_id = item/standard id or '_meta')
create table if not exists public.responses (
  part        text not null,
  item_id     text not null,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  primary key (part, item_id)
);

alter table public.responses enable row level security;

drop policy if exists "team read"   on public.responses;
drop policy if exists "team insert" on public.responses;
drop policy if exists "team update" on public.responses;
drop policy if exists "team delete" on public.responses;
create policy "team read"   on public.responses for select to authenticated using (true);
create policy "team insert" on public.responses for insert to authenticated with check (true);
create policy "team update" on public.responses for update to authenticated using (true) with check (true);
create policy "team delete" on public.responses for delete to authenticated using (true);

-- Live updates between computers
do $$ begin
  alter publication supabase_realtime add table public.responses;
exception when duplicate_object then null; end $$;

-- Evidence files live in Google Drive; only their links are stored in responses.data.links
