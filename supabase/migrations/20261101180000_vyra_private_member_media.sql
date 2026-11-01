alter table public.posts
  add column if not exists media_bucket text not null default 'media';
alter table public.posts
  drop constraint if exists posts_media_bucket_check;
alter table public.posts
  add constraint posts_media_bucket_check check (media_bucket in ('media','member-media'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('member-media', 'member-media', false, 52428800, array['video/mp4','video/webm'])
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types,
  updated_at = now();
