/**
 * A token that changes whenever ANY custom cohort or custom event definition
 * changes. Report caches mix it into their key so an edited cohort cannot keep
 * serving membership computed from the previous definition.
 *
 * DERIVED from the source of truth, not published by mutation handlers. That
 * removes the failure modes of an increment-and-publish design: a missed or
 * lost increment leaving caches stale indefinitely, and any write that bypasses
 * the mutation path (bulk edit, admin script, a future endpoint that forgets to
 * bump) silently skipping invalidation. Row counts are part of the token
 * because a DELETE does not raise max(updatedAt).
 *
 * Memoised IN-PROCESS rather than in Redis, deliberately. A shared Redis entry
 * introduces a poisoning race: a reader can load the pre-mutation state, the
 * mutation can commit and clear the key, and that reader can then write the
 * STALE token back with a fresh TTL. An in-process memo cannot be poisoned by
 * another process, needs no invalidation message, and bounds staleness at
 * MEMO_TTL_MS per process. The cost is one small aggregate query per process
 * per window, against two tables that hold tens of rows.
 */
/**
 * Deliberately short. The memo exists to collapse the burst of parallel
 * requests a multi-widget dashboard fires within a few hundred milliseconds of
 * each other — without it, a 20-widget board would issue 20 Postgres round
 * trips per render instead of 1. It is NOT a caching layer.
 *
 * ACCEPTED RESIDUAL RISK, stated rather than implied: a mutation handled by
 * another process (or racing a read in this one) can be invisible here for up
 * to this window, so an audience-bearing report can serve the previous
 * membership for that long. 250ms is below human perception for a reload and
 * far below the 30s revalidation window live reports already use.
 */
const MEMO_TTL_MS = 250;

let memo: { value: string; expiresAt: number } | null = null;

export async function getAudienceEpoch(): Promise<string> {
  const now = Date.now();
  if (memo && memo.expiresAt > now) {
    return memo.value;
  }

  const { db } = await import('../prisma-client');

  // A CONTENT digest over the definitions themselves — not timestamps, not
  // counts.
  //
  // Timestamp-based tokens keep failing on granularity: max(updatedAt)+counts
  // collided when two rows were edited in the same millisecond, and per-row
  // (id, updatedAt) still collides when the SAME row is edited twice within one
  // tick (custom_events has no version column to break the tie). Hashing the
  // actual definition sidesteps the entire class: identical content yields an
  // identical token (correct — nothing changed), and any change to a name,
  // a definition, or the set of rows yields a different one, regardless of how
  // fast the edits landed or what clock resolution Postgres has.
  //
  // Cost is an md5 over a few rows of JSON on tables that hold tens of rows.
  const [row] = await db.$queryRaw<{ digest: string }[]>`
    SELECT md5(coalesce(string_agg(t, ',' ORDER BY t), '')) AS digest
    FROM (
      SELECT id::text || ':' || name || ':' || definition::text AS t
      FROM custom_cohorts
      UNION ALL
      SELECT id::text || ':' || name || ':' || components::text AS t
      FROM custom_events
    ) x(t)
  `;
  const value = row?.digest ?? 'unknown';

  memo = { value, expiresAt: now + MEMO_TTL_MS };
  return value;
}

/**
 * Drop this process's memo so the next read recomputes immediately. Called
 * after a mutation purely to shorten the window on the process that handled it;
 * correctness does not depend on it, which is the point of deriving the value.
 */
export function invalidateAudienceEpoch(): void {
  memo = null;
}

/** Test seam. */
export function __resetAudienceEpochMemo(): void {
  memo = null;
}
