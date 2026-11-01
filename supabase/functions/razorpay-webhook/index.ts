import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
function fromB64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
function hex(bytes: Uint8Array) {
  return Array.from(bytes).map((value) => value.toString(16).padStart(2, "0")).join("");
}
function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
async function decryptCredentials(value: string) {
  const rawKey = Deno.env.get("PAYMENT_ENCRYPTION_KEY") || "";
  if (!rawKey) throw new Error("Payment encryption key is not configured.");
  const keyBytes = fromB64(rawKey.trim());
  if (keyBytes.length !== 32) throw new Error("Payment encryption key is invalid.");
  const [version, ivText, cipherText] = value.split(".");
  if (version !== "v1" || !ivText || !cipherText) throw new Error("Stored credentials use an unsupported format.");
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(ivText) }, key, fromB64(cipherText),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as Record<string, string>;
}
async function sha256(value: string) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return json({ error: "POST only." }, 405);
  try {
    const creatorId = new URL(request.url).searchParams.get("creator_id") || "";
    if (!/^[0-9a-f-]{36}$/i.test(creatorId)) return json({ error: "Invalid creator webhook route." }, 400);
    const signature = request.headers.get("x-razorpay-signature") || "";
    if (!/^[a-f0-9]{64}$/i.test(signature)) return json({ error: "Missing or invalid Razorpay signature." }, 401);
    const rawBody = await request.text();
    if (!rawBody || rawBody.length > 1024 * 1024) return json({ error: "Invalid webhook payload." }, 413);

    const { data: connection, error: connectionError } = await db.from("creator_payment_connections")
      .select("encrypted_credentials").eq("creator_id", creatorId).eq("provider", "razorpay").maybeSingle();
    if (connectionError) throw connectionError;
    if (!connection) return json({ error: "Creator payment connection not found." }, 404);
    const credentials = await decryptCredentials(connection.encrypted_credentials);
    const secret = String(credentials.webhookSecret || "");
    if (secret.length < 32) return json({ error: "Creator webhook secret is not configured." }, 503);
    const expected = await hmac(secret, rawBody);
    if (!safeEqual(expected.toLowerCase(), signature.toLowerCase())) {
      return json({ error: "Webhook signature verification failed." }, 401);
    }

    const payload = JSON.parse(rawBody);
    const eventType = String(payload.event || "");
    const subscriptionEntity = payload.payload?.subscription?.entity || null;
    const paymentEntity = payload.payload?.payment?.entity || null;
    const statusByEvent: Record<string, string> = {
      "subscription.authenticated": "authenticated",
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
    const payloadHash = await sha256(rawBody);
    const eventId = request.headers.get("x-razorpay-event-id") || await sha256(eventType + ":" + payloadHash);
    if (nextStatus && subscriptionEntity?.id) {
      const updates: Record<string, unknown> = {
        status: nextStatus,
        updated_at: new Date().toISOString(),
      };
      if (paymentEntity?.id) updates.razorpay_payment_id = String(paymentEntity.id);
      if (subscriptionEntity.current_start) updates.current_start_at = new Date(Number(subscriptionEntity.current_start) * 1000).toISOString();
      if (subscriptionEntity.current_end) updates.current_end_at = new Date(Number(subscriptionEntity.current_end) * 1000).toISOString();
      const { data: updated, error: updateError } = await db.from("subscriptions").update(updates)
        .eq("creator_id", creatorId).eq("provider", "razorpay")
        .eq("provider_subscription_id", String(subscriptionEntity.id))
        .select("id").maybeSingle();
      if (updateError) throw updateError;
      // Let Razorpay retry when the app's local subscription row has not been committed yet.
      if (!updated) return json({ error: "Subscription record is not ready; retry this event." }, 503);
    }
    const { error: eventError } = await db.from("razorpay_webhook_events").insert({
      provider_event_id: eventId, creator_id: creatorId, event_type: eventType, payload_hash: payloadHash,
    });
    if (eventError && eventError.code !== "23505") throw eventError;
    return json({ ok: true, duplicate: eventError?.code === "23505", event: eventType }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed.";
    return json({ error: message }, 500);
  }
});
