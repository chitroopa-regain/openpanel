import sqlstring from 'sqlstring';

/**
 * Acquisition cost (Spend / CPI) beside retention cohorts.
 *
 * Spend lives in `ad_spend_campaign_daily` (one row per ad-platform campaign
 * per account-local day, written hourly by the Regain marketing sync). A
 * cohort row is matched to spend through its breakdown:
 *
 * - no attribution breakdown: blended — every cohort carries the date's TOTAL
 *   paid spend, shared pro-rata by cohort size when there are several rows
 *   (so each row reads the blended CPI);
 * - a source breakdown (`install_source`, `utm_source`, …): the row's value is
 *   mapped to a platform (google_ads / meta_ads / apple_ads); organic and
 *   other unpaid sources carry no spend;
 * - a campaign breakdown (`fb_campaign_group_id`, `gad_campaignid`,
 *   `fb_campaign_group_name`, …): matched to the campaign's spend by id. Names
 *   are resolved to ids first, because Meta campaigns get renamed and the
 *   install-time name no longer equals the name the spend is stored under.
 *
 * Rows that share one spend key in one interval (e.g. `instagram` and
 * `facebook` both map to Meta) split that spend pro-rata by cohort size.
 */

export const AD_SPEND_TABLE = 'ad_spend_campaign_daily';

/**
 * First cohort day each platform's installs can be told apart by source or
 * campaign. Before it, matched rows read "—" instead of piling the platform's
 * whole spend onto the handful of installs that happened to be labelled.
 * Regain: Meta's install referrer only decodes to instagram/facebook +
 * fb_campaign_* at scale from 2026-09-06 (120-400 labelled installs a week
 * against Rs 1-2.4 lakh of Meta Android spend before it).
 */
export const ATTRIBUTION_COVERAGE_FROM: Record<
  string,
  Partial<Record<string, string>>
> = {
  'regain-app': { meta_ads: '2026-09-06' },
};

/** Platform-level spend on a cohort can only come from these. */
export const PAID_PLATFORMS = ['google_ads', 'meta_ads', 'apple_ads'] as const;

const CAMPAIGN_ID_KEYS = new Set([
  'fb_campaign_group_id',
  'gad_campaignid',
  'install_referrer_gad_campaignid',
  'campaign_id',
]);
const CAMPAIGN_NAME_KEYS = new Set(['fb_campaign_group_name', 'campaign_name']);
const SOURCE_KEYS = new Set([
  'install_source',
  'first_install_source',
  'utm_source',
  'install_referrer_utm_source',
  'platform',
]);

export type AttributionKind = 'source' | 'campaign_id' | 'campaign_name';

export interface AttributionBreakdown {
  index: number;
  kind: AttributionKind;
  key: string;
}

export interface SpendRow {
  /** Account-local spend day, `YYYY-MM-DD`. */
  day: string;
  platform: string;
  campaign_id: string;
  campaign_name: string;
  spend_inr: number;
  /** Device OS the campaign buys installs on: Apple Ads or `iOS` in the name = ios. */
  os: 'ios' | 'android';
}

export type AcquisitionCostMode = 'blended' | AttributionKind;

export interface AcquisitionCostSummary {
  mode: AcquisitionCostMode;
  /** The breakdown the spend was matched on, e.g. `properties.install_source`. */
  breakdown: string | null;
  /** Paid spend in the report's date range. */
  totalSpend: number;
  /** The part of it assigned to rows on screen. */
  attributedSpend: number;
  currency: 'INR';
  /** ROAS needs a revenue property measure (property_sum / property_average). */
  roasAvailable: boolean;
  /** Days of return window the range covers; D7/D30 need at least 7/30. */
  roasMaxDay: number;
  /** Matched modes only: platform → first attributable cohort day. */
  coverageFrom: Partial<Record<string, string>>;
}

const PROFILE_PROPERTIES_PREFIX = /^profile\.properties\./;
const PROPERTIES_PREFIX = /^properties\./;

/** `properties.x` / `profile.properties.x` / `x` → `x`. */
export function getBreakdownKey(name: string) {
  return name
    .replace(PROFILE_PROPERTIES_PREFIX, '')
    .replace(PROPERTIES_PREFIX, '');
}

function attributionKindOf(key: string): AttributionKind | null {
  if (CAMPAIGN_ID_KEYS.has(key)) {
    return 'campaign_id';
  }
  if (CAMPAIGN_NAME_KEYS.has(key)) {
    return 'campaign_name';
  }
  return SOURCE_KEYS.has(key) ? 'source' : null;
}

