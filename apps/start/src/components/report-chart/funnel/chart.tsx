import { getPreviousMetric } from '@openpanel/common';
import { alphabetIds } from '@openpanel/constants';
import { ChevronRightIcon, InfoIcon, UsersIcon } from 'lucide-react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import { useXAxisProps, useYAxisProps } from '../common/axis';
import { PreviousDiffIndicatorPure } from '../common/previous-diff-indicator';
import { SerieIcon } from '../common/serie-icon';
import { SerieName } from '../common/serie-name';
import { useReportChartContext } from '../context';
import { createChartTooltip } from '@/components/charts/chart-tooltip';
import { ColorSquare } from '@/components/color-square';
import { Button } from '@/components/ui/button';
import { Tooltiper } from '@/components/ui/tooltip';
import { WidgetTable } from '@/components/widget-table';
import { useNumber } from '@/hooks/use-numer-formatter';
import { pushModal } from '@/modals';
import type { RouterOutputs } from '@/trpc/client';
import { cn } from '@/utils/cn';
import { getChartColor, getChartTranslucentColor } from '@/utils/theme';

/** Format seconds into compact human-readable duration. */
export function formatDuration(seconds: number): string {
  return `${Math.round(seconds)}s`;
}

type Props = {
  data: {
    current: RouterOutputs['chart']['funnel']['current'][number];
    previous: RouterOutputs['chart']['funnel']['current'][number] | null;
  };
  noTopBorderRadius?: boolean;
};

export const Metric = ({
  label,
  value,
  enhancer,
  className,
}: {
  label: string;
  value: React.ReactNode;
  enhancer?: React.ReactNode;
  className?: string;
}) => (
  <div className={cn('col flex-1 justify-between gap-1', className)}>
    <div className="text-muted-foreground text-sm">{label}</div>
    <div className="row items-center justify-between gap-2">
      <div className="font-mono font-semibold">{value}</div>
      {enhancer && <div>{enhancer}</div>}
    </div>
  </div>
);

export function Summary({ data }: { data: RouterOutputs['chart']['funnel'] }) {
  const number = useNumber();
  const highestConversion = data.current
    .slice(0)
    .sort((a, b) => b.lastStep.percent - a.lastStep.percent)[0];
  const highestCount = data.current
    .slice(0)
    .sort((a, b) => b.lastStep.count - a.lastStep.count)[0];
  return (
    <div className="grid grid-cols-2 gap-4">
      {highestConversion && (
        <div className="card row items-center p-4 py-3">
          <Metric
            label="Highest conversion rate"
            value={
              <ChartName breakdowns={highestConversion.breakdowns ?? []} />
            }
          />
          <span className="font-mono font-semibold text-xl">
            {number.formatWithUnit(
              highestConversion.lastStep.percent / 100,
              '%'
            )}
          </span>
        </div>
      )}
      {highestCount && (
        <div className="card row items-center p-4 py-3">
          <Metric
            label="Most conversions"
            value={<ChartName breakdowns={highestCount.breakdowns ?? []} />}
          />
          <span className="font-mono font-semibold text-xl">
            {number.format(highestCount.lastStep.count)}
          </span>
        </div>
      )}
    </div>
  );
}

function ChartName({
  breakdowns,
  className,
}: {
  breakdowns: string[];
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2 font-medium', className)}>
      {breakdowns.map((name, index) => {
        return (
          <>
            {index !== 0 && <ChevronRightIcon className="size-3" />}
            <span key={name}>{name}</span>
          </>
        );
      })}
    </div>
  );
}

