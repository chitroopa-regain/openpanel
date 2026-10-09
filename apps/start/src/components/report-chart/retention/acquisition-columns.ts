import type { IAcquisitionColumn } from '@openpanel/validation';

export type RoasWindow = 'd0' | 'd7' | 'd30' | 'lifetime';

export interface AcquisitionColumn {
  key: IAcquisitionColumn;
  label: string;
  title: string;
  roas?: RoasWindow;
  /** Needs store-reported revenue rows (app_store_daily_revenue). */
  store?: boolean;
  /** Days of range the report needs before this window can have values. */
  minDay?: number;
}

export const ACQUISITION_COLUMNS: AcquisitionColumn[] = [
  {
    key: 'play_installs',
    label: 'Play installs',
    title:
      'Google Play Console installs in the period (all sources; Play publishes ~10 days late)',
  },
  {
    key: 'spend',
    label: 'Spend',
    title: 'Paid ad spend matched to this cohort (INR)',
  },
  {
    key: 'cpi',
    label: 'CPI',
    title: 'Cost per install = spend / cohort size',
  },
  {
    key: 'revenue',
    label: 'Revenue',
    title:
      "Cohort lifetime revenue; before install tracking, revenue booked in the period ('booked')",
  },
  {
    key: 'store_revenue',
    label: 'Store revenue',
    title:
      "Store revenue booked in the period, from the store's own report (Apple Sales & Trends; last ~2 days are RevenueCat estimates, marked ~). Not install-cohort revenue",
    store: true,
  },
  {
    key: 'roas_d0',
    label: 'D0 ROAS',
    title: 'Revenue on the install day (the "< 1 Day" column) / spend',
    roas: 'd0',
    minDay: 0,
  },
  {
    key: 'roas_d7',
    label: 'D7 ROAS',
    title: 'Revenue through day 7 / spend. Shown once day 7 has fully passed',
    roas: 'd7',
    minDay: 7,
  },
  {
    key: 'roas_d30',
    label: 'D30 ROAS',
    title:
      'Revenue through day 30 / spend. Needs a report range of at least 31 days',
    roas: 'd30',
    minDay: 30,
  },
  {
    key: 'roas_lifetime',
    label: 'Lifetime ROAS',
    title: 'Everything the cohort has paid so far / spend',
    roas: 'lifetime',
  },
  {
    key: 'store_roas',
    label: 'Store ROAS',
    title:
      'Store revenue in the period / matched paid spend in the period (blended, same spend as the Spend column)',
    store: true,
  },
];

export const ALL_ACQUISITION_COLUMN_KEYS = ACQUISITION_COLUMNS.map(
  (c) => c.key
);

/**
 * Columns this result can fill. ROAS needs a revenue property measure; store
 * columns need the project to have store-reported revenue.
 */
export function availableAcquisitionColumns(
  roasAvailable: boolean,
  storeRevenueAvailable = false
) {
  return ACQUISITION_COLUMNS.filter(
    (c) => (roasAvailable || !c.roas) && (storeRevenueAvailable || !c.store)
  );
}

/** Ticked columns in display order; undefined = every column. */
export function resolveAcquisitionColumns(
  selected: IAcquisitionColumn[] | undefined,
  roasAvailable: boolean,
  storeRevenueAvailable = false
) {
  const ticked = new Set(selected ?? ALL_ACQUISITION_COLUMN_KEYS);
  return availableAcquisitionColumns(
    roasAvailable,
    storeRevenueAvailable
  ).filter((c) =>
    ticked.has(c.key)
  );
}

export function formatRoas(value: number | null | undefined) {
  return value === null || value === undefined ? '—' : `${value.toFixed(2)}x`;
}
