import { average, round } from '@openpanel/common';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useXAxisProps, useYAxisProps } from '../common/axis';
import {
  ReportSeriesScreenshot,
  ReportSeriesScreenshotsProvider,
} from '../common/report-series-screenshots';
import { useReportChartContext } from '../context';
import type { CohortRow } from './table';
import { RetentionTooltip } from './tooltip';
import type { RouterOutputs } from '@/trpc/client';
import { cn } from '@/utils/cn';
import { getChartColor } from '@/utils/theme';

interface Props {
  // Rows may carry a custom-cohort bucket identity; see table.tsx.
  data: CohortRow[];
}

export function toChartValue(
  value: number | string | null | undefined,
  isPercentage: boolean
) {
  if (value === null || value === undefined) {
    return null;
  }
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return null;
  }
  return isPercentage ? numericValue * 100 : numericValue;
}

function getNiceTicks(max: number, isPercentage: boolean): number[] {
  if (max <= 0) {
    return isPercentage ? [0, 0.5, 1] : [0, 5, 10];
  }
  const steps = isPercentage
    ? [0.25, 0.5, 1, 2, 5, 10, 20, 25, 50]
    : [1, 2, 5, 10, 20, 50, 100, 200, 500];
  for (const step of steps) {
    const top = Math.ceil(max / step) * step;
    if (top >= max * 1.05) {
      const ticks: number[] = [];
      for (let value = 0; value <= top; value += step) {
        ticks.push(value);
      }
      if (ticks.length >= 3 && ticks.length <= 8) {
        return ticks;
      }
    }
  }
  return [0, Math.ceil(max)];
}

function getBreakdownChartState(data: Props['data'], isPercentage: boolean) {
  const averageRows = data.filter(
    (row) => row.cohort_interval === 'Weighted Average'
  );
  const averageRow = averageRows[0];
  const hasBreakdowns = averageRows.some(
    (row) =>
      row.breakdowns.length > 0 ||
      Boolean((row as { cohortKey?: string }).cohortKey),
  );
  const dataSource = isPercentage
    ? averageRow?.percentages
    : averageRow?.values;
  const rechartData = hasBreakdowns
    ? Array.from({
        length: Math.max(...averageRows.map((row) => row.values.length), 0),
      }).map((_, dayIndex) => ({
        days: dayIndex,
        ...Object.fromEntries(
          averageRows.map((row, seriesIndex) => [
            `series_${seriesIndex}`,
            toChartValue(
              isPercentage
                ? row.percentages[dayIndex]
                : row.values[dayIndex],
              isPercentage
            ),
          ])
        ),
      }))
    : dataSource?.map((item, index) => ({
        days: index,
        percentage: toChartValue(item as number | string | null, isPercentage),
        value: averageRow?.values?.[index],
        sum: averageRow?.sum,
      }));
  const dataMax = hasBreakdowns
    ? Math.max(
        ...averageRows.flatMap((row) =>
          isPercentage
            ? row.percentages
                .filter((value): value is number => value !== null)
                .map((value) => value * 100)
            : row.values.filter((value): value is number => value !== null)
        ),
        0
      )
    : Math.max(
        ...(dataSource
          ?.filter((value): value is number => value !== null)
          .map((value) =>
            toChartValue(value as number | string | null, isPercentage) ?? 0
          ) ?? [0])
      );

  return { averageRow, averageRows, dataMax, hasBreakdowns, rechartData };
}

