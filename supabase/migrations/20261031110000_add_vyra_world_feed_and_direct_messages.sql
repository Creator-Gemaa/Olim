create schema if not exists private;

alter table public.posts
  add column if not exists views_count integer not null default 0
  check (views_count >= 0);

alter table public.posts
  drop constraint if exists posts_copyright_status_check;

alter table public.posts
  add constraint posts_copyright_status_check
  check (copyright_status = any (array[
    'pending_manual_review'::text,
    'no_exact_match'::text,
    'matched'::text,
    'not_scanned'::text
  ]));

create table if not exists public.dm_conversations (
  id uuid primary key default gen_random_uuid(),
  user_a uuid not null references public.profiles(id) on delete cascade,
  user_b uuid not null references public.profiles(id) on delete cascade,
  requester_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending'
    check (status = any (array['pending'::text, 'accepted'::text, 'declined'::text])),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  last_message_at timestamptz not null default now(),
  constraint dm_conversations_ordered_users check (user_a < user_b),
  constraint dm_conversations_requester_participant check (requester_id = user_a or requester_id = user_b),
  constraint dm_conversations_unique_pair unique (user_a, user_b)
);

create index if not exists dm_conversations_user_a_recent_idx
  on public.dm_conversations(user_a, last_message_at desc);
create index if not exists dm_conversations_user_b_recent_idx
  on public.dm_conversations(user_b, last_message_at desc);
create index if not exists dm_conversations_requester_recent_idx
  on public.dm_conversations(requester_id, created_at desc);

create table if not exists public.dm_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.dm_conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  content text not null check (char_length(btrim(content)) between 1 and 1000),
  created_at timestamptz not null default now()
);

create index if not exists dm_messages_conversation_created_idx
  on public.dm_messages(conversation_id, created_at asc);

create table if not exists public.post_views (
  post_id uuid not null references public.posts(id) on delete cascade,
  viewer_id uuid not null references public.profiles(id) on delete cascade,
  view_day date not null,
  created_at timestamptz not null default now(),
  primary key (post_id, viewer_id, view_day)
);

create index if not exists post_views_viewer_day_idx
  on public.post_views(viewer_id, view_day desc);

create or replace function private.increment_post_views()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.posts
    set views_count = views_count + 1
    where id = new.post_id;
  return new;
end;
$$;

drop trigger if exists post_views_increment_count on public.post_views;
create trigger post_views_increment_count
after insert on public.post_views
for each row execute function private.increment_post_views();

create or replace function private.touch_dm_conversation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.dm_conversations
    set last_message_at = new.created_at
    where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists dm_messages_touch_conversation on public.dm_messages;
create trigger dm_messages_touch_conversation
after insert on public.dm_messages
for each row execute function private.touch_dm_conversation();

create or replace function private.enforce_dm_sender_participant()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  participant_a uuid;
  participant_b uuid;
begin
  select user_a, user_b into participant_a, participant_b
    from public.dm_conversations
    where id = new.conversation_id;
  if participant_a is null or (new.sender_id <> participant_a and new.sender_id <> participant_b) then
    raise exception 'Message sender must be a conversation participant';
  end if;
  return new;
end;
$$;

drop trigger if exists dm_messages_sender_participant on public.dm_messages;
create trigger dm_messages_sender_participant
before insert on public.dm_messages
for each row execute function private.enforce_dm_sender_participant();

alter table public.dm_conversations enable row level security;
alter table public.dm_messages enable row level security;
alter table public.post_views enable row level security;

revoke all on public.dm_conversations, public.dm_messages, public.post_views from anon, authenticated;
grant all on public.dm_conversations, public.dm_messages, public.post_views to service_role;
