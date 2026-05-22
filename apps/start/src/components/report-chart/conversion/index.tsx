import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AspectContainer } from '../aspect-container';
import { ReportChartEmpty } from '../common/empty';
import { ReportChartError } from '../common/error';
import { ReportChartLoading } from '../common/loading';
import { useReportChartContext } from '../context';
import { useReportRevalidation } from '../use-report-revalidation';
import { Chart } from './chart';
import { Summary } from './summary';
import { useTRPC } from '@/integrations/trpc/react';

export function ReportConversionChart() {
  const { isLazyLoading, report, shareId } = useReportChartContext();
  const trpc = useTRPC();
  const queryOptions = trpc.chart.conversion.queryOptions(
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
    trpc.chart.conversion.queryOptions({
      ...report,
      shareId,
      bypassCache: true,
    })
  );

  if (
    isLazyLoading ||
    res.isLoading ||
    (res.isFetching && !res.data?.current.length)
  ) {
    return <Loading />;
  }

  if (res.isError) {
    return <Error />;
  }

  if (!res.data || res.data?.current.length === 0) {
    return <Empty />;
  }

  return (
    <div>
      <Summary data={res.data} />
      <AspectContainer>
        <Chart data={res.data} />
      </AspectContainer>
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
