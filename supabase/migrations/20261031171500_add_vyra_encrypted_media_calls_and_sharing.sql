
alter table public.dm_messages
  drop constraint if exists dm_messages_content_check;

alter table public.dm_messages
  add constraint dm_messages_content_check
  check (char_length(btrim(content)) between 1 and 6000);

alter table public.dm_messages
  add column if not exists message_type text not null default 'text'
    check (message_type = any (array['text'::text,'image'::text,'voice'::text,'shared_post'::text])),
  add column if not exists attachment_path text,
  add column if not exists attachment_iv text,
  add column if not exists attachment_mime text,
  add column if not exists shared_post_id uuid references public.posts(id) on delete set null,
  add column if not exists e2ee_version integer not null default 0
    check (e2ee_version in (0,1));

create index if not exists dm_messages_shared_post_idx
  on public.dm_messages(shared_post_id) where shared_post_id is not null;

create table if not exists public.dm_e2ee_keys (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  public_key jsonb not null,
  wrapped_private_key text not null,
  salt text not null,
  iv text not null,
  key_version integer not null default 1 check (key_version = 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dm_call_sessions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.dm_conversations(id) on delete cascade,
  caller_id uuid not null references public.profiles(id) on delete cascade,
  callee_id uuid not null references public.profiles(id) on delete cascade,
  call_type text not null check (call_type = any (array['audio'::text,'video'::text])),
  status text not null default 'ringing'
    check (status = any (array['ringing'::text,'active'::text,'ended'::text,'missed'::text,'declined'::text])),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  ended_at timestamptz
);

create index if not exists dm_call_sessions_callee_recent_idx
  on public.dm_call_sessions(callee_id, created_at desc);
create index if not exists dm_call_sessions_caller_recent_idx
  on public.dm_call_sessions(caller_id, created_at desc);
create index if not exists dm_call_sessions_conversation_recent_idx
  on public.dm_call_sessions(conversation_id, created_at desc);

create table if not exists public.dm_call_signals (
  id bigint generated always as identity primary key,
  call_id uuid not null references public.dm_call_sessions(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  signal_type text not null check (signal_type = any (array['offer'::text,'answer'::text,'ice'::text])),
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists dm_call_signals_call_id_idx
  on public.dm_call_signals(call_id, id);

alter table public.dm_e2ee_keys enable row level security;
alter table public.dm_call_sessions enable row level security;
alter table public.dm_call_signals enable row level security;

revoke all on public.dm_e2ee_keys, public.dm_call_sessions, public.dm_call_signals from anon, authenticated;
grant all on public.dm_e2ee_keys, public.dm_call_sessions, public.dm_call_signals to service_role;
grant all on public.dm_call_signals_id_seq to service_role;
