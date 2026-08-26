import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The composition contract for the report-level cohort filter: ids within a row
 * are OR, rows AND together. Every query path (chart, aggregate, funnel,
 * retention, drill-down) goes through this one function, so these assertions
 * are what stop a path from inventing its own composition.
 */

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  getSettingsForProject: vi.fn(),
}));

vi.mock('../prisma-client', () => ({
  db: { customCohort: { findMany: mocks.findMany } },
}));
vi.mock('./organization.service', () => ({
  getSettingsForProject: mocks.getSettingsForProject,
}));
vi.mock('../clickhouse/client', () => ({
  TABLE_NAMES: { events: 'events', profiles: 'profiles' },
}));
vi.mock('./chart.service', () => ({
  getCustomEventWhereClause: vi.fn(),
  getEventFiltersWhereClause: vi.fn(() => []),
}));

const cohortRow = (id: string, name: string) => ({
  id,
  name,
  version: 1,
  projectId: 'p1',
  definition: {
    op: 'and',
    groups: [
      {
        op: 'and',
        criteria: [
          {
            kind: 'did',
            event: `${name}_event`,
            aggregate: { kind: 'total_events' },
            operator: 'gte',
            value: 1,
            window: { type: 'ever' },
            universe: 'all_identified',
            filters: [],
          },
        ],
      },
    ],
  },
});

describe('resolveCohortFilters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettingsForProject.mockResolvedValue({ timezone: 'UTC' });
    mocks.findMany.mockResolvedValue([
      cohortRow('a', 'A'),
      cohortRow('b', 'B'),
      cohortRow('c', 'C'),
    ]);
  });

  const resolve = async (rows: any) => {
    const { resolveCohortFilters } = await import('./custom-cohort.service');
    return resolveCohortFilters(rows, 'p1', '2026-08-26');
  };

  it('returns null for no rows, so "no filter" is never an empty predicate', async () => {
    expect((await resolve(undefined)).predicate(null)).toBeNull();
    expect((await resolve([])).predicate(null)).toBeNull();
    // A row with no ids is not a filter either — it must not become `()`.
    expect((await resolve([{ operator: 'in', cohortIds: [] }])).predicate(null)).toBeNull();
  });

  it('ORs ids inside one row', async () => {
    const sql = (await resolve([{ operator: 'in', cohortIds: ['a', 'b'] }])).predicate(
      null,
    )!;
    expect(sql).toContain(' OR ');
    expect(sql).not.toContain(' AND (');
  });

  it('ANDs rows together, each parenthesised', async () => {
    const sql = (
      await resolve([
        { operator: 'in', cohortIds: ['a'] },
        { operator: 'in', cohortIds: ['b'] },
      ])
    ).predicate(null)!;
    // Without the parens around each row, a row that is itself an OR group or a
    // negation would silently reassociate against the AND.
    expect(sql).toMatch(/^\(.*\) AND \(.*\)$/s);
  });

  it('negates a not_in row and keeps the empty-profile guard', async () => {
    const sql = (
      await resolve([{ operator: 'not_in', cohortIds: ['a'] }])
    ).predicate(null)!;
    expect(sql).toContain('NOT ');
    // The guard is what makes In/Not In a true partition: without it anonymous
    // rows sit inside the cohort on `in` AND outside it on `not_in`.
    expect(sql).toContain("profile_id != ''");
  });

  it('mixes polarities across rows', async () => {
    const sql = (
      await resolve([
        { operator: 'in', cohortIds: ['a'] },
        { operator: 'not_in', cohortIds: ['b', 'c'] },
      ])
    ).predicate(null)!;
    const [first, second] = sql.split(') AND (');
    expect(first).not.toContain('NOT ');
    expect(second).toContain('NOT ');
    expect(second).toContain(' OR ');
  });

  it('qualifies against the requested alias', async () => {
    const rows = [{ operator: 'in' as const, cohortIds: ['a'] }];
    expect((await resolve(rows)).predicate('e')!).toContain('e.profile_id');
    expect((await resolve(rows)).predicate(null)!).not.toContain('e.profile_id');
  });

  it('loads every referenced cohort in ONE query and reports the flat id union', async () => {
    const resolved = await resolve([
      { operator: 'in', cohortIds: ['a', 'b'] },
      { operator: 'not_in', cohortIds: ['b', 'c'] },
    ]);
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    // Deduped: `b` appears in both rows but is one cohort to own and reference.
    expect([...resolved.cohortIds].sort()).toEqual(['a', 'b', 'c']);
  });

  it('refuses an id from another project', async () => {
    mocks.findMany.mockResolvedValue([
      { ...cohortRow('a', 'A'), projectId: 'someone-else' },
    ]);
    await expect(
      resolve([{ operator: 'in', cohortIds: ['a'] }]),
    ).rejects.toThrow(/does not belong to this project/);
  });

  it('refuses an id that does not exist rather than filtering by nothing', async () => {
    mocks.findMany.mockResolvedValue([]);
    await expect(
      resolve([{ operator: 'in', cohortIds: ['ghost'] }]),
    ).rejects.toThrow(/not found/);
  });
});
