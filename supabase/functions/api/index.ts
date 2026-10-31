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
const allowedOrigins = (Deno.env.get("APP_ORIGINS") || "").split(",").map((v) => v.trim()).filter(Boolean);
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
  const { data: likes } = await db.from("likes").select("post_id").eq("user_id", viewerId).in("post_id", ids);
  const liked = new Set((likes || []).map((item: any) => item.post_id));
  return rows.map((row) => ({
    id: row.id, caption: row.caption, media_url: publicMedia(row.media_path), media_type: row.media_type,
    kind: row.kind, duration_seconds: Number(row.duration_seconds || 0), likes_count: row.likes_count || 0,
    comments_count: row.comments_count || 0, created_at: row.created_at, is_world_featured: !!row.is_world_featured,
    liked: liked.has(row.id), author: safeUser(row.author),
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
  if (context.profile.is_admin) return true;
  return !!context.session.admin_gate_expires_at && new Date(context.session.admin_gate_expires_at).getTime() > Date.now();
}
async function audit(adminId: string, action: string, targetId: string | null, details: any = {}) {
  await db.from("admin_audit").insert({ admin_id: adminId, action, target_id: targetId, details });
}
async function exactCopyrightMatch(hash: string) {
  const { data } = await db.from("copyright_fingerprints").select("id,rights_holder,source_label").eq("sha256", hash).maybeSingle();
  return data || null;
}
async function storageFileExists(path: string) {
  const parts = path.split("/");
  const folder = parts.slice(0, -1).join("/");
  const leaf = parts[parts.length - 1];
  const { data, error } = await db.storage.from("media").list(folder, { search: leaf, limit: 10 });
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
  const originHeader = req.headers.get("origin") || "";
  const origin = allowedOrigins.length ? (allowedOrigins.includes(originHeader) ? originHeader : "") : "*";
  if (req.method === "OPTIONS") return new Response("ok", { headers: { ...baseHeaders, "Access-Control-Allow-Origin": origin || "null" } });
  if (req.method !== "POST") return fail("Use POST for API actions.", 405, origin || "null");
  if (!SUPABASE_URL || !SERVICE_KEY || !PUBLISHABLE) return fail("The FameLoop API is not configured yet.", 503, origin || "null");
  if (allowedOrigins.length && !origin) return fail("This app origin is not allowed.", 403, "null");
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
        display_name: username, birth_date: birthDate, heard_about: heard,
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
        .order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      const { data: storyRows } = await db.from("stories")
        .select("*,author:profiles!stories_user_id_fkey(*)")
        .eq("status", "approved").gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false }).limit(80);
      const stories = (storyRows || []).map((story: any) => ({
        id: story.id, media_url: publicMedia(story.media_path), media_type: story.media_type,
        caption: story.caption, created_at: story.created_at, author: safeUser(story.author),
      }));
      return response({ posts: await enrichPosts(rows || [], current.profile.id), stories }, 200, origin);
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
      return response({ users: (data || []).map(safeUser) }, 200, origin);
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
    if (action === "notifications") {
      const current = requireUser();
      const { data, error } = await db.from("notifications").select("*").eq("user_id", current.profile.id).order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      return response({ notifications: data || [] }, 200, origin);
    }

    if (action === "create-upload") {
      const current = requireUser();
      const purpose = String(body.purpose || "");
      const mime = String(body.mimeType || "");
      const name = String(body.fileName || "upload").slice(0, 120).replace(/[^a-zA-Z0-9._-]/g, "_");
      const size = Number(body.size || 0);
      const hash = String(body.sha256 || "").toLowerCase();
      const family = mimeFamily(mime);
      const maxSize = family === "video" ? 100 * 1024 * 1024 : family === "image" ? 12 * 1024 * 1024 : family === "audio" ? 25 * 1024 * 1024 : 0;
      if (!["post", "story", "avatar", "audio"].includes(purpose) || !family || !maxSize || !Number.isFinite(size) || size < 1 || size > maxSize) return fail("Unsupported media type or file size.", 422, origin);
      if (!/^[a-f0-9]{64}$/.test(hash)) return fail("Media fingerprint is invalid.", 422, origin);
      if ((purpose === "story" || purpose === "post") && family === "audio") return fail("Audio files belong in your audio library.", 422, origin);
      if (purpose === "avatar" && family !== "image") return fail("Profile photos must be images.", 422, origin);
      if (purpose === "audio" && family !== "audio") return fail("Choose an MP3 or M4A audio file.", 422, origin);
      const match = await exactCopyrightMatch(hash);
      if (match) return response({ blocked: true, reason: "exact_copyright_hash_match" }, 200, origin);
      const extension = name.includes(".") ? name.split(".").pop() : "bin";
      const path = current.profile.id + "/" + crypto.randomUUID() + "." + extension;
      const { data, error } = await db.storage.from("media").createSignedUploadUrl(path, { upsert: false });
      if (error || !data?.token) throw error || new Error("Could not create a signed upload.");
      return response({ path, uploadToken: data.token }, 200, origin);
    }
    if (action === "complete-upload") {
      const current = requireUser();
      const purpose = String(body.purpose || "");
      const path = String(body.path || "");
      const hash = String(body.sha256 || "").toLowerCase();
      const mime = String(body.mimeType || "");
      const family = mimeFamily(mime);
      if (!path.startsWith(current.profile.id + "/") || !/^[a-f0-9]{64}$/.test(hash)) return fail("Invalid upload reference.", 422, origin);
      if (!(await storageFileExists(path))) return fail("Upload was not found in media storage.", 422, origin);
      const match = await exactCopyrightMatch(hash);
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
        const { data, error } = await db.from("posts").insert({
          user_id: current.profile.id, caption: String(body.caption || "").slice(0, 2200), media_path: path,
          media_type: family, kind, duration_seconds: duration, sha256: hash, status: "pending",
          copyright_status: "pending_manual_review",
        }).select("id,kind,status").single();
        if (error) throw error;
        return response({ id: data.id, kind: data.kind, status: data.status }, 201, origin);
      }
      return fail("Unknown upload purpose.", 422, origin);
    }
    if (action === "list-audio") {
      const current = requireUser();
      const { data, error } = await db.from("audio_tracks").select("id,title,artist,media_path,created_at")
        .eq("user_id", current.profile.id).order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      return response({ tracks: (data || []).map((track: any) => ({ ...track, media_url: publicMedia(track.media_path) })) }, 200, origin);
    }

    if (action === "admin-gate") {
      const current = requireUser();
      const password = Deno.env.get("ADMIN_PANEL_PASSWORD") || "";
      const allowlist = (Deno.env.get("ADMIN_USERNAMES") || "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
      if (!password) return fail("Admin passphrase is not configured in Supabase Edge Function secrets.", 503, origin);
      if (allowlist.length && !allowlist.includes(current.profile.username)) return fail("This account is not on the admin allowlist.", 403, origin);
      if (!constantTimeEqual(String(body.password || ""), password)) return fail("Admin passphrase is incorrect.", 401, origin);
      const expiry = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      await db.from("app_sessions").update({ admin_gate_expires_at: expiry }).eq("token_hash", current.tokenHash);
      await db.from("profiles").update({ is_admin: true, updated_at: new Date().toISOString() }).eq("id", current.profile.id);
      return response({ ok: true, expiresAt: expiry }, 200, origin);
    }
    if (action === "admin-summary") {
      const current = await requireAdmin();
      const { data: pending } = await db.from("posts").select("*,author:profiles!posts_user_id_fkey(*)")
        .eq("status", "pending").order("created_at", { ascending: true }).limit(80);
      const { count: users } = await db.from("profiles").select("id", { count: "exact", head: true });
      const { count: verified } = await db.from("profiles").select("id", { count: "exact", head: true }).eq("is_verified", true);
      return response({
        userCount: users || 0, verifiedCount: verified || 0,
        pendingPosts: (pending || []).map((post: any) => ({
          id: post.id, caption: post.caption, media_type: post.media_type, kind: post.kind,
          media_url: publicMedia(post.media_path), copyright_status: post.copyright_status,
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
    if (action === "admin-feature") {
      const current = await requireAdmin();
      const postId = String(body.postId || "");
      const featured = body.featured === true;
      const { data: post } = await db.from("posts").select("id,status").eq("id", postId).maybeSingle();
      if (!post || post.status !== "approved") return fail("Only approved posts can appear in the world feed.", 409, origin);
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
