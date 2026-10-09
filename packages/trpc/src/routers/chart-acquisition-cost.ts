import type { RetentionCoverage, RevenueCohort } from './chart-retention.utils';
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
 * Brainpal: `Install: Attributed` (install_source / fb_campaign_group_*) only
 * exists from 2026-09-14 13:46 IST (first full day 09-15), Meta and Google.
 */
/** Coverage date for a platform whose installs are never labelled. */
export const NEVER_ATTRIBUTABLE = '9999-12-31';

export const ATTRIBUTION_COVERAGE_FROM: Record<
  string,
  Partial<Record<string, string>>
> = {
  'regain-app': { meta_ads: '2026-09-06' },
  // Brainpal creator installs arrive untagged (157 'creator' installs against
  // Rs 3.4 lakh of UGC), so UGC is never matched to a source or campaign row.
  'brainrot-app': {
    meta_ads: '2026-09-15',
    google_ads: '2026-09-15',
    ugc: NEVER_ATTRIBUTABLE,
  },
};

/** Platform-level spend on a cohort can only come from these. */
export const PAID_PLATFORMS = [
  'google_ads',
  'meta_ads',
  'apple_ads',
  // Creator (UGC + paid collab) spend from the marketing dashboard, booked on
  // the day each video goes live.
  'ugc',
] as const;

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
  /** Store-reported revenue columns have data (blended views of synced projects). */
  storeRevenueAvailable: boolean;
  /** Days of return window the range covers; D7/D30 need at least 7/30. */
  roasMaxDay: number;
  /** Matched modes only: platform → first attributable cohort day. */
  coverageFrom: Partial<Record<string, string>>;
  /** Platforms that spent yesterday but report nothing yet for today. */
  spendPendingToday: string[];
  /** First day the cohort event was tracked; earlier spend has no cohort. */
  trackingStart: string | null;
  /** Cohort filters applied to spend / not applicable to spend. */
  spendFilters: { applied: string[]; ignored: string[] };
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
  // Creator links: install_source 'creator', utm_source 'social-media'
  // (utm_campaign carries the creator, e.g. UGC-Amritha).
  if (v === 'creator' || v === 'ugc' || v === 'social-media') {
    return 'ugc';
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

/**
 * Daily volume of the cohort event for the 60 days after it first appears,
 * from cohort_events_mv (Date grain, small). Used to find when tracking went
 * live — test devices send the event days before a release reaches users.
 */
export function buildTrackingDailyQuery({
  projectId,
  eventNames,
}: {
  projectId: string;
  eventNames: string[];
}) {
  const where = `project_id = ${sqlstring.escape(projectId)} AND name IN (${eventNames.map((n) => sqlstring.escape(n)).join(', ')})`;
  return `SELECT toString(created_at) AS day, sum(event_count) AS events
FROM cohort_events_mv
WHERE ${where}
  AND created_at < (SELECT min(created_at) FROM cohort_events_mv WHERE ${where}) + 60
GROUP BY created_at
ORDER BY created_at`;
}

/** Below this share of a typical day, the event is test traffic, not users. */
const TRACKING_LIVE_SHARE = 0.1;

/** First day the cohort event runs at real volume; null when unknown. */
/**
 * Known tracking starts where the volume heuristic misfires. Brainpal grew
 * ~10x from April to May, so 10% of its early median lands on 04-28 although
 * installs were tracked at real volume from 04-04 (360+/day, Play ~1.3k/day).
 */
export const TRACKING_START_OVERRIDE: Record<string, string> = {
  'brainrot-app': '2026-04-04',
};

export function findTrackingStart(
  daily: Array<{ day: string; events: number | string }>,
  projectId?: string
) {
  const override = projectId ? TRACKING_START_OVERRIDE[projectId] : undefined;
  if (override) {
    return override;
  }
  if (daily.length === 0) {
    return null;
  }
  const counts = daily.map((d) => Number(d.events)).sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)] ?? 0;
  const live = daily.find(
    (d) => Number(d.events) >= median * TRACKING_LIVE_SHARE
  );
  return live ? live.day.slice(0, 10) : null;
}

