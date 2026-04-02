import { getPreviousMetric, groupByLabels } from '@openpanel/common';
import type { ISerieDataItem } from '@openpanel/common';
import { alphabetIds } from '@openpanel/constants';
import type {
  FinalChart,
  IChartCustomEvent,
  IChartEventItem,
  ICustomEventComponent,
  IReportInput,
} from '@openpanel/validation';
import { chQuery } from '../clickhouse/client';
import { db } from '../prisma-client';
import {
  getAggregateChartSql,
  getChartPrevStartEndDate,
} from '../services/chart.service';
import {
  getOrganizationSubscriptionChartEndDate,
  getSettingsForProject,
} from '../services/organization.service';
import { compute } from './compute';
import { fetch } from './fetch';
import { format } from './format';
import { normalize } from './normalize';
import { plan } from './plan';
import type { ConcreteSeries } from './types';

/**
 * Chart Engine - Main entry point
 * Executes the pipeline: normalize -> plan -> fetch -> compute -> format
 */
export async function executeChart(input: IReportInput): Promise<FinalChart> {
  // Stage 1: Normalize input
  const normalized = await normalize(input);

  // Handle subscription end date limit
  const endDate = await getOrganizationSubscriptionChartEndDate(
    input.projectId,
    normalized.endDate
  );
  if (endDate) {
    normalized.endDate = endDate;
  }

  // Stage 2: Create execution plan
  const executionPlan = await plan(normalized);

  // Stage 3: Fetch data for event series (current period)
  const fetchResult = await fetch(executionPlan);
  const allQueries = [...fetchResult.queries];

  // Stage 4: Compute formula series
  const computedSeries = compute(fetchResult.series, executionPlan.definitions);

  // Stage 5: Fetch previous period if requested
  let previousSeries: ConcreteSeries[] | null = null;
  if (input.previous) {
    const currentPeriod = {
      startDate: normalized.startDate,
      endDate: normalized.endDate,
    };
    const previousPeriod = getChartPrevStartEndDate(currentPeriod);

    const previousPlan = await plan({
      ...normalized,
      ...previousPeriod,
    });

    const previousFetchResult = await fetch(previousPlan);
    previousSeries = compute(
      previousFetchResult.series,
      previousPlan.definitions
    );
  }

  // Stage 6: Format final output with previous period data
  const includeAlphaIds = executionPlan.definitions.length > 1;
  const response = format(
    computedSeries,
    executionPlan.definitions,
    includeAlphaIds,
    previousSeries
  );

  return { ...response, queries: allQueries, timezone: executionPlan.timezone };
}

/**
 * Aggregate Chart Engine - Optimized for bar/pie charts without time series
 * Executes a simplified pipeline: normalize -> fetch aggregate -> format
 */
