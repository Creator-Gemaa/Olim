alter table public.posts
  add column if not exists visibility text not null default 'public'
  check (visibility in ('public','members'));

alter table public.creator_payment_connections
  add column if not exists consent_accepted_at timestamptz;

alter table public.subscriptions
  add column if not exists membership_plan_id uuid,
  add column if not exists provider_payment_id text,
  add column if not exists activated_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.creator_membership_plans (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  provider_plan_id text not null unique,
  title text not null check (char_length(btrim(title)) between 3 and 60),
  description text not null default '' check (char_length(description) <= 500),
  price_minor integer not null check (price_minor >= 100 and price_minor <= 100000000),
  currency text not null default 'INR' check (currency = 'INR'),
  billing_period text not null check (billing_period in ('monthly','quarterly','yearly')),
  interval_count integer not null default 1 check (interval_count between 1 and 12),
  benefits text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists creator_membership_plans_creator_active_idx
  on public.creator_membership_plans(creator_id, is_active, created_at desc);

alter table public.subscriptions
  drop constraint if exists subscriptions_membership_plan_id_fkey;
alter table public.subscriptions
  add constraint subscriptions_membership_plan_id_fkey
  foreign key (membership_plan_id) references public.creator_membership_plans(id) on delete set null;

create index if not exists subscriptions_creator_status_idx
  on public.subscriptions(creator_id, status, created_at desc);
create index if not exists subscriptions_subscriber_status_idx
  on public.subscriptions(subscriber_id, status, created_at desc);

create table if not exists public.razorpay_webhook_events (
  provider_event_id text primary key,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  event_type text not null,
  received_at timestamptz not null default now()
);

create index if not exists razorpay_webhook_events_creator_idx
  on public.razorpay_webhook_events(creator_id, received_at desc);

create table if not exists public.dm_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 60),
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dm_group_members (
  group_id uuid not null references public.dm_groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create index if not exists dm_group_members_user_idx
  on public.dm_group_members(user_id, joined_at desc);

create table if not exists public.dm_group_messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.dm_groups(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  content text not null check (char_length(btrim(content)) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index if not exists dm_group_messages_group_created_idx
  on public.dm_group_messages(group_id, created_at asc);

create or replace function private.enforce_dm_group_sender_member()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.dm_group_members
    where group_id = new.group_id and user_id = new.sender_id
  ) then
    raise exception 'Message sender must be a group member';
  end if;
  return new;
end;
$$;

drop trigger if exists dm_group_messages_sender_member on public.dm_group_messages;
create trigger dm_group_messages_sender_member
before insert on public.dm_group_messages
for each row execute function private.enforce_dm_group_sender_member();

do $$
declare
  t text;
begin
  foreach t in array array[
    'creator_membership_plans',
    'razorpay_webhook_events',
    'dm_groups',
    'dm_group_members',
    'dm_group_messages'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

revoke all on public.creator_membership_plans, public.razorpay_webhook_events,
  public.dm_groups, public.dm_group_members, public.dm_group_messages
from anon, authenticated;
grant all on public.creator_membership_plans, public.razorpay_webhook_events,
  public.dm_groups, public.dm_group_members, public.dm_group_messages
to service_role;
