import { alphabetIds } from '@openpanel/constants';
import type {
  IChartEvent,
  IChartEventItem,
  IReportInput,
  IReportInputWithDates,
} from '@openpanel/validation';
import { getChartStartEndDate } from '../services/chart.service';
import { getSettingsForProject } from '../services/organization.service';
import type { SeriesDefinition } from './types';

export type NormalizedInput = Awaited<ReturnType<typeof normalize>>;

/**
 * Normalize a chart input into a clean structure with dates and normalized series
 */
export async function normalize(
  input: IReportInput,
): Promise<IReportInputWithDates & { series: SeriesDefinition[] }> {
  const { timezone } = await getSettingsForProject(input.projectId);
  const { startDate, endDate } = getChartStartEndDate(
    {
      range: input.range,
      startDate: input.startDate ?? undefined,
      endDate: input.endDate ?? undefined,
      dateConfig: input.dateConfig,
    },
    timezone,
  );

  // Get series from input (handles both 'series' and 'events' fields)
  // The schema preprocessing should have already converted 'events' to 'series', but handle both for safety
  const rawSeries = (input as any).series ?? (input as any).events ?? [];

  // Normalize each series item
  const normalizedSeries: SeriesDefinition[] = rawSeries.map(
    (item: any, index: number) => {
      // If item already has type field, it's the new format
      if (item && typeof item === 'object' && 'type' in item) {
        return {
          ...item,
          id: item.id ?? alphabetIds[index] ?? `series-${index}`,
        } as SeriesDefinition;
      }

      // Old format without type field - assume it's an event
      const event = item as Partial<IChartEvent>;
      return {
        type: 'event',
        id: event.id ?? alphabetIds[index] ?? `series-${index}`,
        name: event.name || 'unknown_event',
        segment: event.segment ?? 'event',
        filters: event.filters ?? [],
        displayName: event.displayName,
        property: event.property,
        // Carried explicitly. This branch rebuilds the event field-by-field
        // rather than spreading, so anything not named here is silently lost.
        firstTimeFilter: event.firstTimeFilter,
      } as SeriesDefinition;
    },
  );

  // Cohort breakdown and property breakdowns are mutually exclusive: allowing
  // both means K x M series (5 cohorts x 40 countries = 200 queries). Reject it
  // rather than silently dropping one, which would show a chart that is not the
  // one the user asked for.
  if (
    (input.cohortBreakdown?.cohortIds?.length ?? 0) > 0 &&
    (input.breakdowns?.length ?? 0) > 0
  ) {
    throw new Error(
      'A cohort breakdown cannot be combined with a property breakdown. Remove one of them.',
    );
  }

  return {
    ...input,
    series: normalizedSeries,
    startDate,
    endDate,
  };
}

