import { describe, expect, it } from 'vitest';
import { acceptedMediaType, classifyVideo, generateVideoCopy, maxBytesFor } from './media';

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

describe('VYRA generated video copy', () => {
  it('turns a readable filename into an editable title and metadata description', () => {
    const file = new File(['video'], 'ocean_sunset.mp4', { type: 'video/mp4' });
    const copy = generateVideoCopy(file, 83);
    expect(copy.title).toBe('Ocean Sunset');
    expect(copy.description).toContain('1m 23s');
    expect(copy.description).toContain('ocean_sunset.mp4');
  });
  it('uses a safe fallback for camera timestamps', () => {
    const file = new File(['video'], 'VID_20261031_123456.mp4', { type: 'video/mp4' });
    expect(generateVideoCopy(file, 12).title).toBe('Video Moment');
  });
});
