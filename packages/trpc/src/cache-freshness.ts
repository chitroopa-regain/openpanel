import { differenceInCalendarDays, startOfToday } from 'date-fns';

/**
 * Freshness window (seconds): how long a cached report is "fresh enough" to
 * serve WITHOUT kicking a background revalidation.
 *
 * Key insight: a report's *range* does not tell you whether its data is stable.
 * Any range that ends at "now" (today, 7d, 30d, 12m, …) includes the current,
 * still-growing bucket — so it is live at the edge. Only ranges that end in
 * the *past* (a finished period, or a fixed historical custom range) are
 * truly stable.
 *
 * But "live at the edge" is not the same as "changes materially every 30 s".
 * A 30-day funnel over tens of millions of events moves by a rounding error
 * between two board opens a few minutes apart, while recomputing it costs
 * ClickHouse 10-50 s of CPU. Measured on the c66 launch board (2026-09-09):
 * 1,390 chart.funnel calls in 3 days, p90 22 s, because every open after 30 s
 * re-fired every widget. So the window scales with how much history the range
 * covers — the same ordering Mixpanel uses for its query cache:
 *
 *   ≤ 1 day      → LIVE     (30 s)   today, last hour, 30 min
 *   ≤ 7 days     → SHORT    (5 min)  7d
 *   ≤ 45 days    → MEDIUM   (15 min) 30d, month-to-date
 *   longer       → LONG     (60 min) 3m, 6m, 12m, year-to-date
 *   closed       → STABLE   (24 h)   yesterday, last month, past custom range
 *
 * Accuracy is preserved: a served value is always an exact result as of its
 * `_cache.cachedAt`, the chart shows "Updated X ago", and the manual refresh
 * button recomputes on demand. What changes is only how long a board can be
 * re-opened before it silently re-queries ClickHouse in the background.
 *
 * The hard eviction TTL is derived from this in `cacheMiddleware`.
 */
type FreshnessInput = {
  range?: string;
  startDate?: string | null;
  endDate?: string | null;
};

const seconds = (envName: string, fallback: number) =>
  Number(process.env[envName]) || fallback;

// Short debounce for live data: show cache, then background-refresh on load.
const LIVE = seconds('OP_QUERY_CACHE_LIVE_WINDOW', 30);
const SHORT = seconds('OP_QUERY_CACHE_SHORT_WINDOW', 60 * 5);
const MEDIUM = seconds('OP_QUERY_CACHE_MEDIUM_WINDOW', 60 * 15);
const LONG = seconds('OP_QUERY_CACHE_LONG_WINDOW', 60 * 60);
// Closed historical periods barely change — keep them fresh for a day.
const STABLE = seconds('OP_QUERY_CACHE_STABLE_WINDOW', 60 * 60 * 24);

// Live widgets must never serve stale data.
const LIVE_PATHS = new Set(['overview.liveData', 'overview.liveVisitors']);

// Ranges that describe a *finished* period in the past — their data is stable.
const CLOSED_RANGES = new Set(['yesterday', 'lastMonth', 'lastYear']);

// How many days of history a live (ends-now) preset covers. Anything not
// listed is treated as intraday.
const RANGE_DAYS: Record<string, number> = {
  '30min': 0,
  lastHour: 0,
  today: 0,
  '7d': 7,
  '30d': 30,
  monthToDate: 30,
  '3m': 90,
  '6m': 180,
  '12m': 365,
  yearToDate: 365,
};

export function freshnessForSpanDays(days: number): number {
  if (days <= 1) return LIVE;
  if (days <= 7) return SHORT;
  if (days <= 45) return MEDIUM;
  return LONG;
}

export function getReportFreshness(
  input: FreshnessInput | undefined,
  opts: { path: string }
): number {
  if (LIVE_PATHS.has(opts.path)) {
    return 0;
  }

  const range = input?.range;

  if (range && CLOSED_RANGES.has(range)) {
    return STABLE;
  }

  if (range === 'custom') {
    // A fixed custom range that ends before today can't change anymore.
    if (input?.endDate && new Date(input.endDate) < startOfToday()) {
      return STABLE;
    }
    // A custom range that reaches into today: scale by how much it covers.
    if (input?.startDate) {
      const end = input.endDate ? new Date(input.endDate) : new Date();
      const days = differenceInCalendarDays(end, new Date(input.startDate));
      return freshnessForSpanDays(Number.isFinite(days) ? days : 0);
    }
    return LIVE;
  }

  // Preset ranges that end at "now": scale by covered history.
  if (range && range in RANGE_DAYS) {
    return freshnessForSpanDays(RANGE_DAYS[range]!);
  }

  // Unknown range: keep the old behaviour — serve cache, revalidate on load.
  return LIVE;
}
