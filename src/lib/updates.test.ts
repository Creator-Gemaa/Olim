import { describe, expect, it } from 'vitest';
import { compareVersions } from './updates';

describe('compareVersions', () => {
  it('detects a newer patch release', () => {
    expect(compareVersions('1.0.5', '1.0.6')).toBe(-1);
  });

  it('detects a newer major or minor release', () => {
    expect(compareVersions('1.9.9', '2.0.0')).toBe(-1);
    expect(compareVersions('1.0.9', '1.1.0')).toBe(-1);
  });

  it('treats equal versions as current', () => {
    expect(compareVersions('1.0.6', '1.0.6')).toBe(0);
  });

  it('orders a stable release after its prerelease', () => {
    expect(compareVersions('1.0.6-beta.1', '1.0.6')).toBe(-1);
    expect(compareVersions('1.0.6', '1.0.6-beta.1')).toBe(1);
  });
});
