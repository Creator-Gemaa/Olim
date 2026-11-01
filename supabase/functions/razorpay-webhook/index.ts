import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ENCRYPTION_KEY = Deno.env.get("PAYMENT_ENCRYPTION_KEY") || "";
const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

function hex(bytes: Uint8Array) {
  return Array.from(bytes).map((value) => value.toString(16).padStart(2, "0")).join("");
}
function fromB64(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
async function hmac(secret: string, message: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {
    name: "HMAC", hash: "SHA-256",
  }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, message)));
}
function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
async function decryptCredentials(value: string) {
  let keyBytes: Uint8Array;
  try { keyBytes = fromB64(ENCRYPTION_KEY.trim()); } catch { throw new Error("Payment encryption is not configured."); }
  if (keyBytes.length !== 32) throw new Error("Payment encryption is not configured.");
  const [version, iv, cipher] = value.split(".");
  if (version !== "v1" || !iv || !cipher) throw new Error("Stored payment credentials are unreadable.");
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, key, fromB64(cipher));
  return JSON.parse(new TextDecoder().decode(clear));
}
function isoFromUnix(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? new Date(number * 1000).toISOString() : null;
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return json({ error: "POST only." }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY || !ENCRYPTION_KEY) return json({ error: "Webhook is not configured." }, 503);

  try {
    const creatorId = new URL(request.url).searchParams.get("creator") || "";
    if (!/^[0-9a-f-]{36}$/i.test(creatorId)) return json({ error: "Invalid creator route." }, 400);

    // Read and authenticate the raw bytes before parsing the webhook payload.
    const rawBody = new Uint8Array(await request.arrayBuffer());
    if (rawBody.length === 0 || rawBody.length > 1024 * 1024) return json({ error: "Invalid payload size." }, 413);
    const signature = request.headers.get("x-razorpay-signature") || "";
    const eventId = request.headers.get("x-razorpay-event-id") || "";
    if (!/^[a-f0-9]{64}$/i.test(signature) || !/^[A-Za-z0-9_-]{8,160}$/.test(eventId)) {
      return json({ error: "Missing or invalid Razorpay signature headers." }, 400);
    }

    const { data: connection, error: connectionError } = await db.from("creator_payment_connections")
      .select("encrypted_credentials,billing_consent_at,provider")
      .eq("creator_id", creatorId).eq("provider", "razorpay").maybeSingle();
    if (connectionError) throw connectionError;
    if (!connection?.billing_consent_at || !connection.encrypted_credentials) return json({ error: "Creator payment connection not found." }, 404);

    const credentials = await decryptCredentials(connection.encrypted_credentials);
    if (!credentials?.webhookSecret) return json({ error: "Creator webhook secret is not configured." }, 503);
    const expected = await hmac(credentials.webhookSecret, rawBody);
    if (!constantTimeEqual(expected.toLowerCase(), signature.toLowerCase())) return json({ error: "Webhook signature verification failed." }, 401);

    const payload = JSON.parse(new TextDecoder().decode(rawBody));
    const eventType = String(payload?.event || "").slice(0, 120);
    const entity = payload?.payload?.subscription?.entity;
    const subscriptionId = String(entity?.id || "");
    const eventAt = isoFromUnix(payload?.created_at);
    if (!eventType || !/^sub_[A-Za-z0-9]+$/.test(subscriptionId) || !eventAt) {
      return json({ error: "Unsupported or incomplete subscription event." }, 400);
    }

    const statusByEvent: Record<string, string> = {
      "subscription.authenticated": "pending",
      "subscription.activated": "active",
      "subscription.charged": "active",
      "subscription.pending": "pending",
      "subscription.halted": "halted",
      "subscription.paused": "paused",
      "subscription.resumed": "active",
      "subscription.cancelled": "cancelled",
      "subscription.completed": "completed",
    };
    const nextStatus = statusByEvent[eventType];
    if (!nextStatus) return json({ ok: true, ignored: true, event: eventType });

    const payloadHash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", rawBody)));
    const { data: storedSubscription, error: storedError } = await db.from("subscriptions")
      .select("id,creator_id,last_webhook_created_at")
      .eq("creator_id", creatorId).eq("provider", "razorpay")
      .eq("provider_subscription_id", subscriptionId).maybeSingle();
    if (storedError) throw storedError;
    // Return a retryable error if local checkout persistence has not completed yet.
    if (!storedSubscription) return json({ error: "Subscription record not ready; retry this event." }, 503);

    const alreadyNewer = storedSubscription.last_webhook_created_at
      && new Date(storedSubscription.last_webhook_created_at).getTime() > new Date(eventAt).getTime();
    if (!alreadyNewer) {
      // The timestamp filter also protects against two distinct events racing.
      const { data: updated, error: updateError } = await db.from("subscriptions").update({
        status: nextStatus,
        current_start_at: isoFromUnix(entity.current_start),
        current_end_at: isoFromUnix(entity.current_end),
        last_webhook_created_at: eventAt,
        updated_at: new Date().toISOString(),
      }).eq("id", storedSubscription.id).eq("creator_id", creatorId)
        .or("last_webhook_created_at.is.null,last_webhook_created_at.lte." + eventAt)
        .select("id").maybeSingle();
      if (updateError) throw updateError;
      // A newer event won the race. The older, valid event is still acknowledged.
      void updated;
    }

    const { error: eventError } = await db.from("razorpay_webhook_events").insert({
      provider_event_id: eventId, creator_id: creatorId, event_type: eventType,
      payload_hash: payloadHash, processed_at: new Date().toISOString(),
    });
    if (eventError && eventError.code !== "23505") throw eventError;
    return json({ ok: true, duplicate: eventError?.code === "23505", stale: !!alreadyNewer });
  } catch {
    // Do not log or return credentials, raw payment data or webhook payloads.
    return json({ error: "Webhook processing failed." }, 500);
  }
});
