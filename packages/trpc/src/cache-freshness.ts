import { startOfToday } from 'date-fns';

/**
 * Freshness window (seconds): how long a cached report is "fresh enough" to
 * serve WITHOUT kicking a background revalidation.
 *
 * Key insight: a report's *range* does not tell you whether its data is stable.
 * Any range that ends at "now" (today, 7d, 30d, 12m, …) includes the current,
 * still-growing bucket — so it is just as live at the edge as a "today" report.
 * Only ranges that end in the *past* (a finished period, or a fixed historical
 * custom range) are truly stable.
 *
 * So:
 *   - Live ranges → a SHORT window. Every load shows the cache instantly and
 *     then revalidates in the background; the window is only a debounce so a
 *     multi-widget dashboard (or rapid reloads) doesn't re-hit ClickHouse on
 *     every single render.
 *   - Closed/historical ranges → a LONG window, since the data can't change.
 *
 * The hard eviction TTL is derived from this in `cacheMiddleware`.
 */
type FreshnessInput = {
  range?: string;
  startDate?: string | null;
  endDate?: string | null;
};

// Short debounce for live data: show cache, then background-refresh on load.
const LIVE = Number(process.env.OP_QUERY_CACHE_LIVE_WINDOW) || 30;
// Closed historical periods barely change — keep them fresh for a day.
const STABLE = Number(process.env.OP_QUERY_CACHE_STABLE_WINDOW) || 60 * 60 * 24;


// Live widgets must never serve stale data.
const LIVE_PATHS = new Set(['overview.liveData', 'overview.liveVisitors']);

// Ranges that describe a *finished* period in the past — their data is stable.
const CLOSED_RANGES = new Set(['yesterday', 'lastMonth', 'lastYear']);

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

  // A fixed custom range that ends before today can't change anymore.
  if (
    range === 'custom' &&
    input?.endDate &&
    new Date(input.endDate) < startOfToday()
  ) {
    return STABLE;
  }

  // Everything else ends at "now" and includes the live current bucket:
  // serve cache instantly, then revalidate on (essentially) every load.
  return LIVE;
}
