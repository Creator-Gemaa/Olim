-- VYRA reserves administrator authority to the unique owner username.
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_owner_admin_only
  CHECK (is_admin = (username = 'owner'));
