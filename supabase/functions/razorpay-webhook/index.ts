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
async function hmac(secret: string, message: Uint8Array | string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {
    name: "HMAC", hash: "SHA-256",
  }, false, ["sign"]);
  const input = typeof message === "string" ? new TextEncoder().encode(message) : message;
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, input)));
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

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!SUPABASE_URL || !SERVICE_KEY || !ENCRYPTION_KEY) return new Response("Webhook is not configured", { status: 503 });

  try {
    const creatorId = new URL(request.url).searchParams.get("creator") || "";
    if (!/^[0-9a-f-]{36}$/i.test(creatorId)) return new Response("Invalid creator", { status: 400 });

    // Verify Razorpay's signature against the original request bytes. Do not
    // parse and re-serialize JSON before checking the HMAC.
    const rawBody = new Uint8Array(await request.arrayBuffer());
    if (rawBody.length === 0 || rawBody.length > 1024 * 1024) return new Response("Invalid payload size", { status: 413 });
    const signature = request.headers.get("x-razorpay-signature") || "";
    const eventId = request.headers.get("x-razorpay-event-id") || "";
    if (!/^[a-f0-9]{64}$/i.test(signature) || !/^[A-Za-z0-9_-]{8,160}$/.test(eventId)) {
      return new Response("Missing or invalid webhook signature headers", { status: 400 });
    }

    const { data: connection, error: connectionError } = await db.from("creator_payment_connections")
      .select("encrypted_credentials,billing_consent_at,provider")
      .eq("creator_id", creatorId).eq("provider", "razorpay").maybeSingle();
    if (connectionError) throw connectionError;
    if (!connection?.billing_consent_at || !connection.encrypted_credentials) return new Response("Creator payment connection not found", { status: 404 });

    const credentials = await decryptCredentials(connection.encrypted_credentials);
    if (!credentials?.webhookSecret || !credentials?.keyId || !credentials?.keySecret) return new Response("Webhook credentials are incomplete", { status: 503 });
    const expectedSignature = await hmac(credentials.webhookSecret, rawBody);
    if (!constantTimeEqual(expectedSignature.toLowerCase(), signature.toLowerCase())) return new Response("Invalid webhook signature", { status: 401 });

    const payload = JSON.parse(new TextDecoder().decode(rawBody));
    const eventType = String(payload?.event || "").slice(0, 120);
    const entity = payload?.payload?.subscription?.entity;
    const subscriptionId = String(entity?.id || "");
    if (!eventType || !/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) return new Response("Unsupported subscription webhook", { status: 400 });

    const { data: storedSubscription, error: storedError } = await db.from("subscriptions")
      .select("id,creator_id,subscriber_id,provider_subscription_id")
      .eq("creator_id", creatorId).eq("provider", "razorpay")
      .eq("provider_subscription_id", subscriptionId).maybeSingle();
    if (storedError) throw storedError;
    if (!storedSubscription) return new Response("Subscription record not found", { status: 404 });

    // Ask Razorpay for the subscription's current status. This makes the
    // handler resilient to duplicate and out-of-order webhook deliveries.
    const remoteResponse = await fetch("https://api.razorpay.com/v1/subscriptions/" + encodeURIComponent(subscriptionId), {
      headers: { Authorization: "Basic " + btoa(credentials.keyId + ":" + credentials.keySecret) },
      signal: AbortSignal.timeout(10000),
    });
    if (!remoteResponse.ok) return new Response("Could not reconcile Razorpay subscription", { status: 502 });
    const remote = await remoteResponse.json();
    const allowedStatuses = new Set(["created", "authenticated", "active", "pending", "halted", "cancelled", "completed", "paused"]);
    const status = String(remote.status || "");
    if (!allowedStatuses.has(status)) return new Response("Unknown subscription status", { status: 409 });

    const payloadHash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", rawBody)));
    const startAt = isoFromUnix(remote.current_start);
    const endAt = isoFromUnix(remote.current_end);
    const { error: updateError } = await db.from("subscriptions").update({
      status: status === "created" || status === "authenticated" ? "pending" : status,
      current_start_at: startAt,
      current_end_at: endAt,
      updated_at: new Date().toISOString(),
    }).eq("id", storedSubscription.id).eq("creator_id", creatorId);
    if (updateError) throw updateError;

    const { error: eventError } = await db.from("razorpay_webhook_events").upsert({
      provider_event_id: eventId,
      creator_id: creatorId,
      event_type: eventType,
      payload_hash: payloadHash,
      processed_at: new Date().toISOString(),
    }, { onConflict: "provider_event_id", ignoreDuplicates: true });
    if (eventError) throw eventError;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch {
    // Never log or return merchant credentials or request payloads.
    return new Response("Webhook processing failed", { status: 500 });
  }
});
