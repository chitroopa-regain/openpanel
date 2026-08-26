import { describe, expect, it } from 'vitest';
import { hasRenderableRetention } from './has-renderable-retention';

const row = { cohort_interval: '2026-08-01' };

describe('hasRenderableRetention', () => {
  it('renders when the FIRST bucket is empty but a later one is not', () => {
    // The regression: `In 'X'` matching nobody used to blank the whole report,
    // hiding a populated `Not In 'X'` — and the all-zero synthesis written for
    // this case never ran, because the empty check short-circuited above it.
    expect(
      hasRenderableRetention({
        data: [],
        buckets: [{ data: [] }, { data: [row] }],
      }),
    ).toBe(true);
  });

  it('renders when only the first bucket has rows', () => {
    expect(
      hasRenderableRetention({
        data: [],
        buckets: [{ data: [row] }, { data: [] }],
      }),
    ).toBe(true);
  });

  it('is empty only when every bucket is empty', () => {
    expect(
      hasRenderableRetention({ data: [], buckets: [{ data: [] }, { data: [] }] }),
    ).toBe(false);
  });

  it('falls back to data when there is no breakdown', () => {
    expect(hasRenderableRetention({ data: [row] })).toBe(true);
    expect(hasRenderableRetention({ data: [] })).toBe(false);
    // An empty buckets array is not a breakdown, so `data` still decides.
    expect(hasRenderableRetention({ data: [row], buckets: [] })).toBe(true);
  });
});
