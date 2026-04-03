import { fancyMinutes, useNumber } from '@/hooks/use-numer-formatter';
import type { IChartData } from '@/trpc/client';
import { cn } from '@/utils/cn';
import AutoSizer from 'react-virtualized-auto-sizer';
import { Area, AreaChart, Tooltip } from 'recharts';

import type { IChartMetric } from '@openpanel/validation';

import {
  ChartTooltipContainer,
  ChartTooltipHeader,
  ChartTooltipItem,
} from '@/components/charts/chart-tooltip';
import { formatDate } from '@/utils/date';
import { getChartColor } from '@/utils/theme';
import {
  PreviousDiffIndicator,
  PreviousDiffIndicatorPure,
  getDiffIndicator,
} from '../common/previous-diff-indicator';
import { SerieName } from '../common/serie-name';
import { useReportChartContext } from '../context';

interface MetricCardProps {
  serie: IChartData['series'][number];
  color?: string;
  metric: IChartMetric;
  unit?: string;
}

const TooltipContent = (props: { payload?: any[] }) => {
  const number = useNumber();
  return (
    <ChartTooltipContainer>
      {props.payload?.map((item) => {
        const { date, count } = item.payload;
        return (
          <div key={item.id} className="col gap-2">
            <ChartTooltipHeader>
              <div>{formatDate(new Date(date))}</div>
            </ChartTooltipHeader>
            <ChartTooltipItem color={getChartColor(0)}>
              <div>{number.format(count)}</div>
            </ChartTooltipItem>
          </div>
        );
      })}
    </ChartTooltipContainer>
  );
};

export function MetricCard({
  serie,
  color: _color,
  metric,
  unit,
}: MetricCardProps) {
  const { isEditMode, options, report } = useReportChartContext();
  const number = useNumber();
  const isHero = options.metricLayout === 'hero';

  const renderValue = (value: number | undefined, unitClassName?: string) => {
    if (value == null) {
      return <div className="text-muted-foreground">N/A</div>;
    }

    if (unit === 'min') {
      return <>{fancyMinutes(value)}</>;
    }

    return (
      <>
        {number.short(value)}
        {unit && <span className={unitClassName}>{unit}</span>}
      </>
    );
  };

  const previous = serie.metrics.previous?.[metric];

  const graphColors = getDiffIndicator(
    false,
    previous?.state,
    '#6ee7b7', // green
    '#fda4af', // red
    '#93c5fd', // blue
  );

  const label = <SerieName name={serie.names} />;
  const value = renderValue(
    serie.metrics[metric],
    isHero ? 'ml-2 text-4xl font-light' : 'ml-1 font-light text-xl',
  );

  if (isHero) {
    return (
      <div
        className={cn(
          'card flex min-h-[360px] h-full w-full flex-1 flex-col items-center justify-center gap-5 rounded-2xl px-10 py-14 text-center',
          displaySeriesCountClass(report.series.length),
        )}
        key={serie.id}
      >
        <div className="max-w-full truncate text-sm font-medium text-muted-foreground md:text-base">
          {label}
        </div>
        <div className="max-w-full truncate font-mono text-6xl font-bold tracking-tight md:text-7xl">
          {value}
        </div>
        <PreviousDiffIndicatorPure
          diff={previous?.diff}
          state={previous?.state}
          size="md"
          showPrevious={report.previous}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'group relative p-4 hover:z-10',
        isEditMode && 'card h-auto',
      )}
      key={serie.id}
    >
      <div
        className={cn(
          'absolute -left-1 -right-1 bottom-0 top-0 z-0 opacity-100 transition-opacity duration-300 group-hover:opacity-100',
        )}
      >
        <AutoSizer>
          {({ width, height }) => (
            <AreaChart
              width={width}
              height={height / 4}
              data={serie.data}
              style={{ marginTop: (height / 4) * 3 }}
            >
              <defs>
                <linearGradient
                  id={`colorUv${serie.id}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor={graphColors} stopOpacity={0.2} />
                  <stop
                    offset="100%"
                    stopColor={graphColors}
                    stopOpacity={0.05}
                  />
                </linearGradient>
              </defs>
              <Tooltip content={TooltipContent} />
              <Area
                dataKey="count"
                type="step"
                fill={`url(#colorUv${serie.id})`}
                fillOpacity={1}
                stroke={graphColors}
                strokeWidth={1}
                isAnimationActive={false}
              />
            </AreaChart>
          )}
        </AutoSizer>
      </div>
      <MetricCardNumber
        label={label}
        value={value}
        enhancer={
          <PreviousDiffIndicator
            {...previous}
            className="text-sm text-muted-foreground"
          />
        }
      />
    </div>
  );
}

function displaySeriesCountClass(count: number) {
  if (count <= 1) {
    return '';
  }
  if (count === 2) {
    return 'max-w-none';
  }
  return 'max-w-none';
}

export function MetricCardNumber({
  label,
  value,
  enhancer,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  enhancer?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-left">
          <span className="truncate text-muted-foreground">{label}</span>
        </div>
      </div>
      <div className="flex items-end justify-between gap-4">
        <div className="truncate font-mono text-3xl font-bold">{value}</div>
        {enhancer}
      </div>
    </div>
  );
}
