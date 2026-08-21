import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
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
import { Combobox } from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';
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
  const savedTopN = retentionOptions?.topN ?? 20;
  const savedBreakdownSort =
    retentionOptions?.breakdownSort ?? 'profile_count_desc';
  const [topN, setTopN] = useState(savedTopN);
  const [breakdownSort, setBreakdownSort] = useState(savedBreakdownSort);

  useEffect(() => setTopN(savedTopN), [savedTopN]);
  useEffect(() => setBreakdownSort(savedBreakdownSort), [savedBreakdownSort]);
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
    topN,
    breakdownSort,
    breakdowns: report.breakdowns,
    interval: report.interval,
    // Retention builds its own input for chart.cohort rather than passing the
    // whole report, so the audience has to be forwarded explicitly. Omitting it
    // made the picker accept a cohort and change nothing.
    audience: report.audience,
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
  const showBreakdownControls =
    report.breakdowns.length > 0 && !isDashboardLayout;

  return (
    <>
      {showBreakdownControls && (
        <div className="mb-3 flex flex-wrap items-center justify-end gap-4">
          <div className="flex items-center gap-2">
            <Label className="mb-0 whitespace-nowrap">Sort by Profiles</Label>
            <Combobox
              align="end"
              items={[
                { label: 'High to Low', value: 'profile_count_desc' },
                { label: 'Low to High', value: 'profile_count_asc' },
              ]}
              onChange={(value) =>
                setBreakdownSort(
                  value === 'profile_count_asc'
                    ? 'profile_count_asc'
                    : 'profile_count_desc'
                )
              }
              placeholder="High to Low"
              value={breakdownSort}
            />
          </div>
          <div className="flex items-center gap-2">
            <Label className="mb-0 whitespace-nowrap">Show</Label>
            <Combobox
              align="end"
              items={[1, 3, 5, 10, 20].map((value) => ({
                label: `Top ${value}`,
                value: String(value),
              }))}
              onChange={(value) => setTopN(Number(value))}
              placeholder="Top 20"
              value={String(topN)}
            />
          </div>
        </div>
      )}
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
          <div
            className={isDashboardLayout ? 'min-h-0 overflow-auto' : undefined}
          >
            <CohortTable data={res.data.data} />
          </div>
        )}
      </div>
    </>
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
