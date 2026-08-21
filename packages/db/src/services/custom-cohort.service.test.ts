import { describe, expect, it } from 'vitest';
import {
  collectCustomEventIds,
  compileCriterion,
  compileDefinition,
  resolveCohortWindow,
} from './custom-cohort.service';

const PROJECT = 'regain-app';
const TZ = 'Asia/Kolkata';
const AS_OF = '2026-08-20 12:00:00';

const criterion = (over: Partial<any> = {}): any => ({
  kind: 'did',
  event: 'FT: Session Completed',
  aggregate: { kind: 'total_events' },
  operator: 'gte',
  value: 1,
  window: { type: 'last', amount: 30, unit: 'day' },
  universe: 'all_identified',
  filters: [],
  ...over,
});

describe('resolveCohortWindow', () => {
  it('treats "last N days" as calendar days, inclusive of today', () => {
    const { start, end } = resolveCohortWindow(
      { type: 'last', amount: 30, unit: 'day' } as any,
      AS_OF,
      TZ,
    );
    expect(start).toContain('toStartOfDay');
    expect(start).toContain('INTERVAL 29 DAY');
    expect(end).toContain(AS_OF);
  });

  it('starts "last 1 month" at the first day of the current calendar month', () => {
    const { start } = resolveCohortWindow(
      { type: 'last', amount: 1, unit: 'month' } as any,
      AS_OF,
      TZ,
    );
    expect(start).toContain('toStartOfMonth');
    expect(start).toContain('subtractMonths');
    expect(start).toContain(', 0)');
  });

  it('starts weeks on Monday (mode 1)', () => {
    const { start } = resolveCohortWindow(
      { type: 'last', amount: 2, unit: 'week' } as any,
      AS_OF,
      TZ,
    );
    expect(start).toContain('toStartOfWeek');
    expect(start).toContain(', 1,');
  });

  it('uses a fixed window own end, not asOf', () => {
    const { start, end } = resolveCohortWindow(
      { type: 'fixed', start: '2026-08-01', end: '2026-08-10' } as any,
      AS_OF,
      TZ,
    );
    expect(start).toContain('2026-08-01');
    expect(end).toContain('2026-08-10');
    expect(end).not.toContain(AS_OF);
    // half-open: the user's end date is inclusive
    expect(end).toContain('INTERVAL 1 DAY');
  });

  it('gives an "ever" window no lower bound', () => {
    const { start } = resolveCohortWindow({ type: 'ever' } as any, AS_OF, TZ);
    expect(start).toBe('toDateTime(0)');
  });
});

describe('compileCriterion', () => {
  it('always reads events, never cohort_events_mv', () => {
    // cohort_events_mv never sums event_count and its coverage can lag the
    // source table, so using it would silently undercount. See the comment
    // block in custom-cohort.service.ts.
    for (const value of [1, 2, 50, 100]) {
      const sql = compileCriterion(
        criterion({ value }),
        PROJECT,
        AS_OF,
        TZ,
      );
      expect(sql).toContain('FROM events');
      expect(sql).not.toContain('cohort_events_mv');
    }
  });

  it('scopes to identified profiles', () => {
    const sql = compileCriterion(criterion(), PROJECT, AS_OF, TZ);
    expect(sql).toContain('profile_id != device_id');
  });

  it('emits the threshold as a HAVING on the aggregate', () => {
    const sql = compileCriterion(criterion({ value: 5 }), PROJECT, AS_OF, TZ);
    expect(sql).toContain('HAVING count() >= 5');
  });

  it('counts distinct days when asked', () => {
    const sql = compileCriterion(
      criterion({ aggregate: { kind: 'distinct_days' }, value: 3 }),
      PROJECT,
      AS_OF,
      TZ,
    );
    expect(sql).toContain('uniqExact(toDate(created_at)) >= 3');
  });

  it('compiles did_not as an anti-join against a universe, not NOT IN', () => {
    const sql = compileCriterion(
      criterion({ kind: 'did_not', value: 5 }),
      PROJECT,
      AS_OF,
      TZ,
    );
    // ANTI JOIN, not a sentinel comparison: `WHERE m.profile_id = ''` would
    // silently return an empty cohort under join_use_nulls = 1.
    expect(sql).toContain('LEFT ANTI JOIN');
    expect(sql).not.toContain('NOT IN');
    expect(sql).not.toContain("m.profile_id = ''");
    // did_not(>=5) subtracts those who DID >=5 — so 0..4 occurrences match.
    expect(sql).toContain('HAVING count() >= 5');
  });

  it('defaults the did_not universe to all identified profiles', () => {
    const sql = compileCriterion(
      criterion({ kind: 'did_not' }),
      PROJECT,
      AS_OF,
      TZ,
    );
    expect(sql).toContain('FROM profiles');
  });

  it('can restrict the did_not universe to users active in the window', () => {
    const sql = compileCriterion(
      criterion({ kind: 'did_not', universe: 'active_in_window' }),
      PROJECT,
      AS_OF,
      TZ,
    );
    expect(sql).not.toContain('FROM profiles');
    expect(sql).toContain('FROM events');
  });

  it('escapes the event name', () => {
    const sql = compileCriterion(
      criterion({ event: "it's an event" }),
      PROJECT,
      AS_OF,
      TZ,
    );
    expect(sql).toContain("\\'");
  });

  it('throws rather than silently matching nothing when a custom event is missing', () => {
    expect(() =>
      compileCriterion(
        criterion({ event: { customEventId: 'missing-id' } }),
        PROJECT,
        AS_OF,
        TZ,
      ),
    ).toThrow(/was not found/);
  });
});

describe('compileDefinition', () => {
  it('returns one set per criterion for an AND group', () => {
    const sets = compileDefinition(
      {
        op: 'and',
        groups: [
          { op: 'and', criteria: [criterion(), criterion({ event: 'B' })] },
        ],
      } as any,
      PROJECT,
      AS_OF,
      TZ,
    );
    expect(sets).toHaveLength(2);
  });

  it('unions an OR group into a single deduped set', () => {
    const sets = compileDefinition(
      {
        op: 'and',
        groups: [
          { op: 'or', criteria: [criterion(), criterion({ event: 'B' })] },
        ],
      } as any,
      PROJECT,
      AS_OF,
      TZ,
    );
    expect(sets).toHaveLength(1);
    expect(sets[0]).toContain('UNION ALL');
    expect(sets[0]).toContain('GROUP BY profile_id');
  });
});

describe('collectCustomEventIds', () => {
  it('finds every referenced custom event across groups', () => {
    const ids = collectCustomEventIds({
      op: 'and',
      groups: [
        { op: 'and', criteria: [criterion({ event: { customEventId: 'a' } })] },
        {
          op: 'and',
          criteria: [
            criterion({ event: { customEventId: 'b' } }),
            criterion({ event: 'plain' }),
          ],
        },
      ],
    } as any);
    expect(ids.sort()).toEqual(['a', 'b']);
  });
});
