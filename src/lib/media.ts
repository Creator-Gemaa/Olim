export type MediaKind = 'reel' | 'video';

export function classifyVideo(durationSeconds: number): MediaKind {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) throw new Error('Video duration must be a non-negative number.');
  return durationSeconds <= 120 ? 'reel' : 'video';
}
export function acceptedMediaType(type: string): boolean {
  return ['image/jpeg','image/png','image/webp','video/mp4','video/webm','audio/mpeg','audio/mp4'].includes(type);
}
export function maxBytesFor(type: string): number {
  if (type.startsWith('image/')) return 12 * 1024 * 1024;
  if (type.startsWith('audio/')) return 25 * 1024 * 1024;
  if (type.startsWith('video/')) return 100 * 1024 * 1024;
  return 0;
}
export async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function videoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const duration = video.duration; URL.revokeObjectURL(url);
      if (!Number.isFinite(duration)) reject(new Error('Could not read video duration.')); else resolve(duration);
    };
    video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This video could not be read.')); };
    video.src = url;
  });
}
