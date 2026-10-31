import { createClient } from '@supabase/supabase-js';
import { acceptedMediaType, maxBytesFor, sha256 } from './media';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined;
if (!url || !key) console.warn('Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local.');

export const supabase = createClient(url || 'https://example.supabase.co', key || 'sb_publishable_missing', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const apiUrl = (url || '').replace(/\/$/, '') + '/functions/v1/api';
const storageKey = 'vyra_session_v1';

/**
 * Keep the custom VYRA session token across browser/app restarts.
 * Migrate the previous tab-only token once so existing signed-in creators
 * do not get unexpectedly logged out during this update.
 */
export function getSessionToken(): string | null {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) return saved;
    const legacy = sessionStorage.getItem(storageKey);
    if (legacy) {
      localStorage.setItem(storageKey, legacy);
      sessionStorage.removeItem(storageKey);
      return legacy;
    }
  } catch {
    try { return sessionStorage.getItem(storageKey); } catch { return null; }
  }
  return null;
}
export function setSessionToken(value: string): void {
  try {
    localStorage.setItem(storageKey, value);
    sessionStorage.removeItem(storageKey);
  } catch {
    try { sessionStorage.setItem(storageKey, value); } catch { /* Storage can be disabled by the device. */ }
  }
}
export function clearSessionToken(): void {
  try { localStorage.removeItem(storageKey); } catch { /* Continue clearing the tab-scoped fallback. */ }
  try { sessionStorage.removeItem(storageKey); } catch { /* Storage can be disabled by the device. */ }
}

export async function callApi<T = any>(action: string, payload: Record<string, unknown> = {}, token = getSessionToken()): Promise<T> {
  if (!url || !key) throw new Error('VYRA is not configured. Add your Supabase URL and publishable key.');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', apikey: key };
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Something went wrong. Please try again.');
  return body as T;
}

export async function uploadEncryptedAttachment(
  blob: Blob,
  conversationId: string,
  token: string,
  messageType: "image" | "voice",
  originalMime: string,
) {
  const signed = await callApi<{ path: string; uploadToken: string }>("dm-attachment-upload", {
    conversationId, messageType, mimeType: originalMime, size: blob.size,
  }, token);
  const { error } = await supabase.storage.from("media").uploadToSignedUrl(
    signed.path,
    signed.uploadToken,
    blob,
    { contentType: "application/octet-stream", upsert: false },
  );
  if (error) throw new Error(error.message);
  return signed.path;
}

export async function uploadMedia(
  file: File,
  purpose: 'post' | 'story' | 'avatar' | 'audio',
  token: string,
  extra: Record<string, unknown> = {},
) {
  if (!acceptedMediaType(file.type)) throw new Error('Use a JPG, PNG, WebP, MP4, WebM or MP3 file.');
  if (file.size <= 0 || file.size > maxBytesFor(file.type)) throw new Error('This file is empty or larger than the allowed size.');
  const fingerprint = await sha256(file);
  const signed = await callApi<{ path: string; uploadToken: string; blocked?: boolean }>('create-upload', {
    purpose, fileName: file.name, mimeType: file.type, size: file.size, sha256: fingerprint,
  }, token);
  if (signed.blocked) throw new Error('This exact file matches a registered copyrighted asset and cannot be published.');
  const { error } = await supabase.storage.from('media').uploadToSignedUrl(
    signed.path, signed.uploadToken, file, { contentType: file.type, upsert: false },
  );
  if (error) throw new Error(error.message);
  return callApi<{ id?: string; url?: string }>('complete-upload', {
    purpose, path: signed.path, sha256: fingerprint, mimeType: file.type, size: file.size, ...extra,
  }, token);
}
