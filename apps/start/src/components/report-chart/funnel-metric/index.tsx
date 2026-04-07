import { useTRPC } from '@/integrations/trpc/react';
import { useNumber } from '@/hooks/use-numer-formatter';
import type { RouterOutputs } from '@/trpc/client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useReportChartContext } from '../context';
import { ReportChartEmpty } from '../common/empty';
import { ReportChartError } from '../common/error';
import { ReportChartLoading } from '../common/loading';
import { AspectContainer } from '../aspect-container';
import { getChartColor } from '@/utils/theme';
import { getPreviousMetric } from '@openpanel/common';
import { PreviousDiffIndicatorPure } from '../common/previous-diff-indicator';

type FunnelData = RouterOutputs['chart']['funnel'];
type FunnelSeries = FunnelData['current'][number];

export function ReportFunnelMetricChart() {
  const { isLazyLoading, isEditMode, report, shareId } =
    useReportChartContext();
  const trpc = useTRPC();
  const number = useNumber();

  const funnelOptions =
    report.options?.type === 'funnel' ? report.options : undefined;
  const funnelProperty = funnelOptions?.funnelProperty;

  const res = useQuery(
    trpc.chart.funnel.queryOptions(
      {
        ...report,
        shareId,
      },
      {
        placeholderData: keepPreviousData,
        staleTime: 1000 * 60 * 1,
        enabled: !isLazyLoading && report.series.length > 0,
      },
    ),
  );

  if (isLazyLoading || res.isLoading) {
    return (
      <AspectContainer>
        <ReportChartLoading />
      </AspectContainer>
    );
  }

  if (res.isError) {
    return (
      <AspectContainer>
        <ReportChartError />
      </AspectContainer>
    );
  }

  if (!funnelProperty) {
    return (
      <AspectContainer>
        <div className="flex h-full items-center justify-center text-muted-foreground">
          Select a property to measure
        </div>
      </AspectContainer>
    );
  }

  if (!res.data || res.data.current.length === 0) {
    return (
      <AspectContainer>
        <ReportChartEmpty />
      </AspectContainer>
    );
  }

  const { current, previous } = res.data;
  const hasBreakdowns = (report.breakdowns ?? []).length > 0;

  // Build a lookup for previous period by breakdown key
  const previousByKey = new Map<string, FunnelSeries>();
  if (previous) {
    for (const series of previous) {
      previousByKey.set(series.id, series);
    }
  }

  // Build metric data from funnel response
  const metrics = current.map((series, index) => {
    const value = (series.lastStep as any)?.propertySum as number | undefined;
    // Match previous by breakdown key (series.id), not array index
    const prevSeries = previousByKey.get(series.id);
    const prevValue = prevSeries
      ? ((prevSeries.lastStep as any)?.propertySum as number | undefined)
      : undefined;

    const label = hasBreakdowns
      ? (series.breakdowns?.join(' > ') || 'Not set')
      : 'Total';

    return {
      id: series.id,
      label,
      value: value ?? 0,
      prevValue,
      color: getChartColor(index),
    };
  });

  // Sort descending by value
  metrics.sort((a, b) => b.value - a.value);

  // First series display name for the table label
  const firstEvent = report.series[0];
  const metricLabel =
    firstEvent && 'displayName' in firstEvent && firstEvent.displayName
      ? firstEvent.displayName
      : firstEvent && 'name' in firstEvent
        ? firstEvent.name
        : 'Funnel Metric';

  return (
    <div className={`col gap-4 ${!isEditMode ? 'h-full items-center justify-center' : ''}`}>
      {/* KPI Cards */}
      <div
        className={`grid gap-4 ${
          metrics.length === 1
            ? 'grid-cols-1'
            : metrics.length === 2
              ? 'grid-cols-2'
              : 'grid-cols-2 lg:grid-cols-3'
        }`}
      >
        {metrics.map((metric) => (
          <div
            key={metric.id}
            className="card group relative flex flex-col items-center justify-center gap-2 p-6 cursor-default"
          >
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <div
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: metric.color }}
              />
              <span>{metric.label}</span>
            </div>
            <div className="font-mono text-4xl font-bold">
              {number.short(metric.value)}
            </div>
            {metric.prevValue != null && (
              <PreviousDiffIndicatorPure
                {...getPreviousMetric(metric.value, metric.prevValue)}
                size="sm"
              />
            )}
            {/* Hover tooltip */}
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-full z-50 hidden group-hover:flex rounded-lg border bg-card p-3 shadow-lg text-sm whitespace-nowrap mt-2">
              <div className="flex gap-2">
                <div
                  className="w-[3px] rounded-full shrink-0"
                  style={{ backgroundColor: metric.color }}
                />
                <div className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground">
                    Sum of {funnelProperty?.replace('properties.', '')} on {metricLabel}
                  </span>
                  <span className="text-muted-foreground">{metric.label}</span>
                  <span className="font-mono font-semibold bg-def-200 px-1.5 py-0.5 rounded w-fit">
                    {number.format(metric.value)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Simple table — only in edit mode (full report) */}
      {isEditMode && (
        <div className="card overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-def-100">
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">
                  Metric
                </th>
                {hasBreakdowns && (
                  <th className="px-4 py-2 text-left font-medium text-muted-foreground">
                    Breakdown
                  </th>
                )}
                <th className="px-4 py-2 text-right font-medium text-muted-foreground">
                  Value
                </th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((metric) => (
                <tr
                  key={metric.id}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-4 py-2 font-medium">{metricLabel}</td>
                  {hasBreakdowns && (
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <div
                          className="h-2.5 w-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: metric.color }}
                        />
                        {metric.label}
                      </div>
                    </td>
                  )}
                  <td className="px-4 py-2 text-right font-mono font-semibold">
                    {number.short(metric.value)}
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
