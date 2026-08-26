import type { IChartEventFilter } from '@openpanel/validation';

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
    names: (selector.value ?? []).filter((v) => v != null).map(String),
    otherFilters: others,
  };
}
