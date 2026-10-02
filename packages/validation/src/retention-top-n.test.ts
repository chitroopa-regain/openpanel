import { describe, expect, it } from 'vitest';
import { MAX_RETENTION_TOP_N, zRetentionOptions } from './index';

describe('retention topN', () => {
  it('clamps saved values above the cap instead of rejecting the report', () => {
    // "C70 All combinations: ARPU by cell" was saved with topN 200 and failed
    // validation on every load.
    expect(
      zRetentionOptions.parse({ type: 'retention', topN: 200 }).topN
    ).toBe(MAX_RETENTION_TOP_N);
  });

  it('keeps values within the cap', () => {
    expect(zRetentionOptions.parse({ type: 'retention', topN: 64 }).topN).toBe(
      64
    );
  });
});