export function Chart({ data }: Props) {
  const {
    report: {
      breakdowns,
      interval,
      options: reportOptions,
      series,
      unit,
    },
    isEditMode,
    options: { hideXAxis, hideYAxis, retentionLayout },
  } = useReportChartContext();
  const isPropertyMeasure =
    reportOptions?.type === 'retention' &&
    (reportOptions.metric === 'property_average' ||
      reportOptions.metric === 'property_sum');
  const isPercentage = !isPropertyMeasure && unit === '%';
  const isDashboardLayout = retentionLayout === 'dashboard';

  const xAxisProps = useXAxisProps({ interval, hide: hideXAxis });
  const yAxisProps = useYAxisProps({
    hide: hideYAxis,
    tickFormatter: isPercentage ? (value) => `${value}%` : undefined,
  });
  const { averageRow, averageRows, dataMax, hasBreakdowns, rechartData } =
    getBreakdownChartState(data, isPercentage);
  const normalizedAverageValues = (
    isPercentage ? averageRow?.percentages : averageRow?.values
  )
    ?.map((value) =>
      toChartValue(value as number | string | null, isPercentage)
    )
    .filter((value): value is number => value !== null);
  const averageRetentionRate = average(normalizedAverageValues || [], true);
  const breakdownTooltipFormatter = (value: number | string) => {
    const roundedValue = round(Number(value), 2);
    return isPercentage ? `${roundedValue}%` : roundedValue;
  };
  const yTicks = getNiceTicks(dataMax, isPercentage);
  const yMax = yTicks.at(-1) ?? 100;
  const retentionEvent = series[0];
  const screenshotSeries =
    retentionEvent?.type === 'event'
      ? averageRows.map((row, index) => ({
          id: `retention:${index}`,
          serieType: 'event' as const,
          event: {
            id: retentionEvent.id,
            name: retentionEvent.name,
            breakdowns: Object.fromEntries(
              breakdowns.map((breakdown, breakdownIndex) => [
                breakdown.name,
                row.breakdowns[breakdownIndex] ?? null,
              ])
            ),
          },
        }))
      : [];
  /**
   * A row's series name. A custom-cohort bucket carries its label instead of
   * property-breakdown values, and its `breakdowns` are empty — reading them
   * alone rendered every bucket as "(not set)".
   */
  const rowLabel = (row: { breakdowns: string[]; cohortLabel?: string }) =>
    row.cohortLabel ?? (row.breakdowns.join(' / ') || '(not set)');

  const breakdownLegend = () => (
    <div className="flex flex-wrap justify-center gap-3 text-xs">
      {averageRows.map((row, index) => (
        <div className="flex items-center gap-1" key={`retention:${index}`}>
          <ReportSeriesScreenshot
            eventName={`${retentionEvent?.type === 'event' ? retentionEvent.name : 'Retention'} — ${rowLabel(row)}`}
            serieId={`retention:${index}`}
            showNoMatch={false}
          />
          <span>{rowLabel(row)}</span>
        </div>
      ))}
    </div>
  );

  return (
    <ReportSeriesScreenshotsProvider chartSeries={screenshotSeries as never}>
      <div
        className={cn(
          'h-full min-h-0 w-full',
          isDashboardLayout && 'pt-2',
          isEditMode && 'card p-4'
        )}
      >
        <ResponsiveContainer>
          <ComposedChart
            data={rechartData}
            margin={
              isDashboardLayout
                ? { top: 8, right: 8, bottom: 4, left: 0 }
                : undefined
            }
          >
            <CartesianGrid
              className="stroke-border"
              horizontal={true}
              strokeDasharray="3 3"
              vertical={true}
            />
            <YAxis {...yAxisProps} domain={[0, yMax]} ticks={yTicks} />
            <XAxis
              {...xAxisProps}
              allowDuplicatedCategory
              dataKey="days"
              interval={isDashboardLayout ? 'preserveStartEnd' : 0}
              scale="linear"
              tickCount={31}
              tickFormatter={(value) => value.toString()}
            />
            <Tooltip
              content={hasBreakdowns ? undefined : <RetentionTooltip />}
              formatter={hasBreakdowns ? breakdownTooltipFormatter : undefined}
            />
            {hasBreakdowns && (
              <Legend content={breakdownLegend} verticalAlign="top" />
            )}
            <defs>
              <linearGradient id={'color'} x1="0" x2="0" y1="0" y2="1">
                <stop
                  offset="0%"
                  stopColor={getChartColor(0)}
                  stopOpacity={0.8}
                />
                <stop
                  offset="100%"
                  stopColor={getChartColor(0)}
                  stopOpacity={0.1}
                />
              </linearGradient>
            </defs>
            {!hasBreakdowns && (
              <>
                <ReferenceLine
                  label={{
                    value: isPercentage
                      ? `Average (${round(averageRetentionRate, 2)} %)`
                      : `Average (${round(averageRetentionRate, 0)})`,
                    fill: getChartColor(1),
                    position: 'insideBottomRight',
                    fontSize: 12,
                  }}
                  stroke={getChartColor(1)}
                  strokeDasharray="3 3"
                  strokeLinecap="round"
                  strokeOpacity={0.5}
                  strokeWidth={2}
                  y={averageRetentionRate}
                />
                <Area
                  dataKey="percentage"
                  fill={'url(#color)'}
                  fillOpacity={0.1}
                  isAnimationActive={false}
                  stroke={getChartColor(0)}
                  strokeWidth={2}
                  type={'monotone'}
                />
              </>
            )}
            {hasBreakdowns &&
              averageRows.map((row, index) => (
                <Area
                  dataKey={`series_${index}`}
                  fill="transparent"
                  isAnimationActive={false}
                  // Bucket identity, never the label: two cohorts can share a
                  // name, and In / Not In must stay separate lines.
                  key={row.cohortKey ?? JSON.stringify(row.breakdowns)}
                  name={rowLabel(row)}
                  stroke={getChartColor(index)}
                  strokeWidth={2}
                  type="monotone"
                />
              ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </ReportSeriesScreenshotsProvider>
  );
}
