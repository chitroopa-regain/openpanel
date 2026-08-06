import type { IReportInput } from '@openpanel/validation';
import { useQuery } from '@tanstack/react-query';
import { AspectContainer } from '../aspect-container';
import { ReportChartEmpty } from '../common/empty';
import { ReportChartError } from '../common/error';
import { ReportChartLoading } from '../common/loading';
import { useReportChartContext } from '../context';
import { useReportDisplayVisibility } from '../display-mode';
import { useReportRevalidation } from '../use-report-revalidation';
import { Chart } from './chart';
import { useTRPC } from '@/integrations/trpc/react';

export function ReportSankeyChart() {
  const {
    report: {
      series,
      range,
      projectId,
      options,
      startDate,
      endDate,
      breakdowns,
    },
    isLazyLoading,
  } = useReportChartContext();
  const { showChart, showTable } = useReportDisplayVisibility();

  if (!options) {
    return <Empty />;
  }

  const input: IReportInput = {
    series,
    range,
    projectId,
    interval: 'day',
    chartType: 'sankey',
    breakdowns,
    options,
    metric: 'sum',
    startDate,
    endDate,
    limit: 20,
    previous: false,
  };
  const trpc = useTRPC();
  const queryOptions = trpc.chart.sankey.queryOptions(input, {
    enabled: !isLazyLoading && input.series.length > 0,
  });
  const res = useQuery(queryOptions);
  useReportRevalidation(res, queryOptions.queryKey, () =>
    trpc.chart.sankey.queryOptions({ ...input, bypassCache: true })
  );

  if (isLazyLoading || res.isLoading) {
    return <Loading />;
  }

  if (res.isError) {
    return <Error />;
  }

  if (!res.data || res.data.nodes.length === 0) {
    return <Empty />;
  }

  return (
    <div className="col gap-4">
      {showChart && <Chart data={res.data} />}
      {showTable && (
        <div className="card max-h-full overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border border-b bg-def-100">
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">
                  From
                </th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">
                  To
                </th>
                <th className="px-4 py-2 text-right font-medium text-muted-foreground">
                  Users
                </th>
              </tr>
            </thead>
            <tbody>
              {res.data.links.map((link, index) => (
                <tr
                  className="border-border border-b last:border-0"
                  key={`${link.source}-${link.target}-${index}`}
                >
                  <td className="px-4 py-2">{link.source}</td>
                  <td className="px-4 py-2">{link.target}</td>
                  <td className="px-4 py-2 text-right font-mono font-semibold">
                    {link.value.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
