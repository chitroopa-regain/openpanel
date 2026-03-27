import { useTRPC } from '@/integrations/trpc/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { AspectContainer } from '../aspect-container';
import { ReportChartEmpty } from '../common/empty';
import { ReportChartError } from '../common/error';
import { ReportChartLoading } from '../common/loading';
import { useReportChartContext } from '../context';
import { Chart } from './chart';
import CohortTable from './table';

export function ReportRetentionChart() {
  const { isLazyLoading, report, shareId } = useReportChartContext();
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
  const isEnabled =
    (firstEvent.length > 0 || !!firstCustomEventId) &&
    (secondEvent.length > 0 || !!secondCustomEventId) &&
    !isLazyLoading;

  const retentionOptions = report.options?.type === 'retention' ? report.options : undefined;
  const criteria = retentionOptions?.criteria ?? 'on_or_after';

  const trpc = useTRPC();
  const res = useQuery(
    trpc.chart.cohort.queryOptions(
      {
        firstEvent,
        secondEvent,
        firstCustomEventId,
        secondCustomEventId,
        firstEventFilters,
        secondEventFilters,
        projectId: report.projectId,
        range: report.range,
        startDate: report.startDate,
        endDate: report.endDate,
        criteria,
        interval: report.interval,
        shareId,
        id: 'id' in report ? report.id : undefined,
      },
      {
        placeholderData: keepPreviousData,
        staleTime: 1000 * 60 * 1,
        enabled: isEnabled,
      },
    ),
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

  return (
    <div className="col gap-4">
      <AspectContainer>
        <Chart data={res.data.data} />
      </AspectContainer>
      <CohortTable data={res.data.data} />
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