export function Tables({
  data: {
    current: { steps, mostDropoffsStep, lastStep, breakdowns },
    previous: previousData,
  },
  noTopBorderRadius,
}: Props) {
  const number = useNumber();
  const hasHeader = breakdowns.length > 0;
  const {
    report: {
      projectId,
      startDate,
      endDate,
      range,
      interval,
      series: reportSeries,
      breakdowns: reportBreakdowns,
      previous,
      options,
      dateConfig,
    },
  } = useReportChartContext();

  const funnelOptions = options?.type === 'funnel' ? options : undefined;

  const handleInspectStep = (
    step: (typeof steps)[0],
    stepIndex: number,
    breakdownValues?: string[]
  ) => {
    if (!projectId) {
      return;
    }

    pushModal('ViewChartUsers', {
      type: 'funnel',
      report: {
        projectId,
        series: reportSeries,
        breakdowns: reportBreakdowns || [],
        interval: interval || 'day',
        startDate,
        endDate,
        range,
        previous,
        chartType: 'funnel',
        metric: 'sum',
        options: funnelOptions,
        dateConfig,
      },
      stepIndex,
      breakdownValues,
    });
  };
  return (
    <div
      className={cn(
        'col @container card divide-y divide-border',
        noTopBorderRadius && 'rounded-t-none'
      )}
    >
      {hasHeader && <ChartName breakdowns={breakdowns} className="p-4 py-3" />}
      <div
        className={cn(
          'bg-def-100',
          !hasHeader && 'rounded-t-md',
          noTopBorderRadius && 'rounded-t-none'
        )}
      >
        <div className="col md:row divide-border max-md:divide-y md:items-center md:divide-x">
          <Metric
            className="p-4 py-3"
            enhancer={
              previousData && (
                <PreviousDiffIndicatorPure
                  {...getPreviousMetric(
                    lastStep?.percent,
                    previousData.lastStep?.percent
                  )}
                />
              )
            }
            label="Conversion"
            value={number.formatWithUnit(lastStep?.percent / 100, '%')}
          />
          <Metric
            className="p-4 py-3"
            enhancer={
              previousData && (
                <PreviousDiffIndicatorPure
                  {...getPreviousMetric(
                    lastStep?.count,
                    previousData.lastStep?.count
                  )}
                />
              )
            }
            label="Completed"
            value={number.format(lastStep?.count)}
          />
          {!!mostDropoffsStep && (
            <Metric
              className="p-4 py-3"
              enhancer={
                <Tooltiper
                  content={
                    <span>
                      <span className="font-semibold">
                        {mostDropoffsStep?.dropoffCount}
                      </span>{' '}
                      dropped after this event. Improve this step and your
                      conversion rate will likely increase.
                    </span>
                  }
                  tooltipClassName="max-w-xs"
                >
                  <InfoIcon className="size-3" />
                </Tooltiper>
              }
              label="Most dropoffs after"
              value={mostDropoffsStep?.event?.displayName}
            />
          )}
        </div>
      </div>
      <div className="col divide-y divide-def-200">
        <WidgetTable
          className={'@container text-sm'}
          columnClassName="px-2 group/row items-center"
          columns={[
            {
              name: 'Event',
              render: (item, index) => (
                <div className="row relative min-w-0 items-center gap-2">
                  <ColorSquare color={getChartColor(index)}>
                    {alphabetIds[index]}
                  </ColorSquare>
                  <span className="truncate">{item.event.displayName}</span>
                </div>
              ),
              width: 'w-full',
              className: 'text-left font-mono font-semibold',
            },
            {
              name: 'Completed',
              render: (item) => number.format(item.stepConversionCount),
              className: 'text-right font-mono hidden @xl:block',
              width: '82px',
            },
            {
              name: 'Dropped after',
              render: (item) =>
                item.dropoffCount !== null
                  ? number.format(item.dropoffCount)
                  : null,
              className: 'text-right font-mono hidden @2xl:block',
              width: '110px',
            },
            {
              name: 'Median Time',
              render: (item) =>
                item.medianTimeToConvertSeconds != null
                  ? formatDuration(item.medianTimeToConvertSeconds)
                  : '—',
              className: 'text-right font-mono hidden @xl:block',
              width: '100px',
            },
            {
              name: 'Conversion',
              render: (item) =>
                number.formatWithUnit(item.stepConversionPercent / 100, '%'),
              className: 'text-right font-mono font-semibold',
              width: '90px',
            },
            {
              name: '',
              render: (item, index) => (
                <Button
                  className="h-8 w-8 p-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleInspectStep(item, index);
                  }}
                  size="sm"
                  title="View users who completed this step"
                  variant="ghost"
                >
                  <UsersIcon size={16} />
                </Button>
              ),
              className: 'text-right',
              width: '48px',
            },
          ]}
          data={steps}
          eachRow={(item, index) => {
            return (
              <div className="!p-0 absolute inset-px">
                <div
                  className={cn(
                    'relative h-full bg-def-300 transition-colors group-hover/row:bg-blue-200 dark:group-hover/row:bg-blue-900',
                    item.isHighestDropoff && [
                      'bg-red-500/20',
                      'group-hover/row:bg-red-500/70',
                    ],
                    index === steps.length - 1 && 'rounded-bl-sm'
                  )}
                  style={{
                    width: `${item.percent}%`,
                  }}
                />
              </div>
            );
          }}
          keyExtractor={(item) =>
            item.event.id ?? `step-${steps.indexOf(item)}`
          }
        />
      </div>
    </div>
  );
}

type RechartData = {
  id: string;
  stepIndex: number;
  name: string;
  [key: `step:percent:${number}`]: number | null;
  [key: `step:data:${number}`]:
    | (RouterOutputs['chart']['funnel']['current'][number] & {
        step: RouterOutputs['chart']['funnel']['current'][number]['steps'][number];
      })
    | null;
  [key: `prev_step:percent:${number}`]: number | null;
  [key: `prev_step:data:${number}`]:
    | (RouterOutputs['chart']['funnel']['current'][number] & {
        step: RouterOutputs['chart']['funnel']['current'][number]['steps'][number];
      })
    | null;
};

type FunnelBarLabelProps = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  value?: number | string | null;
  payload?: RechartData;
};

