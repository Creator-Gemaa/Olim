create table if not exists public.saved_posts (
  user_id uuid not null references public.profiles(id) on delete cascade,
  post_id uuid not null references public.posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

create index if not exists saved_posts_user_recent_idx
  on public.saved_posts (user_id, created_at desc);

alter table public.saved_posts enable row level security;
revoke all on public.saved_posts from anon, authenticated;
grant all on public.saved_posts to service_role;
