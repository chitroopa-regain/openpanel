import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { AspectContainer } from '../aspect-container';
import { ReportChartEmpty } from '../common/empty';
import { ReportChartError } from '../common/error';
import { ReportTable } from '../common/report-table';
import { ReportSeriesScreenshotsProvider } from '../common/report-series-screenshots';
import { useReportChartContext } from '../context';
import { useReportDisplayVisibility } from '../display-mode';
import { useReportRevalidation } from '../use-report-revalidation';
import { Chart } from './chart';
import { useTRPC } from '@/integrations/trpc/react';
import {
  getHiddenSeriesKeys,
  useVisibleSeries,
} from '@/hooks/use-visible-series';
import type { IChartData } from '@/trpc/client';

export function ReportMetricChart() {
  const { isLazyLoading, report, shareId, options } = useReportChartContext();
  const trpc = useTRPC();
  const isHero = options.metricLayout === 'hero';
  const isPlainHero = isHero && options.metricSurface === 'plain';
  const { showChart, showTable } = useReportDisplayVisibility();

  const queryOptions = trpc.chart.aggregate.queryOptions(
    {
      ...report,
      shareId,
    },
    {
      placeholderData: keepPreviousData,
      staleTime: 1000 * 60 * 1,
      enabled: !isLazyLoading,
    }
  );
  const res = useQuery(queryOptions);
  useReportRevalidation(res, queryOptions.queryKey, () =>
    trpc.chart.aggregate.queryOptions({ ...report, shareId, bypassCache: true })
  );

  if (
    isLazyLoading ||
    res.isLoading ||
    (res.isFetching && !res.data?.series.length)
  ) {
    return <Loading />;
  }

  if (res.isError) {
    return <Error />;
  }

  if (!res.data || res.data?.series.length === 0) {
    return <Empty />;
  }

  return (
    <ReportSeriesScreenshotsProvider chartSeries={res.data.series}>
    <MetricContent data={res.data} isHero={isHero} isPlainHero={isPlainHero} />
    </ReportSeriesScreenshotsProvider>
  );
}

function MetricContent({
  data,
  isHero,
  isPlainHero,
}: {
  data: IChartData;
  isHero: boolean;
  isPlainHero: boolean;
}) {
  const { isEditMode, report } = useReportChartContext();
  const { showChart, showTable } = useReportDisplayVisibility();
  const hiddenSeriesIds = useMemo(
    () => getHiddenSeriesKeys(report.series),
    [report.series]
  );
  const { series, setVisibleSeries } = useVisibleSeries(
    data,
    isEditMode ? 20 : 4,
    hiddenSeriesIds
  );

  if (showChart && !showTable && isHero && !isPlainHero) {
    return (
      <AspectContainer className="max-h-[620px] min-h-[420px]">
        <Chart series={series} />
      </AspectContainer>
    );
  }

  return (
    <div className="col h-full gap-4">
      {showChart && <Chart series={series} />}
      {showTable && (
        <ReportTable
          data={data}
          setVisibleSeries={setVisibleSeries}
          visibleSeries={series}
        />
      )}
    </div>
  );
}

export function Loading() {
  return (
    <div className="flex h-[78px] flex-col justify-between p-4">
      <div className="h-3 w-1/2 animate-pulse rounded bg-def-200" />
      <div className="row items-end justify-between">
        <div className="h-6 w-1/3 animate-pulse rounded bg-def-200" />
        <div className="h-3 w-1/5 animate-pulse rounded bg-def-200" />
      </div>
    </div>
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