const useRechartData = ({
  current,
  previous,
  visibleBreakdowns,
}: RouterOutputs['chart']['funnel'] & {
  visibleBreakdowns: RouterOutputs['chart']['funnel']['current'];
}): RechartData[] => {
  const firstFunnel = current[0];
  // Create a map of original index to visible index
  const visibleBreakdownIds = new Set(visibleBreakdowns.map((b) => b.id));
  const originalToVisibleIndex = new Map<number, number>();
  let visibleIndex = 0;
  current.forEach((item, originalIndex) => {
    if (visibleBreakdownIds.has(item.id)) {
      originalToVisibleIndex.set(originalIndex, visibleIndex);
      visibleIndex++;
    }
  });

  return (
    firstFunnel?.steps.map((step, stepIndex) => {
      return {
        id: step?.event.id ?? `step-${stepIndex}`,
        stepIndex,
        name: step?.event.displayName ?? '',
        ...visibleBreakdowns.reduce((acc, visibleItem, visibleIdx) => {
          // Find the original index for this visible breakdown
          const originalIndex = current.findIndex(
            (item) => item.id === visibleItem.id
          );
          if (originalIndex === -1) {
            return acc;
          }

          const diff = previous?.[originalIndex];
          return {
            ...acc,
            [`step:percent:${visibleIdx}`]:
              visibleItem.steps[stepIndex]?.percent ?? null,
            [`step:data:${visibleIdx}`]: {
              ...visibleItem,
              step: visibleItem.steps[stepIndex],
            },
            [`prev_step:percent:${visibleIdx}`]:
              diff?.steps[stepIndex]?.percent ?? null,
            [`prev_step:data:${visibleIdx}`]: diff
              ? {
                  ...diff,
                  step: diff?.steps?.[stepIndex],
                }
              : null,
          };
        }, {}),
      };
    }) ?? []
  );
};

const StripedBarShape = (props: any) => {
  const { x, y, width, height, fill, stroke, value } = props;
  const patternId = `prev-stripes-${(fill || '').replace(/[^a-z0-9]/gi, '')}`;
  return (
    <g>
      <defs>
        <pattern
          height="6"
          id={patternId}
          patternTransform="rotate(-45)"
          patternUnits="userSpaceOnUse"
          width="6"
        >
          <rect fill="transparent" height="6" width="6" />
          <rect fill={fill} height="6" width="3" />
        </pattern>
      </defs>
      <rect
        fill={`url(#${patternId})`}
        height={height}
        rx={3}
        width={width}
        x={x}
        y={y}
      />
      {value > 0 && (
        <rect
          fill={stroke}
          height={2}
          opacity={0.6}
          rx={2}
          stroke="none"
          width={width}
          x={x}
          y={y - 3}
        />
      )}
    </g>
  );
};

function FunnelOverallLegend({ percent }: { percent: number }) {
  const number = useNumber();

  return (
    <div className="flex items-center justify-center gap-2 text-sm">
      <div
        className="size-2.5 rounded-[3px] shrink-0"
        style={{ backgroundColor: getChartColor(0) }}
      />
      <span className="font-medium text-foreground">
        Overall • {number.formatWithUnit(percent / 100, '%')}
      </span>
    </div>
  );
}

export function getFunnelPreviewSummaryItems({
  breakdowns,
  maxItems,
}: {
  breakdowns: Array<{
    breakdowns?: string[] | null;
    colorIndex?: number;
    id: string;
    lastStep: { percent: number };
  }>;
  maxItems: number;
}) {
  return {
    items: breakdowns.slice(0, maxItems).map((breakdown, index) => ({
      colorIndex: breakdown.colorIndex ?? index,
      id: breakdown.id,
      label:
        breakdown.breakdowns && breakdown.breakdowns.length > 0
          ? breakdown.breakdowns.join(' > ')
          : 'Overall',
      percentText: formatFunnelPercent(breakdown.lastStep.percent),
    })),
    remainingCount: Math.max(0, breakdowns.length - maxItems),
  };
}

function FunnelPreviewSummary({
  allBreakdowns,
  breakdowns,
  maxItems,
}: {
  allBreakdowns: RouterOutputs['chart']['funnel']['current'];
  breakdowns: RouterOutputs['chart']['funnel']['current'];
  maxItems: number;
}) {
  const { items, remainingCount } = getFunnelPreviewSummaryItems({
    breakdowns: breakdowns.map((breakdown, index) => {
      const stableIndex = allBreakdowns.findIndex((b) => b.id === breakdown.id);

      return {
        ...breakdown,
        colorIndex: stableIndex >= 0 ? stableIndex : index,
      };
    }),
    maxItems,
  });

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="overflow-x-auto overflow-y-hidden px-4 py-2">
      <div className="flex min-w-max items-center justify-center gap-x-5 gap-y-1 text-xs whitespace-nowrap">
        {items.map((item) => (
          <div
            className="inline-flex max-w-[160px] shrink-0 items-center gap-1.5 font-medium"
            key={item.id}
            title={`${item.label} • ${item.percentText}`}
          >
            <div
              className="size-2.5 shrink-0 rounded-[3px]"
              style={{ backgroundColor: getChartColor(item.colorIndex) }}
            />
            <span className="truncate text-foreground/90">{item.label}</span>
            <span className="text-muted-foreground">•</span>
            <span className="font-mono text-foreground/90">{item.percentText}</span>
          </div>
        ))}
        {remainingCount > 0 && (
          <div className="shrink-0 font-medium text-foreground/90">
            +{remainingCount} More
          </div>
        )}
      </div>
    </div>
  );
}

