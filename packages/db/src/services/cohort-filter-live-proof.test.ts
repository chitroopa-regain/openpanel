import { describe, expect, it } from 'vitest';
import { chQuery } from '../clickhouse/client';
import { db } from '../prisma-client';
import {
  cohortBucketLabel,
  cohortBucketPredicate,
  loadCohorts,
  resolveCohortFilters,
} from './custom-cohort.service';

/**
 * LIVE proof against the real Postgres + ClickHouse in the local stack. Not a
 * unit test: it exists because the `did_not` sentinel bug in v1 produced 0
 * instead of 1157 and passed every mocked test. A negation is exactly the kind
 * of SQL that looks right and returns nothing.
 *
 * It FAILS rather than skips when the stack or fixtures are missing: a proof
 * that reports success without running is worse than no proof. An earlier
 * revision of this file did exactly that — it silently found zero cohorts
 * (wrong projectId) and printed a green tick.
 */

// The UUID in the dashboard URL is the ORGANISATION id; the project id is the
// second path segment. Getting this wrong made the proof find zero cohorts.
const PROJECT_ID = 'regain-app';
const ASOF = '2026-08-25';

async function reachable() {
  try {
    await chQuery('SELECT 1');
    await db.customCohort.count();
    return true;
  } catch {
    return false;
  }
}

describe('cohort filter — live SQL proof', () => {
  it('in / not_in partition the rows exactly, and neither is trivially empty', async () => {
    // Never pass by default: an unrunnable proof must be visibly skipped or fail.
    if (!(await reachable())) {
      throw new Error(
        'LIVE PROOF COULD NOT RUN: local Postgres/ClickHouse unreachable. ' +
          'Start the local stack, or delete this test — do not let it pass silently.',
      );
    }
    const cohort = await db.customCohort.findFirst({
      where: { projectId: PROJECT_ID },
      orderBy: { createdAt: 'asc' },
    });
    if (!cohort) {
      throw new Error(
        `LIVE PROOF COULD NOT RUN: no custom cohorts for project '${PROJECT_ID}'. ` +
          'Seed one first — an empty fixture must not report success.',
      );
    }

    const inF = await resolveCohortFilters(
      [{ operator: 'in', cohortIds: [cohort.id] }],
      PROJECT_ID,
      ASOF,
    );
    const notF = await resolveCohortFilters(
      [{ operator: 'not_in', cohortIds: [cohort.id] }],
      PROJECT_ID,
      ASOF,
    );

    const inPred = inF.predicate(null)!;
    const notPred = notF.predicate(null)!;
    expect(inPred).toBeTruthy();
    expect(notPred.includes('NOT ')).toBe(true);

    const base = `FROM events WHERE project_id = '${PROJECT_ID}'`;
    const [tot] = await chQuery<{ c: string }>(`SELECT count() AS c ${base}`);
    const [inn] = await chQuery<{ c: string }>(
      `SELECT count() AS c ${base} AND (${inPred})`,
    );
    const [notn] = await chQuery<{ c: string }>(
      `SELECT count() AS c ${base} AND (${notPred})`,
    );

    const total = Number(tot!.c);
    const inCount = Number(inn!.c);
    const notCount = Number(notn!.c);

    // The partition identity for an additive metric (event count).
    expect(inCount + notCount).toBe(total);

    // Guard against the failure mode that makes the identity pass vacuously:
    // a negation that matches nothing still satisfies 0 + total === total.
    expect(inCount).toBeGreaterThan(0);
    expect(notCount).toBeGreaterThan(0);

    console.log(
      `[live proof] cohort="${cohort.name}" in=${inCount} not_in=${notCount} total=${total}`,
    );
  }, 60_000);

  it('OR-combines multiple cohorts, widening rather than narrowing', async () => {
    if (!(await reachable())) {
      throw new Error('LIVE PROOF COULD NOT RUN: local stack unreachable.');
    }
    const cohorts = await db.customCohort.findMany({
      where: { projectId: PROJECT_ID },
      orderBy: { createdAt: 'asc' },
      take: 2,
    });
    if (cohorts.length < 2) {
      throw new Error(
        'LIVE PROOF COULD NOT RUN: need 2 cohorts to prove OR widening.',
      );
    }
    const base = `FROM events WHERE project_id = '${PROJECT_ID}'`;
    const count = async (pred: string) =>
      Number(
        (await chQuery<{ c: string }>(`SELECT count() AS c ${base} AND (${pred})`))[0]!
          .c,
      );

    const a = await resolveCohortFilters(
      [{ operator: 'in', cohortIds: [cohorts[0]!.id] }],
      PROJECT_ID,
      ASOF,
    );
    const b = await resolveCohortFilters(
      [{ operator: 'in', cohortIds: [cohorts[1]!.id] }],
      PROJECT_ID,
      ASOF,
    );
    const both = await resolveCohortFilters(
      [{ operator: 'in', cohortIds: [cohorts[0]!.id, cohorts[1]!.id] }],
      PROJECT_ID,
      ASOF,
    );

    const [ca, cb, cboth] = [
      await count(a.predicate(null)!),
      await count(b.predicate(null)!),
      await count(both.predicate(null)!),
    ];

    // Union: at least as large as either side, never larger than their sum.
    expect(cboth).toBeGreaterThanOrEqual(Math.max(ca, cb));
    expect(cboth).toBeLessThanOrEqual(ca + cb);
    console.log(`[live proof] A=${ca} B=${cb} A_OR_B=${cboth} (sum=${ca + cb})`);
  }, 60_000);
});

