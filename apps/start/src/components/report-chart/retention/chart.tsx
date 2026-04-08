import type { RouterOutputs } from '@/trpc/client';
import { cn } from '@/utils/cn';
import { getChartColor } from '@/utils/theme';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { average, round } from '@openpanel/common';
import { useXAxisProps, useYAxisProps } from '../common/axis';
import { useReportChartContext } from '../context';
import { RetentionTooltip } from './tooltip';

interface Props {
  data: RouterOutputs['chart']['cohort'];
}

export function Chart({ data }: Props) {
  const {
    report: { interval, unit },
    isEditMode,
    options: { hideXAxis, hideYAxis },
  } = useReportChartContext();
  const isPercentage = unit === '%';

  const xAxisProps = useXAxisProps({ interval, hide: hideXAxis });
  const yAxisProps = useYAxisProps({
    hide: hideYAxis,
    tickFormatter: isPercentage ? (value) => `${value}%` : undefined,
  });
  const averageRow = data[0];
  const averageRetentionRate = isPercentage
    ? average(averageRow?.percentages || [], true) * 100
    : average(averageRow?.values || [], true);
  const dataSource = isPercentage ? averageRow?.percentages : averageRow?.values;
  const rechartData = dataSource?.map((item, index) => ({
    days: index,
    percentage: isPercentage ? item * 100 : item,
    value: averageRow?.values?.[index],
    sum: averageRow?.sum,
  }));

  // Compute nice Y-axis ticks: pick a step size, generate explicit ticks
  const dataMax = Math.max(...(rechartData?.map((d) => d.percentage) ?? [0]));
  const niceTicks = (max: number): number[] => {
    if (max <= 0) return isPercentage ? [0, 0.5, 1] : [0, 5, 10];
    const steps = isPercentage
      ? [0.25, 0.5, 1, 2, 5, 10, 20, 25, 50]
      : [1, 2, 5, 10, 20, 50, 100, 200, 500];
    for (const step of steps) {
      const top = Math.ceil(max / step) * step;
      if (top >= max * 1.05) {
        const ticks: number[] = [];
        for (let v = 0; v <= top; v += step) ticks.push(v);
        if (ticks.length >= 3 && ticks.length <= 8) return ticks;
      }
    }
    return [0, Math.ceil(max)];
  };
  const yTicks = niceTicks(dataMax);
  const yMax = yTicks[yTicks.length - 1] ?? 100;

  return (
    <>
      <div className={cn('h-full w-full', isEditMode && 'card p-4')}>
        <ResponsiveContainer>
          <ComposedChart data={rechartData}>
            <CartesianGrid
              strokeDasharray="3 3"
              horizontal={true}
              vertical={true}
              className="stroke-border"
            />
            <YAxis {...yAxisProps} domain={[0, yMax]} ticks={yTicks} />
            <XAxis
              {...xAxisProps}
              dataKey="days"
              allowDuplicatedCategory
              scale="linear"
              tickFormatter={(value) => value.toString()}
              tickCount={31}
              interval={0}
            />
            <Tooltip content={<RetentionTooltip />} />
            <defs>
              <linearGradient id={'color'} x1="0" y1="0" x2="0" y2="1">
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
            <ReferenceLine
              y={averageRetentionRate}
              stroke={getChartColor(1)}
              strokeWidth={2}
              strokeDasharray="3 3"
              strokeOpacity={0.5}
              strokeLinecap="round"
              label={{
                value: isPercentage
                  ? `Average (${round(averageRetentionRate, 2)} %)`
                  : `Average (${round(averageRetentionRate, 0)})`,
                fill: getChartColor(1),
                position: 'insideBottomRight',
                fontSize: 12,
              }}
            />
            <Area
              dataKey="percentage"
              fill={'url(#color)'}
              type={'monotone'}
              isAnimationActive={false}
              strokeWidth={2}
              stroke={getChartColor(0)}
              fillOpacity={0.1}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}
