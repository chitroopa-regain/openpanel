import { useTRPC } from '@/integrations/trpc/react';
import type { RouterOutputs } from '@/trpc/client';
import { useQuery } from '@tanstack/react-query';

import { AspectContainer } from '../aspect-container';
import { ReportChartEmpty } from '../common/empty';
import { ReportChartError } from '../common/error';
import { ReportChartLoading } from '../common/loading';
import { useReportChartContext } from '../context';
import { useVisibleFunnelBreakdowns } from '@/hooks/use-visible-funnel-breakdowns';
import { useDispatch } from '@/redux';
import { pushModal } from '@/modals';
import { useCallback } from 'react';
import { changeFunnelTopN } from '../../../components/report/reportSlice';
import { Chart, Summary } from './chart';
import { BreakdownList } from './breakdown-list';

export function ReportFunnelChart() {
  const { isLazyLoading, isEditMode, report, shareId } =
    useReportChartContext();
  const trpc = useTRPC();
  const res = useQuery(
    trpc.chart.funnel.queryOptions(
      {
        ...report,
        shareId,
      },
      {
        enabled: !isLazyLoading && report.series.length > 0,
      },
    ),
  );

  const funnelOptions =
    report.options?.type === 'funnel' ? report.options : undefined;
  const savedTopN = funnelOptions?.topN ?? 10;
  const dispatch = useDispatch();

  // Hook for limiting which breakdowns are shown in the chart only
  const { breakdowns: visibleBreakdowns, setVisibleSeries } =
    useVisibleFunnelBreakdowns(res.data?.current ?? [], savedTopN);

  const handleTopNChange = useCallback(
    (n: number | undefined) => {
      dispatch(changeFunnelTopN(n));
    },
    [dispatch],
  );

  const handleInspectStep = useCallback(
    (stepIndex: number, breakdownValues?: string[]) => {
      pushModal('ViewChartUsers', {
        type: 'funnel',
        report: {
          projectId: report.projectId,
          series: report.series,
          breakdowns: report.breakdowns || [],
          interval: report.interval || 'day',
          startDate: report.startDate,
          endDate: report.endDate,
          range: report.range,
          previous: report.previous,
          chartType: 'funnel',
          metric: 'sum',
          options: funnelOptions,
          dateConfig: report.dateConfig,
        },
        stepIndex,
        breakdownValues,
      });
    },
    [report, funnelOptions],
  );

  if (isLazyLoading || res.isLoading) {
    return <Loading />;
  }

  if (res.isError) {
    return <Error />;
  }

  if (!res.data || res.data.current.length === 0) {
    return <Empty />;
  }

  const hasBreakdowns = res.data.current.length > 1;

  return (
    <div className="col gap-4">
      {isEditMode && hasBreakdowns && <Summary data={res.data} />}
      <Chart data={res.data} visibleBreakdowns={visibleBreakdowns} />
      {isEditMode && (
        <BreakdownList
          data={res.data}
          visibleSeriesIds={visibleBreakdowns.map((b) => b.id)}
          setVisibleSeries={setVisibleSeries}
          onInspectStep={handleInspectStep}
          savedTopN={savedTopN}
          onTopNChange={handleTopNChange}
        />
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