/**
 * The breakdown spend is matched on. Campaign beats source (it is the finer
 * grain); among equals the first one wins. `null` = no attribution breakdown,
 * so spend is blended.
 */
export function findAttributionBreakdown(
  breakdownNames: string[]
): AttributionBreakdown | null {
  const candidates = breakdownNames.map((name, index) => {
    const key = getBreakdownKey(name);
    const kind = attributionKindOf(key);
    return kind ? { index, kind, key } : null;
  });
  const rank: Record<AttributionKind, number> = {
    campaign_id: 0,
    campaign_name: 1,
    source: 2,
  };
  return (
    candidates
      .filter((c): c is AttributionBreakdown => c !== null)
      .sort((a, b) => rank[a.kind] - rank[b.kind] || a.index - b.index)[0] ??
    null
  );
}

/** An install-source / utm_source value → the ad platform that paid for it. */
export function sourceValueToPlatform(value: string | null | undefined) {
  const v = (value ?? '').trim().toLowerCase();
  if (!v) {
    return null;
  }
  if (v === 'google_ads' || v === 'google-ads' || v === 'googleads') {
    return 'google_ads';
  }
  if (
    v === 'instagram' ||
    v === 'facebook' ||
    v === 'meta' ||
    v === 'meta_ads' ||
    v === 'meta-ads' ||
    v === 'apps.instagram.com' ||
    v === 'apps.facebook.com'
  ) {
    return 'meta_ads';
  }
  if (v === 'apple_ads' || v === 'apple-ads' || v === 'apple_search_ads') {
    return 'apple_ads';
  }
  return null;
}

/** Start of the cohort interval a `YYYY-MM-DD` day falls in (week = Sunday). */
export function cohortIntervalKey(
  day: string,
  interval: string | undefined
): string {
  const date = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  if (interval === 'week') {
    date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  } else if (interval === 'month') {
    date.setUTCDate(1);
  }
  return date.toISOString().slice(0, 10);
}

/** First day of the spend window: snapped back to the first cohort interval. */
export function spendWindowStart(startDate: string, interval?: string) {
  return cohortIntervalKey(startDate.slice(0, 10), interval);
}

export function buildSpendQuery({
  projectId,
  startDay,
  endDay,
}: {
  projectId: string;
  startDay: string;
  endDay: string;
}) {
  const where = `project_id = ${sqlstring.escape(projectId)} AND spend_date BETWEEN toDate(${sqlstring.escape(startDay)}) AND toDate(${sqlstring.escape(endDay)})`;
  // Each sync writes a whole platform-day batch under one synced_at; only the
  // latest batch is live, so a campaign missing from a refetch stops counting.
  // Output column is `day`, not `spend_date`: aliasing toString(spend_date)
  // back to its own name makes ClickHouse resolve the WHERE against the
  // String alias (NO_COMMON_TYPE with the Date bounds).
  return `SELECT toString(spend_date) AS day, platform, campaign_id, campaign_name, sum(spend_inr) AS spend_inr,
  if(platform = 'apple_ads' OR match(campaign_name, '(?i)(^|[^a-z])ios([^a-z]|$)'), 'ios', 'android') AS os
FROM ${AD_SPEND_TABLE} FINAL
WHERE ${where}
  AND (spend_date, platform, synced_at) IN (
    SELECT spend_date, platform, max(synced_at) FROM ${AD_SPEND_TABLE} WHERE ${where} GROUP BY spend_date, platform
  )
GROUP BY spend_date, platform, campaign_id, campaign_name`;
}

/** OS mix of the cohort's first event over the report range (sorting-key scan). */
export function buildCohortOsQuery({
  projectId,
  eventNames,
  startDay,
  endDay,
  timezone,
}: {
  projectId: string;
  eventNames: string[];
  startDay: string;
  endDay: string;
  timezone: string;
}) {
  const tz = sqlstring.escape(timezone);
  return `SELECT lower(os) AS os, count() AS events
FROM events
WHERE project_id = ${sqlstring.escape(projectId)}
  AND name IN (${eventNames.map((n) => sqlstring.escape(n)).join(', ')})
  AND created_at >= toDateTime(${sqlstring.escape(`${startDay} 00:00:00`)}, ${tz})
  AND created_at < toDateTime(${sqlstring.escape(`${endDay} 00:00:00`)}, ${tz}) + INTERVAL 1 DAY
GROUP BY os`;
}

