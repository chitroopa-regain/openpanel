import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import {
  changeFunnelHiddenBreakdowns,
  changeFunnelTopN,
} from '../../../components/report/reportSlice';
import { AspectContainer } from '../aspect-container';
import { ReportChartEmpty } from '../common/empty';
import { ReportChartError } from '../common/error';
import { ReportChartLoading } from '../common/loading';
import { useReportChartContext } from '../context';
import { useReportRevalidation } from '../use-report-revalidation';
import { BreakdownList } from './breakdown-list';
import { Chart, Summary } from './chart';
import { useVisibleFunnelBreakdowns } from '@/hooks/use-visible-funnel-breakdowns';
import { useTRPC } from '@/integrations/trpc/react';
import { pushModal } from '@/modals';
import { useDispatch } from '@/redux';

export function ReportFunnelChart() {
  const { isLazyLoading, isEditMode, report, shareId } =
    useReportChartContext();
  const trpc = useTRPC();
  const queryOptions = trpc.chart.funnel.queryOptions(
    {
      ...report,
      shareId,
    },
    {
      enabled: !isLazyLoading && report.series.length > 0,
    }
  );
  const res = useQuery(queryOptions);
  useReportRevalidation(res, queryOptions.queryKey, () =>
    trpc.chart.funnel.queryOptions({ ...report, shareId, bypassCache: true })
  );

  const funnelOptions =
    report.options?.type === 'funnel' ? report.options : undefined;
  const savedTopN = funnelOptions?.topN ?? 10;
  const savedHiddenBreakdowns = funnelOptions?.hiddenBreakdowns;
  const dispatch = useDispatch();

  // Hook for limiting which breakdowns are shown in the chart only
  const {
    breakdowns: visibleBreakdowns,
    visibleSeriesIds,
    rankOf,
  } = useVisibleFunnelBreakdowns(
    res.data?.current ?? [],
    savedTopN,
    savedHiddenBreakdowns
  );

  const handleTopNChange = useCallback(
    (n: number | undefined) => {
      dispatch(changeFunnelTopN(n));
    },
    [dispatch]
  );

  const handleToggleVisibility = useCallback(
    (id: string) => {
      const isVisible = visibleSeriesIds.includes(id);
      const hidden = savedHiddenBreakdowns ?? [];
      if (isVisible) {
        // Hide: explicitly add to blocklist.
        dispatch(changeFunnelHiddenBreakdowns([...hidden, id]));
        return;
      }
      // Show: remove from hidden if present, and bump topN if rank is
      // below the current cutoff so the row actually becomes visible.
      if (hidden.includes(id)) {
        dispatch(changeFunnelHiddenBreakdowns(hidden.filter((h) => h !== id)));
      }
      const rank = rankOf(id);
      if (rank > 0 && rank > savedTopN) {
        dispatch(changeFunnelTopN(rank === 10 ? undefined : rank));
      }
    },
    [visibleSeriesIds, savedHiddenBreakdowns, savedTopN, rankOf, dispatch]
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
    [report, funnelOptions]
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
    <div className="col h-full gap-4">
      {isEditMode && hasBreakdowns && <Summary data={res.data} />}
      <Chart data={res.data} visibleBreakdowns={visibleBreakdowns} />
      {isEditMode && (
        <BreakdownList
          data={res.data}
          onInspectStep={handleInspectStep}
          onToggleVisibility={handleToggleVisibility}
          onTopNChange={handleTopNChange}
          savedTopN={savedTopN}
          visibleSeriesIds={visibleSeriesIds}
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
