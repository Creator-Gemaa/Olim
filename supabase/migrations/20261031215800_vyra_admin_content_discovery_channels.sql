create table if not exists public.vyra_content_channels (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 3 and 50),
  search_query text not null check (char_length(search_query) between 2 and 120),
  youtube_channel_id text,
  created_by uuid not null references public.profiles(id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists vyra_content_channels_name_ci_uidx
  on public.vyra_content_channels (lower(name));
create index if not exists vyra_content_channels_created_at_idx
  on public.vyra_content_channels (created_at desc);

alter table public.vyra_content_channels enable row level security;
revoke all on table public.vyra_content_channels from anon, authenticated;
grant all on table public.vyra_content_channels to service_role;

comment on table public.vyra_content_channels is
  'Admin-defined discovery channel configurations only. External platform API results are returned transiently and are not persisted.';