/** Below this share an OS is noise (a QA device), not an acquisition channel. */
const MIN_OS_SHARE = 0.01;

/**
 * Only spend that bought installs the cohort can contain. Regain's install
 * events are Android-only, so Meta iOS campaigns and Apple Ads must not be
 * charged to them — doing so inflated Meta's Android CPI by 30-50%. With no
 * android/ios signal at all, spend is left unfiltered.
 */
export function spendForCohortOs(
  spend: SpendRow[],
  osCounts: Array<{ os: string; events: number | string }>
) {
  const known = osCounts.filter((r) => r.os === 'android' || r.os === 'ios');
  const total = known.reduce((acc, r) => acc + Number(r.events), 0);
  if (total === 0) {
    return spend;
  }
  const present = new Set(
    known
      .filter((r) => Number(r.events) / total >= MIN_OS_SHARE)
      .map((r) => r.os)
  );
  return spend.filter((s) => present.has(s.os));
}

/**
 * Campaign name → ids, from profile traits (names change; ids do not). The
 * events table is the wrong source: an unindexed property scan over the
 * report range read ~940M rows / 5 min on regain-app, the traits pair ~2 s.
 */
export function buildCampaignNameMapQuery({
  projectId,
  key,
}: {
  projectId: string;
  key: string;
}) {
  const idKey =
    key === 'fb_campaign_group_name' ? 'fb_campaign_group_id' : 'campaign_id';
  const latest = (traitKey: string) =>
    `SELECT profile_id, argMax(value, updated_at) AS value FROM profile_traits WHERE project_id = ${sqlstring.escape(projectId)} AND key = ${sqlstring.escape(traitKey)} GROUP BY profile_id`;
  return `SELECT n.value AS name, groupUniqArray(20)(i.value) AS ids
FROM (${latest(key)}) AS n
INNER JOIN (${latest(idKey)}) AS i ON i.profile_id = n.profile_id
WHERE n.value != '' AND i.value != ''
GROUP BY name`;
}

type Matcher =
  | { kind: 'all' }
  | { kind: 'platform'; platform: string }
  | { kind: 'campaign'; ids: string[] }
  | { kind: 'unpaid' };

function matcherKey(m: Matcher) {
  if (m.kind === 'platform') {
    return `platform:${m.platform}`;
  }
  if (m.kind === 'campaign') {
    return `campaign:${[...m.ids].sort().join(',')}`;
  }
  return m.kind;
}

function matcherFor(
  breakdowns: Array<string | null | undefined>,
  attribution: AttributionBreakdown | null,
  campaignNameToIds: Map<string, string[]>
): Matcher {
  if (!attribution) {
    return { kind: 'all' };
  }
  const value = (breakdowns[attribution.index] ?? '').trim();
  if (!value || value === '(not set)') {
    return { kind: 'unpaid' };
  }
  if (attribution.kind === 'source') {
    const platform = sourceValueToPlatform(value);
    return platform ? { kind: 'platform', platform } : { kind: 'unpaid' };
  }
  if (attribution.kind === 'campaign_id') {
    return { kind: 'campaign', ids: [value] };
  }
  const ids = campaignNameToIds.get(value) ?? [];
  // Unresolvable names fall back to matching the stored campaign name.
  return { kind: 'campaign', ids: ids.length > 0 ? ids : [`name:${value}`] };
}

