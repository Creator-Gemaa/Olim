import { describe, expect, it } from 'vitest';
import { acceptedMediaType, classifyVideo, maxBytesFor } from './media';

describe('video categorization', () => {
  it('keeps a two-minute video in Reels', () => expect(classifyVideo(120)).toBe('reel'));
  it('moves longer videos to Videos', () => expect(classifyVideo(120.01)).toBe('video'));
  it('rejects invalid duration', () => expect(() => classifyVideo(Number.NaN)).toThrow());
});
describe('media validation', () => {
  it('accepts supported video and image types only', () => {
    expect(acceptedMediaType('video/mp4')).toBe(true);
    expect(acceptedMediaType('image/webp')).toBe(true);
    expect(acceptedMediaType('application/x-msdownload')).toBe(false);
  });
  it('enforces bounded upload sizes', () => {
    expect(maxBytesFor('video/mp4')).toBe(50 * 1024 * 1024);
    expect(maxBytesFor('image/png')).toBe(12 * 1024 * 1024);
    expect(maxBytesFor('text/plain')).toBe(0);
  });
});
