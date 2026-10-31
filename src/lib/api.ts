import { createClient } from '@supabase/supabase-js';
import { acceptedMediaType, maxBytesFor, sha256 } from './media';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
if (!url || !key) console.warn('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local.');

export const supabase = createClient(url || 'https://example.supabase.co', key || 'sb_publishable_missing', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const apiUrl = (url || '').replace(/\/$/, '') + '/functions/v1/api';
const storageKey = 'fameloop_session_v1';
export function getSessionToken(): string | null { return sessionStorage.getItem(storageKey); }
export function setSessionToken(value: string): void { sessionStorage.setItem(storageKey, value); }
export function clearSessionToken(): void { sessionStorage.removeItem(storageKey); }

export async function callApi<T = any>(action: string, payload: Record<string, unknown> = {}, token = getSessionToken()): Promise<T> {
  if (!url || !key) throw new Error('FameLoop is not configured. Add your Supabase URL and publishable key.');
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: key, Authorization: 'Bearer ' + (token || key) },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Something went wrong. Please try again.');
  return body as T;
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
