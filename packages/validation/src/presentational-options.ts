/**
 * Report `options` keys that change only how a chart is DRAWN, never what the
 * server computes.
 *
 * Why this exists: the funnel chart spreads the whole report into
 * `trpc.chart.funnel.queryOptions({...report})`. Anything inside `options`
 * therefore lands in BOTH the React Query key and the server's `canonicalKey`
 * Redis key. Toggling a breakdown checkbox then invalidated both layers and
 * recomputed the funnel — up to ~90s on regain-app — to return byte-identical
 * data.
 *
 * `hiddenBreakdowns` and funnel `topN` are read nowhere in packages/db or
 * packages/trpc; they are filtered client-side in useVisibleFunnelBreakdowns.
 *
 * ⚠️ `topN` is stripped for FUNNEL options only. Retention genuinely uses it
 * server-side (`chart.ts` → `retentionOptions?.topN` → `LIMIT ${topN}`), so
 * stripping it there would silently change results.
 */
const ALWAYS_PRESENTATIONAL = ['displayMode'] as const;
const FUNNEL_ONLY_PRESENTATIONAL = ['hiddenBreakdowns', 'topN'] as const;

/**
 * Returns `options` with presentational keys removed. Returns the SAME object
 * when nothing was removed, so callers can cheaply detect a no-op.
 */
export function stripPresentationalOptions<T>(options: T): T {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return options;
  }
  const source = options as Record<string, unknown>;
  const keys = [
    ...ALWAYS_PRESENTATIONAL,
    ...(source.type === 'funnel' ? FUNNEL_ONLY_PRESENTATIONAL : []),
  ];
  if (!keys.some((key) => key in source)) {
    return options;
  }
  const next: Record<string, unknown> = { ...source };
  for (const key of keys) {
    delete next[key];
  }
  return next as T;
}

/**
 * Top-level report fields that are pure editor state. Neither appears in
 * `zReportInput`, so the server discards them anyway — but they DO sit in the
 * client's React Query key, so flipping one refetches for nothing.
 *
 * `dirty` is the one that bites: the first edit of a session flips it
 * false -> true, which refetched the funnel even after the options fix.
 * Deliberately NOT stripped: `id` (the server loads the saved report from it),
 * `shareId` and `bypassCache` (the cache middleware reads both).
 */
const EDITOR_ONLY_FIELDS = ['dirty', 'ready'] as const;

/**
 * Report-level wrapper: strips presentational option keys and editor-only
 * top-level fields, returning the same report object when there is nothing
 * to strip.
 */
export function stripPresentationalReportOptions<
  T extends { options?: unknown },
>(report: T): T {
  const options = report.options;
  const strippedOptions = stripPresentationalOptions(options);
  const source = report as Record<string, unknown>;
  const editorKeys = EDITOR_ONLY_FIELDS.filter((key) => key in source);
  if (strippedOptions === options && editorKeys.length === 0) {
    return report;
  }
  const next: Record<string, unknown> = { ...source };
  for (const key of editorKeys) {
    delete next[key];
  }
  if (strippedOptions !== options) {
    next.options = strippedOptions;
  }
  return next as T;
}
