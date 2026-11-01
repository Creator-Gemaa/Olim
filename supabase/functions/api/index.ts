import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const PUBLISHABLE = (() => {
  try { return JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}").default || ""; }
  catch { return Deno.env.get("SUPABASE_ANON_KEY") || ""; }
})();
const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const origin = "*";
const baseHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Vary": "Origin",
};

function response(data: unknown, status = 200, origin = "*") {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...baseHeaders, "Access-Control-Allow-Origin": origin },
  });
}
function fail(message: string, status = 400, origin = "*") {
  return response({ error: message }, status, origin);
}
function hex(bytes: Uint8Array) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function indiaDateKey(value = new Date()) {
  return new Date(value.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}
function indiaDayStartIso() {
  return new Date(`${indiaDateKey()}T00:00:00+05:30`).toISOString();
}
async function digest(value: string) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
function b64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((b) => binary += String.fromCharCode(b));
  return btoa(binary);
}
function fromB64(value: string) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
function constantTimeEqual(a: string, b: string) {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
async function passwordHash(password: string, salt: Uint8Array, iterations = 310000) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return b64(new Uint8Array(bits));
}
async function encryptCredentials(value: string) {
  const rawKey = Deno.env.get("PAYMENT_ENCRYPTION_KEY") || "";
  if (!rawKey) throw new Error("Payment credential encryption is not configured.");
  let keyBytes: Uint8Array;
  try { keyBytes = fromB64(rawKey.trim()); } catch { throw new Error("PAYMENT_ENCRYPTION_KEY must be base64 for a 32-byte AES key."); }
  if (keyBytes.length !== 32) throw new Error("PAYMENT_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, new TextEncoder().encode(value));
  return "v1." + b64(iv) + "." + b64(new Uint8Array(cipher));
}
async function decryptCredentials(value: string) {
  const rawKey = Deno.env.get("PAYMENT_ENCRYPTION_KEY") || "";
  let keyBytes: Uint8Array;
  try { keyBytes = fromB64(rawKey.trim()); } catch { throw new Error("Payment credential encryption is not configured."); }
  if (keyBytes.length !== 32) throw new Error("Payment credential encryption is not configured.");
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("Stored payment credentials are not readable.");
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(parts[1]) }, cryptoKey, fromB64(parts[2]));
  return JSON.parse(new TextDecoder().decode(plain));
}
async function hmacHex(secret: string, value: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {
    name: "HMAC", hash: "SHA-256",
  }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}
