import type { IChartEventFilter } from './types.validation';

// Lives in @openpanel/validation, not @openpanel/db, because the report editor
// and the chart components import it. Pulling it from @openpanel/db would drag
// Prisma and the ClickHouse client into the browser bundle — which is exactly
// what happened on the first attempt: Vite failed the client entry with
// "Outdated Optimize Dep" and the app rendered a degraded shell.

/**
 * Retention smuggles "which events" through a reserved filter named `name`
 * rather than through `series[].name`, which holds the wildcard `*`.
 *
 * Three separate call sites used to pull that apart POSITIONALLY — `filters[0]`
 * was assumed to be the reserved filter and `.slice(1)` to be everything else:
 * the retention chart, the SQL inspector, and the server's saved-report
 * extraction. Position is not identity. A report whose first filter was an
 * ordinary one (say `country is IN`) had that filter's VALUE read as the list
 * of event names, and the filter itself dropped from the query — an enabled,
 * confidently wrong retention query with no error anywhere.
 *
 * This module is the single place that pulls the shape apart, by predicate.
 */

/** The filter name retention reserves to carry the selected event names. */
const RESERVED = 'name';

export type RetentionSelection = {
  /** Selected event names. Empty means the slot is UNSET — never "match all". */
  names: string[];
  /** Every filter that is NOT the reserved selector, in original order. */
  otherFilters: IChartEventFilter[];
  /**
   * Set when the series cannot be interpreted. Callers must surface this rather
   * than querying: guessing narrows or widens the population silently.
   */
  error?: string;
};

type SeriesLike =
  | {
      type: 'event';
      name?: string;
      filters?: IChartEventFilter[] | null;
    }
  | {
      type: 'custom_event';
      filters?: IChartEventFilter[] | null;
    }
  | { type: 'formula' }
  | null
  | undefined;

/**
 * Split one retention slot into its selected event names and its real filters.
 *
 * Behaviour on every shape, so that no caller has to decide:
 *
 * - reserved filter NOT first     → found anyway; position is irrelevant
 * - no reserved filter            → names: [], slot UNSET (never a wildcard match)
 * - DUPLICATE reserved filters    → error; picking one narrows, unioning widens
 * - reserved filter, empty value  → names: [], and the filter is CONSUMED, not
 *                                   passed through: a live `name is []` matches
 *                                   nothing and would silently zero the chart
 * - `name` with a non-`is` operator → NOT the selector. It is a genuine
 *                                   exclusion (`name isNot X`), so it stays an
 *                                   ordinary filter and the slot has no selector
 * - custom events                 → carry no selector; all filters are ordinary
 */
export function extractRetentionSelection(serie: SeriesLike): RetentionSelection {
  if (!serie || serie.type === 'formula') {
    return { names: [], otherFilters: [] };
  }

  const filters = serie.filters ?? [];

  // A custom event is identified by customEventId, never by a name filter, so
  // every filter it carries is an ordinary one.
  if (serie.type === 'custom_event') {
    return { names: [], otherFilters: [...filters] };
  }

  const reserved = filters.filter(
    (filter) => filter.name === RESERVED && filter.operator === 'is',
  );
  const others = filters.filter((filter) => !reserved.includes(filter));

  if (reserved.length > 1) {
    return {
      names: [],
      otherFilters: others,
      error:
        'This series has more than one event-name filter, so which events it selects is ambiguous. Remove the extra one.',
    };
  }

  const selector = reserved[0];
  if (!selector) {
    return { names: [], otherFilters: [...filters] };
  }

  return {
    names: (selector.value ?? [])
      .filter((v: unknown) => v != null)
      .map(String),
    otherFilters: others,
  };
}

/**
 * Chart types that cap how many series they can use, and which kinds they can
 * use at all. Verified in the source, not inferred:
 *
 *   retention  — `event` + `custom_event` (chart.ts:1108-1109, :1273-1290)
 *   conversion — `event` + `custom_event` (conversion.service.ts -> resolveSeriesForFunnel)
 *   sankey     — `event` ONLY (onlyReportEvents, reports.service.ts)
 *   formulas   — usable by none of them
 *
 * ⚠️ `onlyReportEvents`'s own comment claims custom events are unsupported in
 * retention. That comment is stale — retention resolves them server-side. Do
 * not take it as the spec.
 */
