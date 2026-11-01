alter table public.profiles
  add column if not exists monetization_unlocked_at timestamptz;

alter table public.creator_payment_connections
  add column if not exists billing_consent_at timestamptz,
  add column if not exists billing_consent_version text;

alter table public.posts
  add column if not exists visibility text not null default 'public',
  add column if not exists membership_plan_id uuid,
  add column if not exists media_bucket text not null default 'media';

alter table public.posts
  drop constraint if exists posts_visibility_check;
alter table public.posts
  add constraint posts_visibility_check
  check (visibility in ('public','members_only'));

alter table public.posts
  drop constraint if exists posts_media_bucket_check;
alter table public.posts
  add constraint posts_media_bucket_check
  check (media_bucket in ('media','member-media'));

create table if not exists public.membership_plans (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 60),
  description text not null default '' check (char_length(description) <= 240),
  features jsonb not null default '[]'::jsonb,
  amount_paise integer not null check (amount_paise >= 100 and amount_paise <= 100000000),
  currency text not null default 'INR' check (currency = 'INR'),
  period text not null default 'monthly' check (period in ('monthly','yearly')),
  "interval" integer not null default 1 check ("interval" between 1 and 12),
  razorpay_plan_id text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.subscriptions
  add column if not exists membership_plan_id uuid,
  add column if not exists razorpay_payment_id text,
  add column if not exists current_start_at timestamptz,
  add column if not exists current_end_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table public.posts
  drop constraint if exists posts_membership_plan_id_fkey;
alter table public.posts
  add constraint posts_membership_plan_id_fkey
  foreign key (membership_plan_id) references public.membership_plans(id) on delete set null;

alter table public.subscriptions
  drop constraint if exists subscriptions_membership_plan_id_fkey;
alter table public.subscriptions
  add constraint subscriptions_membership_plan_id_fkey
  foreign key (membership_plan_id) references public.membership_plans(id) on delete set null;

create index if not exists membership_plans_creator_active_idx
  on public.membership_plans(creator_id,is_active,created_at desc);
create index if not exists subscriptions_creator_status_idx
  on public.subscriptions(creator_id,status,created_at desc);
create index if not exists subscriptions_subscriber_status_idx
  on public.subscriptions(subscriber_id,status,created_at desc);

create table if not exists public.razorpay_webhook_events (
  provider_event_id text primary key,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  event_type text not null,
  payload_hash text not null,
  processed_at timestamptz not null default now()
);

create table if not exists public.dm_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 60),
  description text not null default '' check (char_length(description) <= 180),
  created_by uuid not null references public.profiles(id) on delete cascade,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.dm_group_members (
  group_id uuid not null references public.dm_groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('admin','member')),
  joined_at timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (group_id,user_id)
);

create table if not exists public.dm_group_messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.dm_groups(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  content text not null check (char_length(btrim(content)) between 1 and 6000),
  message_type text not null default 'text' check (message_type in ('text','image','voice')),
  attachment_path text,
  attachment_iv text,
  attachment_mime text,
  created_at timestamptz not null default now()
);

create index if not exists dm_group_members_user_idx
  on public.dm_group_members(user_id,joined_at desc);
create index if not exists dm_group_messages_group_created_idx
  on public.dm_group_messages(group_id,created_at asc);

create or replace function private.touch_dm_group_last_message()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.dm_groups set last_message_at = new.created_at where id = new.group_id;
  return new;
end;
$$;

drop trigger if exists dm_group_messages_touch_group on public.dm_group_messages;
create trigger dm_group_messages_touch_group
after insert on public.dm_group_messages
for each row execute function private.touch_dm_group_last_message();

do $$
declare t text;
begin
  foreach t in array array[
    'membership_plans','razorpay_webhook_events',
    'dm_groups','dm_group_members','dm_group_messages'
  ] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on table public.%I from anon,authenticated',t);
    execute format('grant all on table public.%I to service_role',t);
  end loop;
end $$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('member-media','member-media',false,104857600,
  array['video/mp4','video/webm']::text[])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
