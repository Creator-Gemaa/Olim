create table if not exists public.membership_plans (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 60),
  description text not null default '' check (char_length(description) <= 240),
  features jsonb not null default '[]'::jsonb,
  amount_paise integer not null check (amount_paise >= 100 and amount_paise <= 100000000),
  currency text not null default 'INR' check (currency = 'INR'),
  period text not null default 'monthly' check (period in ('monthly','yearly')),
  interval integer not null default 1 check (interval between 1 and 12),
  razorpay_plan_id text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists membership_plans_creator_active_idx on public.membership_plans(creator_id, is_active, created_at desc);

alter table public.posts add column if not exists visibility text not null default 'public';
alter table public.posts drop constraint if exists posts_visibility_check;
alter table public.posts add constraint posts_visibility_check check (visibility in ('public','members_only'));
alter table public.posts add column if not exists membership_plan_id uuid references public.membership_plans(id) on delete set null;
create index if not exists posts_membership_plan_idx on public.posts(membership_plan_id) where visibility = 'members_only';

alter table public.subscriptions add column if not exists membership_plan_id uuid references public.membership_plans(id) on delete set null;
alter table public.subscriptions add column if not exists razorpay_payment_id text;
alter table public.subscriptions add column if not exists current_start_at timestamptz;
alter table public.subscriptions add column if not exists current_end_at timestamptz;
alter table public.subscriptions add column if not exists updated_at timestamptz not null default now();
create index if not exists subscriptions_membership_access_idx on public.subscriptions(creator_id, subscriber_id, status);

alter table public.creator_payment_connections add column if not exists billing_consent_at timestamptz;
alter table public.creator_payment_connections add column if not exists billing_consent_version text;

create table if not exists public.razorpay_webhook_events (
  provider_event_id text primary key,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  event_type text not null,
  payload_hash text not null,
  processed_at timestamptz not null default now()
);
create index if not exists razorpay_webhook_events_creator_idx on public.razorpay_webhook_events(creator_id, processed_at desc);

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
  primary key (group_id, user_id)
);
create index if not exists dm_group_members_user_idx on public.dm_group_members(user_id, joined_at desc);
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
create index if not exists dm_group_messages_group_created_idx on public.dm_group_messages(group_id, created_at desc);

alter table public.membership_plans enable row level security;
alter table public.razorpay_webhook_events enable row level security;
alter table public.dm_groups enable row level security;
alter table public.dm_group_members enable row level security;
alter table public.dm_group_messages enable row level security;
revoke all on public.membership_plans, public.razorpay_webhook_events, public.dm_groups, public.dm_group_members, public.dm_group_messages from anon, authenticated;
grant all on public.membership_plans, public.razorpay_webhook_events, public.dm_groups, public.dm_group_members, public.dm_group_messages to service_role;
revoke all on public.creator_payment_connections from anon, authenticated;