function formatFunnelPercent(percent: number) {
  const rounded = Math.round(percent * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)}%` : `${rounded}%`;
}

function formatFunnelCount(count: number) {
  return new Intl.NumberFormat('en-US').format(count);
}

const FUNNEL_LABEL_FONT_SIZE = 11;
const FUNNEL_LABEL_COMPACT_FONT_SIZE = 10;

function getFunnelLabelTextWidth(text: string, fontSize: number) {
  // SVG labels use the mono font. This estimate intentionally errs slightly
  // wide so the dark label chip is related to the value text instead of being
  // a fixed, fat 56px box for every tiny value.
  return text.length * fontSize * 0.62;
}

export function getFunnelBarSize({
  breakdownCount,
  stepCount,
  dashboardLayout,
}: {
  breakdownCount: number;
  stepCount: number;
  dashboardLayout: boolean;
}) {
  if (breakdownCount <= 1) {
    return dashboardLayout ? 56 : 72;
  }

  if (breakdownCount >= 5) {
    return dashboardLayout ? 18 : 24;
  }

  if (breakdownCount >= 4) {
    return dashboardLayout ? 28 : 34;
  }

  if (breakdownCount === 3) {
    return dashboardLayout || stepCount >= 3 ? 34 : 42;
  }

  return dashboardLayout || stepCount >= 4 ? 42 : 48;
}

export function getFunnelLabelLayout({
  x,
  y,
  width,
  value,
  percentText,
  countText,
}: {
  x: number;
  y: number;
  width: number;
  value?: number | string | null;
  percentText: string;
  countText: string;
}) {
  const { effectiveY } = getFunnelBarGeometry({ y, height: 0, value });
  const compact = width < 42;
  const fontSize = compact
    ? FUNNEL_LABEL_COMPACT_FONT_SIZE
    : FUNNEL_LABEL_FONT_SIZE;
  const textWidth = Math.max(
    getFunnelLabelTextWidth(percentText, fontSize),
    getFunnelLabelTextWidth(countText, fontSize)
  );
  const labelWidth = Math.ceil(
    Math.min(68, Math.max(compact ? 38 : 42, textWidth + 12))
  );
  const labelHeight = compact ? 28 : 32;
  const labelX = x + width / 2;
  const labelRectX = labelX - labelWidth / 2;

  // Mixpanel-style: keep labels outside/above the bar when there is headroom,
  // but don't let 100% bars shove values into the chart legend/title area. In
  // that case, pull the chip just inside the bar top. This keeps values readable
  // without trying to squeeze raw text inside the colored funnel itself.
  const outsideY = effectiveY - labelHeight + 4;
  const minReadableY = 4;
  const labelY = outsideY < minReadableY ? effectiveY + 4 : outsideY;

  return {
    compact,
    fontSize,
    labelHeight,
    labelRectX,
    labelWidth,
    labelX,
    labelY,
  };
}

function truncateFunnelLabel(label: string, maxChars: number) {
  if (label.length <= maxChars) {
    return label;
  }

  return `${label.slice(0, Math.max(0, maxChars - 1))}…`;
}

function getFunnelBarGeometry({
  y,
  height,
  value,
}: {
  y: number;
  height: number;
  value?: number | string | null;
}) {
  const numericValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : 0;
  const hasZeroValue = !Number.isNaN(numericValue) && numericValue <= 0;
  const minVisibleHeight = hasZeroValue ? 6 : 0;

  return {
    effectiveHeight: Math.max(height, minVisibleHeight),
    effectiveY: hasZeroValue ? y - minVisibleHeight : y,
  };
}

function FunnelBarLabel({
  x,
  y,
  width,
  height,
  value,
  payload,
  breakdownIndex = 0,
}: FunnelBarLabelProps & { breakdownIndex?: number }) {
  const currentVariant = payload?.[`step:data:${breakdownIndex}`];

  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !currentVariant?.step
  ) {
    return null;
  }

  // Conversion vs the IMMEDIATELY PREVIOUS step (Mixpanel-style), not vs the
  // first step. Step 0 always shows 100%. For step N, divide its count by
  // step N-1's count.
  const stepIndex: number =
    typeof (payload as any)?.stepIndex === 'number'
      ? (payload as any).stepIndex
      : 0;
  const prevStepCount: number | undefined =
    stepIndex > 0 ? currentVariant.steps?.[stepIndex - 1]?.count : undefined;
  const fromPrevPercent =
    stepIndex === 0
      ? 100
      : prevStepCount && prevStepCount > 0
        ? (currentVariant.step.count / prevStepCount) * 100
        : 0;
  const percentText = formatFunnelPercent(fromPrevPercent);
  const countText = formatFunnelCount(currentVariant.step.count);
  const label = getFunnelLabelLayout({
    x,
    y,
    width,
    value,
    percentText,
    countText,
  });

  return (
    <g>
      <rect
        x={label.labelRectX}
        y={label.labelY}
        width={label.labelWidth}
        height={label.labelHeight}
        rx={4}
        fill="rgba(23, 23, 23, 0.96)"
        stroke="rgba(255, 255, 255, 0.18)"
      />
      <text
        x={label.labelX}
        y={label.labelY + (label.compact ? 11 : 12)}
        textAnchor="middle"
        fill="rgba(255, 255, 255, 0.98)"
        fontFamily="var(--font-mono), ui-monospace, SFMono-Regular, monospace"
        fontSize={label.fontSize}
        fontWeight={600}
      >
        {percentText}
      </text>
      <text
        x={label.labelX}
        y={label.labelY + (label.compact ? 23 : 26)}
        textAnchor="middle"
        fill="rgba(255, 255, 255, 0.7)"
        fontFamily="var(--font-mono), ui-monospace, SFMono-Regular, monospace"
        fontSize={label.fontSize}
      >
        {countText}
      </text>
    </g>
  );
}

type FunnelBarShapeProps = FunnelBarLabelProps & {
  fill?: string;
  stroke?: string;
  value?: number;
  isActive?: boolean;
};

function FunnelBarShape(props: FunnelBarShapeProps) {
  const { x, y, width, height, fill, stroke, value, isActive } = props;

  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    return null;
  }
  const { effectiveHeight, effectiveY } = getFunnelBarGeometry({
    y,
    height,
    value,
  });

  const resolvedFill =
    typeof fill === 'string'
      ? isActive && fill.startsWith('rgba')
        ? fill.replace(/, 0\.\d+\)$/, ', 0.4)')
        : fill
      : fill;
  const resolvedStroke =
    typeof stroke === 'string'
      ? isActive && stroke.startsWith('rgba')
        ? stroke.replace(/, 0\.\d+\)$/, ', 1)')
        : stroke
      : stroke;
  const radius = Math.min(4, width / 2, effectiveHeight);
  const topRoundedPath =
    effectiveHeight > radius
      ? [
          `M ${x} ${effectiveY + effectiveHeight}`,
          `L ${x} ${effectiveY + radius}`,
          `Q ${x} ${effectiveY} ${x + radius} ${effectiveY}`,
          `L ${x + width - radius} ${effectiveY}`,
          `Q ${x + width} ${effectiveY} ${x + width} ${effectiveY + radius}`,
          `L ${x + width} ${effectiveY + effectiveHeight}`,
          'Z',
        ].join(' ')
      : [
          `M ${x} ${effectiveY + effectiveHeight}`,
          `L ${x} ${effectiveY + radius}`,
          `Q ${x} ${effectiveY} ${x + radius} ${effectiveY}`,
          `L ${x + width - radius} ${effectiveY}`,
          `Q ${x + width} ${effectiveY} ${x + width} ${effectiveY + radius}`,
          `L ${x + width} ${effectiveY + effectiveHeight}`,
          'Z',
        ].join(' ');

  return (
    <g>
      <path d={topRoundedPath} stroke="none" fill={resolvedFill} />
      <FunnelBarLabel {...props} />
    </g>
  );
}

function FunnelBreakdownBarShape({
  showLabel,
  breakdownIndex,
  ...props
}: FunnelBarShapeProps & { showLabel?: boolean; breakdownIndex?: number }) {
  const { x, y, width, height, fill, value, isActive } = props;

  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    return null;
  }

  const { effectiveHeight, effectiveY } = getFunnelBarGeometry({
    y,
    height,
    value,
  });

  const resolvedFill =
    typeof fill === 'string'
      ? isActive && fill.startsWith('rgba')
        ? fill.replace(/, 0\.\d+\)$/, ', 0.92)')
        : fill
      : fill;
  const radius = Math.min(4, width / 2, effectiveHeight);
  const topRoundedPath = [
    `M ${x} ${effectiveY + effectiveHeight}`,
    `L ${x} ${effectiveY + radius}`,
    `Q ${x} ${effectiveY} ${x + radius} ${effectiveY}`,
    `L ${x + width - radius} ${effectiveY}`,
    `Q ${x + width} ${effectiveY} ${x + width} ${effectiveY + radius}`,
    `L ${x + width} ${effectiveY + effectiveHeight}`,
    'Z',
  ].join(' ');

  return (
    <g>
      <path d={topRoundedPath} fill={resolvedFill} stroke="none" />
      {showLabel && (
        <FunnelBarLabel {...props} breakdownIndex={breakdownIndex} />
      )}
    </g>
  );
}

function FunnelXAxisTick({
  x,
  y,
  payload,
  steps,
  totalSteps,
  compact,
}: {
  x?: number;
  y?: number;
  payload?: { value?: string };
  steps: RouterOutputs['chart']['funnel']['current'][number]['steps'];
  totalSteps: number;
  compact?: boolean;
}) {
  if (typeof x !== 'number' || typeof y !== 'number' || !payload?.value) {
    return null;
  }

  const index = steps.findIndex(
    (step) => (step?.event.id ?? '') === payload.value
  );
  const displayName = index >= 0 ? (steps[index]?.event.displayName ?? '') : '';
  const truncatedName = truncateFunnelLabel(
    displayName,
    compact
      ? totalSteps >= 4
        ? 16
        : totalSteps === 3
          ? 20
          : 26
      : totalSteps >= 4
        ? 14
        : totalSteps === 3
          ? 18
          : 24
  );

  // Show the full label on hover when the visible text was truncated.
  const isTruncated = truncatedName !== displayName;
  const textRef = useRef<SVGTextElement | null>(null);
  const [tipPos, setTipPos] = useState<{ x: number; y: number } | null>(null);

  const onEnter = () => {
    if (!isTruncated || !textRef.current) return;
    const r = textRef.current.getBoundingClientRect();
    setTipPos({ x: r.left + r.width / 2, y: r.top });
  };
  const onLeave = () => setTipPos(null);

  return (
    <>
      <g transform={`translate(${x},${y})`}>
        <text
          ref={textRef}
          y={compact ? 10 : 8}
          textAnchor="middle"
          fontSize={compact ? 10 : 11}
          fontFamily="var(--font-mono), ui-monospace, SFMono-Regular, monospace"
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
          style={isTruncated ? { cursor: 'help' } : undefined}
        >
          <tspan fill="rgba(255, 255, 255, 0.45)">{index + 1} </tspan>
          <tspan fill="rgba(255, 255, 255, 0.98)">{truncatedName}</tspan>
          {isTruncated && <title>{displayName}</title>}
        </text>
      </g>
      {tipPos && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="fixed z-[1000] pointer-events-none rounded-md border border-border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md whitespace-nowrap -translate-x-1/2 -translate-y-full"
              style={{ left: tipPos.x, top: tipPos.y - 6 }}
            >
              {displayName}
            </div>,
            document.body
          )
        : null}
    </>
  );
}

export function getFunnelChartWidth({
  containerWidth,
  stepCount,
  breakdownCount,
  stepLabels,
}: {
  containerWidth: number;
  stepCount: number;
  breakdownCount: number;
  stepLabels: string[];
}) {
  if (stepCount <= 0) {
    return containerWidth;
  }

  // Minimum width per step to keep bars from collapsing into thin lines.
  // Labels are already truncated by `truncateFunnelLabel`, so step width
  // doesn't need to fit the full label text.
  const MIN_STEP_WIDTH = 80;
  const breakdownBarWidth = getFunnelBarSize({
    breakdownCount,
    stepCount,
    dashboardLayout: true,
  });
  const breakdownGapWidth = 8;
  // When showing multiple breakdowns per step, the step must be wide enough
  // to fit them side-by-side. Otherwise just enforce the per-step minimum.
  const groupedStepWidth =
    breakdownCount > 1
      ? Math.max(
          MIN_STEP_WIDTH,
          breakdownCount * breakdownBarWidth +
            Math.max(0, breakdownCount - 1) * breakdownGapWidth +
            36
        )
      : MIN_STEP_WIDTH;
  const horizontalPadding = 24;
  const minRequiredWidth = stepCount * groupedStepWidth + horizontalPadding;

  // Fit to container when possible (no horizontal scroll); fall back to
  // scrolling only if the container is genuinely too narrow for the floor.
  return Math.max(containerWidth, minRequiredWidth);
}

export function getFunnelResponsiveBarSize({
  containerWidth,
  chartWidth,
  stepCount,
  breakdownCount,
  dashboardLayout,
}: {
  containerWidth: number;
  chartWidth: number;
  stepCount: number;
  breakdownCount: number;
  dashboardLayout: boolean;
}) {
  const baseSize = getFunnelBarSize({
    breakdownCount,
    stepCount,
    dashboardLayout,
  });

  if (stepCount <= 0 || breakdownCount <= 0) {
    return baseSize;
  }

  // Recharts centers each step in a category band. A fixed barSize leaves the
  // group tiny in wide dashboard cards. Mixpanel uses almost the full category
  // band, leaving just a small breathing gap between step groups, so calculate
  // the bar width from the available band instead of applying a small cap.
  const estimatedAxisAndMargins = dashboardLayout ? 56 : 64;
  const plotWidth =
    Math.max(containerWidth, chartWidth) - estimatedAxisAndMargins;
  const stepBandWidth = Math.max(0, plotWidth / stepCount);
  const groupOccupancy =
    breakdownCount <= 1
      ? 0.72
      : breakdownCount === 2
        ? 0.94
        : breakdownCount === 3
          ? 0.92
          : breakdownCount === 4
            ? 0.9
            : 0.88;
  const barGap = breakdownCount > 1 ? 8 : 0;
  const availableGroupWidth = stepBandWidth * groupOccupancy;
  const targetSize =
    (availableGroupWidth - Math.max(0, breakdownCount - 1) * barGap) /
    breakdownCount;
  const maxSize = dashboardLayout ? 720 : 560;

  return Math.round(
    Math.max(baseSize, Math.min(maxSize, targetSize || baseSize))
  );
}

export function Chart({
  data,
  visibleBreakdowns,
}: {
  data: RouterOutputs['chart']['funnel'];
  visibleBreakdowns: RouterOutputs['chart']['funnel']['current'];
}) {
  const { options } = useReportChartContext();
  const rechartData = useRechartData({ ...data, visibleBreakdowns });
  const xAxisProps = useXAxisProps();
  const yAxisProps = useYAxisProps();
  const hasBreakdowns = data.current.length > 1;
  const hasVisibleBreakdowns = visibleBreakdowns.length > 1;
  const hasPrevious =
    data.previous !== null &&
    data.previous !== undefined &&
    data.previous.length > 0;
  const showPreviousBars = hasPrevious && !hasBreakdowns;
  const showSingleFunnelLabels = !hasBreakdowns;
  const showBreakdownPreviewLabels =
    hasBreakdowns && options.showFunnelPreviewLabels === true;
  const isDashboardLayout = options.funnelLayout === 'dashboard';
  const overallPercent = data.current[0]?.lastStep.percent;
  const steps = data.current[0]?.steps ?? [];
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }

    const update = () => {
      // Subtract horizontal padding so chartWidth fits inside the scroll
      // container's content box (otherwise the chart overflows by exactly
      // padding-left + padding-right and triggers a horizontal scrollbar).
      const cs = getComputedStyle(node);
      const padX =
        (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      setContainerWidth(Math.max(0, node.clientWidth - padX));
    };

    update();

    const observer = new ResizeObserver(update);
    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  }, []);

  const chartWidth = useMemo(
    () =>
      getFunnelChartWidth({
        containerWidth,
        stepCount: steps.length,
        breakdownCount: visibleBreakdowns.length,
        stepLabels: steps.map((step) => step?.event.displayName ?? ''),
      }),
    [containerWidth, steps, visibleBreakdowns.length]
  );
  const funnelBarSize = getFunnelResponsiveBarSize({
    containerWidth,
    chartWidth,
    breakdownCount: visibleBreakdowns.length,
    stepCount: steps.length,
    dashboardLayout: isDashboardLayout,
  });

  const PreviousLegend = useCallback(() => {
    if (!showPreviousBars) {
      return null;
    }
    return (
      <div className="mt-4 -mb-2 flex flex-wrap justify-center gap-x-4 gap-y-1.5 text-xs">
        <div className="flex items-center gap-1.5 rounded px-2 py-1">
          <div
            className="h-3 w-3 rounded-[2px]"
            style={{
              background: 'rgba(59, 121, 255, 0.3)',
              borderTop: '2px solid rgba(59, 121, 255, 1)',
            }}
          />
          <span className="font-medium text-muted-foreground">Current</span>
        </div>
        <div className="flex items-center gap-1.5 rounded px-2 py-1">
          <svg height="12" viewBox="0 0 12 12" width="12">
            <defs>
              <pattern
                height="4"
                id="legend-stripes"
                patternTransform="rotate(-45)"
                patternUnits="userSpaceOnUse"
                width="4"
              >
                <rect fill="transparent" height="4" width="4" />
                <rect fill="rgba(59, 121, 255, 0.3)" height="4" width="2" />
              </pattern>
            </defs>
            <rect fill="url(#legend-stripes)" height="12" rx="2" width="12" />
          </svg>
          <span className="font-medium text-muted-foreground">Previous</span>
        </div>
      </div>
    );
  }, [showPreviousBars]);

  return (
    <TooltipProvider
      data={data.current}
      hasBreakdowns={hasBreakdowns}
      hasPrevious={hasPrevious}
      visibleBreakdownIds={new Set(visibleBreakdowns.map((b) => b.id))}
    >
      <div
        className={cn(
          'w-full',
          isDashboardLayout ? 'flex h-full min-h-0 flex-col' : 'card'
        )}
      >
        {showSingleFunnelLabels && typeof overallPercent === 'number' && (
          <div
            className={cn(
              'px-4 py-2',
              !isDashboardLayout && 'border-b border-border'
            )}
          >
            <FunnelOverallLegend percent={overallPercent} />
          </div>
        )}
        {hasVisibleBreakdowns && !isDashboardLayout && (
          <div className="border-b border-border">
            <FunnelPreviewSummary
              allBreakdowns={data.current}
              breakdowns={visibleBreakdowns}
              maxItems={7}
            />
          </div>
        )}
        <div
          ref={containerRef}
          className={cn(
            'relative w-full overflow-x-auto overflow-y-hidden',
            isDashboardLayout
              ? 'min-h-0 flex-1 px-1 pt-4 pb-0'
              : 'aspect-video max-h-[250px] p-4 pb-1'
          )}
        >
          {hasVisibleBreakdowns && isDashboardLayout && (
            <div className="pointer-events-none absolute top-0 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-background/80 px-3 backdrop-blur-sm">
              <FunnelPreviewSummary
                allBreakdowns={data.current}
                breakdowns={visibleBreakdowns}
                maxItems={5}
              />
            </div>
          )}
          <div
            className="relative h-full min-w-full"
            style={{ width: chartWidth > 0 ? `${chartWidth}px` : '100%' }}
          >
            <ResponsiveContainer>
              <BarChart
                barCategoryGap="3%"
                barGap={8}
                data={rechartData}
                margin={{ top: 24, right: 4, left: 0, bottom: 18 }}
              >
                <CartesianGrid
                  className="stroke-border"
                  horizontal={true}
                  strokeDasharray="3 3"
                  vertical={true}
                />
                <XAxis
                  {...xAxisProps}
                  allowDuplicatedCategory={false}
                  dataKey="id"
                  domain={undefined}
                  interval="preserveStartEnd"
                  scale="auto"
                  tick={
                    <FunnelXAxisTick
                      compact={hasBreakdowns}
                      steps={steps}
                      totalSteps={steps.length}
                    />
                  }
                  tickFormatter={undefined}
                  tickMargin={4}
                  tickSize={0}
                  type={'category'}
                />
                <YAxis {...yAxisProps} />
                {hasBreakdowns &&
                  visibleBreakdowns.map((item, breakdownIndex) => {
                    const stableIndex = data.current.findIndex(
                      (b) => b.id === item.id
                    );
                    const colorIndex =
                      stableIndex >= 0 ? stableIndex : breakdownIndex;
                    return (
                      <Bar
                        barSize={funnelBarSize}
                        dataKey={`step:percent:${breakdownIndex}`}
                        key={`step:percent:${item.id}`}
                        shape={
                          <FunnelBreakdownBarShape
                            showLabel={showBreakdownPreviewLabels}
                            breakdownIndex={breakdownIndex}
                          />
                        }
                      >
                        {rechartData.map((row, stepIndex) => (
                          <Cell
                            fill={getChartColor(colorIndex)}
                            key={`${row.name}-${breakdownIndex}`}
                            stroke={getChartColor(colorIndex)}
                          />
                        ))}
                      </Bar>
                    );
                  })}
                {!hasBreakdowns && (
                  <Bar
                    barSize={funnelBarSize}
                    dataKey="step:percent:0"
                    shape={<FunnelBarShape />}
                  >
                    {rechartData.map((item, index) => (
                      <Cell
                        fill={getChartColor(0)}
                        key={item.name}
                        stroke={getChartColor(0)}
                      />
                    ))}
                  </Bar>
                )}
                {showPreviousBars && (
                  <Bar
                    barSize={funnelBarSize}
                    dataKey="prev_step:percent:0"
                    shape={<StripedBarShape />}
                  >
                    {rechartData.map((item, index) => (
                      <Cell
                        fill={getChartTranslucentColor(index)}
                        key={`prev-${item.name}`}
                        stroke={getChartColor(index)}
                      />
                    ))}
                  </Bar>
                )}
                {showPreviousBars && <Legend content={<PreviousLegend />} />}
                <Tooltip shared={!hasBreakdowns} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

const { Tooltip, TooltipProvider } = createChartTooltip<
  RechartData,
  {
    data: RouterOutputs['chart']['funnel']['current'];
    visibleBreakdownIds: Set<string>;
    hasPrevious: boolean;
    hasBreakdowns: boolean;
  }
>(({ data: dataArray, items, context, ...props }) => {
  const data = dataArray[0];
  const number = useNumber();
  if (!data) {
    return null;
  }
  const variants = Object.keys(data).filter((key) =>
    key.startsWith('step:data:')
  ) as `step:data:${number}`[];

  const index = (data as RechartData).stepIndex;

  // In breakdown mode with shared={false}, Recharts sends only the hovered
  // bar's payload item. Extract the breakdown index from its dataKey.
  const hoveredDataKey = items[0]?.dataKey as string | undefined;
  const hoveredBreakdownIndex =
    hoveredDataKey?.match(/^step:percent:(\d+)$/)?.[1];

  // Filter variants to only show visible breakdowns
  const visibleVariants = variants.filter((key) => {
    const variant = data[key];
    if (!variant) {
      return false;
    }
    // If we have a hovered breakdown index, only show that one
    if (hoveredBreakdownIndex !== undefined) {
      return key === `step:data:${hoveredBreakdownIndex}`;
    }
    return context.visibleBreakdownIds.has(variant.id);
  });

  if (!context.hasBreakdowns && context.hasPrevious) {
    const currentVariant = data['step:data:0'];
    const previousVariant = data['prev_step:data:0'];

    if (!currentVariant?.step) {
      return null;
    }

    const metric = getPreviousMetric(
      currentVariant.step.percent,
      previousVariant?.step.percent
    );

    return (
      <>
        <div className="text-muted-foreground">{data.name}</div>
        <div className="col gap-1.5">
          <div className="flex justify-between gap-8 font-medium font-mono">
            <span className="text-muted-foreground">Current</span>
            <span>
              {number.format(currentVariant.step.count)} (
              {number.formatWithUnit(currentVariant.step.percent / 100, '%')})
            </span>
          </div>
          {previousVariant?.step && (
            <div className="flex justify-between gap-8 font-medium font-mono text-muted-foreground">
              <span>Previous</span>
              <span>
                {number.format(previousVariant.step.count)} (
                {number.formatWithUnit(previousVariant.step.percent / 100, '%')}
                )
              </span>
            </div>
          )}
          {metric && metric.diff != null && (
            <div className="mt-0.5 flex items-center justify-between gap-8 border-border border-t pt-1.5">
              <span className="font-medium text-sm">
                {metric.state === 'positive'
                  ? 'Improvement'
                  : metric.state === 'negative'
                    ? 'Decline'
                    : 'No change'}
              </span>
              <PreviousDiffIndicatorPure {...metric} size="xs" />
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="flex justify-between gap-8 text-muted-foreground">
        <div>{data.name}</div>
      </div>
      {visibleVariants.map((key, visibleIndex) => {
        const variant = data[key];
        const prevVariant = data[`prev_${key}`];
        if (!variant?.step) {
          return null;
        }
        // Find the original breakdown index for color (matches chart bar order)
        const originalBreakdownIndex = context.data.findIndex(
          (b) => b.id === variant.id
        );
        let colorIndex = index;
        if (!context.hasBreakdowns) {
          colorIndex = 0;
        } else {
          colorIndex =
            originalBreakdownIndex >= 0 ? originalBreakdownIndex : visibleIndex;
        }
        return (
          <div className="row gap-2" key={key}>
            <div
              className="w-[3px] rounded-full shrink-0"
              style={{
                background: getChartColor(colorIndex),
              }}
            />
            <div className="col flex-1 gap-1 min-w-0">
              <div className="flex items-center gap-1">
                <ChartName breakdowns={variant.breakdowns ?? []} />
              </div>
              <div className="flex items-center justify-between gap-4 font-mono font-medium">
                <div className="col gap-0.5">
                  <span>
                    {number.formatWithUnit(variant.step.percent / 100, '%')}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    ({number.format(variant.step.count)})
                  </span>
                </div>

                <PreviousDiffIndicatorPure
                  {...getPreviousMetric(
                    variant.step.percent,
                    prevVariant?.step.percent
                  )}
                  size="xs"
                />
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
});