describe('breakdown buckets — live partition proof', () => {
  it('In + Not In partitions rows exactly, per metric class', async () => {
    if (!(await reachable())) {
      throw new Error('LIVE PROOF COULD NOT RUN: local stack unreachable.');
    }
    const cohort = await db.customCohort.findFirst({
      where: { projectId: PROJECT_ID },
      orderBy: { createdAt: 'asc' },
    });
    if (!cohort) throw new Error('LIVE PROOF COULD NOT RUN: no cohorts seeded.');

    const resolved = await loadCohorts([cohort.id], PROJECT_ID, ASOF);
    const compiled = resolved.cohorts[0]!;
    const inPred = cohortBucketPredicate(compiled, 'in', null);
    const notPred = cohortBucketPredicate(compiled, 'not_in', null);

    expect(cohortBucketLabel(cohort.name, 'in')).toBe(`In '${cohort.name}'`);
    expect(cohortBucketLabel(cohort.name, 'not_in')).toBe(`Not In '${cohort.name}'`);

    const base = `FROM events WHERE project_id = '${PROJECT_ID}'`;
    const agg = async (expr: string, pred?: string) =>
      Number(
        (
          await chQuery<{ v: string }>(
            `SELECT ${expr} AS v ${base}${pred ? ` AND (${pred})` : ''}`,
          )
        )[0]!.v,
      );

    // EXACT for additive metrics: event count and exact distinct profiles.
    // countDistinct, not uniq: uniq is HyperLogLog and an exact assertion
    // against an approximate counter fails on correct code.
    for (const expr of ['count()', 'countDistinct(profile_id)']) {
      const [t, i, n] = [
        await agg(expr),
        await agg(expr, inPred),
        await agg(expr, notPred),
      ];
      expect(i + n).toBe(t);
      expect(i).toBeGreaterThan(0);
      expect(n).toBeGreaterThan(0);
      console.log(`[bucket proof] ${expr}: in=${i} + not_in=${n} = ${t}`);
    }

    // NOT additive: distinct sessions. A session whose events straddle both
    // buckets is counted twice, so the identity carries the overlap term.
    const sTot = await agg('countDistinct(session_id)');
    const sIn = await agg('countDistinct(session_id)', inPred);
    const sNot = await agg('countDistinct(session_id)', notPred);
    const overlap = Number(
      (
        await chQuery<{ v: string }>(`
          SELECT countDistinct(session_id) AS v FROM (
            SELECT session_id FROM events
            WHERE project_id = '${PROJECT_ID}' AND (${inPred})
            INTERSECT
            SELECT session_id FROM events
            WHERE project_id = '${PROJECT_ID}' AND (${notPred})
          )`)
      )[0]!.v,
    );
    expect(sIn + sNot).toBe(sTot + overlap);
    console.log(
      `[bucket proof] sessions: in=${sIn} + not_in=${sNot} = total=${sTot} + overlap=${overlap}`,
    );
  }, 120_000);
});