/** Daily installs from the Play Console export (play_installs_daily). */
export function buildExternalInstallsQuery({
  projectId,
  startDay,
  endDay,
}: {
  projectId: string;
  startDay: string;
  endDay: string;
}) {
  // Qualified p.day: an unqualified `day` would resolve to the String alias.
  return `SELECT toString(p.day) AS day, p.device_installs AS installs
FROM play_installs_daily AS p FINAL
WHERE p.project_id = ${sqlstring.escape(projectId)} AND p.day BETWEEN toDate(${sqlstring.escape(startDay)}) AND toDate(${sqlstring.escape(endDay)})`;
}

export const ESTIMATE_SOURCE = 'revenuecat_webhook_estimate';

/**
 * Daily store revenue from the store's own report (app_store_daily_revenue:
 * Apple Sales & Trends, with RevenueCat webhook estimates for the last ~2
 * days). One row per project-day; `estimated` marks the estimate days.
 */
export function buildStoreRevenueQuery({
  projectId,
  startDay,
  endDay,
}: {
  projectId: string;
  startDay: string;
  endDay: string;
}) {
  // Qualified r.day: an unqualified `day` would resolve to the String alias.
  return `SELECT toString(r.day) AS day, r.gross_inr AS revenue, r.source = ${sqlstring.escape(ESTIMATE_SOURCE)} AS estimated
FROM app_store_daily_revenue AS r FINAL
WHERE r.project_id = ${sqlstring.escape(projectId)} AND r.day BETWEEN toDate(${sqlstring.escape(startDay)}) AND toDate(${sqlstring.escape(endDay)})`;
}

/** Daily aggregate purchases imported from before event tracking. */
export const HISTORIC_PURCHASE_EVENT = 'Historic: Daily Purchases';

/**
 * Revenue booked per local day: imported historic aggregates plus the report's
 * revenue event, the latter de-duplicated by transaction_id (re-sent purchase
 * events exist, e.g. regain-app April 2026).
 */
