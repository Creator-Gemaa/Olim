alter table public.profiles add column if not exists follower_count integer not null default 0,add column if not exists following_count integer not null default 0,add column if not exists posts_count integer not null default 0;
alter table public.app_sessions add column if not exists admin_gate_expires_at timestamptz;
create table if not exists public.auth_attempts(id bigint generated always as identity primary key,ip_hash text not null,attempted_at timestamptz not null default now());
create index if not exists auth_attempts_ip_time_idx on public.auth_attempts(ip_hash,attempted_at);
alter table public.auth_attempts enable row level security;revoke all on table public.auth_attempts from anon,authenticated;grant all on table public.auth_attempts to service_role;
create or replace function public.fameloop_follow_counts() returns trigger language plpgsql as $$
declare new_count integer;begin
 if tg_op='INSERT' then
  update public.profiles set follower_count=follower_count+1 where id=new.following_id returning follower_count into new_count;
  update public.profiles set following_count=following_count+1 where id=new.follower_id;
  if new_count=500000 then insert into public.notifications(user_id,actor_id,type,message) select id,new.following_id,'milestone_500k','A creator you manage just reached 500,000 followers.' from public.profiles where is_admin=true;end if;return new;
 elsif tg_op='DELETE' then update public.profiles set follower_count=greatest(0,follower_count-1) where id=old.following_id;update public.profiles set following_count=greatest(0,following_count-1) where id=old.follower_id;return old;end if;return null;
end $$;
drop trigger if exists follows_count_trigger on public.follows;create trigger follows_count_trigger after insert or delete on public.follows for each row execute function public.fameloop_follow_counts();
create or replace function public.fameloop_like_counts() returns trigger language plpgsql as $$begin
 if tg_op='INSERT' then update public.posts set likes_count=likes_count+1 where id=new.post_id;return new;
 elsif tg_op='DELETE' then update public.posts set likes_count=greatest(0,likes_count-1) where id=old.post_id;return old;end if;return null;end $$;
drop trigger if exists likes_count_trigger on public.likes;create trigger likes_count_trigger after insert or delete on public.likes for each row execute function public.fameloop_like_counts();
create or replace function public.fameloop_comment_counts() returns trigger language plpgsql as $$begin
 if tg_op='INSERT' then update public.posts set comments_count=comments_count+1 where id=new.post_id;return new;
 elsif tg_op='DELETE' then update public.posts set comments_count=greatest(0,comments_count-1) where id=old.post_id;return old;end if;return null;end $$;
drop trigger if exists comments_count_trigger on public.comments;create trigger comments_count_trigger after insert or delete on public.comments for each row execute function public.fameloop_comment_counts();
create or replace function public.fameloop_post_counts() returns trigger language plpgsql as $$begin
 if tg_op='INSERT' then update public.profiles set posts_count=posts_count+1 where id=new.user_id;return new;
 elsif tg_op='DELETE' then update public.profiles set posts_count=greatest(0,posts_count-1) where id=old.user_id;return old;end if;return null;end $$;
drop trigger if exists posts_count_trigger on public.posts;create trigger posts_count_trigger after insert or delete on public.posts for each row execute function public.fameloop_post_counts();
create index if not exists admin_audit_admin_idx on public.admin_audit(admin_id);
create index if not exists audio_tracks_user_idx on public.audio_tracks(user_id);
create index if not exists comments_user_idx on public.comments(user_id);
create index if not exists copyright_fingerprints_creator_idx on public.copyright_fingerprints(created_by);
create index if not exists notifications_actor_idx on public.notifications(actor_id);
create index if not exists notifications_post_idx on public.notifications(post_id);
create index if not exists posts_audio_track_idx on public.posts(audio_track_id);
create index if not exists posts_reviewer_idx on public.posts(reviewed_by);
create index if not exists stories_reviewer_idx on public.stories(reviewed_by);
create index if not exists subscriptions_subscriber_idx on public.subscriptions(subscriber_id);