export const CHART_SERIES_SUPPORT: Record<
  string,
  { kinds: Array<'event' | 'custom_event'>; cap: number }
> = {
  retention: { kinds: ['event', 'custom_event'], cap: 2 },
  conversion: { kinds: ['event', 'custom_event'], cap: 2 },
  // Sankey's cap depends on options.mode: 2 for 'between', 1 otherwise.
  // Entering sankey initialises mode 'after', so the cap ON ENTRY is 1.
  sankey: { kinds: ['event'], cap: 1 },
};

/**
 * Trim a series list to what the target chart type can actually run.
 *
 * Truncates over the SUPPORTED series, never over raw indices. Raw positional
 * truncation is unsafe: `[custom event, ordinary event]` entering non-`between`
 * sankey would keep the custom one as "the first", which the server then strips
 * via onlyReportEvents, failing with "Start and end events are required".
 */
export function fitSeriesToChartType<T extends { type: string }>(
  series: T[],
  chartType: string,
  options?: { sankeyMode?: string },
): { kept: T[]; removed: T[]; unsupported: T[]; overCap: T[] } {
  const support = CHART_SERIES_SUPPORT[chartType];
  if (!support) {
    return { kept: series, removed: [], unsupported: [], overCap: [] };
  }

  const cap =
    chartType === 'sankey'
      ? options?.sankeyMode === 'between'
        ? 2
        : 1
      : support.cap;

  const usable = series.filter((s) =>
    support.kinds.includes(s.type as 'event' | 'custom_event'),
  );
  const kept = usable.slice(0, cap);
  // Two DIFFERENT reasons, kept apart so the UI can state the real one. A
  // metric dropped because this chart type cannot evaluate it (a formula in
  // retention, a custom event in sankey) is not the same as one dropped
  // because the chart only has room for two.
  const unsupported = series.filter((s) => !usable.includes(s));
  const overCap = usable.filter((s) => !kept.includes(s));
  return { kept, removed: [...unsupported, ...overCap], unsupported, overCap };
}

/**
 * Convert one series INTO retention's shape: the selected event moves from
 * `name` into the reserved filter, and `name` becomes the wildcard.
 *
 * Everything else is carried: the user's own filters, firstTimeFilter, hidden,
 * displayName, property. A custom event has no name to move and passes through.
 */
export function toRetentionShape<T extends Record<string, any>>(serie: T): T {
  if (serie?.type !== 'event') return serie;

  const existing = extractRetentionSelection(serie as any);
  // Already in retention shape — do not re-wrap, which would bury the real
  // selector under a second one and make the series ambiguous.
  if (existing.names.length > 0) return serie;

  const name = serie.name;
  if (!name || name === '*') return serie;

  return {
    ...serie,
    name: '*',
    segment: 'user',
    filters: [
      { name: RESERVED, operator: 'is', value: [name] },
      ...(serie.filters ?? []),
    ],
  };
}

/**
 * Convert one series OUT of retention's shape, back to `name`.
 *
 * A slot matching several events cannot be represented by a single-event chart
 * type, so the first is kept and the rest dropped — the decision recorded in
 * the plan (match Mixpanel: truncate to fit, accept the loss). `droppedNames`
 * is returned so the caller can say so rather than changing a number in
 * silence.
 *
 * `segment` is NOT restored: retention coerces it to 'user' and the original is
 * not recoverable. Documented, deliberate loss.
 */
export function fromRetentionShape<T extends Record<string, any>>(
  serie: T,
): { serie: T; droppedNames: string[] } {
  if (serie?.type !== 'event') return { serie, droppedNames: [] };

  const { names, otherFilters } = extractRetentionSelection(serie as any);
  if (names.length === 0) {
    // A genuine wildcard with no selector stays unset rather than becoming the
    // literal event "*".
    return {
      serie: serie.name === '*' ? { ...serie, name: '' } : serie,
      droppedNames: [],
    };
  }

  return {
    serie: { ...serie, name: names[0], filters: otherFilters },
    droppedNames: names.slice(1),
  };
}
