import { describe, expect, it } from 'vitest';
import { formatCacheAge } from './report-cache-status';

describe('formatCacheAge', () => {
  const now = new Date('2026-06-04T10:00:00Z').getTime();

  it('shows a compact minute age for stale cached data', () => {
    expect(formatCacheAge(now - 5 * 60 * 1000, now)).toBe('5m ago');
  });

  it('shows a compact hour age for older cached data', () => {
    expect(formatCacheAge(now - 2 * 60 * 60 * 1000, now)).toBe('2h ago');
  });

  it('clamps future server timestamps to now', () => {
    expect(formatCacheAge(now + 60 * 1000, now)).toBe('now');
  });
});
