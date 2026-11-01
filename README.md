# VYRA

VYRA is a creator-first social app: make your mark. It includes a responsive web app, an Android APK build and a Windows desktop installer, backed by Supabase.

## Stack
- React + TypeScript + Vite
- Supabase Postgres and Storage
- Custom username/password authentication (not Supabase Auth)
- Capacitor 8 for Android
- Electron 45 and NSIS for Windows

## First account and admin access
The Supabase project currently has no registered user accounts. Register the username **Owner** first to create the founder account. Usernames are case-insensitive, so `Owner` is stored as `owner`. This is the only username that receives admin access. After login, Owner sees the Admin item and can open it directly; there is no second admin password prompt. The database constraint and Edge Function both enforce this rule. Do not share the Owner account password.

## Supabase
The migrations in `supabase/migrations` have been applied to project `wjejsrsrnmhzknhhyjde`. Media is stored in the `media` bucket. Browser roles have no direct access to application tables; the Edge Function uses the private server key.

## Run locally
Requires Node.js 22 and npm.
1. Copy `.env.example` to `.env.local`.
2. Run `npm install`.
3. Run `npm run dev`.

The committed `.env.production` contains only the Supabase URL and public anon client key required by VYRA builds. It does not contain the database service-role key.

## Android APK
Install Android Studio, Android SDK API 36 and JDK 21.
1. `npm install`
2. `npm run build`
3. `npx cap add android` (once)
4. `npx @capacitor/assets generate --android --iconBackgroundColor "#0B1020" --splashBackgroundColor "#0B1020"`
5. `npx cap sync android`
6. `cd android && ./gradlew assembleDebug`

The downloadable APK is debug-signed for direct installation/testing. It is not a Google Play release-signed package.

## Windows EXE
On Windows with Node.js 22:
1. `npm install`
2. `npm run build`
3. `npm run desktop:package`

This creates `release/VYRA-Setup.exe`. It is unsigned, so Windows SmartScreen may display an unrecognized-publisher warning. A code-signing certificate is needed to remove that warning.

## Downloads
The native workflow builds and publishes both installers to [VYRA latest releases](https://github.com/Creator-Gemaa/Olim/releases/tag/vyra-latest):
- `VYRA-Android.apk`
- `VYRA-Setup.exe`

## Admin
Press `Ctrl+Q` while signed in to the Owner account. Only Owner can verify creators, review posts and stories, register exact copyright hashes and feature approved videos in the world feed.

## Creator controls, calling and payments
- Creators can remove their own uploaded videos from their creator wall. The API checks ownership before deleting the database record and stored media.
- Direct messages support client-side end-to-end encryption, photo and voice attachments, inbox search, connection status, keyboard sending, copying decrypted text and sender-only message unsend.
- Audio/video calls use WebRTC, Google STUN and optional Coturn-compatible REST-auth TURN. The call setup lifecycle is reset safely during React StrictMode effect cleanup, and failed calls can be retried from the call UI. For restrictive mobile/carrier networks, configure a TURN service with Supabase Edge Function secrets `TURN_URLS` (comma-separated `turn:`/`turns:` URLs) and `TURN_SHARED_SECRET`. VYRA issues short-lived, per-user TURN credentials. TURN hosting and valid credentials are still required on networks that block direct peer-to-peer traffic.
- Each verified creator must provide their own Razorpay Key ID and Key Secret in Settings from their own Razorpay account. VYRA does not issue, provide or share payment keys; credentials are encrypted server-side.
- Razorpay key storage is not live recurring billing. Checkout, verified payment webhooks, cancellations, refunds and subscription lifecycle handling still need implementation before creators can charge members.

## Feature boundaries
- Copyright matching is exact SHA-256 comparison against an admin-managed list, not a global crawler or perceptual matching engine.
- Audio uploads are for creator-owned or licensed music; this is not an iTunes/Apple Music catalog.

## Checks
- `npm run test`
- `npm run build`
- `npm run desktop:package`
