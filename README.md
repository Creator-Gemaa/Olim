# FameLoop

FameLoop is a creator-first social PWA: real fame, real people, and your moment. It includes a Reels-style feed, video posts, 24-hour stories, profiles, follows, likes, comments, creator audio uploads, moderation, verification and an installable web app.

## Stack
- React + TypeScript + Vite
- Supabase Postgres and Storage
- Supabase Edge Function API
- Custom username/password authentication (not Supabase Auth): PBKDF2-SHA-256 password hashes with unique salts and opaque, server-validated sessions
- Progressive Web App service worker with a user-confirmed update action

## Supabase project
The migrations in `supabase/migrations` have already been applied to project `wjejsrsrnmhzknhhyjde`. The Storage bucket is named `media`. Browser roles have no direct access to application tables; application database access goes through the private Edge Function.

## Run locally
Requires Node.js 20.19+ and npm.
1. Copy `.env.example` to `.env.local`.
2. Keep the Supabase URL and legacy anon public key from the example (or replace them with the matching project values).
3. Run `npm install`, then `npm run dev`.
4. Open the local address printed by Vite.

Run quality checks with `npm run test` and `npm run build`.

## Edge Function
The `api` function is deployed and active in Supabase. Source: `supabase/functions/api/index.ts`. To redeploy after changing it, run `supabase functions deploy api`.

Set these secrets in Supabase Dashboard → Edge Functions → Secrets:
- `ADMIN_PANEL_PASSWORD`: choose a new, strong administrator passphrase. `Ctrl+Q` opens the gate. This secret is not stored in Git.
- `ADMIN_USERNAMES`: optional comma-separated username allowlist for admin access.
- `PAYMENT_ENCRYPTION_KEY`: required to save creator Razorpay/Stripe credentials. Generate a fresh 32-byte key, base64-encoded (for example, `openssl rand -base64 32`), and save it only as an Edge Function secret.
- `APP_ORIGINS`: recommended comma-separated list of production origins before public launch.

Do not use a weak numeric PIN or a password previously pasted into a chat as the live admin secret. Use a new random secret and rotate it if it has been exposed.

## Feature boundaries and security notes
- Signup asks for username, password, confirmation, referral source and date of birth. The API enforces an age minimum of 13. Passwords are stored as salted PBKDF2-SHA-256 hashes; raw passwords are not stored.
- The browser stores an opaque API session in `sessionStorage`, so it is cleared when the tab session ends. This is still accessible to same-origin JavaScript; use a same-origin backend with HttpOnly, Secure, SameSite cookies and a strong Content Security Policy before a high-risk public launch.
- Posts are held pending until an administrator reviews them. Only approved posts enter the public feed. Exact SHA-256 matches against the administrator-managed fingerprint table are blocked.
- Copyright detection is deliberately limited to exact file-hash matching against assets manually entered by administrators. It is **not** a global crawler, perceptual audio/video matching engine, legal determination or an external corpus of hundreds of thousands of videos. Broad matching requires licensed reference material and an appropriately licensed fingerprinting provider.
- Stories have a 24-hour expiry and require moderation before appearing.
- Videos up to and including 120 seconds are classified as Reels; longer videos are categorized as Videos.
- Audio uploads require a rights confirmation. This is a creator audio upload area, not an iTunes/Apple Music catalogue and does not grant music licenses.
- The admin keyboard shortcut reveals a password gate only. The API validates the configured server secret and checks admin permission for each admin operation. On successful gate entry, the account is marked as an admin for the milestone notification workflow.
- Creators can submit their own Razorpay Key ID + Key Secret or Stripe secret key. The API encrypts the credential bundle with AES-GCM using the server-only `PAYMENT_ENCRYPTION_KEY`, stores ciphertext in Postgres, and never returns the secret to the browser. Live checkout, signed webhook processing, refunds and subscription lifecycle handling are not implemented yet; do not treat a stored key as a working payment connection. FameLoop does not charge or take a creator revenue share.
- PWA updates are checked by the service worker and shown as an Update button. Browser/OS installation behavior still applies; this is not an app-store auto-updater or native push-notification service.

## Before public launch
Configure a new admin passphrase and production CORS origins. Add user reporting, block/mute controls, story moderation controls, moderation staffing, privacy/terms/age processes, backups, observability, robust per-IP rate limiting, CSP, same-origin HttpOnly sessions and end-to-end tests. Configure and test payment providers and licensed music separately.