export function buildBookedRevenueQuery({
  projectId,
  eventNames,
  propertyKey,
  startDay,
  endDayExclusive,
  timezone,
}: {
  projectId: string;
  eventNames: string[];
  propertyKey: string;
  startDay: string;
  endDayExclusive: string;
  timezone: string;
}) {
  const tz = sqlstring.escape(timezone);
  const window = `created_at >= toDateTime64(toDate(${sqlstring.escape(startDay)}), 3, ${tz}) AND created_at < toDateTime64(toDate(${sqlstring.escape(endDayExclusive)}), 3, ${tz})`;
  const project = `project_id = ${sqlstring.escape(projectId)}`;
  return `SELECT toString(bd) AS day, sum(v) AS revenue FROM (
  SELECT toDate(created_at, ${tz}) AS bd, toFloat64OrZero(properties['revenue_inr']) AS v
  FROM events WHERE ${project} AND name = ${sqlstring.escape(HISTORIC_PURCHASE_EVENT)} AND ${window}
  UNION ALL
  SELECT bd, v FROM (
    SELECT toDate(created_at, ${tz}) AS bd, toFloat64OrZero(properties[${sqlstring.escape(propertyKey)}]) AS v,
      row_number() OVER (PARTITION BY if(properties['transaction_id'] = '', toString(id), properties['transaction_id']) ORDER BY created_at) AS rn
    FROM events WHERE ${project} AND name IN (${eventNames.map((n) => sqlstring.escape(n)).join(', ')}) AND ${window}
  ) WHERE rn = 1
) GROUP BY bd`;
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

export interface SpendFilterInput {
  name: string;
  operator: string;
  value?: Array<string | number | boolean | null>;
}

export interface SpendFilter {
  /** Whether a spend row survives the report's cohort filters. */
  allows: (row: SpendRow) => boolean;
  /** Filters applied to spend, e.g. `install_referrer_utm_source is google-ads`. */
  applied: string[];
  /** Cohort filters that cannot narrow ad spend (shown in the footnote). */
  ignored: string[];
  /** An `is` filter that only lets unpaid traffic through: no CPI at all. */
  unpaidOnly: boolean;
}

/**
 * Turn the cohort event's filters into a spend filter, so a report filtered
 * to e.g. Google installs is charged Google spend only. `is` keeps spend
 * matching any value, `isNot` drops it; other operators and non-attribution
 * properties cannot be mapped onto ad spend and are reported as ignored.
 */
export function buildSpendFilter(
  filters: SpendFilterInput[],
  campaignNameToIds: Map<string, string[]>
): SpendFilter {
  const include: Matcher[][] = [];
  const exclude: Matcher[] = [];
  const applied: string[] = [];
  const ignored: string[] = [];
  let unpaidOnly = false;
  for (const f of filters) {
    if (f.name === 'name') {
      continue;
    }
    const attribution = findAttributionBreakdown([f.name]);
    const values = (f.value ?? [])
      .filter((v) => v !== null && v !== undefined && v !== '')
      .map(String);
    const label =
      `${getBreakdownKey(f.name)} ${f.operator} ${values.join(', ')}`.trim();
    if (
      !attribution ||
      (f.operator !== 'is' && f.operator !== 'isNot') ||
      values.length === 0
    ) {
      ignored.push(label);
      continue;
    }
    const matchers = values
      .map((v) =>
        matcherFor([v], { ...attribution, index: 0 }, campaignNameToIds)
      )
      .filter((m) => m.kind !== 'unpaid');
    applied.push(label);
    if (f.operator === 'is') {
      if (matchers.length === 0) {
        unpaidOnly = true;
      }
      include.push(matchers);
    } else {
      exclude.push(...matchers);
    }
  }
  return {
    allows: (row) =>
      include.every((any) => any.some((m) => spendMatches(row, m))) &&
      !exclude.some((m) => spendMatches(row, m)),
    applied,
    ignored,
    unpaidOnly,
  };
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
export type Roas = Record<RoasKey, number | null> & {
  /** Windows still in progress ("so far" values), e.g. today's D0. */
  partial?: RoasKey[];
  coverage?: Partial<Record<RoasKey, RetentionCoverage>>;
  /** 'booked': revenue booked in the period / spend (no cohort data then). */
  basis?: 'booked';
};
/** Cohort revenue per window; d0Partial = the cohort day is still running. */
export type RoasRevenueInput = Record<RoasKey, number | null> & {
  d0Partial?: boolean;
};

export interface CostRowInput {
  cohort_interval: string;
  sum: number;
  breakdowns?: Array<string | null | undefined>;
  /** Cumulative cohort revenue per ROAS window (null = not yet complete). */
  revenue?: RoasRevenueInput;
  revenueCohorts?: RevenueCohort[];
}

export type WithAcquisitionCost<T> = T & {
  spend: number | null;
  cpi: number | null;
  /**
   * Set on rows from before install tracking began: their CPI uses installs
   * from an external source (Play Console), and they have no cohort ROAS.
   */
  installsSource?: 'play';
  externalInstalls?: number;
  /** Play Console installs in the row's period (blended views only). */
  playInstalls?: number | null;
  /**
   * Store-reported revenue booked in the row's period (blended views, only
   * for projects with app_store_daily_revenue rows). Not install-cohort revenue.
   */
  storeRevenue?: number | null;
  /** Some day in the period is a RevenueCat estimate, not a settled figure. */
  storeRevenueEstimated?: boolean;
  /** storeRevenue / the row's spend; null without spend. */
  storeRoas?: number | null;
  /** Cohort lifetime revenue, or revenue booked in the period before tracking. */
  lifetimeRevenue?: number | null;
  revenueBasis?: 'cohort' | 'booked';
  /** revenue / spend per window; null when unpaid, unspent or incomplete. */
  roas: Roas | null;
};

const ratio = (num: number, den: number) =>
  den > 0 ? Math.round((num / den) * 1000) / 1000 : null;

function rowRoas(
  revenue: RoasRevenueInput | undefined,
  spend: number
): Roas | null {
  if (!revenue) {
    return null;
  }
  const out = {} as Roas;
  for (const key of ROAS_KEYS) {
    const value = revenue[key];
    out[key] = value === null ? null : ratio(value, spend);
  }
  if (revenue.d0Partial) {
    out.partial = ['d0'];
  }
  return out;
}

/** Summary ROAS per window over the cohorts whose window is complete. */
function summaryRoas(
  members: Array<{ revenue?: RoasRevenueInput; spend: number }>,
  includeLiveD0 = false,
  lifetimeMembers = members
): Roas | null {
  if (!members.some((m) => m.revenue)) {
    return null;
  }
  const out: Roas = {
    d0: null,
    d7: null,
    d30: null,
    lifetime: null,
    coverage: {},
  };
  for (const key of ROAS_KEYS) {
    let eligible = 0;
    let revenue = 0;
    let spend = 0;
    const windowMembers = key === 'lifetime' ? lifetimeMembers : members;
    for (const m of windowMembers) {
      const value = m.revenue?.[key];
      // An in-progress day is not a finished D0; keep it out of the average.
      if (
        value === null ||
        value === undefined ||
        (!includeLiveD0 && key === 'd0' && m.revenue?.d0Partial)
      ) {
        continue;
      }
      eligible += 1;
      revenue += value;
      spend += m.spend;
    }
    out[key] = eligible > 0 ? ratio(revenue, spend) : null;
    out.coverage![key] = { eligible, total: windowMembers.length };
  }
  if (includeLiveD0 && members.some((m) => m.revenue?.d0Partial))
    out.partial = ['d0'];
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
  members: Array<{ revenue?: RoasRevenueInput; spend: number }>;
  lifetimeMembers: Array<{ revenue?: RoasRevenueInput; spend: number }>;
}

/** Per breakdown group: covered cohorts' spend, installs and revenue. */
function summarizeGroups<T extends CostRowInput>(
  cohortRows: T[],
  shares: Map<T, number>,
  uncovered: Set<T>,
  dailyMembers: Map<T, Array<{ revenue?: RoasRevenueInput; spend: number }>>
) {
  const groups = new Map<string, GroupSummary>();
  for (const row of cohortRows) {
    if (uncovered.has(row)) {
      continue;
    }
    const key = JSON.stringify(row.breakdowns ?? []);
    const group = groups.get(key) ?? {
      spend: 0,
      size: 0,
      members: [],
      lifetimeMembers: [],
    };
    const share = shares.get(row) ?? 0;
    group.spend += share;
    group.size += Number(row.sum);
    // Lifetime has no maturity cutoff: retain all displayed-period spend,
    // including spend on dates with no observed install cohort.
    group.lifetimeMembers.push({ revenue: row.revenue, spend: share });
    group.members.push(
      ...(dailyMembers.get(row) ?? [{ revenue: row.revenue, spend: share }])
    );
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
    overallDailySums,
    coverageFrom = {},
    trackingStart = null,
    externalInstalls = [],
    bookedRevenue = [],
    storeRevenue = [],
  }: {
    interval: string | undefined;
    attribution: AttributionBreakdown | null;
    campaignNameToIds?: Map<string, string[]>;
    overallSums?: Map<string, number>;
    overallDailySums?: Map<string, number>;
    /** platform → first covered cohort day; see ATTRIBUTION_COVERAGE_FROM. */
    coverageFrom?: Partial<Record<string, string>>;
    /** First day the cohort event was tracked at real volume. */
    trackingStart?: string | null;
    /** Daily installs from outside the event stream (Play Console). */
    externalInstalls?: Array<{ day: string; installs: number | string }>;
    /** Daily booked revenue, for rows before tracking. */
    bookedRevenue?: Array<{ day: string; revenue: number | string }>;
    /** Daily store-reported revenue; `estimated` marks non-settled days. */
    storeRevenue?: Array<{
      day: string;
      revenue: number | string;
      estimated?: number | boolean | string;
    }>;
  }
): { rows: WithAcquisitionCost<T>[]; attributedSpend: number } {
  // Before tracking began there are no cohorts to charge: spend from those
  // days stays out of every CPI/ROAS and summary. Rows wholly before it show
  // their spend with CPI from external installs, and no ROAS.
  const trackingKey = trackingStart
    ? cohortIntervalKey(trackingStart, interval)
    : null;
  const isBeforeTracking = (row: T) =>
    trackingKey !== null &&
    row.cohort_interval !== AVERAGE_ROW &&
    row.cohort_interval < trackingKey;
  const trackedSpend = trackingStart
    ? spend.filter((s) => s.day >= trackingStart)
    : spend;
  const cohortRows = rows.filter(
    (r) => r.cohort_interval !== AVERAGE_ROW && !isBeforeTracking(r)
  );
  const rowMatcher = (row: T) =>
    matcherFor(row.breakdowns ?? [], attribution, campaignNameToIds);
  // Matched rows whose cohort starts before their platform is attributable.
  const uncovered = new Set<T>();
  const matcherOfRow = (row: T): Matcher => {
    const m = rowMatcher(row);
    const platform = attribution ? matcherPlatform(m, trackedSpend) : null;
    const from = platform ? coverageFrom[platform] : undefined;
    // A week/month bucket that contains the coverage day is covered; only its
    // pre-coverage spend is dropped (below).
    if (from && row.cohort_interval < cohortIntervalKey(from, interval)) {
      uncovered.add(row);
      return { kind: 'unpaid' };
    }
    return m;
  };
  // Matched views: spend from before a platform is attributable belongs to no row.
  const matchableSpend = attribution
    ? trackedSpend.filter((s) => {
        const from = coverageFrom[s.platform];
        return !from || s.day >= from;
      })
    : trackedSpend;
  const { shares, attributed } = allocateShares(
    groupBySpendKey(cohortRows, matcherOfRow),
    buildSpendLookup(matchableSpend, interval),
    overallSums
  );
  // Display-row spend/CPI stays unchanged. ROAS allocates spend at the daily
  // grain BEFORE selecting eligible windows, never prorates monthly spend by
  // the number of days (daily budgets and breakdown shares can differ).
  const dailyRows = cohortRows.flatMap((row) =>
    (row.revenueCohorts ?? []).map((member) => ({
      ...member,
      breakdowns: row.breakdowns,
      parent: row,
    }))
  );
  const dailyShares = allocateShares(
    groupBySpendKey(dailyRows, (row) => rowMatcher(row.parent)),
    buildSpendLookup(matchableSpend, 'day'),
    overallDailySums
  ).shares;
  const dailyMembers = new Map<
    T,
    Array<{ revenue?: RoasRevenueInput; spend: number }>
  >();
  for (const row of dailyRows) {
    const members = dailyMembers.get(row.parent) ?? [];
    members.push({ revenue: row.revenue, spend: dailyShares.get(row) ?? 0 });
    dailyMembers.set(row.parent, members);
  }
  const allSpendFor = buildSpendLookup(spend, interval);
  const externalByInterval = sumByInterval(
    externalInstalls.map((e) => ({ day: e.day, value: Number(e.installs) })),
    interval
  );
  const bookedByInterval = sumByInterval(
    bookedRevenue.map((e) => ({ day: e.day, value: Number(e.revenue) })),
    interval
  );
  // Play installs are not split by source, so only blended views show them.
  const showPlay = !attribution && externalInstalls.length > 0;
  const playFor = (row: T) =>
    showPlay
      ? (externalByInterval.get(row.cohort_interval) ?? null)
      : undefined;
  const trackedPlayTotal = showPlay
    ? cohortRows.reduce(
        (acc, r) => acc + (externalByInterval.get(r.cohort_interval) ?? 0),
        0
      )
    : undefined;
  // Store revenue is booked per period, not per source: blended views only.
  const showStore = !attribution && storeRevenue.length > 0;
  const storeByInterval = sumByInterval(
    storeRevenue.map((e) => ({ day: e.day, value: Number(e.revenue) })),
    interval
  );
  const storeEstimated = new Set(
    storeRevenue
      .filter((e) => e.estimated === true || Number(e.estimated) === 1)
      .map((e) => cohortIntervalKey(e.day, interval))
  );
  const storeCells = (cohortInterval: string, spendValue: number | null) => {
    if (!showStore) {
      return {};
    }
    const value = storeByInterval.get(cohortInterval);
    if (value === undefined) {
      return { storeRevenue: null, storeRevenueEstimated: false, storeRoas: null };
    }
    return {
      storeRevenue: round2(value),
      storeRevenueEstimated: storeEstimated.has(cohortInterval),
      storeRoas: spendValue ? ratio(value, spendValue) : null,
    };
  };
  const trackedStoreTotal = showStore
    ? cohortRows.reduce(
        (acc, r) => acc + (storeByInterval.get(r.cohort_interval) ?? 0),
        0
      )
    : 0;
  const trackedStoreEstimated = showStore
    ? cohortRows.some((r) => storeEstimated.has(r.cohort_interval))
    : false;
  const cohortRevenueTotal = (key: string) =>
    round2(
      cohortRows
        .filter((r) => JSON.stringify(r.breakdowns ?? []) === key)
        .reduce((acc, r) => acc + (r.revenue?.lifetime ?? 0), 0)
    );
  const summaries = summarizeGroups(
    cohortRows,
    shares,
    uncovered,
    dailyMembers
  );

  const baseOut = rows.map((row) => {
    if (isBeforeTracking(row)) {
      // Matched views cannot split untracked spend; blended can show it.
      if (attribution) {
        return { ...row, spend: null, cpi: null, roas: null };
      }
      return {
        ...row,
        ...beforeTrackingCells(
          allSpendFor(row.cohort_interval, { kind: 'all' }),
          externalByInterval.get(row.cohort_interval),
          bookedByInterval.get(row.cohort_interval)
        ),
        playInstalls: playFor(row),
      };
    }
    // Organic / unattributed rows have no acquisition cost, not a zero one;
    // neither do matched rows from before their platform is attributable.
    const unpaid = uncovered.has(row) || rowMatcher(row).kind === 'unpaid';
    if (row.cohort_interval === AVERAGE_ROW) {
      const key = JSON.stringify(row.breakdowns ?? []);
      const group = summaries.get(key);
      return {
        ...row,
        ...costCells(unpaid, group?.spend ?? 0, group?.size ?? 0, () =>
          summaryRoas(group?.members ?? [], false, group?.lifetimeMembers ?? [])
        ),
        playInstalls: trackedPlayTotal,
        lifetimeRevenue: cohortRevenueTotal(key),
        revenueBasis: 'cohort' as const,
      };
    }
    const value = shares.get(row) ?? 0;
    return {
      ...row,
      ...costCells(unpaid, value, Number(row.sum), () =>
        dailyMembers.has(row)
          ? summaryRoas(dailyMembers.get(row)!, true, [
              { revenue: row.revenue, spend: value },
            ])
          : rowRoas(row.revenue, value)
      ),
      playInstalls: playFor(row),
      lifetimeRevenue: row.revenue ? round2(row.revenue.lifetime ?? 0) : null,
      revenueBasis: 'cohort' as const,
    };
  });
  // Store-revenue columns are layered on last, from each row's final spend, so
  // no existing field can change.
  const out = showStore
    ? baseOut.map((row) => {
        const spendValue = (row as { spend?: number | null }).spend ?? null;
        if (row.cohort_interval === AVERAGE_ROW) {
          return {
            ...row,
            storeRevenue: round2(trackedStoreTotal),
            storeRevenueEstimated: trackedStoreEstimated,
            storeRoas: spendValue ? ratio(trackedStoreTotal, spendValue) : null,
          };
        }
        return { ...row, ...storeCells(row.cohort_interval, spendValue) };
      })
    : baseOut;
  return { rows: out, attributedSpend: round2(attributed) };
}

/**
 * A row from before install tracking: its spend, CPI over Play Console
 * installs, and revenue booked in the period / spend ("booked" ROAS).
 */
function beforeTrackingCells(
  spendValue: number,
  installs: number | undefined,
  booked: number | undefined
) {
  return {
    spend: round2(spendValue),
    cpi: installs ? round2(spendValue / installs) : null,
    roas:
      booked === undefined
        ? null
        : {
            d0: null,
            d7: null,
            d30: null,
            lifetime: ratio(booked, spendValue),
            basis: 'booked' as const,
          },
    lifetimeRevenue: booked === undefined ? null : round2(booked),
    revenueBasis: 'booked' as const,
    ...(installs
      ? { installsSource: 'play' as const, externalInstalls: installs }
      : {}),
  };
}

function sumByInterval(
  rows: Array<{ day: string; value: number }>,
  interval: string | undefined
) {
  const out = new Map<string, number>();
  for (const r of rows) {
    const key = cohortIntervalKey(r.day, interval);
    out.set(key, (out.get(key) ?? 0) + r.value);
  }
  return out;
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

/**
 * Platforms whose spend for `today` is not in yet: they spent the day before
 * but report zero today (Meta posts some accounts' spend late in the day).
 * Today's spend, CPI and ROAS undercount them until they do.
 */
export function spendPendingToday(spend: SpendRow[], today: string) {
  const yesterday = new Date(`${today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const y = yesterday.toISOString().slice(0, 10);
  const byDay = (day: string, platform: string) =>
    spend
      .filter((s) => s.day === day && s.platform === platform)
      .reduce((acc, s) => acc + Number(s.spend_inr), 0);
  // UGC is booked on posting days, so a zero day is normal, not pending.
  return PAID_PLATFORMS.filter(
    (platform) =>
      platform !== 'ugc' &&
      byDay(y, platform) > 0 &&
      byDay(today, platform) <= 0
  );
}

export function totalPaidSpend(spend: SpendRow[]) {
  return round2(
    spend
      .filter((s) => (PAID_PLATFORMS as readonly string[]).includes(s.platform))
      .reduce((acc, s) => acc + Number(s.spend_inr), 0)
  );
}
