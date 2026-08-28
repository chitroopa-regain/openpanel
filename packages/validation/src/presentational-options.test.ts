import { describe, expect, it } from 'vitest';
import {
  stripPresentationalOptions,
  stripPresentationalReportOptions,
} from './presentational-options';

describe('stripPresentationalOptions', () => {
  it('drops funnel keys the server never reads', () => {
    expect(
      stripPresentationalOptions({
        type: 'funnel',
        displayMode: 'both',
        topN: 10,
        hiddenBreakdowns: ['DE', 'FR'],
        funnelWindow: 24,
      }),
    ).toEqual({ type: 'funnel', funnelWindow: 24 });
  });

  it('🔴 KEEPS retention topN — the server uses it as a LIMIT', () => {
    // chart.ts: retentionOptions?.topN -> `LIMIT ${topN}`. Stripping this
    // would silently change which breakdown rows come back.
    expect(
      stripPresentationalOptions({
        type: 'retention',
        displayMode: 'chart',
        topN: 20,
      }),
    ).toEqual({ type: 'retention', topN: 20 });
  });

  it('returns the SAME object when there is nothing to strip', () => {
    const options = { type: 'funnel', funnelWindow: 24 };
    expect(stripPresentationalOptions(options)).toBe(options);
  });

  it('passes through non-objects untouched', () => {
    expect(stripPresentationalOptions(undefined)).toBeUndefined();
    expect(stripPresentationalOptions(null)).toBeNull();
  });
});

describe('query-key stability — the actual regression', () => {
  const base = {
    projectId: 'regain-app',
    range: '7d',
    series: [{ name: 'Application Installed' }],
    options: {
      type: 'funnel',
      displayMode: 'both',
      topN: 10,
      hiddenBreakdowns: [] as string[],
    },
  };

  it('hiding a breakdown does not change the query input', () => {
    // Before the fix these two produced different React Query keys AND
    // different Redis cache keys, so unchecking one country recomputed a
    // ~90s funnel to return byte-identical data.
    const before = stripPresentationalReportOptions(base);
    const after = stripPresentationalReportOptions({
      ...base,
      options: { ...base.options, hiddenBreakdowns: ['DE', 'FR', 'RO', 'NL'] },
    });
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('changing topN does not change the query input either', () => {
    const before = stripPresentationalReportOptions(base);
    const after = stripPresentationalReportOptions({
      ...base,
      options: { ...base.options, topN: 20 },
    });
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('a real query field still changes the input', () => {
    // Guard against over-stripping: the fix must not make the key blind to
    // things that genuinely alter the result.
    const before = stripPresentationalReportOptions(base);
    const after = stripPresentationalReportOptions({ ...base, range: '30d' });
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
  });
});

describe('editor-only top-level fields', () => {
  const base = {
    projectId: 'regain-app',
    options: { type: 'funnel', hiddenBreakdowns: [] as string[] },
  };

  it('the first edit flipping dirty does not change the query input', () => {
    // Observed on localhost AFTER the options fix: the first toggle still
    // refetched, because changeFunnelHiddenBreakdowns sets dirty = true and
    // dirty sits in the React Query key. The second toggle did not.
    const clean = stripPresentationalReportOptions({ ...base, dirty: false });
    const dirty = stripPresentationalReportOptions({
      ...base,
      dirty: true,
      options: { ...base.options, hiddenBreakdowns: ['GIFT_SCREEN'] },
    });
    expect(JSON.stringify(dirty)).toBe(JSON.stringify(clean));
  });

  it('keeps id / shareId — the server genuinely uses them', () => {
    const out = stripPresentationalReportOptions({
      ...base,
      id: 'report-1',
      shareId: 'share-1',
      dirty: true,
    }) as Record<string, unknown>;
    expect(out.id).toBe('report-1');
    expect(out.shareId).toBe('share-1');
    expect('dirty' in out).toBe(false);
  });
});
