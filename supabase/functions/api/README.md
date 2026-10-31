# FameLoop Edge API

The `api` function has gateway JWT verification disabled because FameLoop uses its own username/password session table instead of Supabase Auth. Every signed-in operation validates a random opaque session token against a server-side SHA-256 digest. The function uses the Supabase private service key for Postgres and Storage access. The browser receives only the project publishable key.

Never commit the service key, admin passphrase, or merchant payment secrets. Set `ADMIN_PANEL_PASSWORD`, optional `ADMIN_USERNAMES`, and production `APP_ORIGINS` in Supabase Edge Function Secrets.
