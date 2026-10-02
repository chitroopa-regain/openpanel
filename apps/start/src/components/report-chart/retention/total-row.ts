import type { CohortRow } from './table';

const AVERAGE_ROW = 'Weighted Average';
export const TOTAL_ROW = 'Total';

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The "Total" row shown above "Weighted Average" when acquisition cost is on:
 * plain sums over every row in the range, so long ranges add up to the
 * business totals (e.g. all Play installs since launch).
 *
 * - Play installs, Spend, Revenue, Total profiles: sums.
 * - CPI: total spend / the installs each row's own CPI uses (Play installs on
 *   rows before tracking, cohort size after).
 * - Lifetime ROAS: total revenue / total spend.
 * - D0/D7/D30 and the day columns are not additive: left blank.
 */
export function buildTotalRow(data: CohortRow[]): CohortRow | null {
  const rows = data.filter((r) => r.cohort_interval !== AVERAGE_ROW);
  if (!rows.some((r) => r.spend !== undefined && r.spend !== null)) {
    return null;
  }
  let spend = 0;
  let size = 0;
  let cpiInstalls = 0;
  let play = 0;
  let hasPlay = false;
  let revenue = 0;
  let hasRevenue = false;
  for (const r of rows) {
    spend += r.spend ?? 0;
    size += Number(r.sum) || 0;
    cpiInstalls +=
      r.installsSource === 'play'
        ? (r.externalInstalls ?? 0)
        : Number(r.sum) || 0;
    if (r.playInstalls !== null && r.playInstalls !== undefined) {
      play += r.playInstalls;
      hasPlay = true;
    }
    if (r.lifetimeRevenue !== null && r.lifetimeRevenue !== undefined) {
      revenue += r.lifetimeRevenue;
      hasRevenue = true;
    }
  }
  const width = rows[0]?.values.length ?? 0;
  const blanks = Array.from({ length: width }, () => null);
  return {
    cohort_interval: TOTAL_ROW,
    breakdowns: [],
    sum: size,
    values: blanks,
    percentages: blanks,
    spend: round2(spend),
    cpi: cpiInstalls > 0 ? round2(spend / cpiInstalls) : null,
    playInstalls: hasPlay ? play : null,
    lifetimeRevenue: hasRevenue ? round2(revenue) : null,
    revenueBasis: 'total',
    roas: {
      d0: null,
      d7: null,
      d30: null,
      lifetime:
        hasRevenue && spend > 0
          ? Math.round((revenue / spend) * 1000) / 1000
          : null,
    },
  } as CohortRow;
}
