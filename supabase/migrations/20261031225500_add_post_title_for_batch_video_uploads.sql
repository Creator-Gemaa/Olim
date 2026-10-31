alter table public.posts
  add column if not exists title text not null default '';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'posts_title_length'
      and conrelid = 'public.posts'::regclass
  ) then
    alter table public.posts
      add constraint posts_title_length check (char_length(title) <= 160);
  end if;
end
$$;