async function razorpayApi(credentials: { keyId: string; keySecret: string }, path: string, method = "GET", payload?: any) {
  const rpResponse = await fetch("https://api.razorpay.com/v1" + path, {
    method,
    headers: {
      Authorization: "Basic " + btoa(credentials.keyId + ":" + credentials.keySecret),
      "Content-Type": "application/json",
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(12000),
  });
  const data = await rpResponse.json().catch(() => ({}));
  if (!rpResponse.ok) {
    const description = String(data?.error?.description || "");
    throw new Error(description.slice(0, 240) || "Razorpay rejected the request. Check the connected API credentials and account permissions.");
  }
  return data;
}
async function creatorFollowerCount(creatorId: string) {
  const { count, error } = await db.from("follows").select("follower_id", { count: "exact", head: true })
    .eq("following_id", creatorId);
  if (error) throw error;
  return count || 0;
}
async function unlockMonetization(profile: any) {
  if (profile.monetization_unlocked_at) return { unlocked: true, followerCount: await creatorFollowerCount(profile.id) };
  const followerCount = await creatorFollowerCount(profile.id);
  if (followerCount >= 20000) {
    const unlockedAt = new Date().toISOString();
    const { error } = await db.from("profiles").update({ monetization_unlocked_at: unlockedAt }).eq("id", profile.id);
    if (error) throw error;
    profile.monetization_unlocked_at = unlockedAt;
    return { unlocked: true, followerCount };
  }
  return { unlocked: false, followerCount };
}
async function paymentConnection(creatorId: string) {
  const { data, error } = await db.from("creator_payment_connections")
    .select("provider,encrypted_credentials,billing_consent_at,billing_consent_version,connected_at,updated_at")
    .eq("creator_id", creatorId).maybeSingle();
  if (error) throw error;
  if (!data || data.provider !== "razorpay" || !data.billing_consent_at) return null;
  const credentials = await decryptCredentials(data.encrypted_credentials);
  if (!credentials?.keyId || !credentials?.keySecret || !credentials?.webhookSecret) return null;
  return { connection: data, credentials };
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeUser(profile: any) {
  if (!profile) return null;
  const avatar = profile.avatar_path
    ? db.storage.from("media").getPublicUrl(profile.avatar_path).data.publicUrl
    : null;
  return {
    id: profile.id, username: profile.username, display_name: profile.display_name,
    bio: profile.bio || "", avatar_url: avatar, is_verified: !!profile.is_verified,
    follower_count: profile.follower_count || 0, following_count: profile.following_count || 0,
    posts_count: profile.posts_count || 0, is_admin: !!profile.is_admin,
  };
}
async function makeSession(userId: string) {
  const token = randomToken();
  const tokenHash = await digest(token);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await db.from("app_sessions").insert({ token_hash: tokenHash, user_id: userId, expires_at: expiresAt });
  if (error) throw error;
  return token;
}
async function auth(req: Request) {
  const authorization = req.headers.get("authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  if (!token || token === PUBLISHABLE) return null;
  const tokenHash = await digest(token);
  const { data: session } = await db.from("app_sessions")
    .select("user_id,expires_at,admin_gate_expires_at")
    .eq("token_hash", tokenHash).maybeSingle();
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) return null;
  // Rolling 30-day session: active creators stay signed in, while inactive or
  // stolen tokens still expire instead of becoming permanent credentials.
  if (new Date(session.expires_at).getTime() <= Date.now() + 14 * 24 * 60 * 60 * 1000) {
    const refreshedExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { error: refreshError } = await db.from("app_sessions")
      .update({ expires_at: refreshedExpiry }).eq("token_hash", tokenHash);
    if (refreshError) throw refreshError;
    session.expires_at = refreshedExpiry;
  }
  const { data: profile } = await db.from("profiles").select("*").eq("id", session.user_id).maybeSingle();
  if (!profile) return null;
  return { tokenHash, session, profile };
}
function publicMedia(path: string | null) {
  return path ? db.storage.from("media").getPublicUrl(path).data.publicUrl : null;
}
async function enrichPosts(rows: any[], viewerId: string) {
  if (!rows?.length) return [];
  const ids = rows.map((row) => row.id);
  const authorIds = [...new Set(rows.map((row) => row.user_id).filter(Boolean))];
  const memberPostRows = rows.filter((row) => row.visibility === "members_only" && row.user_id !== viewerId);
  const [likesResult, followsResult, savedResult, subscriptionsResult] = await Promise.all([
    db.from("likes").select("post_id").eq("user_id", viewerId).in("post_id", ids),
    authorIds.length
      ? db.from("follows").select("following_id").eq("follower_id", viewerId).in("following_id", authorIds)
      : Promise.resolve({ data: [], error: null }),
    db.from("saved_posts").select("post_id").eq("user_id", viewerId).in("post_id", ids),
    memberPostRows.length
      ? db.from("subscriptions").select("creator_id,membership_plan_id")
          .eq("subscriber_id", viewerId).eq("status", "active")
          .in("creator_id", [...new Set(memberPostRows.map((row) => row.user_id))])
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (likesResult.error) throw likesResult.error;
  if (followsResult.error) throw followsResult.error;
  if (savedResult.error) throw savedResult.error;
  if (subscriptionsResult.error) throw subscriptionsResult.error;
  const liked = new Set((likesResult.data || []).map((item: any) => item.post_id));
  const following = new Set((followsResult.data || []).map((item: any) => item.following_id));
  const saved = new Set((savedResult.data || []).map((item: any) => item.post_id));
  const activeMemberships = new Set((subscriptionsResult.data || [])
    .map((item: any) => item.creator_id + ":" + item.membership_plan_id));
  const visibleRows = rows.filter((row) => row.visibility !== "members_only"
    || row.user_id === viewerId
    || (!!row.membership_plan_id && activeMemberships.has(row.user_id + ":" + row.membership_plan_id)));
  return await Promise.all(visibleRows.map(async (row) => {
    const bucket = row.media_bucket === "member-media" ? "member-media" : "media";
    let mediaUrl = publicMedia(row.media_path);
    if (bucket === "member-media") {
      const { data, error } = await db.storage.from(bucket).createSignedUrl(row.media_path, 60 * 60);
      mediaUrl = error ? "" : data?.signedUrl || "";
    }
    return {
      id: row.id, title: row.title || "", caption: row.caption, media_url: mediaUrl, media_type: row.media_type,
      kind: row.kind, duration_seconds: Number(row.duration_seconds || 0), likes_count: row.likes_count || 0,
      comments_count: row.comments_count || 0, views_count: row.views_count || 0,
      visibility: row.visibility || "public", membership_plan_id: row.membership_plan_id || null,
      created_at: row.created_at, is_world_featured: !!row.is_world_featured,
      liked: liked.has(row.id), saved: saved.has(row.id), author: { ...safeUser(row.author), is_following: following.has(row.user_id) },
    };
  }));
}
async function authRateLimit(req: Request) {
  const address = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const ipHash = await digest("fameloop-rate:" + address);
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  await db.from("auth_attempts").delete().lt("attempted_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  const { count } = await db.from("auth_attempts").select("id", { count: "exact", head: true }).eq("ip_hash", ipHash).gte("attempted_at", cutoff);
  if ((count || 0) >= 12) return false;
  await db.from("auth_attempts").insert({ ip_hash: ipHash });
  return true;
}
function validateUsername(username: string) {
  return /^[a-z0-9_]{3,24}$/.test(username);
}
async function isAdmin(context: any) {
  return context.profile.username === "owner" && context.profile.is_admin === true;
}
async function audit(adminId: string, action: string, targetId: string | null, details: any = {}) {
  await db.from("admin_audit").insert({ admin_id: adminId, action, target_id: targetId, details });
}
async function exactCopyrightMatch(hash: string) {
  const { data } = await db.from("copyright_fingerprints").select("id,rights_holder,source_label").eq("sha256", hash).maybeSingle();
  return data || null;
}
async function storageFileExists(path: string, bucket = "media") {
  const parts = path.split("/");
  const folder = parts.slice(0, -1).join("/");
  const leaf = parts[parts.length - 1];
  const { data, error } = await db.storage.from(bucket).list(folder, { search: leaf, limit: 10 });
  if (error) return false;
  return (data || []).some((item: any) => item.name === leaf);
}
function mimeFamily(type: string) {
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  return "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { ...baseHeaders, "Access-Control-Allow-Origin": origin } });
  if (req.method !== "POST") return fail("Use POST for API actions.", 405, origin || "null");
  if (!SUPABASE_URL || !SERVICE_KEY || !PUBLISHABLE) return fail("The FameLoop API is not configured yet.", 503, origin || "null");
  const apiKey = req.headers.get("apikey") || "";
  if (!constantTimeEqual(apiKey, PUBLISHABLE) && !constantTimeEqual(apiKey, Deno.env.get("SUPABASE_ANON_KEY") || "")) {
    return fail("Invalid application key.", 401, origin || "null");
  }
  try {
    const body = await req.json();
    const action = String(body.action || "");
    const context = await auth(req);
    const requireUser = () => {
      if (!context) throw new Error("Please log in again to continue.");
      return context;
    };
    const requireAdmin = async () => {
      const current = requireUser();
      if (!(await isAdmin(current))) throw new Error("Administrator access is required.");
      return current;
    };

    if (action === "signup") {
      if (!(await authRateLimit(req))) return fail("Too many attempts. Try again in 15 minutes.", 429, origin);
      const username = String(body.username || "").toLowerCase().trim();
      const password = String(body.password || "");
      const confirm = String(body.confirmPassword || "");
      const birthDate = String(body.birthDate || "");
      const heard = String(body.heardAbout || "");
      if (!validateUsername(username)) return fail("Username must be 3–24 characters using lowercase letters, numbers or underscores.", 422, origin);
      if (password.length < 10 || password.length > 128) return fail("Password must be between 10 and 128 characters.", 422, origin);
      if (password !== confirm) return fail("Passwords do not match.", 422, origin);
      if (!["Google", "Friends", "AI", "Other"].includes(heard)) return fail("Choose how you heard about FameLoop.", 422, origin);
      const birth = new Date(birthDate + "T00:00:00Z");
      const now = new Date();
      const age = now.getUTCFullYear() - birth.getUTCFullYear() - (now.getUTCMonth() < birth.getUTCMonth() || (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() < birth.getUTCDate()) ? 1 : 0);
      if (!birthDate || Number.isNaN(birth.getTime()) || birth > now || age < 13 || age > 120) return fail("Enter a valid birth date. You must be at least 13 to use this app.", 422, origin);
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iterations = 310000;
      const hash = await passwordHash(password, salt, iterations);
      const { data: profile, error } = await db.from("profiles").insert({
        username, password_salt: b64(salt), password_hash: hash, password_iterations: iterations,
        display_name: username === "owner" ? "Owner" : username,
        birth_date: birthDate, heard_about: heard, is_admin: username === "owner",
      }).select("*").single();
      if (error) return fail(error.code === "23505" ? "That username is already taken." : "Could not create your account.", 409, origin);
      const token = await makeSession(profile.id);
      return response({ user: safeUser(profile), token }, 201, origin);
    }

    if (action === "login") {
      if (!(await authRateLimit(req))) return fail("Too many login attempts. Try again in 15 minutes.", 429, origin);
      const username = String(body.username || "").toLowerCase().trim();
      const password = String(body.password || "");
      const { data: profile } = await db.from("profiles").select("*").eq("username", username).maybeSingle();
      if (!profile || password.length > 128) return fail("Username or password is incorrect.", 401, origin);
      const actual = await passwordHash(password, fromB64(profile.password_salt), profile.password_iterations || 310000);
      if (!constantTimeEqual(actual, profile.password_hash)) return fail("Username or password is incorrect.", 401, origin);
      const token = await makeSession(profile.id);
      return response({ user: safeUser(profile), token }, 200, origin);
    }

    if (action === "me") {
      const current = requireUser();
      return response({ user: safeUser(current.profile) }, 200, origin);
    }
    if (action === "logout") {
      const current = requireUser();
      await db.from("app_sessions").delete().eq("token_hash", current.tokenHash);
      return response({ ok: true }, 200, origin);
    }
    if (action === "feed") {
      const current = requireUser();
      const { data: rows, error } = await db.from("posts")
        .select("*,author:profiles!posts_user_id_fkey(*)")
        .eq("status", "approved").order("is_world_featured", { ascending: false })
        .order("created_at", { ascending: false }).limit(60);
      if (error) throw error;

      // Personalize Reels from videos this creator has liked, then mix in discovery.
      const { data: likedRows, error: likedError } = await db.from("likes")
        .select("post_id").eq("user_id", current.profile.id).limit(250);
      if (likedError) throw likedError;
      const likedPostIds = (likedRows || []).map((item: any) => item.post_id).filter(Boolean);
      const likedCreatorIds = new Set<string>();
      if (likedPostIds.length) {
        const { data: likedVideoRows, error: likedVideoError } = await db.from("posts")
          .select("user_id").in("id", likedPostIds).eq("status", "approved").eq("media_type", "video");
        if (likedVideoError) throw likedVideoError;
        (likedVideoRows || []).forEach((item: any) => {
          if (item.user_id && item.user_id !== current.profile.id) likedCreatorIds.add(item.user_id);
        });
      }
      const { data: reelCandidates, error: reelError } = await db.from("posts")
        .select("*,author:profiles!posts_user_id_fkey(*)")
        .eq("status", "approved").eq("media_type", "video")
        .order("created_at", { ascending: false }).limit(500);
      if (reelError) throw reelError;
      // Include the current creator's own Reels. The former owner exclusion
      // hid every Reel when the library consisted of one creator's uploads.
      // Duration fallback repairs legacy rows that were saved with kind="video".
      const reelRows = (reelCandidates || [])
        .filter((post: any) => post.kind === "reel" ||
          (Number(post.duration_seconds) > 0 && Number(post.duration_seconds) <= 120))
        .map((post: any) => ({ ...post, kind: "reel" }));
      const shuffle = (items: any[]) => {
        const result = [...items];
        for (let index = result.length - 1; index > 0; index--) {
          const swapIndex = Math.floor(Math.random() * (index + 1));
          [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
        }
        return result;
      };
      const preferredReels = shuffle((reelRows || []).filter((post: any) => likedCreatorIds.has(post.user_id)));
      const discoveryReels = shuffle((reelRows || []).filter((post: any) => !likedCreatorIds.has(post.user_id)));
      const randomizedReels: any[] = [];
      while (preferredReels.length || discoveryReels.length) {
        const choosePreferred = preferredReels.length > 0 &&
          (discoveryReels.length === 0 || Math.random() < 0.68);
        randomizedReels.push(choosePreferred ? preferredReels.pop() : discoveryReels.pop());
      }

      // The World Feed is a fresh India-time day bucket, ranked independently of personalized Reels.
      const { data: worldRows, error: worldError } = await db.from("posts")
        .select("*,author:profiles!posts_user_id_fkey(*)")
        .eq("status", "approved").eq("media_type", "video")
        .gte("created_at", indiaDayStartIso())
        .order("created_at", { ascending: true }).limit(500);
      if (worldError) throw worldError;
      const rankScore = (post: any) => {
        const ageHours = Math.max(0, (Date.now() - new Date(post.created_at).getTime()) / 3600000);
        return ageHours * 0.25 + Number(post.likes_count || 0) * 1.5
          + Number(post.comments_count || 0) * 2.5 + Number(post.views_count || 0) * 0.05;
      };
      const rankedWorldRows = (worldRows || []).sort((a: any, b: any) =>
        rankScore(b) - rankScore(a) || new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );

      const { data: storyRows } = await db.from("stories")
        .select("*,author:profiles!stories_user_id_fkey(*)")
        .eq("status", "approved").gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false }).limit(80);
      const stories = (storyRows || []).map((story: any) => ({
        id: story.id, media_url: publicMedia(story.media_path), media_type: story.media_type,
        caption: story.caption, created_at: story.created_at, author: safeUser(story.author),
      }));
      return response({
        posts: await enrichPosts(rows || [], current.profile.id),
        stories,
        reels: await enrichPosts(randomizedReels.slice(0, 150), current.profile.id),
        worldFeed: await enrichPosts(rankedWorldRows, current.profile.id),
        worldFeedResetsAt: "00:00 Asia/Kolkata",
      }, 200, origin);
    }
    if (action === "profile-posts") {
      const current = requireUser();
      const username = String(body.username || "").toLowerCase();
      const { data: owner } = await db.from("profiles").select("id").eq("username", username).maybeSingle();
      if (!owner) return response({ posts: [] }, 200, origin);
      const { data: rows, error } = await db.from("posts").select("*,author:profiles!posts_user_id_fkey(*)")
        .eq("user_id", owner.id).eq("status", "approved").order("created_at", { ascending: false }).limit(60);
      if (error) throw error;
      return response({ posts: await enrichPosts(rows || [], current.profile.id) }, 200, origin);
    }
    if (action === "saved-posts") {
      const current = requireUser();
      const { data: rows, error } = await db.from("saved_posts")
        .select("post:posts!saved_posts_post_id_fkey(*,author:profiles!posts_user_id_fkey(*))")
        .eq("user_id", current.profile.id).order("created_at", { ascending: false }).limit(100);
      if (error) throw error;
      const posts = (rows || []).map((item: any) => item.post).filter((post: any) => post?.status === "approved");
      return response({ posts: (await enrichPosts(posts, current.profile.id)).map((post: any) => ({ ...post, saved: true })) }, 200, origin);
    }
    if (action === "save-post") {
      const current = requireUser();
      const postId = String(body.postId || "");
      if (!/^[0-9a-f-]{36}$/i.test(postId)) return fail("Choose a valid video to save.", 422, origin);
      const { data: post, error: postError } = await db.from("posts").select("id,status,media_type").eq("id", postId).maybeSingle();
      if (postError) throw postError;
      if (!post || post.status !== "approved" || post.media_type !== "video") return fail("Only approved videos can be saved.", 404, origin);
      const { data: existing, error: lookupError } = await db.from("saved_posts").select("post_id")
        .eq("user_id", current.profile.id).eq("post_id", postId).maybeSingle();
      if (lookupError) throw lookupError;
      if (existing) {
        const { error } = await db.from("saved_posts").delete().eq("user_id", current.profile.id).eq("post_id", postId);
        if (error) throw error;
        return response({ saved: false }, 200, origin);
      }
      const { error } = await db.from("saved_posts").insert({ user_id: current.profile.id, post_id: postId });
      if (error) throw error;
      return response({ saved: true }, 201, origin);
    }
    if (action === "delete-own-post") {
      const current = requireUser();
      const postId = String(body.postId || "");
      if (!/^[0-9a-f-]{36}$/i.test(postId)) return fail("Choose a valid post to delete.", 422, origin);
      const { data: post, error: lookupError } = await db.from("posts")
        .select("id,media_path,media_bucket,user_id").eq("id", postId).eq("user_id", current.profile.id).maybeSingle();
      if (lookupError) throw lookupError;
      if (!post) return fail("This post was not found on your creator account.", 404, origin);
      const { data: deleted, error: deleteError } = await db.from("posts").delete()
        .eq("id", postId).eq("user_id", current.profile.id).select("id").maybeSingle();
      if (deleteError) throw deleteError;
      if (!deleted) return fail("The post could not be deleted. Refresh and try again.", 409, origin);
      const { error: storageError } = await db.storage.from(post.media_bucket === "member-media" ? "member-media" : "media").remove([post.media_path]);
      return response({ ok: true, storageCleanupPending: !!storageError }, 200, origin);
    }
    if (action === "search-users" || action === "suggestions") {
      const current = requireUser();
      let query = db.from("profiles").select("*").neq("id", current.profile.id).order("follower_count", { ascending: false }).limit(8);
      if (action === "search-users") {
        const term = String(body.query || "").replace(/[^a-zA-Z0-9_ ]/g, "").trim().slice(0, 24);
        if (!term) return response({ users: [] }, 200, origin);
        query = db.from("profiles").select("*").neq("id", current.profile.id).ilike("username", "%" + term + "%").order("follower_count", { ascending: false }).limit(12);
      }
      const { data, error } = await query;
      if (error) throw error;
      const people = data || [];
      const personIds = people.map((person: any) => person.id);
      const { data: followRows, error: followError } = personIds.length
        ? await db.from("follows").select("following_id").eq("follower_id", current.profile.id).in("following_id", personIds)
        : { data: [], error: null };
      if (followError) throw followError;
      const following = new Set((followRows || []).map((item: any) => item.following_id));
      return response({ users: people.map((person: any) => ({
        ...safeUser(person), is_following: following.has(person.id),
      })) }, 200, origin);
    }
    if (action === "update-profile") {
      const current = requireUser();
      const displayName = String(body.displayName || "").trim().slice(0, 60);
      const bio = String(body.bio || "").trim().slice(0, 300);
      if (!displayName) return fail("Display name cannot be empty.", 422, origin);
      const { data, error } = await db.from("profiles").update({ display_name: displayName, bio, updated_at: new Date().toISOString() })
        .eq("id", current.profile.id).select("*").single();
      if (error) throw error;
      return response({ user: safeUser(data) }, 200, origin);
    }
    if (action === "follow") {
      const current = requireUser();
      const username = String(body.username || "").toLowerCase();
      const { data: target } = await db.from("profiles").select("id,username").eq("username", username).maybeSingle();
      if (!target || target.id === current.profile.id) return fail("Creator not found.", 404, origin);
      const { data: existing } = await db.from("follows").select("follower_id").eq("follower_id", current.profile.id).eq("following_id", target.id).maybeSingle();
      if (existing) {
        await db.from("follows").delete().eq("follower_id", current.profile.id).eq("following_id", target.id);
        return response({ following: false }, 200, origin);
      }
      const { error } = await db.from("follows").insert({ follower_id: current.profile.id, following_id: target.id });
      if (error && error.code !== "23505") throw error;
      await db.from("notifications").insert({ user_id: target.id, actor_id: current.profile.id, type: "follow", message: "@" + current.profile.username + " started following you." });
      return response({ following: true }, 200, origin);
    }
    if (action === "like") {
      const current = requireUser();
      const postId = String(body.postId || "");
      const { data: post } = await db.from("posts").select("id,user_id").eq("id", postId).eq("status", "approved").maybeSingle();
      if (!post) return fail("Post not found.", 404, origin);
      const { data: existing } = await db.from("likes").select("user_id").eq("user_id", current.profile.id).eq("post_id", postId).maybeSingle();
      if (existing) {
        await db.from("likes").delete().eq("user_id", current.profile.id).eq("post_id", postId);
        return response({ liked: false }, 200, origin);
      }
      const { error } = await db.from("likes").insert({ user_id: current.profile.id, post_id: postId });
      if (error && error.code !== "23505") throw error;
      if (post.user_id !== current.profile.id) await db.from("notifications").insert({ user_id: post.user_id, actor_id: current.profile.id, type: "like", post_id: postId, message: "@" + current.profile.username + " appreciated your post." });
      return response({ liked: true }, 200, origin);
    }
    if (action === "comment") {
      const current = requireUser();
      const postId = String(body.postId || "");
      const content = String(body.content || "").trim().slice(0, 1000);
      if (!content) return fail("Write a comment first.", 422, origin);
      const { data: post } = await db.from("posts").select("id,user_id").eq("id", postId).eq("status", "approved").maybeSingle();
      if (!post) return fail("Post not found.", 404, origin);
      const { data, error } = await db.from("comments").insert({ post_id: postId, user_id: current.profile.id, content }).select("id").single();
      if (error) throw error;
      if (post.user_id !== current.profile.id) await db.from("notifications").insert({ user_id: post.user_id, actor_id: current.profile.id, type: "comment", post_id: postId, message: "@" + current.profile.username + " commented on your post." });
      return response({ id: data.id }, 201, origin);
    }
    if (action === "post-comments") {
      const current = requireUser();
      const postId = String(body.postId || "");
      const { data: post } = await db.from("posts").select("id").eq("id", postId).eq("status", "approved").maybeSingle();
      if (!post) return fail("Post not found.", 404, origin);
      const { data, error } = await db.from("comments")
        .select("id,content,created_at,author:profiles!comments_user_id_fkey(id,username,display_name,is_verified,avatar_path)")
        .eq("post_id", postId).order("created_at", { ascending: true }).limit(50);
      if (error) throw error;
      return response({ comments: (data || []).map((comment: any) => ({
        id: comment.id, content: comment.content, created_at: comment.created_at, author: safeUser(comment.author),
      })) }, 200, origin);
    }
    if (action === "notifications") {
      const current = requireUser();
      const { data, error } = await db.from("notifications").select("*").eq("user_id", current.profile.id).order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      return response({ notifications: data || [] }, 200, origin);
    }

    if (action === "dm-group-list") {
      const current = requireUser();
      const { data: memberships, error: memberError } = await db.from("dm_group_members")
        .select("group_id,role,last_read_at").eq("user_id", current.profile.id);
      if (memberError) throw memberError;
      const groupIds = (memberships || []).map((m: any) => m.group_id);
      if (!groupIds.length) return response({ groups: [] }, 200, origin);
      const { data: groups, error: groupError } = await db.from("dm_groups").select("*")
        .in("id", groupIds).order("last_message_at", { ascending: false }).limit(100);
      if (groupError) throw groupError;
      const [allMembers, latestMessages] = await Promise.all([
        db.from("dm_group_members").select("group_id,user_id,role,last_read_at").in("group_id", groupIds),
        db.from("dm_group_messages").select("id,group_id,sender_id,content,message_type,created_at")
          .in("group_id", groupIds).order("created_at", { ascending: false }).limit(500),
      ]);
      if (allMembers.error) throw allMembers.error;
      if (latestMessages.error) throw latestMessages.error;
      const membershipByGroup = new Map((memberships || []).map((m: any) => [m.group_id, m]));
      const latestByGroup = new Map<string, any>();
      for (const message of latestMessages.data || []) {
        if (!latestByGroup.has(message.group_id)) latestByGroup.set(message.group_id, message);
      }
      const memberCounts = new Map<string, number>();
      for (const member of allMembers.data || []) memberCounts.set(member.group_id, (memberCounts.get(member.group_id) || 0) + 1);
      const groupsOut = (groups || []).map((group: any) => {
        const latest = latestByGroup.get(group.id) || null;
        const member = membershipByGroup.get(group.id);
        return {
          id: group.id, name: group.name, description: group.description || "",
          created_by: group.created_by, last_message_at: group.last_message_at,
          created_at: group.created_at, member_count: memberCounts.get(group.id) || 1,
          role: member?.role || "member", last_read_at: member?.last_read_at || null,
          last_message: latest ? { content: latest.content, sender_id: latest.sender_id, created_at: latest.created_at, message_type: latest.message_type } : null,
        };
      });
      return response({ groups: groupsOut }, 200, origin);
    }
    if (action === "dm-group-create") {
      const current = requireUser();
      const name = String(body.name || "").trim().slice(0, 60);
      const description = String(body.description || "").trim().slice(0, 180);
      const requested = Array.isArray(body.memberUsernames) ? body.memberUsernames : [];
      const usernames = [...new Set(requested.map((value: any) => String(value).replace(/^@/, "").toLowerCase().trim()).filter((value: string) => validateUsername(value)))];
      if (name.length < 2) return fail("Group names must contain at least two characters.", 422, origin);
      if (usernames.length > 49) return fail("A VYRA group can contain up to 50 people.", 422, origin);
      const { data: people, error: peopleError } = usernames.length
        ? await db.from("profiles").select("id,username").in("username", usernames).neq("id", current.profile.id)
        : { data: [], error: null };
      if (peopleError) throw peopleError;
      if ((people || []).length !== usernames.length) return fail("One or more usernames could not be found. Check the handles and try again.", 404, origin);
      const { data: group, error } = await db.from("dm_groups").insert({
        name, description, created_by: current.profile.id,
      }).select("id,name,description,created_by,created_at,last_message_at").single();
      if (error) throw error;
      const memberRows = [
        { group_id: group.id, user_id: current.profile.id, role: "admin" },
        ...(people || []).map((person: any) => ({ group_id: group.id, user_id: person.id, role: "member" })),
      ];
      const { error: insertError } = await db.from("dm_group_members").insert(memberRows);
      if (insertError) {
        await db.from("dm_groups").delete().eq("id", group.id);
        throw insertError;
      }
      if (people?.length) {
        await db.from("notifications").insert(people.map((person: any) => ({
          user_id: person.id, actor_id: current.profile.id, type: "group_invite",
          message: "@" + current.profile.username + " added you to the group " + name + ".",
        })));
      }
      return response({ group }, 201, origin);
    }
    if (action === "dm-group-add") {
      const current = requireUser();
      const groupId = String(body.groupId || "");
      const requested = Array.isArray(body.memberUsernames) ? body.memberUsernames : [];
      const usernames = [...new Set(requested.map((value: any) => String(value).replace(/^@/, "").toLowerCase().trim()).filter((value: string) => validateUsername(value)))];
      if (!groupId || !usernames.length || usernames.length > 49) return fail("Choose at least one valid username to add.", 422, origin);
      const { data: permission } = await db.from("dm_group_members").select("role")
        .eq("group_id", groupId).eq("user_id", current.profile.id).maybeSingle();
      if (permission?.role !== "admin") return fail("Only group admins can add members.", 403, origin);
      const { count } = await db.from("dm_group_members").select("user_id", { count: "exact", head: true }).eq("group_id", groupId);
      if ((count || 0) + usernames.length > 50) return fail("Groups can contain up to 50 people.", 422, origin);
      const { data: people, error } = await db.from("profiles").select("id,username").in("username", usernames).neq("id", current.profile.id);
      if (error) throw error;
      if ((people || []).length !== usernames.length) return fail("One or more usernames could not be found.", 404, origin);
      const { data: existing } = await db.from("dm_group_members").select("user_id").eq("group_id", groupId)
        .in("user_id", (people || []).map((p: any) => p.id));
      const present = new Set((existing || []).map((m: any) => m.user_id));
      const newPeople = (people || []).filter((p: any) => !present.has(p.id));
      if (newPeople.length) {
        const { error: addError } = await db.from("dm_group_members").insert(newPeople.map((p: any) => ({ group_id: groupId, user_id: p.id, role: "member" })));
        if (addError) throw addError;
        const { data: group } = await db.from("dm_groups").select("name").eq("id", groupId).maybeSingle();
        await db.from("notifications").insert(newPeople.map((person: any) => ({
          user_id: person.id, actor_id: current.profile.id, type: "group_invite",
          message: "@" + current.profile.username + " added you to the group " + (group?.name || "a VYRA group") + ".",
        })));
      }
      return response({ added: newPeople.length }, 200, origin);
    }
    if (action === "dm-group-messages") {
      const current = requireUser();
      const groupId = String(body.groupId || "");
      const { data: membership } = await db.from("dm_group_members").select("group_id")
        .eq("group_id", groupId).eq("user_id", current.profile.id).maybeSingle();
      if (!membership) return fail("Group chat not found.", 404, origin);
      const { data: messages, error } = await db.from("dm_group_messages")
        .select("id,group_id,sender_id,content,message_type,created_at")
        .eq("group_id", groupId).order("created_at", { ascending: true }).limit(200);
      if (error) throw error;
      await db.from("dm_group_members").update({ last_read_at: new Date().toISOString() })
        .eq("group_id", groupId).eq("user_id", current.profile.id);
      const senderIds = [...new Set((messages || []).map((m: any) => m.sender_id))];
      const { data: people } = senderIds.length
        ? await db.from("profiles").select("*").in("id", senderIds)
        : { data: [] };
      const peopleById = new Map((people || []).map((p: any) => [p.id, safeUser(p)]));
      return response({ messages: (messages || []).map((m: any) => ({
        ...m, author: peopleById.get(m.sender_id) || null,
      })) }, 200, origin);
    }
    if (action === "dm-group-send") {
      const current = requireUser();
      const groupId = String(body.groupId || "");
      const content = String(body.content || "").trim();
      if (!content || content.length > 2000) return fail("Group messages must contain 1–2,000 characters.", 422, origin);
      const { data: membership } = await db.from("dm_group_members").select("group_id")
        .eq("group_id", groupId).eq("user_id", current.profile.id).maybeSingle();
      if (!membership) return fail("You are not a member of this group.", 403, origin);
      const { data: message, error } = await db.from("dm_group_messages").insert({
        group_id: groupId, sender_id: current.profile.id, content, message_type: "text",
      }).select("id,group_id,sender_id,content,message_type,created_at").single();
      if (error) throw error;
      const { data: members } = await db.from("dm_group_members").select("user_id").eq("group_id", groupId).neq("user_id", current.profile.id);
      if (members?.length) {
        await db.from("notifications").insert(members.map((m: any) => ({
          user_id: m.user_id, actor_id: current.profile.id, type: "group_message",
          message: "@" + current.profile.username + " sent a message in your group.",
        })));
      }
      return response({ message }, 201, origin);
    }
    if (action === "dm-group-leave") {
      const current = requireUser();
      const groupId = String(body.groupId || "");
      const { data: membership } = await db.from("dm_group_members").select("role")
        .eq("group_id", groupId).eq("user_id", current.profile.id).maybeSingle();
      if (!membership) return fail("Group chat not found.", 404, origin);
      if (membership.role === "admin") {
        const { count } = await db.from("dm_group_members").select("user_id", { count: "exact", head: true })
          .eq("group_id", groupId).eq("role", "admin");
        if ((count || 0) <= 1) {
          const { error } = await db.from("dm_groups").delete().eq("id", groupId);
          if (error) throw error;
          return response({ deleted: true }, 200, origin);
        }
      }
      const { error } = await db.from("dm_group_members").delete().eq("group_id", groupId).eq("user_id", current.profile.id);
      if (error) throw error;
      return response({ deleted: false }, 200, origin);
    }
    if (action === "dm-group-rename") {
      const current = requireUser();
      const groupId = String(body.groupId || "");
      const name = String(body.name || "").trim().slice(0, 60);
      if (name.length < 2) return fail("Enter a group name with at least two characters.", 422, origin);
      const { data: membership } = await db.from("dm_group_members").select("role")
        .eq("group_id", groupId).eq("user_id", current.profile.id).maybeSingle();
      if (membership?.role !== "admin") return fail("Only group admins can rename this chat.", 403, origin);
      const { data, error } = await db.from("dm_groups").update({ name }).eq("id", groupId).select("id,name").single();
      if (error) throw error;
      return response({ group: data }, 200, origin);
    }
    if (action === "dm-inbox") {
      const current = requireUser();
      const userId = current.profile.id;
      const [aResult, bResult] = await Promise.all([
        db.from("dm_conversations").select("*").eq("user_a", userId).order("last_message_at", { ascending: false }).limit(100),
        db.from("dm_conversations").select("*").eq("user_b", userId).order("last_message_at", { ascending: false }).limit(100),
      ]);
      if (aResult.error) throw aResult.error;
      if (bResult.error) throw bResult.error;
      const rows = [...(aResult.data || []), ...(bResult.data || [])]
        .sort((a: any, b: any) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime());
      if (!rows.length) return response({ conversations: [] }, 200, origin);
      const otherIds = [...new Set(rows.map((row: any) => row.user_a === userId ? row.user_b : row.user_a))];
      const { data: people, error: peopleError } = await db.from("profiles")
        .select("id,username,display_name,bio,avatar_path,is_verified,follower_count,following_count,posts_count,is_admin")
        .in("id", otherIds);
      if (peopleError) throw peopleError;
      const peopleById = new Map((people || []).map((person: any) => [person.id, person]));
      const ids = rows.map((row: any) => row.id);
      const { data: recentMessages, error: recentError } = await db.from("dm_messages")
        .select("conversation_id,content,sender_id,message_type,e2ee_version,created_at")
        .in("conversation_id", ids).order("created_at", { ascending: false }).limit(500);
      if (recentError) throw recentError;
      const latestByConversation = new Map<string, any>();
      for (const message of recentMessages || []) {
        if (!latestByConversation.has(message.conversation_id)) latestByConversation.set(message.conversation_id, message);
      }
      const conversations = rows.map((row: any) => {
        const otherId = row.user_a === userId ? row.user_b : row.user_a;
        const latest = latestByConversation.get(row.id) || null;
        return {
          id: row.id, status: row.status, requester_id: row.requester_id,
          created_at: row.created_at, last_message_at: row.last_message_at,
          otherUser: safeUser(peopleById.get(otherId)),
          last_message: latest ? {
            ...latest,
            preview: latest.e2ee_version === 1
              ? latest.message_type === "image" ? "Older encrypted photo"
                : latest.message_type === "voice" ? "Older encrypted voice note"
                : "Older encrypted message"
              : latest.message_type === "image" ? "Photo"
                : latest.message_type === "voice" ? "Voice note"
                : latest.message_type === "shared_post" ? "Shared a video"
                : String(latest.content || "").slice(0, 100),
          } : null,
        };
      }).filter((row: any) => row.otherUser);
      return response({ conversations }, 200, origin);
    }

    if (action === "e2ee-key-get") {
      const current = requireUser();
      const username = String(body.username || current.profile.username).toLowerCase().trim();
      const { data: target } = await db.from("profiles").select("id,username").eq("username", username).maybeSingle();
      if (!target) return fail("Creator not found.", 404, origin);
      const { data: keyRow, error } = await db.from("dm_e2ee_keys").select("*").eq("user_id", target.id).maybeSingle();
      if (error) throw error;
      if (!keyRow) return response({ key: null }, 200, origin);
      const key: any = {
        username: target.username, publicKey: keyRow.public_key, keyVersion: keyRow.key_version,
      };
      if (target.id === current.profile.id) {
        key.wrappedPrivateKey = keyRow.wrapped_private_key;
        key.salt = keyRow.salt;
        key.iv = keyRow.iv;
      }
      return response({ key }, 200, origin);
    }


    if (action === "dm-start") {
      const current = requireUser();
      const username = String(body.username || "").toLowerCase().trim();
      if (!username) return fail("Choose a creator first.", 422, origin);
      const { data: target } = await db.from("profiles").select("id,username").eq("username", username).maybeSingle();
      if (!target || target.id === current.profile.id) return fail("Creator not found.", 404, origin);
      const [userA, userB] = [current.profile.id, target.id].sort();
      const { data: existing, error: lookupError } = await db.from("dm_conversations")
        .select("*").eq("user_a", userA).eq("user_b", userB).maybeSingle();
      if (lookupError) throw lookupError;
      if (!existing || existing.status === "declined") {
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { count: requestsToday } = await db.from("dm_conversations")
          .select("id", { count: "exact", head: true })
          .eq("requester_id", current.profile.id).gte("created_at", cutoff);
        if ((requestsToday || 0) >= 20) return fail("You've reached today's message-request limit.", 429, origin);
      }
      let conversation: any = existing;
      if (!conversation) {
        const { data: created, error: createError } = await db.from("dm_conversations")
          .insert({ user_a: userA, user_b: userB, requester_id: current.profile.id, status: "pending" })
          .select("*").single();
        if (createError && createError.code !== "23505") throw createError;
        if (created) conversation = created;
        else {
          const { data: raced, error: racedError } = await db.from("dm_conversations")
            .select("*").eq("user_a", userA).eq("user_b", userB).maybeSingle();
          if (racedError || !raced) throw racedError || new Error("Could not create the message request.");
          conversation = raced;
        }
      }
      if (conversation.status === "pending") return response({
        conversationId: conversation.id,
        status: conversation.requester_id === current.profile.id ? "pending" : "incoming",
      }, 200, origin);
      if (conversation.status === "accepted") return response({ conversationId: conversation.id, status: "accepted" }, 200, origin);

      const { data: reopened, error: reopenError } = await db.from("dm_conversations")
        .update({ requester_id: current.profile.id, status: "pending", accepted_at: null, created_at: new Date().toISOString() })
        .eq("id", conversation.id).select("*").single();
      if (reopenError) throw reopenError;
      await db.from("notifications").insert({
        user_id: target.id, actor_id: current.profile.id, type: "message_request",
        message: "@" + current.profile.username + " sent you a message request.",
      });
      return response({ conversationId: reopened.id, status: "pending" }, 201, origin);
    }

    if (action === "dm-request-send") {
      const current = requireUser();
      const conversationId = String(body.conversationId || "");
      const content = String(body.content || "");
      const legacyEncrypted = content.startsWith("vyra1.");
      if (!content.trim() || content.length > (legacyEncrypted ? 6000 : 1000)) {
        return fail("Your first message must contain 1–1000 characters.", 422, origin);
      }
      const { data: conversation } = await db.from("dm_conversations")
        .select("id,user_a,user_b,requester_id,status")
        .eq("id", conversationId).maybeSingle();
      if (!conversation || (conversation.user_a !== current.profile.id && conversation.user_b !== current.profile.id)) {
        return fail("Message request not found.", 404, origin);
      }
      if (conversation.status !== "pending" || conversation.requester_id !== current.profile.id) {
        return fail("Only the request sender can add the first message.", 403, origin);
      }
      const { count } = await db.from("dm_messages")
        .select("id", { count: "exact", head: true }).eq("conversation_id", conversationId);
      if ((count || 0) > 0) return fail("This request already has its first message.", 409, origin);
      const { data: message, error } = await db.from("dm_messages").insert({
        conversation_id: conversationId, sender_id: current.profile.id, content,
        message_type: "text", e2ee_version: legacyEncrypted ? 1 : 0,
      }).select("id,conversation_id,sender_id,content,message_type,created_at").single();
      if (error) throw error;
      const recipientId = conversation.user_a === current.profile.id ? conversation.user_b : conversation.user_a;
      await db.from("notifications").insert({
        user_id: recipientId, actor_id: current.profile.id, type: "message_request",
        message: "@" + current.profile.username + " sent you a message request.",
      });
      return response({ message }, 201, origin);
    }

    if (action === "dm-respond") {
      const current = requireUser();
      const conversationId = String(body.conversationId || "");
      const decision = String(body.decision || "");
      if (!["accept", "decline"].includes(decision)) return fail("Choose accept or decline.", 422, origin);
      const { data: conversation } = await db.from("dm_conversations")
        .select("id,user_a,user_b,requester_id,status").eq("id", conversationId).maybeSingle();
      if (!conversation || (conversation.user_a !== current.profile.id && conversation.user_b !== current.profile.id)) {
        return fail("Message request not found.", 404, origin);
      }
      if (conversation.status !== "pending" || conversation.requester_id === current.profile.id) {
        return fail("Only the recipient can respond to this request.", 403, origin);
      }
      const nextStatus = decision === "accept" ? "accepted" : "declined";
      const { error } = await db.from("dm_conversations")
        .update({ status: nextStatus, accepted_at: decision === "accept" ? new Date().toISOString() : null })
        .eq("id", conversationId).eq("status", "pending");
      if (error) throw error;
      if (decision === "accept") {
        await db.from("notifications").insert({
          user_id: conversation.requester_id, actor_id: current.profile.id, type: "message_accepted",
          message: "@" + current.profile.username + " accepted your message request.",
        });
      }
      return response({ status: nextStatus }, 200, origin);
    }

    if (action === "dm-messages") {
      const current = requireUser();
      const conversationId = String(body.conversationId || "");
      const { data: conversation } = await db.from("dm_conversations")
        .select("id,user_a,user_b,status").eq("id", conversationId).maybeSingle();
      if (!conversation || (conversation.user_a !== current.profile.id && conversation.user_b !== current.profile.id)) {
        return fail("Conversation not found.", 404, origin);
      }
      const { data: messages, error } = await db.from("dm_messages")
        .select("id,conversation_id,sender_id,content,message_type,attachment_path,attachment_iv,attachment_mime,shared_post_id,e2ee_version,created_at,shared_post:posts!dm_messages_shared_post_id_fkey(id,caption,media_path,media_type,kind,created_at,author:profiles!posts_user_id_fkey(*))")
        .eq("conversation_id", conversationId).order("created_at", { ascending: true }).limit(200);
      if (error) throw error;
      return response({
        messages: (messages || []).map((message: any) => ({
          id: message.id, conversation_id: message.conversation_id, sender_id: message.sender_id,
          content: message.content, message_type: message.message_type || "text",
          media_url: message.attachment_path ? publicMedia(message.attachment_path) : null,
          attachment_iv: message.attachment_iv, attachment_mime: message.attachment_mime,
          e2ee_version: message.e2ee_version || 0, created_at: message.created_at,
          shared_post: message.shared_post ? {
            id: message.shared_post.id, caption: message.shared_post.caption,
            media_url: publicMedia(message.shared_post.media_path), media_type: message.shared_post.media_type,
            kind: message.shared_post.kind, author: safeUser(message.shared_post.author),
          } : null,
        }))
      }, 200, origin);
    }

    if (action === "dm-attachment-upload") {
      const current = requireUser();
      const conversationId = String(body.conversationId || "");
      const mime = String(body.mimeType || "");
      const size = Number(body.size || 0);
      const messageType = String(body.messageType || "");
      const allowed = messageType === "image"
        ? ["image/jpeg","image/png","image/webp"]
        : messageType === "voice" ? ["audio/webm","audio/ogg","audio/mp4","audio/mpeg"] : [];
      if (!allowed.includes(mime) || !Number.isFinite(size) || size < 1 || size > 15 * 1024 * 1024) {
        return fail("This attachment type or size is not supported.", 422, origin);
      }
      const { data: conversation } = await db.from("dm_conversations")
        .select("id,user_a,user_b,status").eq("id", conversationId).maybeSingle();
      if (!conversation || conversation.status !== "accepted"
        || (conversation.user_a !== current.profile.id && conversation.user_b !== current.profile.id)) {
        return fail("An accepted conversation is required to share attachments.", 403, origin);
      }
      const path = current.profile.id + "/dm/" + conversationId + "/" + crypto.randomUUID() + ".bin";
      const { data, error } = await db.storage.from("media").createSignedUploadUrl(path, { upsert: false });
      if (error || !data?.token) throw error || new Error("Could not create a secure upload URL.");
      return response({ path, uploadToken: data.token }, 200, origin);
    }

    if (action === "dm-send") {
      const current = requireUser();
      const conversationId = String(body.conversationId || "");
      const content = String(body.content || "");
      const messageType = String(body.messageType || "text");
      const attachmentPath = String(body.attachmentPath || "");
      const attachmentIv = String(body.attachmentIv || "");
      const attachmentMime = String(body.attachmentMime || "");
      const legacyEncrypted = content.startsWith("vyra1.");
      if (!content.trim() || content.length > (legacyEncrypted ? 6000 : 1000)) return fail("Messages must contain 1–1000 characters.", 422, origin);
      if (!["text","image","voice"].includes(messageType)) return fail("Unsupported message type.", 422, origin);
      const { data: conversation } = await db.from("dm_conversations")
        .select("id,user_a,user_b,status").eq("id", conversationId).maybeSingle();
      if (!conversation || (conversation.user_a !== current.profile.id && conversation.user_b !== current.profile.id)) {
        return fail("Conversation not found.", 404, origin);
      }
      if (conversation.status !== "accepted") return fail("This chat opens after the recipient accepts the request.", 403, origin);
      if (messageType === "text" && (attachmentPath || attachmentIv)) return fail("Text messages cannot contain attachment data.", 422, origin);
      if (messageType !== "text") {
        if (!attachmentPath.startsWith(current.profile.id + "/dm/" + conversationId + "/")
          || (attachmentIv && !/^[A-Za-z0-9+/=]{12,64}$/.test(attachmentIv))
          || !["image/jpeg","image/png","image/webp","audio/webm","audio/ogg","audio/mp4","audio/mpeg"].includes(attachmentMime)
          || !(await storageFileExists(attachmentPath))) {
          return fail("Attachment could not be verified.", 422, origin);
        }
      }
      const { data: message, error } = await db.from("dm_messages").insert({
        conversation_id: conversationId, sender_id: current.profile.id, content,
        message_type: messageType, attachment_path: messageType === "text" ? null : attachmentPath,
        attachment_iv: messageType === "text" ? null : attachmentIv,
        attachment_mime: messageType === "text" ? null : attachmentMime,
        e2ee_version: legacyEncrypted ? 1 : 0,
      }).select("id,conversation_id,sender_id,content,message_type,attachment_path,attachment_iv,attachment_mime,e2ee_version,created_at").single();
      if (error) throw error;
      const recipientId = conversation.user_a === current.profile.id ? conversation.user_b : conversation.user_a;
      await db.from("notifications").insert({
        user_id: recipientId, actor_id: current.profile.id, type: "message",
        message: "@" + current.profile.username + " sent you a message.",
      });
      return response({ message: { ...message, media_url: message.attachment_path ? publicMedia(message.attachment_path) : null } }, 201, origin);
    }

    if (action === "dm-delete-message") {
      const current = requireUser();
      const messageId = String(body.messageId || "");
      if (!/^[0-9a-f-]{36}$/i.test(messageId)) return fail("Choose a valid message to remove.", 422, origin);
      const { data: message, error: messageError } = await db.from("dm_messages")
        .select("id,conversation_id,sender_id,attachment_path")
        .eq("id", messageId).eq("sender_id", current.profile.id).maybeSingle();
      if (messageError) throw messageError;
      if (!message) return fail("Only your own messages can be removed.", 404, origin);
      const { data: conversation, error: conversationError } = await db.from("dm_conversations")
        .select("id,user_a,user_b").eq("id", message.conversation_id).maybeSingle();
      if (conversationError) throw conversationError;
      if (!conversation || (conversation.user_a !== current.profile.id && conversation.user_b !== current.profile.id)) {
        return fail("Conversation not found.", 404, origin);
      }
      const { data: deleted, error: deleteError } = await db.from("dm_messages").delete()
        .eq("id", messageId).eq("sender_id", current.profile.id).select("id").maybeSingle();
      if (deleteError) throw deleteError;
      if (!deleted) return fail("Message could not be removed. Refresh and try again.", 409, origin);
      let storageCleanupPending = false;
      if (message.attachment_path) {
        const allowedPrefix = current.profile.id + "/dm/" + message.conversation_id + "/";
        if (!message.attachment_path.startsWith(allowedPrefix)) {
          storageCleanupPending = true;
        } else {
          const { error: storageError } = await db.storage.from("media").remove([message.attachment_path]);
          storageCleanupPending = !!storageError;
        }
      }
      return response({ ok: true, storageCleanupPending }, 200, origin);
    }

    if (action === "dm-share-post") {
      const current = requireUser();
      const conversationId = String(body.conversationId || "");
      const postId = String(body.postId || "");
      const content = String(body.content || "");
      const legacyEncrypted = content.startsWith("vyra1.");
      if (!content.trim() || content.length > (legacyEncrypted ? 6000 : 1000)) return fail("This share message is too long.", 422, origin);
      const { data: conversation } = await db.from("dm_conversations")
        .select("id,user_a,user_b,status").eq("id", conversationId).maybeSingle();
      if (!conversation || conversation.status !== "accepted"
        || (conversation.user_a !== current.profile.id && conversation.user_b !== current.profile.id)) return fail("Accepted conversation not found.", 403, origin);
      const { data: post } = await db.from("posts").select("id").eq("id", postId).eq("status","approved").maybeSingle();
      if (!post) return fail("This post is no longer available to share.", 404, origin);
      const { data: message, error } = await db.from("dm_messages").insert({
        conversation_id: conversationId, sender_id: current.profile.id, content,
        message_type: "shared_post", shared_post_id: postId, e2ee_version: legacyEncrypted ? 1 : 0,
      }).select("id,conversation_id,sender_id,content,message_type,shared_post_id,e2ee_version,created_at").single();
      if (error) throw error;
      const recipientId = conversation.user_a === current.profile.id ? conversation.user_b : conversation.user_a;
      await db.from("notifications").insert({ user_id:recipientId,actor_id:current.profile.id,type:"message",message:"@" + current.profile.username + " shared a post with you." });
      return response({ message },201,origin);
    }

    if (action === "dm-call-ice-config") {
      const current = requireUser();
      const iceServers: any[] = [
        { urls: ["stun:stun.l.google.com:19302"] },
      ];
      const turnUrls = (Deno.env.get("TURN_URLS") || "").split(",").map(value => value.trim()).filter(Boolean);
      const turnSharedSecret = Deno.env.get("TURN_SHARED_SECRET") || "";
      if (turnUrls.length && turnSharedSecret) {
        // Coturn REST API credentials expire after one hour; never expose a long-lived TURN password.
        const username = String(Math.floor(Date.now() / 1000) + 3600) + ":" + current.profile.id;
        const hmacKey = await crypto.subtle.importKey(
          "raw", new TextEncoder().encode(turnSharedSecret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"],
        );
        const signature = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(username)));
        const credential = btoa(String.fromCharCode(...signature));
        iceServers.push({ urls: turnUrls, username, credential });
      }
      return response({ iceServers, turnConfigured: iceServers.length > 1 }, 200, origin);
    }

    if (action === "dm-call-start") {
      const current = requireUser();
      const conversationId = String(body.conversationId || "");
      const callType = String(body.callType || "");
      if (!["audio","video"].includes(callType)) return fail("Choose an audio or video call.",422,origin);
      const { data: conversation } = await db.from("dm_conversations").select("id,user_a,user_b,status")
        .eq("id",conversationId).maybeSingle();
      if (!conversation || conversation.status !== "accepted"
        || (conversation.user_a !== current.profile.id && conversation.user_b !== current.profile.id)) return fail("Accepted conversation not found.",403,origin);
      const { data: existing } = await db.from("dm_call_sessions").select("id")
        .eq("conversation_id",conversationId).in("status",["ringing","active"]).gte("created_at",new Date(Date.now()-5*60*1000).toISOString()).limit(1);
      if (existing?.length) return fail("A call is already active in this chat.",409,origin);
      const calleeId = conversation.user_a === current.profile.id ? conversation.user_b : conversation.user_a;
      const { data: call, error } = await db.from("dm_call_sessions").insert({
        conversation_id:conversationId,caller_id:current.profile.id,callee_id:calleeId,call_type:callType,status:"ringing",
      }).select("*").single();
      if (error) throw error;
      return response({ call },201,origin);
    }

    if (action === "dm-call-poll") {
      const current = requireUser();
      const now = Date.now();
      const staleRingingCutoff = new Date(now - 90 * 1000).toISOString();
      const { error: staleError } = await db.from("dm_call_sessions")
        .update({ status: "missed", ended_at: new Date(now).toISOString() })
        .eq("status", "ringing").lt("created_at", staleRingingCutoff);
      if (staleError) throw staleError;
      const { data: calls, error } = await db.from("dm_call_sessions").select("*")
        .or("caller_id.eq." + current.profile.id + ",callee_id.eq." + current.profile.id)
        .gte("created_at",new Date(now - 12 * 60 * 60 * 1000).toISOString())
        .order("created_at",{ascending:false}).limit(1);
      if (error) throw error;
      const latest = calls?.[0] || null;
      const liveCall = latest && ["ringing","active"].includes(latest.status) ? latest : null;
      return response({ call: liveCall },200,origin);
    }

    if (action === "dm-call-accept") {
      const current = requireUser();
      const callId = String(body.callId || "");
      const { data: call } = await db.from("dm_call_sessions").select("*").eq("id",callId).maybeSingle();
      if (!call || call.callee_id !== current.profile.id || call.status !== "ringing") return fail("Incoming call not found.",404,origin);
      const { data, error } = await db.from("dm_call_sessions").update({status:"active",accepted_at:new Date().toISOString()})
        .eq("id",callId).eq("status","ringing").select("*").single();
      if (error) throw error;
      return response({call:data},200,origin);
    }

    if (action === "dm-call-signal") {
      const current = requireUser();
      const callId = String(body.callId || "");
      const signalType = String(body.signalType || "");
      const payload = body.payload;
      if (!["offer","answer","ice"].includes(signalType) || !payload || typeof payload !== "object"
        || JSON.stringify(payload).length > 40000) return fail("Call signal is invalid.",422,origin);
      const { data: call } = await db.from("dm_call_sessions").select("id,caller_id,callee_id,status")
        .eq("id",callId).maybeSingle();
      if (!call || (call.caller_id !== current.profile.id && call.callee_id !== current.profile.id)
        || !["ringing","active"].includes(call.status)) return fail("Call session is not active.",403,origin);
      const { data: signal, error } = await db.from("dm_call_signals").insert({
        call_id:callId,sender_id:current.profile.id,signal_type:signalType,payload,
      }).select("id").single();
      if (error) throw error;
      return response({id:signal.id},201,origin);
    }

    if (action === "dm-call-signals") {
      const current = requireUser();
      const callId = String(body.callId || "");
      const afterId = Number(body.afterId || 0);
      const { data: call } = await db.from("dm_call_sessions").select("id,caller_id,callee_id,status")
        .eq("id",callId).maybeSingle();
      if (!call || (call.caller_id !== current.profile.id && call.callee_id !== current.profile.id)) return fail("Call session not found.",404,origin);
      const { data, error } = await db.from("dm_call_signals").select("id,sender_id,signal_type,payload,created_at")
        .eq("call_id",callId).neq("sender_id",current.profile.id).gt("id",afterId).order("id",{ascending:true}).limit(100);
      if (error) throw error;
      return response({signals:data || [],status:call.status},200,origin);
    }

    if (action === "dm-call-end") {
      const current = requireUser();
      const callId = String(body.callId || "");
      const decision = String(body.decision || "end");
      const { data: call } = await db.from("dm_call_sessions").select("id,caller_id,callee_id,status")
        .eq("id",callId).maybeSingle();
      if (!call || (call.caller_id !== current.profile.id && call.callee_id !== current.profile.id)) return fail("Call session not found.",404,origin);
      const status = decision === "decline" && call.callee_id === current.profile.id ? "declined" :
        decision === "missed" ? "missed" : "ended";
      const { error } = await db.from("dm_call_sessions").update({status,ended_at:new Date().toISOString()}).eq("id",callId);
      if (error) throw error;
      return response({status},200,origin);
    }

    if (action === "record-view") {
      const current = requireUser();
      const postId = String(body.postId || "");
      const { data: post } = await db.from("posts").select("id,user_id").eq("id", postId)
        .eq("status", "approved").eq("media_type", "video").maybeSingle();
      if (!post) return fail("Video not found.", 404, origin);
      if (post.user_id !== current.profile.id) {
        const { error } = await db.from("post_views").upsert({
          post_id: postId, viewer_id: current.profile.id, view_day: indiaDateKey(),
        }, { onConflict: "post_id,viewer_id,view_day", ignoreDuplicates: true });
        if (error) throw error;
      }
      const { data: refreshed, error: refreshError } = await db.from("posts")
        .select("views_count").eq("id", postId).single();
      if (refreshError) throw refreshError;
      return response({ views_count: refreshed.views_count || 0 }, 200, origin);
    }

    if (action === "create-upload") {
      const current = requireUser();
      const purpose = String(body.purpose || "");
      const mime = String(body.mimeType || "");
      const visibility = String(body.visibility || "public");
      const name = String(body.fileName || "upload").slice(0, 120).replace(/[^a-zA-Z0-9._-]/g, "_");
      const size = Number(body.size || 0);
      const hash = String(body.sha256 || "").toLowerCase();
      const family = mimeFamily(mime);
      const maxSize = family === "video" ? 50 * 1024 * 1024 : family === "image" ? 12 * 1024 * 1024 : family === "audio" ? 25 * 1024 * 1024 : 0;
      if (!["post", "story", "avatar", "audio"].includes(purpose) || !family || !maxSize || !Number.isFinite(size) || size < 1 || size > maxSize) return fail("Unsupported media type or file size.", 422, origin);
      if (!/^[a-f0-9]{64}$/.test(hash)) return fail("Media fingerprint is invalid.", 422, origin);
      if ((purpose === "story" || purpose === "post") && family === "audio") return fail("Audio files belong in your audio library.", 422, origin);
      if (purpose === "avatar" && family !== "image") return fail("Profile photos must be images.", 422, origin);
      if (purpose === "audio" && family !== "audio") return fail("Choose an MP3 or M4A audio file.", 422, origin);
      if (!["public","members_only"].includes(visibility)) return fail("Choose a valid video audience.", 422, origin);
      let uploadBucket = "media";
      if (visibility === "members_only") {
        if (purpose !== "post" || family !== "video") return fail("Only videos can be published for channel members.", 422, origin);
        const unlock = await unlockMonetization(current.profile);
        if (!unlock.unlocked) return fail("Channel monetization unlocks at 20,000 followers.", 403, origin);
        const planId = String(body.membershipPlanId || "");
        const { data: plan } = await db.from("membership_plans").select("id")
          .eq("id", planId).eq("creator_id", current.profile.id).eq("is_active", true).maybeSingle();
        if (!plan || !(await paymentConnection(current.profile.id))) return fail("Create an active Razorpay membership plan first.", 403, origin);
        uploadBucket = "member-media";
      }
      const match = await exactCopyrightMatch(hash);
      if (match) return response({ blocked: true, reason: "exact_copyright_hash_match" }, 200, origin);
      const extension = name.includes(".") ? name.split(".").pop() : "bin";
      const path = current.profile.id + "/" + crypto.randomUUID() + "." + extension;
      const { data, error } = await db.storage.from(uploadBucket).createSignedUploadUrl(path, { upsert: false });
      if (error || !data?.token) throw error || new Error("Could not create a signed upload.");
      return response({ path, uploadToken: data.token, bucket: uploadBucket }, 200, origin);
    }
    if (action === "complete-upload") {
      const current = requireUser();
      const purpose = String(body.purpose || "");
      const path = String(body.path || "");
      const hash = String(body.sha256 || "").toLowerCase();
      const mime = String(body.mimeType || "");
      const family = mimeFamily(mime);
      const adminCurated = body.adminCurated === true;
      const visibility = String(body.visibility || "public");
      const storageBucket = visibility === "members_only" ? "member-media" : "media";
      let membershipPlanId: string | null = null;
      let curatedSourceUrl = "";
      let curatedRightsHolder = "";
      if (adminCurated) {
        await requireAdmin();
        if (purpose !== "post" || family !== "video") return fail("Admin-curated imports must be video posts.", 422, origin);
        if (String(body.rightsConfirmation || "") !== "I confirm VYRA has written permission or a valid licence to host and distribute this video.") {
          return fail("Confirm that VYRA has written permission or a valid licence for this video.", 422, origin);
        }
        curatedSourceUrl = String(body.sourceUrl || "").trim();
        curatedRightsHolder = String(body.rightsHolder || "").trim().slice(0, 160);
        try {
          const source = new URL(curatedSourceUrl);
          if (source.protocol !== "https:") throw new Error("https required");
        } catch {
          return fail("Enter a valid HTTPS source URL for the rights record.", 422, origin);
        }
        if (!curatedRightsHolder) return fail("Enter the creator or rights holder name.", 422, origin);
      } else if (purpose === "post" && family === "video"
        && !String(body.rightsConfirmation || "").startsWith("I own or have permission to publish")) {
        return fail("Confirm that you own this video or have permission to publish it.", 422, origin);
      }
      if (!["public","members_only"].includes(visibility)) return fail("Choose a valid video audience.", 422, origin);
      if (visibility === "members_only") {
        if (purpose !== "post" || family !== "video") return fail("Only videos can be published for channel members.", 422, origin);
        const unlock = await unlockMonetization(current.profile);
        if (!unlock.unlocked) return fail("Channel monetization unlocks at 20,000 followers.", 403, origin);
        const planId = String(body.membershipPlanId || "");
        const { data: plan } = await db.from("membership_plans").select("id")
          .eq("id", planId).eq("creator_id", current.profile.id).eq("is_active", true).maybeSingle();
        if (!plan || !(await paymentConnection(current.profile.id))) return fail("Choose one of your active membership plans.", 403, origin);
        membershipPlanId = plan.id;
      }
      if (!path.startsWith(current.profile.id + "/") || !/^[a-f0-9]{64}$/.test(hash)) return fail("Invalid upload reference.", 422, origin);
      if (!(await storageFileExists(path, storageBucket))) return fail("Upload was not found in media storage.", 422, origin);
      const { data: uploadedBlob, error: downloadError } = await db.storage.from(storageBucket).download(path);
      if (downloadError || !uploadedBlob) return fail("Uploaded media could not be verified.", 422, origin);
      if (uploadedBlob.size !== Number(body.size || 0) || (uploadedBlob.type && uploadedBlob.type !== mime)) {
        await db.storage.from("media").remove([path]);
        return fail("Uploaded file metadata did not match the upload request.", 422, origin);
      }
      const verifiedHash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", await uploadedBlob.arrayBuffer())));
      if (verifiedHash !== hash) {
        await db.storage.from("media").remove([path]);
        return fail("The uploaded file fingerprint did not match its actual bytes.", 422, origin);
      }
      const match = await exactCopyrightMatch(verifiedHash);
      if (match) {
        await db.storage.from("media").remove([path]);
        return fail("This exact file is registered as copyrighted and has been blocked.", 451, origin);
      }
      if (purpose === "avatar") {
        if (family !== "image") return fail("Avatar must be an image.", 422, origin);
        const { error } = await db.from("profiles").update({ avatar_path: path, updated_at: new Date().toISOString() }).eq("id", current.profile.id);
        if (error) throw error;
        return response({ url: publicMedia(path) }, 200, origin);
      }
      if (purpose === "audio") {
        if (family !== "audio" || !String(body.rightsConfirmation || "").startsWith("I own")) return fail("Confirm your rights to this audio upload.", 422, origin);
        const title = String(body.title || "").trim().slice(0, 100);
        if (!title) return fail("Track title is required.", 422, origin);
        const { data, error } = await db.from("audio_tracks").insert({
          user_id: current.profile.id, title, artist: String(body.artist || "").slice(0, 100),
          media_path: path, rights_confirmation: String(body.rightsConfirmation),
        }).select("id,title,artist,created_at").single();
        if (error) throw error;
        return response({ track: data }, 201, origin);
      }
      if (purpose === "story") {
        if (family !== "image" && family !== "video") return fail("Story must be a photo or video.", 422, origin);
        const { data, error } = await db.from("stories").insert({
          user_id: current.profile.id, media_path: path, media_type: family,
          caption: String(body.caption || "").slice(0, 500), sha256: hash, status: "pending",
          copyright_status: "pending_manual_review",
        }).select("id").single();
        if (error) throw error;
        return response({ id: data.id, status: "pending" }, 201, origin);
      }
      if (purpose === "post") {
        if (family !== "image" && family !== "video") return fail("Post must be a photo or video.", 422, origin);
        const duration = Number(body.durationSeconds || 0);
        if (!Number.isFinite(duration) || duration < 0 || duration > 3600) return fail("Video duration is invalid.", 422, origin);
        const kind = family === "image" ? "photo" : (duration <= 120 ? "reel" : "video");
        const audioTrackId = String(body.audioTrackId || "");
        if (audioTrackId) {
          const { data: ownedTrack } = await db.from("audio_tracks").select("id")
            .eq("id", audioTrackId).eq("user_id", current.profile.id).maybeSingle();
          if (!ownedTrack) return fail("Choose an audio track from your own library.", 403, origin);
        }
        const { data, error } = await db.from("posts").insert({
          user_id: current.profile.id,
          title: String(body.title || "").trim().slice(0, 160),
          caption: String(body.caption || "").slice(0, 2200), media_path: path,
          media_type: family, kind, duration_seconds: duration, audio_track_id: audioTrackId || null,
          visibility, membership_plan_id: membershipPlanId, media_bucket: storageBucket,
          sha256: hash,
          status: family === "video" ? "approved" : "pending",
          copyright_status: family === "video" ? "not_scanned" : "pending_manual_review",
          is_world_featured: family === "video",
        }).select("id,kind,status").single();
        if (error) throw error;
        if (adminCurated) {
          await audit(current.profile.id, "import_rights_cleared_video", data.id, {
            sourceUrl: curatedSourceUrl, rightsHolder: curatedRightsHolder,
            rightsConfirmation: "admin_attested_written_permission_or_licence",
          });
        }
        return response({ id: data.id, kind: data.kind, status: data.status }, 201, origin);
      }
      return fail("Unknown upload purpose.", 422, origin);
    }
    if (action === "connect-payment") {
      const current = requireUser();
      const unlock = await unlockMonetization(current.profile);
      if (!unlock.unlocked) return fail("VYRA monetization unlocks when your channel reaches 20,000 followers.", 403, origin);
      if (body.consentAccepted !== true) return fail("Confirm the Razorpay storage and billing consent before connecting.", 422, origin);
      const provider = String(body.provider || "razorpay");
      if (provider !== "razorpay") return fail("Creator memberships currently use Razorpay.", 422, origin);
      const keyId = String(body.keyId || "").trim();
      const keySecret = String(body.keySecret || "").trim();
      const webhookSecret = String(body.webhookSecret || "").trim();
      if (!/^rzp_(test|live)_[A-Za-z0-9]{8,}$/.test(keyId)
        || keySecret.length < 16 || keySecret.length > 256
        || webhookSecret.length < 16 || webhookSecret.length > 256) {
        return fail("Enter your Razorpay Key ID, Key Secret and a webhook secret (each secret must be at least 16 characters).", 422, origin);
      }
      const credentials = { keyId, keySecret, webhookSecret };
      // Validate the key pair with Razorpay before encrypting or storing it.
      await razorpayApi({ keyId, keySecret }, "/plans?count=1");
      const encrypted = await encryptCredentials(JSON.stringify(credentials));
      const now = new Date().toISOString();
      const { error } = await db.from("creator_payment_connections").upsert({
        creator_id: current.profile.id, provider, encrypted_credentials: encrypted,
        connected_at: now, updated_at: now,
        billing_consent_at: now, billing_consent_version: "vyra-creator-billing-2026-11",
      }, { onConflict: "creator_id" });
      if (error) throw error;
      await audit(current.profile.id, "connect_creator_razorpay_memberships", current.profile.id, {
        provider, consentVersion: "vyra-creator-billing-2026-11", followerCount: unlock.followerCount,
      });
      return response({
        ok: true, provider, connectedAt: now,
        webhookUrl: SUPABASE_URL.replace(/\/$/, "") + "/functions/v1/razorpay-webhook?creator=" + current.profile.id,
      }, 200, origin);
    }
    if (action === "payment-status") {
      const current = requireUser();
      const { data, error } = await db.from("creator_payment_connections")
        .select("provider,connected_at,updated_at,billing_consent_at,billing_consent_version")
        .eq("creator_id", current.profile.id).maybeSingle();
      if (error) throw error;
      return response({ connection: data || null }, 200, origin);
    }
    if (action === "membership-status") {
      const current = requireUser();
      const unlock = await unlockMonetization(current.profile);
      const { data: plans, error: plansError } = await db.from("membership_plans")
        .select("id,name,description,features,amount_paise,currency,period,interval,is_active,created_at")
        .eq("creator_id", current.profile.id).order("created_at", { ascending: false });
      if (plansError) throw plansError;
      const activePlanIds = (plans || []).filter((p: any) => p.is_active).map((p: any) => p.id);
      const { count: activeSubscribers, error: subError } = activePlanIds.length
        ? await db.from("subscriptions").select("id", { count: "exact", head: true })
            .eq("creator_id", current.profile.id).eq("status", "active").in("membership_plan_id", activePlanIds)
        : { count: 0, error: null };
      if (subError) throw subError;
      const connection = await paymentConnection(current.profile.id);
      return response({
        followerCount: unlock.followerCount, unlocked: unlock.unlocked,
        connection: connection ? {
          provider: "razorpay", connectedAt: connection.connection.connected_at,
          consentAcceptedAt: connection.connection.billing_consent_at,
          keyMode: connection.credentials.keyId.startsWith("rzp_live_") ? "live" : "test",
        } : null,
        webhookUrl: SUPABASE_URL.replace(/\/$/, "") + "/functions/v1/razorpay-webhook?creator=" + current.profile.id,
        plans: plans || [], activeSubscribers: activeSubscribers || 0,
      }, 200, origin);
    }
    if (action === "creator-membership-plans") {
      const current = requireUser();
      const creatorId = String(body.creatorId || "");
      if (!/^[0-9a-f-]{36}$/i.test(creatorId) || creatorId === current.profile.id) return response({ plans: [] }, 200, origin);
      const { data: plans, error } = await db.from("membership_plans")
        .select("id,creator_id,name,description,features,amount_paise,currency,period,interval")
        .eq("creator_id", creatorId).eq("is_active", true).order("created_at", { ascending: true });
      if (error) throw error;
      const { data: subscriptions, error: subError } = plans?.length
        ? await db.from("subscriptions").select("membership_plan_id,status,current_end_at")
            .eq("subscriber_id", current.profile.id).eq("creator_id", creatorId)
            .eq("status", "active").in("membership_plan_id", plans.map((p: any) => p.id))
        : { data: [], error: null };
      if (subError) throw subError;
      const subscribed = new Map((subscriptions || []).map((row: any) => [row.membership_plan_id, row]));
      return response({
        plans: (plans || []).map((plan: any) => ({
          ...plan, subscribed: subscribed.has(plan.id),
          currentEndAt: subscribed.get(plan.id)?.current_end_at || null,
        })),
      }, 200, origin);
    }
    if (action === "membership-plan-create") {
      const current = requireUser();
      const unlock = await unlockMonetization(current.profile);
      if (!unlock.unlocked) return fail("Creator monetization unlocks at 20,000 followers.", 403, origin);
      const connection = await paymentConnection(current.profile.id);
      if (!connection) return fail("Connect and consent to Razorpay billing first.", 403, origin);
      const name = String(body.name || "").trim().slice(0, 60);
      const description = String(body.description || "").trim().slice(0, 240);
      const amountPaise = Math.round(Number(body.amountRupees) * 100);
      const period = String(body.period || "monthly");
      const interval = Number(body.interval || 1);
      const features = Array.isArray(body.features)
        ? body.features.map((item: any) => String(item).trim().slice(0, 80)).filter(Boolean).slice(0, 8)
        : [];
      if (name.length < 2 || !Number.isInteger(amountPaise) || amountPaise < 100 || amountPaise > 100000000
        || !["monthly","yearly"].includes(period) || !Number.isInteger(interval) || interval < 1 || interval > 12) {
        return fail("Enter a plan name, a price of at least ₹1, and a valid monthly or yearly billing cycle.", 422, origin);
      }
      if (!features.length) return fail("Add at least one member benefit so subscribers know what they receive.", 422, origin);
      const razorpayPlan = await razorpayApi(connection.credentials, "/plans", "POST", {
        period, interval,
        item: { name, description: description || name, amount: amountPaise, currency: "INR" },
        notes: { vyra_creator_id: current.profile.id },
      });
      const { data: plan, error } = await db.from("membership_plans").insert({
        creator_id: current.profile.id, name, description, features,
        amount_paise: amountPaise, currency: "INR", period, interval,
        razorpay_plan_id: razorpayPlan.id, is_active: true,
      }).select("id,name,description,features,amount_paise,currency,period,interval,is_active,created_at").single();
      if (error) throw error;
      await audit(current.profile.id, "create_razorpay_membership_plan", plan.id, { amountPaise, period, interval });
      return response({ plan }, 201, origin);
    }
    if (action === "membership-plan-toggle") {
      const current = requireUser();
      const planId = String(body.planId || "");
      const isActive = body.isActive === true;
      const { data, error } = await db.from("membership_plans").update({ is_active: isActive, updated_at: new Date().toISOString() })
        .eq("id", planId).eq("creator_id", current.profile.id)
        .select("id,name,is_active").maybeSingle();
      if (error) throw error;
      if (!data) return fail("Membership plan not found.", 404, origin);
      return response({ plan: data }, 200, origin);
    }
    if (action === "membership-start") {
      const current = requireUser();
      const planId = String(body.planId || "");
      const { data: plan, error } = await db.from("membership_plans")
        .select("id,creator_id,name,description,amount_paise,currency,period,interval,razorpay_plan_id,is_active")
        .eq("id", planId).eq("is_active", true).maybeSingle();
      if (error) throw error;
      if (!plan || plan.creator_id === current.profile.id) return fail("Membership plan is not available.", 404, origin);
      const connection = await paymentConnection(plan.creator_id);
      if (!connection) return fail("This creator has not connected Razorpay memberships yet.", 409, origin);
      const { data: existing, error: existingError } = await db.from("subscriptions")
        .select("provider_subscription_id,status").eq("creator_id", plan.creator_id)
        .eq("subscriber_id", current.profile.id).eq("membership_plan_id", plan.id)
        .in("status", ["active","pending"]).maybeSingle();
      if (existingError) throw existingError;
      if (existing?.status === "active") return fail("You are already a member of this channel.", 409, origin);
      if (existing?.provider_subscription_id) {
        return response({
          subscriptionId: existing.provider_subscription_id,
          keyId: connection.credentials.keyId,
          plan: { name: plan.name, amountPaise: plan.amount_paise, currency: plan.currency },
        }, 200, origin);
      }
      const totalCount = plan.period === "yearly" ? 10 : 120;
      const rpSubscription = await razorpayApi(connection.credentials, "/subscriptions", "POST", {
        plan_id: plan.razorpay_plan_id, total_count: totalCount, quantity: 1, customer_notify: true,
        notes: {
          vyra_creator_id: plan.creator_id, vyra_subscriber_id: current.profile.id,
          vyra_membership_plan_id: plan.id,
        },
      });
      const { error: insertError } = await db.from("subscriptions").insert({
        creator_id: plan.creator_id, subscriber_id: current.profile.id, provider: "razorpay",
        provider_subscription_id: rpSubscription.id, membership_plan_id: plan.id, status: "pending",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      if (insertError) throw insertError;
      return response({
        subscriptionId: rpSubscription.id, keyId: connection.credentials.keyId,
        plan: { name: plan.name, amountPaise: plan.amount_paise, currency: plan.currency },
      }, 201, origin);
    }
    if (action === "membership-verify") {
      const current = requireUser();
      const subscriptionId = String(body.subscriptionId || "");
      const paymentId = String(body.razorpayPaymentId || "");
      const signature = String(body.razorpaySignature || "");
      if (!/^sub_[A-Za-z0-9]+$/.test(subscriptionId) || !/^pay_[A-Za-z0-9]+$/.test(paymentId) || !/^[a-f0-9]{64}$/i.test(signature)) {
        return fail("Razorpay returned an invalid subscription verification response.", 422, origin);
      }
      const { data: subscription, error } = await db.from("subscriptions")
        .select("id,creator_id,subscriber_id,status,membership_plan_id")
        .eq("provider_subscription_id", subscriptionId).eq("subscriber_id", current.profile.id)
        .eq("provider", "razorpay").maybeSingle();
      if (error) throw error;
      if (!subscription) return fail("Membership checkout was not found for this account.", 404, origin);
      const connection = await paymentConnection(subscription.creator_id);
      if (!connection) return fail("The creator's Razorpay connection is no longer available.", 409, origin);
      const expected = await hmacHex(connection.credentials.keySecret, paymentId + "|" + subscriptionId);
      if (!constantTimeEqual(expected.toLowerCase(), signature.toLowerCase())) return fail("Razorpay payment signature could not be verified.", 403, origin);
      const { error: updateError } = await db.from("subscriptions").update({
        status: "active", razorpay_payment_id: paymentId, updated_at: new Date().toISOString(),
      }).eq("id", subscription.id);
      if (updateError) throw updateError;
      await db.from("notifications").insert({
        user_id: subscription.creator_id, actor_id: current.profile.id, type: "membership",
        message: "@" + current.profile.username + " joined your channel as a member.",
      });
      return response({ ok: true, status: "active" }, 200, origin);
    }
    if (action === "list-audio") {
      const current = requireUser();
      const { data, error } = await db.from("audio_tracks").select("id,title,artist,media_path,created_at")
        .eq("user_id", current.profile.id).order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      return response({ tracks: (data || []).map((track: any) => ({ ...track, media_url: publicMedia(track.media_path) })) }, 200, origin);
    }

    if (action === "admin-discovery-channels") {
      const current = await requireAdmin();
      const { data, error } = await db.from("vyra_content_channels")
        .select("id,name,search_query,youtube_channel_id,is_active,created_at")
        .eq("is_active", true).order("created_at", { ascending: false }).limit(40);
      if (error) throw error;
      return response({ channels: data || [], adminId: current.profile.id }, 200, origin);
    }
    if (action === "admin-discovery-channel-create") {
      const current = await requireAdmin();
      const name = String(body.name || "").trim().slice(0, 50);
      const searchQuery = String(body.searchQuery || "").trim().slice(0, 120);
      const youtubeChannelId = String(body.youtubeChannelId || "").trim();
      if (name.length < 3 || searchQuery.length < 2) return fail("Enter a channel name and a search phrase.", 422, origin);
      if (youtubeChannelId && !/^UC[a-zA-Z0-9_-]{22}$/.test(youtubeChannelId)) {
        return fail("YouTube channel IDs should start with UC and contain 24 characters.", 422, origin);
      }
      const { data, error } = await db.from("vyra_content_channels").insert({
        name, search_query: searchQuery, youtube_channel_id: youtubeChannelId || null,
        created_by: current.profile.id,
      }).select("id,name,search_query,youtube_channel_id,is_active,created_at").single();
      if (error) return fail(error.code === "23505" ? "A discovery channel already uses that name." : "Could not create discovery channel.", 409, origin);
      await audit(current.profile.id, "create_content_discovery_channel", data.id, { name, searchQuery, hasChannelFilter: !!youtubeChannelId });
      return response({ channel: data }, 201, origin);
    }
    if (action === "admin-discovery-channel-delete") {
      const current = await requireAdmin();
      const channelId = String(body.channelId || "");
      if (!/^[0-9a-f-]{36}$/i.test(channelId)) return fail("Choose a valid discovery channel.", 422, origin);
      const { data, error } = await db.from("vyra_content_channels").delete()
        .eq("id", channelId).select("id,name").maybeSingle();
      if (error) throw error;
      if (!data) return fail("Discovery channel not found.", 404, origin);
      await audit(current.profile.id, "delete_content_discovery_channel", data.id, { name: data.name });
      return response({ ok: true }, 200, origin);
    }
    if (action === "admin-content-discover") {
      const current = await requireAdmin();
      const channelId = String(body.channelId || "");
      const { data: channel, error: channelError } = await db.from("vyra_content_channels")
        .select("id,name,search_query,youtube_channel_id,is_active")
        .eq("id", channelId).eq("is_active", true).maybeSingle();
      if (channelError) throw channelError;
      if (!channel) return fail("Discovery channel not found or disabled.", 404, origin);
      const apiKey = Deno.env.get("YOUTUBE_API_KEY") || "";
      if (!apiKey) return fail("YouTube discovery is not configured yet. Add YOUTUBE_API_KEY to Supabase Edge Function secrets.", 503, origin);
      const params = new URLSearchParams({
        part: "snippet", type: "video", q: channel.search_query,
        maxResults: "10", order: "relevance", safeSearch: "strict",
        videoEmbeddable: "true", videoDuration: "short",
        videoLicense: "creativeCommon", key: apiKey,
      });
      if (channel.youtube_channel_id) params.set("channelId", channel.youtube_channel_id);
      const youtubeResponse = await fetch("https://www.googleapis.com/youtube/v3/search?" + params.toString(), {
        headers: { "Accept": "application/json" },
      });
      const youtubeData = await youtubeResponse.json().catch(() => ({}));
      if (!youtubeResponse.ok) {
        const reason = youtubeData?.error?.errors?.[0]?.reason || "";
        const safeMessage = reason === "quotaExceeded"
          ? "YouTube API quota is used up. Try again after the quota resets."
          : "YouTube search failed. Check the API key and YouTube Data API v3 access.";
        return fail(safeMessage, youtubeResponse.status === 403 ? 503 : 502, origin);
      }
      const videos = (youtubeData.items || []).flatMap((item: any) => {
        const videoId = String(item?.id?.videoId || "");
        if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return [];
        const snippet = item.snippet || {};
        return [{
          videoId, title: String(snippet.title || "").slice(0, 180),
          description: String(snippet.description || "").slice(0, 240),
          channelTitle: String(snippet.channelTitle || "").slice(0, 100),
          channelId: String(snippet.channelId || ""),
          publishedAt: String(snippet.publishedAt || ""),
          thumbnailUrl: String(snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || ""),
          sourceUrl: "https://www.youtube.com/watch?v=" + videoId,
          platform: "YouTube",
        }];
      });
      await audit(current.profile.id, "scan_youtube_discovery_channel", channel.id, {
        query: channel.search_query, channelFilter: !!channel.youtube_channel_id, returned: videos.length,
      });
      // Results are transient. VYRA stores only the admin-defined channel config and scan audit.
      return response({ channel, videos, scannedAt: new Date().toISOString(), licenseFilter: "Creative Commons" }, 200, origin);
    }

    if (action === "admin-summary") {
      const current = await requireAdmin();
      const { data: pending } = await db.from("posts").select("*,author:profiles!posts_user_id_fkey(*)")
        .eq("status", "pending").order("created_at", { ascending: true }).limit(80);
      const { data: pendingStories } = await db.from("stories").select("*,author:profiles!stories_user_id_fkey(*)")
        .eq("status", "pending").order("created_at", { ascending: true }).limit(80);
      const { data: approvedRows } = await db.from("posts").select("*,author:profiles!posts_user_id_fkey(*)")
        .eq("status", "approved").eq("media_type", "video").order("created_at", { ascending: false }).limit(40);
      const { count: users } = await db.from("profiles").select("id", { count: "exact", head: true });
      const { count: verified } = await db.from("profiles").select("id", { count: "exact", head: true }).eq("is_verified", true);
      return response({
        userCount: users || 0, verifiedCount: verified || 0,
        pendingPosts: (pending || []).map((post: any) => ({
          id: post.id, title: post.title || "", caption: post.caption, media_type: post.media_type, kind: post.kind,
          media_url: publicMedia(post.media_path), copyright_status: post.copyright_status,
          author: safeUser(post.author),
        })),
        pendingStories: (pendingStories || []).map((story: any) => ({
          id: story.id, caption: story.caption, media_type: story.media_type,
          media_url: publicMedia(story.media_path), copyright_status: story.copyright_status,
          author: safeUser(story.author),
        })),
        approvedPosts: (approvedRows || []).map((post: any) => ({
          id: post.id, title: post.title || "", caption: post.caption, media_type: post.media_type, kind: post.kind,
          media_url: publicMedia(post.media_path), is_world_featured: !!post.is_world_featured,
          author: safeUser(post.author),
        })),
        admin: safeUser(current.profile),
      }, 200, origin);
    }
    if (action === "admin-verify") {
      const current = await requireAdmin();
      const username = String(body.username || "").toLowerCase().trim();
      if (!validateUsername(username)) return fail("Enter an exact valid username.", 422, origin);
      const { data: target } = await db.from("profiles").select("id").eq("username", username).maybeSingle();
      if (!target) return fail("No account has that username.", 404, origin);
      const { error } = await db.from("profiles").update({ is_verified: true, updated_at: new Date().toISOString() }).eq("id", target.id);
      if (error) throw error;
      await audit(current.profile.id, "verify_creator", target.id, { username });
      return response({ ok: true }, 200, origin);
    }
    if (action === "admin-moderate") {
      const current = await requireAdmin();
      const postId = String(body.postId || "");
      const decision = String(body.decision || "");
      if (!["approve", "block"].includes(decision)) return fail("Choose approve or block.", 422, origin);
      const { data: post } = await db.from("posts").select("id,user_id,sha256").eq("id", postId).maybeSingle();
      if (!post) return fail("Post not found.", 404, origin);
      const match = await exactCopyrightMatch(post.sha256);
      if (match && decision === "approve") return fail("An exact copyright registry match exists. Remove the match only if the rights record is wrong.", 409, origin);
      const status = decision === "approve" ? "approved" : "blocked";
      const { error } = await db.from("posts").update({
        status, copyright_status: decision === "approve" ? "no_exact_match" : (match ? "matched" : "pending_manual_review"),
        reviewed_at: new Date().toISOString(), reviewed_by: current.profile.id,
      }).eq("id", postId);
      if (error) throw error;
      await audit(current.profile.id, "moderate_post_" + decision, postId);
      if (decision === "approve") await db.from("notifications").insert({ user_id: post.user_id, actor_id: current.profile.id, type: "post_approved", post_id: postId, message: "Your post has been approved and is now eligible for the feed." });
      return response({ ok: true }, 200, origin);
    }
    if (action === "admin-moderate-story") {
      const current = await requireAdmin();
      const storyId = String(body.storyId || "");
      const decision = String(body.decision || "");
      if (!["approve", "block"].includes(decision)) return fail("Choose approve or block.", 422, origin);
      const { data: story } = await db.from("stories").select("id,user_id,sha256").eq("id", storyId).maybeSingle();
      if (!story) return fail("Story not found.", 404, origin);
      const match = await exactCopyrightMatch(story.sha256);
      if (match && decision === "approve") return fail("An exact copyright registry match exists. This story cannot be approved.", 409, origin);
      const { error } = await db.from("stories").update({
        status: decision === "approve" ? "approved" : "blocked",
        copyright_status: decision === "approve" ? "no_exact_match" : (match ? "matched" : "pending_manual_review"),
        reviewed_at: new Date().toISOString(), reviewed_by: current.profile.id,
      }).eq("id", storyId);
      if (error) throw error;
      await audit(current.profile.id, "moderate_story_" + decision, storyId);
      if (decision === "approve") await db.from("notifications").insert({
        user_id: story.user_id, actor_id: current.profile.id, type: "story_approved",
        message: "Your story has been approved and is now visible for 24 hours.",
      });
      return response({ ok: true }, 200, origin);
    }
    if (action === "admin-feature") {
      const current = await requireAdmin();
      const postId = String(body.postId || "");
      const featured = body.featured === true;
      const { data: post } = await db.from("posts").select("id,status,media_type").eq("id", postId).maybeSingle();
      if (!post || post.status !== "approved" || post.media_type !== "video") return fail("Only approved videos can appear in the world feed.", 409, origin);
      const { error } = await db.from("posts").update({ is_world_featured: featured }).eq("id", postId);
      if (error) throw error;
      await audit(current.profile.id, "feature_world_post", postId, { featured });
      return response({ ok: true }, 200, origin);
    }
    if (action === "admin-add-fingerprint") {
      const current = await requireAdmin();
      const hash = String(body.sha256 || "").toLowerCase();
      const holder = String(body.rightsHolder || "").trim().slice(0, 160);
      if (!/^[a-f0-9]{64}$/.test(hash) || !holder) return fail("Enter a 64-character SHA-256 and rights holder.", 422, origin);
      const { error } = await db.from("copyright_fingerprints").insert({ sha256: hash, rights_holder: holder, source_label: "Admin-registered exact fingerprint", created_by: current.profile.id });
      if (error) return fail(error.code === "23505" ? "This fingerprint is already registered." : "Could not register fingerprint.", 409, origin);
      await db.from("posts").update({ status: "blocked", copyright_status: "matched" }).eq("sha256", hash);
      await db.from("stories").update({ status: "blocked", copyright_status: "matched" }).eq("sha256", hash);
      await audit(current.profile.id, "register_copyright_fingerprint", null, { rightsHolder: holder });
      return response({ ok: true }, 200, origin);
    }
    return fail("Unknown FameLoop action.", 404, origin);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return fail(message, 400, origin || "null");
  }
});
