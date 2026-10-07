export interface CellCoverage {
  eligible: number;
  total: number;
}

/** Coverage counts observed cohort days, not synthetic zero/gap-fill rows. */
export function describePartialCoverage(
  coverage: CellCoverage | undefined,
  cohortInterval?: string,
  displayInterval?: string
): string | undefined {
  if (
    !coverage ||
    coverage.eligible <= 0 ||
    coverage.eligible >= coverage.total
  ) {
    return undefined;
  }
  const month =
    displayInterval === 'month' &&
    /^\d{4}-\d{2}-\d{2}$/.test(cohortInterval ?? '')
      ? new Intl.DateTimeFormat('en', {
          month: 'long',
          timeZone: 'UTC',
        }).format(new Date(`${cohortInterval}T00:00:00Z`))
      : undefined;
  return `Based on ${coverage.eligible} of ${coverage.total} ${month ? `${month} ` : ''}cohort days. Only completed windows contribute; their matching denominators are used.`;
}
