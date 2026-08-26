import { describe, expect, it } from 'vitest';
import { getCohortBreakdownGroups, type CohortRow } from './table';

const row = (over: Partial<CohortRow> = {}): CohortRow =>
  ({
    cohort_interval: '2026-08-01',
    sum: 10,
    values: [10, 5],
    percentages: [1, 0.5],
    breakdowns: [],
    ...over,
  }) as CohortRow;

describe('retention grouping with custom-cohort buckets', () => {
  it('keys on (cohortId, membership), not on the label', () => {
    // Two DIFFERENT cohorts that share a name. Keying on what is displayed
    // would merge them into one grid and silently add their populations.
    const groups = getCohortBreakdownGroups([
      row({ cohortKey: 'a:in', cohortLabel: "In 'Power users'" }),
      row({ cohortKey: 'b:in', cohortLabel: "In 'Power users'" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.key)).toEqual(['a:in', 'b:in']);
  });

  it('keeps In and Not In of one cohort apart', () => {
    const groups = getCohortBreakdownGroups([
      row({ cohortKey: 'a:in', cohortLabel: "In 'X'" }),
      row({ cohortKey: 'a:not_in', cohortLabel: "Not In 'X'" }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["In 'X'", "Not In 'X'"]);
  });

  it('labels a bucket from its cohort label, not from empty breakdowns', () => {
    const [group] = getCohortBreakdownGroups([
      row({ cohortKey: 'a:in', cohortLabel: "In 'X'", breakdowns: [] }),
    ]);
    // Without this the bucket would render as "(not set)".
    expect(group!.label).toBe("In 'X'");
  });

  it('still groups property breakdowns the old way', () => {
    const groups = getCohortBreakdownGroups([
      row({ breakdowns: ['IN'] }),
      row({ breakdowns: ['US'] }),
      row({ breakdowns: ['IN'], cohort_interval: '2026-08-02' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.label).sort()).toEqual(['IN', 'US']);
  });
});
