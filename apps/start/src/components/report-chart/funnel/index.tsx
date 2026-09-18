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
import { useReportDisplayVisibility } from '../display-mode';
import { useReportRevalidation } from '../use-report-revalidation';
import { BreakdownList } from './breakdown-list';
import { Chart, Summary } from './chart';
import { useVisibleFunnelBreakdowns } from '@/hooks/use-visible-funnel-breakdowns';
import { stripPresentationalReportOptions } from '@openpanel/validation';
import { useTRPC } from '@/integrations/trpc/react';
import { pushModal } from '@/modals';
import { parseCohortSerieId } from '../cohort-serie-id';
import { useDispatch } from '@/redux';

export function ReportFunnelChart() {
  const { isLazyLoading, isEditMode, options, report, shareId } =
    useReportChartContext();
  const { showChart, showTable } = useReportDisplayVisibility();
  const trpc = useTRPC();
  // Hiding a breakdown row or changing topN only affects what is DRAWN, but
  // both live in `report.options`, and this spread puts them in the React Query
  // key. Unchecking a country therefore refetched a funnel that takes ~90s on
  // regain-app, to redraw data the client already had. Strip them here; the
  // server strips the same keys from its cache key in canonicalKey.
  const queryInput = stripPresentationalReportOptions(report);
  const queryOptions = trpc.chart.funnel.queryOptions(
    {
      ...queryInput,
      shareId,
    },
    {
      enabled: !isLazyLoading && report.series.length > 0,
    }
  );
  const res = useQuery(queryOptions);
  useReportRevalidation(res, queryOptions.queryKey, () =>
    trpc.chart.funnel.queryOptions({
      ...queryInput,
      shareId,
      bypassCache: true,
    })
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
    (stepIndex: number, breakdownValues?: string[], serieId?: string) => {
      const bucket = parseCohortSerieId(serieId);
      pushModal('ViewChartUsers', {
        type: 'funnel',
        report: {
          projectId: report.projectId,
          series: report.series,
          breakdowns: report.breakdowns || [],
          // The funnel's own cohort restriction. Without it the modal lists the
          // unfiltered population beside a filtered number.
          cohortFilters: report.cohortFilters,
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
        // Which bucket was clicked, and the instant the SERVER resolved
        // membership at — never re-derived here.
        ...(bucket ?? {}),
        membershipAsOf: res.data?.membershipAsOf,
      });
    },
    [report, funnelOptions, res.data?.membershipAsOf]
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
  const isDashboardBoth =
    options.displayLayout === 'dashboard' && showChart && showTable;
  const chart = (
    <Chart data={res.data} visibleBreakdowns={visibleBreakdowns} />
  );
  const table = (
    <BreakdownList
      data={res.data}
      onInspectStep={handleInspectStep}
      onToggleVisibility={handleToggleVisibility}
      onTopNChange={handleTopNChange}
      savedTopN={savedTopN}
      visibleSeriesIds={visibleSeriesIds}
    />
  );

  return (
    <div className="col h-full min-w-0 gap-4">
      {showChart && isEditMode && hasBreakdowns && <Summary data={res.data} />}
      {/* The dashboard chart uses h-full/min-h-0 internally. As a direct flex
          sibling of the scrollable table it can shrink to almost zero. Give
          both surfaces non-shrinking slots; ReportChart owns vertical scrolling
          when the card is too short, while BreakdownList keeps its own scroll. */}
      {showChart &&
        (isDashboardBoth ? (
          <div className="h-[320px] min-h-[320px] min-w-0 grow shrink-0">
            {chart}
          </div>
        ) : (
          chart
        ))}
      {showTable &&
        (isDashboardBoth ? (
          <div className="min-w-0 shrink-0">{table}</div>
        ) : (
          table
        ))}
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
