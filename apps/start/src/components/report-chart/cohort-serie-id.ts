/**
 * A cohort-bucket series is identified by `${cohortId}:${membership}` — the
 * shape the server stamps on each bucket. The label is NOT identity: two custom
 * cohorts can share a name, and `In 'X'` / `Not In 'X'` must never merge.
 *
 * Parsing it back is what lets a drill-down re-apply the exact bucket that was
 * clicked instead of listing the whole funnel.
 */
/**
 * Keys are named exactly as the drill-down contract names them, so call sites
 * can spread this straight into a modal payload. An earlier version returned
 * `membership`, which spread into a payload expecting `cohortMembership`: the
 * polarity was silently dropped, the server defaulted to `in`, and a
 * `Not In 'X'` drill-down listed the members of X.
 */
export type CohortSerieIdentity = {
  cohortId: string;
  cohortMembership: 'in' | 'not_in';
};

export function parseCohortSerieId(
  id: string | undefined | null,
): CohortSerieIdentity | null {
  if (!id) return null;
  // Split from the RIGHT: only the membership suffix is fixed, and an id is
  // free to contain colons.
  const separator = id.lastIndexOf(':');
  if (separator <= 0) return null;
  const cohortId = id.slice(0, separator);
  const membership = id.slice(separator + 1);
  if (membership !== 'in' && membership !== 'not_in') return null;
  return { cohortId, cohortMembership: membership };
}