export async function executeAggregateChart(
  input: IReportInput
): Promise<FinalChart> {
  // Stage 1: Normalize input
  const normalized = await normalize(input);

  // Handle subscription end date limit
  const endDate = await getOrganizationSubscriptionChartEndDate(
    input.projectId,
    normalized.endDate
  );
  if (endDate) {
    normalized.endDate = endDate;
  }

  const { timezone } = await getSettingsForProject(normalized.projectId);

  // Stage 2: Fetch aggregate data for current period (event series only)
  const fetchedSeries: ConcreteSeries[] = [];
  const allQueries: string[] = [];

  for (let i = 0; i < normalized.series.length; i++) {
    const definition = normalized.series[i]!;

    if (definition.type !== 'event' && definition.type !== 'custom_event') {
      // Skip formulas - they'll be computed in the next stage
      continue;
    }

    // Resolve custom event components
    let customEventComponents: ICustomEventComponent[] | undefined;
    let eventName: string;
    let eventSegment: string;
    let eventFilters: IChartEventItem extends { filters: infer F } ? F : never =
      [] as any;
    let eventDisplayName: string | undefined;
    let eventProperty: string | undefined;

    if (definition.type === 'custom_event') {
      const customDef = definition as IChartCustomEvent;
      const customEvent = await db.customEvent.findUnique({
        where: { id: customDef.customEventId },
      });
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
      const event = definition as IChartEventItem & { type: 'event' };
      eventName = event.name;
      eventSegment = event.segment;
      eventFilters = event.filters;
      eventDisplayName = event.displayName;
      eventProperty = event.property;
    }

    // Extract firstTimeFilter
    const eventFirstTimeFilter =
      definition.type === 'custom_event'
        ? (definition as IChartCustomEvent).firstTimeFilter
        : definition.type === 'event'
          ? (definition as IChartEventItem & { type: 'event' }).firstTimeFilter
          : undefined;

    // Build query input
    const queryInput = {
      event: {
        id: definition.id,
        name: eventName,
        segment: eventSegment as any,
        filters: eventFilters,
        displayName: eventDisplayName,
        property: eventProperty,
        firstTimeFilter: eventFirstTimeFilter,
      },
      projectId: normalized.projectId,
      startDate: normalized.startDate,
      endDate: normalized.endDate,
      breakdowns: normalized.breakdowns,
      limit: normalized.limit,
      metric: normalized.metric,
      previous: normalized.previous,
      timezone,
      customEventComponents,
    };

    // Execute aggregate query
    const sql = getAggregateChartSql(queryInput);
    allQueries.push(sql);
    let queryResult = await chQuery<ISerieDataItem>(sql, {
      session_timezone: timezone,
    });

    // Fallback: if no results with breakdowns, try without breakdowns
    if (queryResult.length === 0 && normalized.breakdowns.length > 0) {
      const fallbackSql = getAggregateChartSql({
        ...queryInput,
        breakdowns: [],
      });
      allQueries.push(fallbackSql);
      queryResult = await chQuery<ISerieDataItem>(fallbackSql, {
        session_timezone: timezone,
      });
    }

    // Group by labels (handles breakdown expansion)
    const groupedSeries = groupByLabels(queryResult);

    // Create concrete series for each grouped result
    groupedSeries.forEach((grouped) => {
      // Extract breakdown value from name array
      const breakdownValue =
        normalized.breakdowns.length > 0 && grouped.name.length > 1
          ? grouped.name.slice(1).join(' - ')
          : undefined;

      // Build breakdowns object
      const breakdowns: Record<string, string> | undefined =
        normalized.breakdowns.length > 0 && grouped.name.length > 1
          ? {}
          : undefined;

      if (breakdowns) {
        normalized.breakdowns.forEach((breakdown, idx) => {
          const breakdownNamePart = grouped.name[idx + 1];
          if (breakdownNamePart) {
            breakdowns[breakdown.name] = breakdownNamePart;
          }
        });
      }

      // Build filters including breakdown value
      const filters = [...eventFilters];
      if (breakdownValue && normalized.breakdowns.length > 0) {
        normalized.breakdowns.forEach((breakdown, idx) => {
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

      // For aggregate charts, grouped.data should have a single data point
      // (since we use a constant date in the query)
      const concrete: ConcreteSeries = {
        id: `${eventName}-${grouped.name.join('-')}-${i}`,
        definitionId: definition.id ?? alphabetIds[i] ?? `series-${i}`,
        definitionIndex: i,
        name: grouped.name,
        context: {
          event: eventName,
          filters,
          breakdownValue,
          breakdowns,
        },
        data: grouped.data,
        definition,
      };

      fetchedSeries.push(concrete);
    });
  }

  // Stage 3: Compute formula series from fetched event series
  const computedSeries = compute(fetchedSeries, normalized.series);

  // Stage 4: Fetch previous period if requested
  let previousSeries: ConcreteSeries[] | null = null;
  if (input.previous) {
    const currentPeriod = {
      startDate: normalized.startDate,
      endDate: normalized.endDate,
    };
    const previousPeriod = getChartPrevStartEndDate(currentPeriod);

    const previousFetchedSeries: ConcreteSeries[] = [];

    for (let i = 0; i < normalized.series.length; i++) {
      const definition = normalized.series[i]!;

      if (definition.type !== 'event' && definition.type !== 'custom_event') {
        continue;
      }

      // Resolve custom event components (same logic as current period)
      let prevCustomEventComponents: ICustomEventComponent[] | undefined;
      let prevEventName: string;
      let prevEventSegment: string;
      let prevEventFilters: any[] = [];
      let prevEventDisplayName: string | undefined;
      let prevEventProperty: string | undefined;

      if (definition.type === 'custom_event') {
        const customDef = definition as IChartCustomEvent;
        const customEvent = await db.customEvent.findUnique({
          where: { id: customDef.customEventId },
        });
        if (
          !customEvent ||
          !Array.isArray(customEvent.components) ||
          (customEvent.components as ICustomEventComponent[]).length === 0
        ) {
          continue;
        }
        prevCustomEventComponents =
          customEvent.components as ICustomEventComponent[];
        prevEventName = customEvent.name;
        prevEventSegment = customDef.segment;
        prevEventFilters = customDef.filters ?? [];
        prevEventDisplayName = customDef.displayName ?? prevEventName;
        prevEventProperty = customDef.property;
      } else {
        const event = definition as IChartEventItem & { type: 'event' };
        prevEventName = event.name;
        prevEventSegment = event.segment;
        prevEventFilters = event.filters;
        prevEventDisplayName = event.displayName;
        prevEventProperty = event.property;
      }

      const queryInput = {
        event: {
          id: definition.id,
          name: prevEventName,
          segment: prevEventSegment as any,
          filters: prevEventFilters,
          displayName: prevEventDisplayName,
          property: prevEventProperty,
        },
        projectId: normalized.projectId,
        startDate: previousPeriod.startDate,
        endDate: previousPeriod.endDate,
        breakdowns: normalized.breakdowns,
        limit: normalized.limit,
        metric: normalized.metric,
        previous: normalized.previous,
        timezone,
        customEventComponents: prevCustomEventComponents,
      };

      const prevSql = getAggregateChartSql(queryInput);
      let queryResult = await chQuery<ISerieDataItem>(prevSql, {
        session_timezone: timezone,
      });

      if (queryResult.length === 0 && normalized.breakdowns.length > 0) {
        const prevFallbackSql = getAggregateChartSql({
          ...queryInput,
          breakdowns: [],
        });
        queryResult = await chQuery<ISerieDataItem>(prevFallbackSql, {
          session_timezone: timezone,
        });
      }

      const groupedSeries = groupByLabels(queryResult);

      groupedSeries.forEach((grouped) => {
        const breakdownValue =
          normalized.breakdowns.length > 0 && grouped.name.length > 1
            ? grouped.name.slice(1).join(' - ')
            : undefined;

        const breakdowns: Record<string, string> | undefined =
          normalized.breakdowns.length > 0 && grouped.name.length > 1
            ? {}
            : undefined;

        if (breakdowns) {
          normalized.breakdowns.forEach((breakdown, idx) => {
            const breakdownNamePart = grouped.name[idx + 1];
            if (breakdownNamePart) {
              breakdowns[breakdown.name] = breakdownNamePart;
            }
          });
        }

        const filters = [...prevEventFilters];
        if (breakdownValue && normalized.breakdowns.length > 0) {
          normalized.breakdowns.forEach((breakdown, idx) => {
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
          id: `${prevEventName}-${grouped.name.join('-')}-${i}`,
          definitionId: definition.id ?? alphabetIds[i] ?? `series-${i}`,
          definitionIndex: i,
          name: grouped.name,
          context: {
            event: prevEventName,
            filters,
            breakdownValue,
            breakdowns,
          },
          data: grouped.data,
          definition,
        };

        previousFetchedSeries.push(concrete);
      });
    }

    // Compute formula series for previous period
    previousSeries = compute(previousFetchedSeries, normalized.series);
  }

  // Stage 5: Format final output with previous period data
  const includeAlphaIds = normalized.series.length > 1;
  const response = format(
    computedSeries,
    normalized.series,
    includeAlphaIds,
    previousSeries,
    normalized.limit
  );

  return { ...response, queries: allQueries, timezone };
}

// Export as ChartEngine for backward compatibility
export const ChartEngine = {
  execute: executeChart,
};

// Export aggregate chart engine
export const AggregateChartEngine = {
  execute: executeAggregateChart,
};
