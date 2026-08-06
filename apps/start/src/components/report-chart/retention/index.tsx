import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AspectContainer } from '../aspect-container';
import { ReportChartEmpty } from '../common/empty';
import { ReportChartError } from '../common/error';
import { ReportChartLoading } from '../common/loading';
import { useReportChartContext } from '../context';
import {
  getReportDisplayMode,
  getReportDisplayVisibility,
} from '../display-mode';
import { useReportRevalidation } from '../use-report-revalidation';
import { Chart } from './chart';
import CohortTable from './table';
import { useTRPC } from '@/integrations/trpc/react';

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Retention query state and its chart/table layouts are coordinated here.
export function ReportRetentionChart() {
  const { isLazyLoading, report, shareId, options } = useReportChartContext();
  const firstItem = report.series[0];
  const secondItem = report.series[1];

  const firstEvent =
    firstItem?.type === 'event'
      ? (firstItem.filters?.[0]?.value ?? []).map(String)
      : [];
  const firstCustomEventId =
    firstItem?.type === 'custom_event' ? firstItem.customEventId : undefined;
  const secondEvent =
    secondItem?.type === 'event'
      ? (secondItem.filters?.[0]?.value ?? []).map(String)
      : [];
  const secondCustomEventId =
    secondItem?.type === 'custom_event' ? secondItem.customEventId : undefined;

  // Extract additional filters (beyond filters[0] which is the event name).
  // For custom events, all filters are "outer" filters (no filters[0] event name).
  const firstEventFilters =
    firstItem?.type === 'event'
      ? (firstItem.filters ?? []).slice(1)
      : firstItem?.type === 'custom_event'
        ? (firstItem.filters ?? [])
        : [];
  const secondEventFilters =
    secondItem?.type === 'event'
      ? (secondItem.filters ?? []).slice(1)
      : secondItem?.type === 'custom_event'
        ? (secondItem.filters ?? [])
        : [];
  const firstEventFirstTimeFilter =
    firstItem?.type === 'event' || firstItem?.type === 'custom_event'
      ? !!firstItem.firstTimeFilter
      : false;
  const secondEventFirstTimeFilter =
    secondItem?.type === 'event' || secondItem?.type === 'custom_event'
      ? !!secondItem.firstTimeFilter
      : false;
  const retentionOptions =
    report.options?.type === 'retention' ? report.options : undefined;
  const criteria = retentionOptions?.criteria ?? 'on_or_after';
  const metric = retentionOptions?.metric;
  const property = retentionOptions?.property;
  const retentionUnit = retentionOptions?.retentionUnit ?? 'day';
  const propertyAverageDenominatorStep =
    retentionOptions?.propertyAverageDenominatorStep;
  const isEnabled =
    (firstEvent.length > 0 || !!firstCustomEventId) &&
    (secondEvent.length > 0 || !!secondCustomEventId) &&
    ((metric !== 'property_average' && metric !== 'property_sum') ||
      !!property) &&
    !isLazyLoading;

  const trpc = useTRPC();
  const cohortInput = {
    firstEvent,
    secondEvent,
    firstCustomEventId,
    secondCustomEventId,
    firstEventFilters,
    secondEventFilters,
    firstEventFirstTimeFilter,
    secondEventFirstTimeFilter,
    projectId: report.projectId,
    range: report.range,
    startDate: report.startDate,
    endDate: report.endDate,
    dateConfig: report.dateConfig,
    criteria,
    metric,
    property,
    propertyAverageDenominatorStep,
    retentionUnit,
    breakdowns: report.breakdowns,
    interval: report.interval,
    shareId,
    id: 'id' in report ? report.id : undefined,
  };
  const queryOptions = trpc.chart.cohort.queryOptions(cohortInput, {
    placeholderData: keepPreviousData,
    staleTime: 1000 * 60 * 1,
    enabled: isEnabled,
  });
  const res = useQuery(queryOptions);
  useReportRevalidation(res, queryOptions.queryKey, () =>
    trpc.chart.cohort.queryOptions({ ...cohortInput, bypassCache: true })
  );

  if (!isEnabled) {
    return <Disabled />;
  }

  if (isLazyLoading || res.isLoading) {
    return <Loading />;
  }

  if (res.isError) {
    return <Error />;
  }

  if (!res.data || res.data.data.length === 0) {
    return <Empty />;
  }

  const isDashboardLayout = options.retentionLayout === 'dashboard';
  const displayMode = getReportDisplayMode(
    report,
    options.displayLayout ?? (isDashboardLayout ? 'dashboard' : 'default')
  );
  const { showChart, showTable } = getReportDisplayVisibility(displayMode);

  return (
    <div
      className={
        isDashboardLayout
          ? `grid h-full min-h-0 w-full gap-2 ${showChart && showTable ? 'grid-rows-2' : 'grid-rows-1'}`
          : 'col gap-4'
      }
    >
      {showChart &&
        (isDashboardLayout ? (
          <div className="min-h-0 overflow-hidden">
            <Chart data={res.data.data} />
          </div>
        ) : (
          <AspectContainer>
            <Chart data={res.data.data} />
          </AspectContainer>
        ))}
      {showTable && (
        <div className={isDashboardLayout ? 'min-h-0 overflow-auto' : undefined}>
          <CohortTable data={res.data.data} />
        </div>
      )}
    </div>
  );
}

function Loading() {
  return (
    <AspectContainer>
      <ReportChartLoading />
    </AspectContainer>
  );
}

function Error() {
  return (
    <AspectContainer>
      <ReportChartError />
    </AspectContainer>
  );
}

function Empty() {
  return (
    <AspectContainer>
      <ReportChartEmpty />
    </AspectContainer>
  );
}

function Disabled() {
  return (
    <AspectContainer>
      <ReportChartEmpty title="Select 2 events">
        We need two events to determine the retention rate.
      </ReportChartEmpty>
    </AspectContainer>
  );
}
