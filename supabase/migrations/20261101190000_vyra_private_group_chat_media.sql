insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('private-chat', 'private-chat', false, 15728640, array[
  'image/jpeg','image/png','image/webp','audio/webm','audio/ogg','audio/mp4','audio/mpeg'
])
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types,
  updated_at = now();