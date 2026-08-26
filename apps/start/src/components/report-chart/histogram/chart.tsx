import { useQuery } from '@tanstack/react-query';
import { BookmarkIcon, UsersIcon } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useXAxisProps, useYAxisProps } from '../common/axis';
import {
  ChartClickMenu,
  type ChartClickMenuItem,
} from '../common/chart-click-menu';
import { ReportChartTooltip } from '../common/report-chart-tooltip';
import { ReportSeriesScreenshotsProvider } from '../common/report-series-screenshots';
import { ReportTable } from '../common/report-table';
import { useReportChartContext } from '../context';
import { useReportDisplayVisibility } from '../display-mode';
import { useRechartDataModel } from '@/hooks/use-rechart-data-model';
import { useTheme } from '@/hooks/use-theme';
import {
  getHiddenSeriesKeys,
  useVisibleSeries,
} from '@/hooks/use-visible-series';
import { useTRPC } from '@/integrations/trpc/react';
import { pushModal } from '@/modals';
import type { IChartData } from '@/trpc/client';
import { cn } from '@/utils/cn';
import { getChartColor } from '@/utils/theme';

interface Props {
  data: IChartData;
}

function BarHover({ x, y, width, height, top, left, right, bottom }: any) {
  const themeMode = useTheme();
  const styles = getComputedStyle(document.documentElement);
  const def100 = styles.getPropertyValue('--def-100');
  const def300 = styles.getPropertyValue('--def-300');
  const bg = themeMode?.theme === 'dark' ? def100 : def300;
  return (
    <rect
      {...{ x, y, width, height, top, left, right, bottom }}
      fill={bg}
      fillOpacity={0.5}
      rx="3"
    />
  );
}

export function Chart({ data }: Props) {
  const { showChart, showTable } = useReportDisplayVisibility();
  const {
    isEditMode,
    report: {
      previous,
      interval,
      projectId,
      startDate,
      endDate,
      range,
      series: reportSeries,
      breakdowns,
      audience,
      cohortFilter,
      options: reportOptions,
    },
    options: { hideXAxis, hideYAxis },
  } = useReportChartContext();

  const histogramOptions =
    reportOptions?.type === 'histogram' ? reportOptions : undefined;
  const isStacked = histogramOptions?.stacked ?? false;
  const trpc = useTRPC();
  const references = useQuery(
    trpc.reference.getChartReferences.queryOptions(
      {
        projectId,
        startDate,
        endDate,
        range,
      },
      {
        staleTime: 1000 * 60 * 10,
      }
    )
  );
  const hiddenSeriesIds = useMemo(
    () => getHiddenSeriesKeys(reportSeries),
    [reportSeries]
  );
  const { series, setVisibleSeries } = useVisibleSeries(
    data,
    undefined,
    hiddenSeriesIds
  );
  const rechartData = useRechartDataModel(series);
  const yAxisProps = useYAxisProps({
    hide: hideYAxis,
  });
  const xAxisProps = useXAxisProps({
    hide: hideXAxis,
    interval,
  });

  const getMenuItems = useCallback(
    (e: any, clickedData: any): ChartClickMenuItem[] => {
      const items: ChartClickMenuItem[] = [];

      if (!clickedData?.date) {
        return items;
      }

      // Which concrete chart series was clicked. Recharts puts it in the
      // payload's dataKey. Without it the drill-down falls back to the FIRST
      // metric, so clicking metric B (or one of its cohort buckets) would
      // silently query metric A.
      const validPayload = e.activePayload?.find(
        (p: any) =>
          p.dataKey &&
          p.dataKey !== 'calcStrokeDasharray' &&
          typeof p.dataKey === 'string' &&
          p.dataKey.includes(':count'),
      );
      const serieId = validPayload?.dataKey?.toString().replace(':count', '');

      // View Users - only show if we have projectId
      if (projectId) {
        items.push({
          label: 'View Users',
          icon: <UsersIcon size={16} />,
          onClick: () => {
            pushModal('ViewChartUsers', {
              type: 'chart',
              chartData: data,
              report: {
                projectId,
                series: reportSeries,
                breakdowns: breakdowns || [],
                // Without these the drill-down lists the UNFILTERED population
                // while the chart shows a cohort-filtered number.
                audience,
                cohortFilter,
                interval,
                startDate,
                endDate,
                range,
                previous,
                chartType: 'histogram',
                metric: 'sum',
              },
              date: clickedData.date,
              serieId,
            });
          },
        });
      }

      // Add Reference - always show
      items.push({
        label: 'Add Reference',
        icon: <BookmarkIcon size={16} />,
        onClick: () => {
          pushModal('AddReference', {
            datetime: new Date(clickedData.date).toISOString(),
          });
        },
      });

      return items;
    },
    [
      projectId,
      data,
      reportSeries,
      breakdowns,
      // Without these the handler keeps a STALE closure: changing the cohort
      // filter without touching the series would leave View Users querying the
      // previous (or unfiltered) population while the chart shows the new one.
      audience,
      cohortFilter,
      interval,
      startDate,
      endDate,
      range,
      previous,
    ]
  );

  return (
    <ReportSeriesScreenshotsProvider chartSeries={data.series}>
    <ReportChartTooltip.TooltipProvider references={references.data}>
      <ChartClickMenu getMenuItems={getMenuItems}>
        {showChart && (
        <div className={cn('h-full w-full', isEditMode && 'card p-4')}>
          <ResponsiveContainer>
            <BarChart data={rechartData}>
              <CartesianGrid
                className="stroke-def-200"
                strokeDasharray="3 3"
                vertical={false}
              />
              <Tooltip
                content={<ReportChartTooltip.Tooltip />}
                cursor={<BarHover />}
              />
              <YAxis {...yAxisProps} />
              <XAxis {...xAxisProps} scale={'auto'} type="category" />
              {previous
                ? series.map((serie) => {
                    return (
                      <Bar
                        dataKey={`${serie.id}:prev:count`}
                        fill={getChartColor(serie.index)}
                        fillOpacity={0.3}
                        key={`${serie.id}:prev`}
                        name={`${serie.id}:prev`}
                        radius={5}
                        stackId={isStacked ? 'prev' : undefined}
                      />
                    );
                  })
                : null}
              {series.map((serie) => {
                return (
                  <Bar
                    dataKey={`${serie.id}:count`}
                    fill={getChartColor(serie.index)}
                    fillOpacity={1}
                    key={serie.id}
                    name={serie.id}
                    radius={isStacked ? 0 : 4}
                    stackId={isStacked ? 'current' : undefined}
                  />
                );
              })}
              {references.data?.map((ref) => (
                <ReferenceLine
                  fontSize={10}
                  key={ref.id}
                  label={{
                    value: ref.title,
                    position: 'centerTop',
                    fill: '#334155',
                    fontSize: 12,
                  }}
                  stroke={'oklch(from var(--foreground) l c h / 0.1)'}
                  strokeDasharray={'3 3'}
                  x={ref.date.getTime()}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
          </div>
        )}
        {showTable && (
          <ReportTable
            data={data}
            setVisibleSeries={setVisibleSeries}
            visibleSeries={data.series}
          />
        )}
      </ChartClickMenu>
    </ReportChartTooltip.TooltipProvider>
    </ReportSeriesScreenshotsProvider>
  );
}
