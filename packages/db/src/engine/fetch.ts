import type { ISerieDataItem } from '@openpanel/common';
import { groupByLabels } from '@openpanel/common';
import { alphabetIds } from '@openpanel/constants';
import type {
  IChartCustomEvent,
  ICustomEventComponent,
  IGetChartDataInput,
} from '@openpanel/validation';
import { chQuery } from '../clickhouse/client';
import { db } from '../prisma-client';
import { getChartSql } from '../services/chart.service';
import type { ConcreteSeries, Plan } from './types';

/**
 * Fetch data for all event series in the plan
 * This handles breakdown expansion automatically via groupByLabels
 */
export type FetchResult = {
  series: ConcreteSeries[];
  queries: string[];
};

export async function fetch(plan: Plan): Promise<FetchResult> {
  const results: ConcreteSeries[] = [];
  const queries: string[] = [];

  // Process each event definition
  for (let i = 0; i < plan.definitions.length; i++) {
    const definition = plan.definitions[i]!;

    if (definition.type !== 'event' && definition.type !== 'custom_event') {
      // Skip formulas - they'll be handled in compute stage
      continue;
    }

    // Find the corresponding concrete series placeholder
    const placeholder = plan.concreteSeries.find(
      (cs) => cs.definitionId === definition.id
    );

    if (!placeholder) {
      continue;
    }

    // Resolve custom event components from PostgreSQL
    let customEventComponents: ICustomEventComponent[] | undefined;
    let eventName: string;
    let eventSegment: string;
    let eventFilters: IGetChartDataInput['event']['filters'] = [];
    let eventDisplayName: string | undefined;
    let eventProperty: string | undefined;

    if (definition.type === 'custom_event') {
      const customDef = definition as IChartCustomEvent;
      const customEvent = await db.customEvent.findUnique({
        where: { id: customDef.customEventId },
      });
      // Skip if custom event was deleted
      if (
        !customEvent ||
        !Array.isArray(customEvent.components) ||
        (customEvent.components as ICustomEventComponent[]).length === 0
      ) {
        continue;
      }
      customEventComponents = customEvent.components as ICustomEventComponent[];
      eventName = customEvent.name;
      eventSegment = customDef.segment;
      eventFilters = customDef.filters ?? [];
      eventDisplayName = customDef.displayName ?? eventName;
      eventProperty = customDef.property;
    } else {
      const event = definition as typeof definition & { type: 'event' };
      eventName = event.name;
      eventSegment = event.segment;
      eventFilters = event.filters;
      eventDisplayName = event.displayName;
      eventProperty = event.property;
    }

    // Build query input
    const queryInput: IGetChartDataInput = {
      event: {
        id: definition.id,
        name: eventName,
        segment: eventSegment as any,
        filters: eventFilters,
        displayName: eventDisplayName,
        property: eventProperty,
      },
      projectId: plan.input.projectId,
      startDate: plan.input.startDate,
      endDate: plan.input.endDate,
      breakdowns: plan.input.breakdowns,
      interval: plan.input.interval,
      chartType: plan.input.chartType,
      metric: plan.input.metric,
      previous: plan.input.previous ?? false,
      limit: plan.input.limit,
      offset: plan.input.offset,
    };

    // Execute query
    const sql = getChartSql({
      ...queryInput,
      timezone: plan.timezone,
      customEventComponents,
    });
    queries.push(sql);
    let queryResult = await chQuery<ISerieDataItem>(sql, {
      session_timezone: plan.timezone,
    });

    // Fallback: if no results with breakdowns, try without breakdowns
    if (queryResult.length === 0 && plan.input.breakdowns.length > 0) {
      const fallbackSql = getChartSql({
        ...queryInput,
        breakdowns: [],
        timezone: plan.timezone,
        customEventComponents,
      });
      queries.push(fallbackSql);
      queryResult = await chQuery<ISerieDataItem>(fallbackSql, {
        session_timezone: plan.timezone,
      });
    }

    // Group by labels (handles breakdown expansion)
    const groupedSeries = groupByLabels(queryResult);

    // Create concrete series for each grouped result
    groupedSeries.forEach((grouped) => {
      // Extract breakdown value from name array
      // If breakdowns exist, name[0] is event name, name[1+] are breakdown values
      const breakdownValue =
        plan.input.breakdowns.length > 0 && grouped.name.length > 1
          ? grouped.name.slice(1).join(' - ')
          : undefined;

      // Build breakdowns object: { country: 'SE', path: '/ewoqmepwq' }
      const breakdowns: Record<string, string> | undefined =
        plan.input.breakdowns.length > 0 && grouped.name.length > 1
          ? {}
          : undefined;

      if (breakdowns) {
        plan.input.breakdowns.forEach((breakdown, idx) => {
          const breakdownNamePart = grouped.name[idx + 1];
          if (breakdownNamePart) {
            breakdowns[breakdown.name] = breakdownNamePart;
          }
        });
      }

      // Build filters including breakdown value
      const filters = [...eventFilters];
      if (breakdownValue && plan.input.breakdowns.length > 0) {
        // Add breakdown filter
        plan.input.breakdowns.forEach((breakdown, idx) => {
          const breakdownNamePart = grouped.name[idx + 1];
          if (breakdownNamePart) {
            filters.push({
              id: `breakdown-${idx}`,
              name: breakdown.name,
              operator: 'is',
              value: [breakdownNamePart],
            });
          }
        });
      }

      const concrete: ConcreteSeries = {
        id: `${placeholder.id}-${grouped.name.join('-')}`,
        definitionId: definition.id ?? alphabetIds[i] ?? `series-${i}`,
        definitionIndex: i,
        name: grouped.name,
        context: {
          event: eventName,
          filters,
          breakdownValue,
          breakdowns,
        },
        data: grouped.data.map((item) => ({
          date: item.date,
          count: item.count,
          total_count: item.total_count,
        })),
        definition,
      };

      results.push(concrete);
    });
  }

  return { series: results, queries };
}
