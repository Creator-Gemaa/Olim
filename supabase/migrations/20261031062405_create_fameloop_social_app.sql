create table if not exists public.profiles (
 id uuid primary key default gen_random_uuid(),username text not null unique check(username=lower(username) and username~'^[a-z0-9_]{3,24}$'),
 password_salt text not null,password_hash text not null,password_iterations integer not null default 310000,display_name text not null,
 bio text not null default '',avatar_path text,birth_date date not null,heard_about text not null check(heard_about in('Google','Friends','AI','Other')),
 is_verified boolean not null default false,is_admin boolean not null default false,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table if not exists public.app_sessions(token_hash text primary key,user_id uuid not null references public.profiles(id) on delete cascade,expires_at timestamptz not null,created_at timestamptz not null default now());
create index if not exists app_sessions_user_idx on public.app_sessions(user_id);
create index if not exists app_sessions_expires_idx on public.app_sessions(expires_at);
create table if not exists public.posts(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.profiles(id) on delete cascade,caption text not null default '' check(char_length(caption)<=2200),
 media_path text not null,media_type text not null check(media_type in('image','video')),kind text not null check(kind in('photo','reel','video')),
 duration_seconds numeric(10,2) not null default 0 check(duration_seconds>=0),audio_track_id uuid,
 status text not null default 'pending' check(status in('pending','approved','blocked')),
 copyright_status text not null default 'pending_manual_review' check(copyright_status in('pending_manual_review','no_exact_match','matched')),
 sha256 text not null,is_world_featured boolean not null default false,likes_count integer not null default 0,comments_count integer not null default 0,
 created_at timestamptz not null default now(),reviewed_at timestamptz,reviewed_by uuid references public.profiles(id)
);
create index if not exists posts_feed_idx on public.posts(status,is_world_featured desc,created_at desc);
create index if not exists posts_user_idx on public.posts(user_id,created_at desc);
create index if not exists posts_hash_idx on public.posts(sha256);
create table if not exists public.stories(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.profiles(id) on delete cascade,media_path text not null,
 media_type text not null check(media_type in('image','video')),caption text not null default '' check(char_length(caption)<=500),sha256 text not null,
 status text not null default 'pending' check(status in('pending','approved','blocked')),
 copyright_status text not null default 'pending_manual_review' check(copyright_status in('pending_manual_review','no_exact_match','matched')),
 created_at timestamptz not null default now(),expires_at timestamptz not null default(now()+interval '24 hours'),
 reviewed_at timestamptz,reviewed_by uuid references public.profiles(id)
);
create index if not exists stories_expiry_idx on public.stories(expires_at);
create index if not exists stories_user_idx on public.stories(user_id,created_at desc);
create table if not exists public.follows(follower_id uuid not null references public.profiles(id) on delete cascade,following_id uuid not null references public.profiles(id) on delete cascade,created_at timestamptz not null default now(),primary key(follower_id,following_id),check(follower_id<>following_id));
create index if not exists follows_following_idx on public.follows(following_id);
create table if not exists public.likes(user_id uuid not null references public.profiles(id) on delete cascade,post_id uuid not null references public.posts(id) on delete cascade,created_at timestamptz not null default now(),primary key(user_id,post_id));
create index if not exists likes_post_idx on public.likes(post_id);
create table if not exists public.comments(id uuid primary key default gen_random_uuid(),post_id uuid not null references public.posts(id) on delete cascade,user_id uuid not null references public.profiles(id) on delete cascade,content text not null check(char_length(content) between 1 and 1000),created_at timestamptz not null default now());
create index if not exists comments_post_idx on public.comments(post_id,created_at);
create table if not exists public.notifications(id uuid primary key default gen_random_uuid(),user_id uuid not null references public.profiles(id) on delete cascade,actor_id uuid references public.profiles(id) on delete set null,type text not null,post_id uuid references public.posts(id) on delete cascade,message text not null,read_at timestamptz,created_at timestamptz not null default now());
create index if not exists notifications_user_idx on public.notifications(user_id,created_at desc);
create table if not exists public.copyright_fingerprints(id uuid primary key default gen_random_uuid(),sha256 text not null unique check(sha256~'^[a-f0-9]{64}$'),rights_holder text not null,source_label text not null,created_by uuid references public.profiles(id),created_at timestamptz not null default now());
create table if not exists public.audio_tracks(id uuid primary key default gen_random_uuid(),user_id uuid not null references public.profiles(id) on delete cascade,title text not null,artist text not null default '',media_path text not null,rights_confirmation text not null,created_at timestamptz not null default now());
alter table public.posts add constraint posts_audio_track_id_fkey foreign key(audio_track_id) references public.audio_tracks(id) on delete set null;
create table if not exists public.creator_payment_connections(creator_id uuid primary key references public.profiles(id) on delete cascade,provider text not null check(provider in('razorpay','stripe')),encrypted_credentials text not null,connected_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table if not exists public.subscriptions(id uuid primary key default gen_random_uuid(),creator_id uuid not null references public.profiles(id) on delete cascade,subscriber_id uuid not null references public.profiles(id) on delete cascade,provider text not null check(provider in('razorpay','stripe')),provider_subscription_id text not null unique,status text not null default 'pending',created_at timestamptz not null default now(),check(creator_id<>subscriber_id));
create index if not exists subscriptions_creator_idx on public.subscriptions(creator_id,created_at desc);
create table if not exists public.admin_audit(id uuid primary key default gen_random_uuid(),admin_id uuid not null references public.profiles(id),action text not null,target_id uuid,details jsonb not null default '{}'::jsonb,created_at timestamptz not null default now());
do $$ declare t text; begin foreach t in array array['profiles','app_sessions','posts','stories','follows','likes','comments','notifications','copyright_fingerprints','audio_tracks','creator_payment_connections','subscriptions','admin_audit'] loop execute format('alter table public.%I enable row level security',t);execute format('revoke all on table public.%I from anon,authenticated',t);execute format('grant all on table public.%I to service_role',t);end loop;end $$;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('media','media',true,104857600,array['image/jpeg','image/png','image/webp','video/mp4','video/webm','audio/mpeg','audio/mp4']::text[]) on conflict(id) do update set public=excluded.public,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
