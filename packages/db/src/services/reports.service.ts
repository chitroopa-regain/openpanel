import {
  alphabetIds,
  deprecated_timeRanges,
  lineTypes,
  timeWindows,
} from '@openpanel/constants';
import type {
  ICohortBreakdown,
  IReportAudience,
  IChartBreakdown,
  IChartEventFilter,
  IChartEventItem,
  IChartLineType,
  IChartRange,
  IReport,
  IReportOptions,
} from '@openpanel/validation';

import type { Report as DbReport, ReportLayout } from '../prisma-client';
import { db } from '../prisma-client';

export type IServiceReport = Awaited<ReturnType<typeof getReportById>>;

export const onlyReportEvents = (
  series: NonNullable<IServiceReport>['series']
) => {
  // Only include real events — custom events lack .name/.filters
  // and are not supported in funnels/conversions/retention
  return series.filter((item) => item.type === 'event');
};

export function transformFilter(
  filter: Partial<IChartEventFilter>,
  index: number
): IChartEventFilter {
  return {
    id: filter.id ?? alphabetIds[index] ?? 'A',
    name: filter.name ?? 'Unknown Filter',
    operator: filter.operator ?? 'is',
    value:
      typeof filter.value === 'string' ? [filter.value] : (filter.value ?? []),
  };
}

export function transformReportEventItem(
  item: IChartEventItem,
  index: number
): IChartEventItem {
  if (item.type === 'formula') {
    // Transform formula
    return {
      type: 'formula',
      id: item.id ?? alphabetIds[index]!,
      formula: item.formula || '',
      displayName: item.displayName,
      hidden: item.hidden,
    };
  }

  if (item.type === 'custom_event') {
    return {
      type: 'custom_event',
      id: item.id ?? alphabetIds[index]!,
      customEventId: item.customEventId,
      displayName: item.displayName,
      hidden: item.hidden,
      segment: item.segment ?? 'event',
      filters: (item.filters ?? []).map(transformFilter),
      property: item.property,
      firstTimeFilter: item.firstTimeFilter,
    };
  }

  // Transform event with type field
  return {
    type: 'event',
    segment: item.segment ?? 'event',
    filters: (item.filters ?? []).map(transformFilter),
    id: item.id ?? alphabetIds[index]!,
    name: item.name || 'unknown_event',
    displayName: item.displayName,
    hidden: item.hidden,
    property: item.property,
    firstTimeFilter: item.firstTimeFilter,
  };
}

export function transformReport(
  report: DbReport & { layout?: ReportLayout | null }
): IReport & {
  id: string;
  layout?: ReportLayout | null;
  dashboardId: string;
} {
  const options = report.options as IReportOptions | null | undefined;

  return {
    id: report.id,
    dashboardId: report.dashboardId,
    projectId: report.projectId,
    name: report.name || 'Untitled',
    chartType: report.chartType,
    lineType: (report.lineType as IChartLineType) ?? lineTypes.monotone,
    interval: report.interval,
    series:
      (report.events as IChartEventItem[]).map(transformReportEventItem) ?? [],
    breakdowns: report.breakdowns as IChartBreakdown[],
    range:
      report.range in deprecated_timeRanges && !(report.range in timeWindows)
        ? '30d'
        : (report.range as IChartRange),
    previous: report.previous ?? false,
    formula: report.formula ?? undefined,
    metric: report.metric ?? 'sum',
    unit: report.unit ?? undefined,
    layout: report.layout ?? undefined,
    options: options ?? undefined,
    dateConfig: (report as any).dateConfig ?? undefined,
    audience: ((report as any).audience as IReportAudience) ?? undefined,
    cohortBreakdown:
      ((report as any).cohortBreakdown as ICohortBreakdown) ?? undefined,
  };
}

export function getReportsByDashboardId(dashboardId: string) {
  return db.report
    .findMany({
      where: {
        dashboardId,
      },
      include: {
        layout: true,
      },
      // Order by saved grid position so the dashboard's responsive repack
      // renders tiles in row/column order. createdAt is a tiebreaker so a
      // freshly-duplicated report (which copies its source's layout) sits
      // right after the source.
      orderBy: [
        { layout: { y: 'asc' } },
        { layout: { x: 'asc' } },
        { createdAt: 'asc' },
      ],
    })
    .then((reports) => reports.map(transformReport));
}

export async function getReportById(id: string) {
  const report = await db.report.findUnique({
    where: {
      id,
    },
    include: {
      layout: true,
    },
  });

  if (!report) {
    return null;
  }

  return transformReport(report);
}
