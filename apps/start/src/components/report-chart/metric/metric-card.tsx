import { useEffect, useRef, useState } from 'react';

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
import { Tooltiper } from '@/components/ui/tooltip';
import { formatDate } from '@/utils/date';
import { getChartColor } from '@/utils/theme';
import {
  PreviousDiffIndicator,
  PreviousDiffIndicatorPure,
  getDiffIndicator,
} from '../common/previous-diff-indicator';
import { SerieName } from '../common/serie-name';
import { ReportSeriesScreenshot } from '../common/report-series-screenshots';
import { useReportChartContext } from '../context';
import {
  compactMetricCardClassName,
  compactMetricLabelClassName,
  compactMetricValueClassName,
  getCompactMetricLabelFontSizePx,
  getCompactMetricValueFontSizePx,
} from './metric-card-layout';
import { formatMetricDisplayValue } from './metric-value-format';

interface MetricCardProps {
  serie: IChartData['series'][number];
  color?: string;
  metric: IChartMetric;
  unit?: string;
  forceCompactLayout?: boolean;
}

function renderExactMetricValue(
  number: ReturnType<typeof useNumber>,
  value: number | undefined,
  unit?: string,
) {
  if (value == null) {
    return 'N/A';
  }

  if (unit === 'min') {
    return fancyMinutes(value);
  }

  return number.formatWithUnit(value, unit);
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

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry?.contentRect.width ?? 0);
    });
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

export function MetricCard({
  serie,
  color: _color,
  metric,
  unit,
  forceCompactLayout = false,
}: MetricCardProps) {
  const { isEditMode, options, report } = useReportChartContext();
  const number = useNumber();
  const isHero = options.metricLayout === 'hero' && !forceCompactLayout;
  const metricSurface = options.metricSurface ?? 'card';
  const [compactCardRef, compactCardWidth] = useElementWidth<HTMLDivElement>();

  const renderValue = (value: number | undefined, unitClassName?: string) => {
    if (value == null) {
      return <div className="text-muted-foreground">N/A</div>;
    }

    if (unit === 'min') {
      return <>{fancyMinutes(value)}</>;
    }

    const displayValue = formatMetricDisplayValue(value);

    return (
      <>
        {displayValue}
        {unit && <span className={unitClassName}>{unit}</span>}
      </>
    );
  };

  const previous = serie.metrics.previous?.[metric];
  const showBackgroundChart = serie.data.length > 1;

  const graphColors = getDiffIndicator(
    false,
    previous?.state,
    '#6ee7b7', // green
    '#fda4af', // red
    '#93c5fd', // blue
  );

  const label = (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <ReportSeriesScreenshot
        eventName={serie.names.join(' — ')}
        serieId={serie.id}
        showNoMatch={false}
      />
      <SerieName name={serie.names} />
    </span>
  );
  const labelText = Array.isArray(serie.names)
    ? serie.names.join(' > ')
    : serie.names;
  const valueText = renderExactMetricValue(number, serie.metrics[metric], unit);
  const compactValueFontSize = getCompactMetricValueFontSizePx(
    compactCardWidth,
    valueText.length,
  );
  const compactLabelFontSize = getCompactMetricLabelFontSizePx(
    compactCardWidth,
    labelText.length,
  );
  const value = renderValue(
    serie.metrics[metric],
    isHero ? 'ml-2 text-4xl font-light' : 'ml-1 text-[clamp(1rem,1.8vw,1.25rem)] font-light',
  );
  const exactValue = valueText;
  const hoverTooltip = (
    <div className="flex max-w-sm gap-2">
      <div
        className="w-[3px] shrink-0 rounded-full"
        style={{ backgroundColor: graphColors }}
      />
      <div className="flex flex-col gap-1">
        <span className="font-medium">{label}</span>
        <span className="font-mono font-semibold">{exactValue}</span>
      </div>
    </div>
  );

  if (isHero) {
    return (
      <div
        className={cn(
          'flex h-full w-full flex-1 flex-col items-center justify-center gap-5 text-center',
          metricSurface === 'card' && 'card',
          metricSurface === 'card' && 'min-h-[360px] rounded-2xl px-10 py-14',
          metricSurface === 'plain' && 'min-h-0 px-6 py-8',
          displaySeriesCountClass(report.series.length),
        )}
        key={serie.id}
      >
        <div className="max-w-full truncate text-sm font-medium text-muted-foreground md:text-base">
          {label}
        </div>
        <Tooltiper content={hoverTooltip}>
          <div className="max-w-full cursor-default truncate font-mono text-6xl font-bold tracking-tight md:text-7xl">
            {value}
          </div>
        </Tooltiper>
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
      ref={compactCardRef}
      className={cn(
        compactMetricCardClassName,
        isEditMode && 'card h-auto min-h-[120px] p-4',
      )}
      key={serie.id}
    >
      {showBackgroundChart && (
        <div
          className={cn(
            'absolute inset-x-0 bottom-0 z-0 h-[50%] opacity-100 transition-opacity duration-300 group-hover:opacity-100',
          )}
        >
          <AutoSizer>
            {({ width, height }) => (
              <AreaChart
                width={width}
                height={height}
                data={serie.data}
              >
                <defs>
                  <linearGradient
                    id={`colorUv${serie.id}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0%" stopColor={graphColors} stopOpacity={0.28} />
                    <stop
                      offset="100%"
                      stopColor={graphColors}
                      stopOpacity={0.08}
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
      )}
      <div className="relative z-10 flex h-full flex-col justify-between">
        <div className="flex min-w-0 items-start justify-between gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div
              className={compactMetricLabelClassName}
              style={
                compactLabelFontSize
                  ? { fontSize: `${compactLabelFontSize}px` }
                  : undefined
              }
            >
              {label}
            </div>
            <Tooltiper content={hoverTooltip}>
              <div
                className={compactMetricValueClassName}
                style={
                  compactValueFontSize
                    ? { fontSize: `${compactValueFontSize}px` }
                    : undefined
                }
              >
                {value}
              </div>
            </Tooltiper>
          </div>
          <PreviousDiffIndicator
            {...previous}
            className="mt-1 hidden shrink-0 text-xs text-muted-foreground @min-[220px]:flex"
          />
        </div>
      </div>
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