function spendMatches(row: SpendRow, m: Matcher) {
  if (!(PAID_PLATFORMS as readonly string[]).includes(row.platform)) {
    return false;
  }
  switch (m.kind) {
    case 'all':
      return true;
    case 'platform':
      return row.platform === m.platform;
    case 'campaign':
      return m.ids.some((id) =>
        id.startsWith('name:')
          ? row.campaign_name === id.slice(5)
          : row.campaign_id === id
      );
    default:
      return false;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** (cohort interval, matcher) → matching paid spend, summed. */
function buildSpendLookup(spend: SpendRow[], interval: string | undefined) {
  const spendByInterval = new Map<string, SpendRow[]>();
  for (const s of spend) {
    const key = cohortIntervalKey(s.day, interval);
    const list = spendByInterval.get(key) ?? [];
    list.push(s);
    spendByInterval.set(key, list);
  }
  return (cohortInterval: string, m: Matcher) =>
    (spendByInterval.get(cohortInterval) ?? [])
      .filter((s) => spendMatches(s, m))
      .reduce((acc, s) => acc + Number(s.spend_inr), 0);
}

/** The ad platform a matched row's spend comes from. */
function matcherPlatform(m: Matcher, spend: SpendRow[]) {
  if (m.kind === 'platform') {
    return m.platform;
  }
  if (m.kind === 'campaign') {
    return spend.find((s) => spendMatches(s, m))?.platform ?? null;
  }
  return null;
}

/** Rows sharing one spend key in one interval split that spend. Unpaid rows are left out. */
function groupBySpendKey<T extends { cohort_interval: string }>(
  rows: T[],
  matcherOf: (row: T) => Matcher
) {
  const groups = new Map<string, { m: Matcher; rows: T[] }>();
  for (const row of rows) {
    const m = matcherOf(row);
    if (m.kind === 'unpaid') {
      continue;
    }
    const key = `${row.cohort_interval}|${matcherKey(m)}`;
    const group = groups.get(key) ?? { m, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return groups.values();
}

export const ROAS_KEYS = ['d0', 'd7', 'd30', 'lifetime'] as const;
export type RoasKey = (typeof ROAS_KEYS)[number];
export type Roas = Record<RoasKey, number | null>;

export interface CostRowInput {
  cohort_interval: string;
  sum: number;
  breakdowns?: Array<string | null | undefined>;
  /** Cumulative cohort revenue per ROAS window (null = not yet complete). */
  revenue?: Roas;
}

export type WithAcquisitionCost<T> = T & {
  spend: number | null;
  cpi: number | null;
  /** revenue / spend per window; null when unpaid, unspent or incomplete. */
  roas: Roas | null;
};

const ratio = (num: number, den: number) =>
  den > 0 ? Math.round((num / den) * 1000) / 1000 : null;

function rowRoas(revenue: Roas | undefined, spend: number): Roas | null {
  if (!revenue) {
    return null;
  }
  const out = {} as Roas;
  for (const key of ROAS_KEYS) {
    const value = revenue[key];
    out[key] = value === null ? null : ratio(value, spend);
  }
  return out;
}

/** Summary ROAS per window over the cohorts whose window is complete. */
function summaryRoas(
  members: Array<{ revenue?: Roas; spend: number }>
): Roas | null {
  if (!members.some((m) => m.revenue)) {
    return null;
  }
  const out = {} as Roas;
  for (const key of ROAS_KEYS) {
    let revenue = 0;
    let spend = 0;
    for (const m of members) {
      const value = m.revenue?.[key];
      if (value === null || value === undefined) {
        continue;
      }
      revenue += value;
      spend += m.spend;
    }
    out[key] = ratio(revenue, spend);
  }
  return out;
}

const AVERAGE_ROW = 'Weighted Average';

/**
 * Stamp `spend` / `cpi` on retention rows (one breakdown group or many).
 *
 * `overallSums` (interval → cohort size of the whole population) is the
 * pro-rata denominator for BLENDED rows when the rows on screen are only part
 * of the population (top-N breakdowns, cohort buckets). Without it the rows'
 * own sizes are used.
 */
interface GroupSummary {
  spend: number;
  size: number;
  members: Array<{ revenue?: Roas; spend: number }>;
}

/** Per breakdown group: covered cohorts' spend, installs and revenue. */
function summarizeGroups<T extends CostRowInput>(
  cohortRows: T[],
  shares: Map<T, number>,
  uncovered: Set<T>
) {
  const groups = new Map<string, GroupSummary>();
  for (const row of cohortRows) {
    if (uncovered.has(row)) {
      continue;
    }
    const key = JSON.stringify(row.breakdowns ?? []);
    const group = groups.get(key) ?? { spend: 0, size: 0, members: [] };
    const share = shares.get(row) ?? 0;
    group.spend += share;
    group.size += Number(row.sum);
    group.members.push({ revenue: row.revenue, spend: share });
    groups.set(key, group);
  }
  return groups;
}

/** Split each spend group's money across its rows by cohort size. */
function allocateShares<T extends CostRowInput>(
  groups: Iterable<{ m: Matcher; rows: T[] }>,
  spendFor: (cohortInterval: string, m: Matcher) => number,
  overallSums: Map<string, number> | undefined
) {
  const shares = new Map<T, number>();
  let attributed = 0;
  for (const { m, rows: groupRows } of groups) {
    const cohortInterval = groupRows[0]!.cohort_interval;
    const total = spendFor(cohortInterval, m);
    const ownSize = groupRows.reduce((acc, r) => acc + Number(r.sum), 0);
    const overall =
      m.kind === 'all' ? overallSums?.get(cohortInterval) : undefined;
    const denominator = Math.max(overall ?? 0, ownSize);
    for (const row of groupRows) {
      const share =
        denominator > 0
          ? (total * Number(row.sum)) / denominator
          : total / groupRows.length;
      shares.set(row, share);
      attributed += share;
    }
  }
  return { shares, attributed };
}

function costCells(
  unpaid: boolean,
  value: number,
  size: number,
  roas: () => Roas | null
) {
  if (unpaid) {
    return { spend: null, cpi: null, roas: null };
  }
  return {
    spend: round2(value),
    cpi: size > 0 ? round2(value / size) : null,
    roas: roas(),
  };
}

/**
 * Stamp `spend` / `cpi` / `roas` on retention rows (one breakdown group or
 * many).
 *
 * `overallSums` (interval → cohort size of the whole population) is the
 * pro-rata denominator for BLENDED rows when the rows on screen are only part
 * of the population (top-N breakdowns, cohort buckets). Without it the rows'
 * own sizes are used.
 */
export function attachAcquisitionCost<T extends CostRowInput>(
  rows: T[],
  spend: SpendRow[],
  {
    interval,
    attribution,
    campaignNameToIds = new Map(),
    overallSums,
    coverageFrom = {},
  }: {
    interval: string | undefined;
    attribution: AttributionBreakdown | null;
    campaignNameToIds?: Map<string, string[]>;
    overallSums?: Map<string, number>;
    /** platform → first covered cohort day; see ATTRIBUTION_COVERAGE_FROM. */
    coverageFrom?: Partial<Record<string, string>>;
  }
): { rows: WithAcquisitionCost<T>[]; attributedSpend: number } {
  const cohortRows = rows.filter((r) => r.cohort_interval !== AVERAGE_ROW);
  const rowMatcher = (row: T) =>
    matcherFor(row.breakdowns ?? [], attribution, campaignNameToIds);
  // Matched rows whose cohort starts before their platform is attributable.
  const uncovered = new Set<T>();
  const matcherOfRow = (row: T): Matcher => {
    const m = rowMatcher(row);
    const platform = attribution ? matcherPlatform(m, spend) : null;
    const from = platform ? coverageFrom[platform] : undefined;
    if (from && row.cohort_interval < from) {
      uncovered.add(row);
      return { kind: 'unpaid' };
    }
    return m;
  };
  const { shares, attributed } = allocateShares(
    groupBySpendKey(cohortRows, matcherOfRow),
    buildSpendLookup(spend, interval),
    overallSums
  );
  const summaries = summarizeGroups(cohortRows, shares, uncovered);

  const out = rows.map((row) => {
    // Organic / unattributed rows have no acquisition cost, not a zero one;
    // neither do matched rows from before their platform is attributable.
    const unpaid = uncovered.has(row) || rowMatcher(row).kind === 'unpaid';
    if (row.cohort_interval === AVERAGE_ROW) {
      const group = summaries.get(JSON.stringify(row.breakdowns ?? []));
      return {
        ...row,
        ...costCells(unpaid, group?.spend ?? 0, group?.size ?? 0, () =>
          summaryRoas(group?.members ?? [])
        ),
      };
    }
    const value = shares.get(row) ?? 0;
    return {
      ...row,
      ...costCells(unpaid, value, Number(row.sum), () =>
        rowRoas(row.revenue, value)
      ),
    };
  });
  return { rows: out, attributedSpend: round2(attributed) };
}

/** interval → cohort size, from the whole-population rows. */
export function cohortSizesByInterval(rows: CostRowInput[]) {
  const sizes = new Map<string, number>();
  for (const row of rows) {
    if (row.cohort_interval === AVERAGE_ROW) {
      continue;
    }
    sizes.set(
      row.cohort_interval,
      (sizes.get(row.cohort_interval) ?? 0) + Number(row.sum)
    );
  }
  return sizes;
}

export function totalPaidSpend(spend: SpendRow[]) {
  return round2(
    spend
      .filter((s) => (PAID_PLATFORMS as readonly string[]).includes(s.platform))
      .reduce((acc, s) => acc + Number(s.spend_inr), 0)
  );
}
