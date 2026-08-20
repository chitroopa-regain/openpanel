import { Checkbox } from '@/components/ui/checkbox';
import {
  buildBreakdownScreenshotContextBatches,
  buildFunnelBreakdownScreenshotTargets,
  EVENT_SCREENSHOT_SIGNED_URL_REFRESH_MS,
  eventScreenshotsForContext,
  MAX_SCREENSHOT_CONTEXTS_PER_QUERY,
  mergeEventScreenshotCatalogs,
} from '@/components/events/event-screenshot-context';
import { EventScreenshotPreview } from '@/components/events/event-screenshot-preview';
import { useNumber } from '@/hooks/use-numer-formatter';
import { useTRPC } from '@/integrations/trpc/react';
import type { RouterOutputs } from '@/trpc/client';
import { getChartColor } from '@/utils/theme';
import { useQueries } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronDown } from 'lucide-react';
import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  formatDuration,
  formatFunnelMeasureValue,
  getFunnelMeasureFromOptions,
  getFunnelMeasureLabel,
  getFunnelMeasureValue,
} from './chart';
import { useReportChartContext } from '../context';

type FunnelSeries = RouterOutputs['chart']['funnel']['current'][number];

interface BreakdownListProps {
  data: RouterOutputs['chart']['funnel'];
  visibleSeriesIds: string[];
  onToggleVisibility: (id: string) => void;
  onInspectStep?: (stepIndex: number, breakdownValues?: string[]) => void;
  savedTopN?: number;
  onTopNChange?: (n: number | undefined) => void;
}

type SortKey =
  | 'label'
  | 'totalConv'
  | `step:${number}:count`
  | `step:${number}:conv`
  | `step:${number}:time`;
type SortDir = 'asc' | 'desc';

function getSortValue(
  item: FunnelSeries,
  key: SortKey,
  measure = getFunnelMeasureFromOptions(undefined)
): number | string {
  if (key === 'label') {
    return item.breakdowns?.join(' > ') ?? '';
  }
  if (key === 'totalConv') {
    return getFunnelMeasureValue(item.lastStep, measure);
  }
  const match = key.match(/^step:(\d+):(\w+)$/);
  if (!match) return 0;
  const stepIdx = Number(match[1]);
  const metric = match[2];
  const step = item.steps[stepIdx];
  if (!step) return 0;
  if (metric === 'count') return step.stepConversionCount ?? 0;
  if (metric === 'conv') return step.stepConversionPercent ?? 0;
  if (metric === 'time') return step.medianTimeToConvertSeconds ?? Infinity;
  return 0;
}

export function getFunnelBreakdownStickyLayout() {
  const selectionWidth = 40;
  const breakdownWidth = 200;
  const totalConversionWidth = 120;

  return {
    selection: {
      width: selectionWidth,
      left: 0,
    },
    breakdown: {
      width: breakdownWidth,
      left: selectionWidth,
    },
    totalConversion: {
      width: totalConversionWidth,
      left: selectionWidth + breakdownWidth,
    },
  };
}

export function getFunnelBreakdownMetricColumnWidths() {
  return {
    // The first step has only one metric sub-column, so its step-name header
    // does not span the wider Time/Conv/# group used by later steps. Reserve
    // enough room for real event names such as "Application Installed" instead
    // of letting the fixed table clip them to "Application I".
    firstStepCount: 240,
    time: 96,
    conversion: 112,
    count: 80,
  };
}

export function getFunnelBreakdownTableScrollGutterWidth() {
  return 96;
}

export function getFunnelBreakdownTableMinWidth(stepCount: number) {
  const layout = getFunnelBreakdownStickyLayout();
  const metrics = getFunnelBreakdownMetricColumnWidths();
  const pinnedWidth =
    layout.selection.width +
    layout.breakdown.width +
    layout.totalConversion.width;
  let metricWidth = 0;
  for (let index = 0; index < stepCount; index += 1) {
    metricWidth +=
      index === 0
        ? metrics.firstStepCount
        : metrics.time + metrics.conversion + metrics.count;
  }

  return pinnedWidth + metricWidth + getFunnelBreakdownTableScrollGutterWidth();
}

export function getFunnelBreakdownStickyColumnStyle(
  column: keyof ReturnType<typeof getFunnelBreakdownStickyLayout>
) {
  const layout = getFunnelBreakdownStickyLayout()[column];

  return {
    left: layout.left,
    width: layout.width,
    minWidth: layout.width,
    maxWidth: layout.width,
  };
}

// Sticky cell styles. Widths include horizontal padding; the left offsets must
// match the rendered widths or the pinned Total Conv. column can overlap/crop
// percentage values on narrow mobile viewports. Keep these literal Tailwind
// classes in sync with getFunnelBreakdownStickyLayout() so the generated CSS
// includes them.
const stickyLeft0 = 'sticky left-0 z-10 bg-card w-[40px] min-w-[40px]';
const stickyLeft1 =
  'sticky left-[40px] z-10 bg-card w-[200px] min-w-[200px] max-w-[200px]';
const stickyLeft2 =
  'sticky left-[240px] z-10 bg-card border-r border-border w-[120px] min-w-[120px]';
const stickyHeader = 'sticky top-0 z-20 bg-card';
const stickyHeaderLeft0 =
  'sticky top-0 left-0 z-30 bg-card w-[40px] min-w-[40px]';
const stickyHeaderLeft1 =
  'sticky top-0 left-[40px] z-30 bg-card w-[200px] min-w-[200px] max-w-[200px]';
const stickyHeaderLeft2 =
  'sticky top-0 left-[240px] z-30 bg-card border-r border-border w-[120px] min-w-[120px]';
const scrollGutterWidth = getFunnelBreakdownTableScrollGutterWidth();
const scrollGutterStyle = {
  width: scrollGutterWidth,
  minWidth: scrollGutterWidth,
};

export function BreakdownList({
  data,
  visibleSeriesIds,
  onToggleVisibility,
  onInspectStep,
  savedTopN,
  onTopNChange,
}: BreakdownListProps) {
  const allBreakdowns = data.current;
  const number = useNumber();
  const { report } = useReportChartContext();
  const measure = getFunnelMeasureFromOptions(report.options);
  const trpc = useTRPC();
  const breakdownStep =
    report.options?.type === 'funnel'
      ? report.options.breakdownStep
      : undefined;
  const screenshotTargets = useMemo(
    () =>
      buildFunnelBreakdownScreenshotTargets({
        rows: allBreakdowns,
        reportSeries: report.series,
        breakdownProperties: report.breakdowns.map((item) => item.name),
        breakdownStep,
        startDate: report.startDate,
        endDate: report.endDate,
      }),
    [
      allBreakdowns,
      breakdownStep,
      report.breakdowns,
      report.endDate,
      report.series,
      report.startDate,
    ]
  );
  const screenshotContextBatches = useMemo(
    () => buildBreakdownScreenshotContextBatches(screenshotTargets),
    [screenshotTargets]
  );
  const screenshotCatalogQueries = useQueries({
    queries: screenshotContextBatches.map((screenshotContexts) =>
      trpc.chart.events.queryOptions(
        {
          includeDropped: true,
          projectId: report.projectId,
          screenshotContexts,
        },
        {
          enabled: screenshotContexts.length > 0,
          refetchInterval: EVENT_SCREENSHOT_SIGNED_URL_REFRESH_MS,
        }
      )
    ),
  });
  const screenshotCatalog = mergeEventScreenshotCatalogs(
    screenshotCatalogQueries.map((query) => query.data)
  );
  const screenshotTargetByRowId = new Map(
    screenshotTargets.map((target, index) => [
      target.serieId,
      {
        batchIndex: Math.floor(index / MAX_SCREENSHOT_CONTEXTS_PER_QUERY),
        target,
      },
    ])
  );
  const screenshotsByRowId = new Map(
    screenshotTargets.map((target) => [
      target.serieId,
      eventScreenshotsForContext(screenshotCatalog, target.context),
    ])
  );
  const screenshotBatchRefreshedAt = useRef(new Map<number, number>());
  const [sortKey, setSortKey] = useState<SortKey>('totalConv');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const displayedTopN = savedTopN ?? 10;
  const [topNDraft, setTopNDraft] = useState(displayedTopN);
  const [showTopNMenu, setShowTopNMenu] = useState(false);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'label' ? 'asc' : 'desc');
    }
  };

  const sortedBreakdowns = useMemo(() => {
    const items = [...allBreakdowns];
    items.sort((a, b) => {
      const va = getSortValue(a, sortKey, measure);
      const vb = getSortValue(b, sortKey, measure);
      let cmp: number;
      if (typeof va === 'string' && typeof vb === 'string') {
        cmp = va.localeCompare(vb);
      } else {
        const na = typeof va === 'number' ? va : 0;
        const nb = typeof vb === 'number' ? vb : 0;
        // Infinity (null times) always sort to the bottom regardless of direction
        if (na === Infinity && nb === Infinity) return 0;
        if (na === Infinity) return 1;
        if (nb === Infinity) return -1;
        cmp = na - nb;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return items;
  }, [allBreakdowns, sortKey, sortDir, measure]);

  const applyTopN = useCallback(
    (n: number) => {
      setTopNDraft(n);
      setShowTopNMenu(false);
      onTopNChange?.(n === 10 ? undefined : n);
    },
    [onTopNChange]
  );

  if (allBreakdowns.length === 0) {
    return null;
  }

  const steps = allBreakdowns[0]!.steps;
  const stickyLayout = getFunnelBreakdownStickyLayout();
  const stickySelectionStyle = getFunnelBreakdownStickyColumnStyle('selection');
  const stickyBreakdownStyle = getFunnelBreakdownStickyColumnStyle('breakdown');
  const stickyTotalConversionStyle =
    getFunnelBreakdownStickyColumnStyle('totalConversion');
  const metricWidths = getFunnelBreakdownMetricColumnWidths();
  const tableMinWidth = getFunnelBreakdownTableMinWidth(steps.length);

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return null;
    return sortDir === 'asc' ? (
      <ArrowUp className="size-3 inline ml-0.5" />
    ) : (
      <ArrowDown className="size-3 inline ml-0.5" />
    );
  };

  const stickySubHeaderStyle = { top: 48 };

  const sortableHeader = (
    key: SortKey,
    label: string,
    className?: string,
    style?: CSSProperties
  ) => (
    <th
      className={`h-12 px-3 py-0 align-middle text-right font-normal cursor-pointer hover:text-foreground select-none whitespace-nowrap ${className ?? ''}`}
      style={style}
      onClick={() => handleSort(key)}
    >
      {label}
      <SortIcon col={key} />
    </th>
  );

  return (
    <div className="card overflow-auto max-h-[600px]">
      {/* Top N selector */}
      {allBreakdowns.length > 6 && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border text-sm relative">
          <span className="text-muted-foreground">
            {allBreakdowns[0]?.breakdowns?.[0] ? 'source' : 'Breakdown'}{' '}
            {allBreakdowns.length}
          </span>
          <button
            type="button"
            className="row items-center gap-1 px-2 py-0.5 rounded border border-border hover:bg-muted/50 text-xs font-medium"
            onClick={() => {
              setTopNDraft(displayedTopN);
              setShowTopNMenu(!showTopNMenu);
            }}
          >
            Top {displayedTopN}
            <ChevronDown className="size-3" />
          </button>
          {showTopNMenu && (
            <>
              {/* Click-outside overlay to close and apply */}
              <div
                className="fixed inset-0 z-40"
                onClick={() => {
                  if (topNDraft > 0 && topNDraft <= allBreakdowns.length) {
                    applyTopN(topNDraft);
                  }
                  setShowTopNMenu(false);
                }}
              />
              <div className="absolute top-full left-12 z-50 mt-1 rounded-lg border bg-card p-3 shadow-lg col gap-2 min-w-[200px]">
                <div className="font-medium text-sm">Top Values</div>
                <div className="text-xs text-muted-foreground">
                  Choose the number of rows to show in the chart.
                </div>
                <div className="row items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={allBreakdowns.length}
                    value={topNDraft}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isNaN(v)) {
                        setTopNDraft(v);
                      }
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') {
                        const v = Math.min(
                          Math.max(topNDraft, 1),
                          allBreakdowns.length
                        );
                        applyTopN(v);
                      } else if (e.key === 'Escape') {
                        setTopNDraft(displayedTopN);
                        setShowTopNMenu(false);
                      }
                    }}
                    onBlur={() => {
                      const v = Math.min(
                        Math.max(topNDraft, 1),
                        allBreakdowns.length
                      );
                      setTopNDraft(v);
                    }}
                    className="w-16 rounded border border-border bg-transparent px-2 py-1 text-sm"
                  />
                  <span className="text-sm">rows</span>
                </div>
                <button
                  type="button"
                  className="text-xs text-left hover:text-foreground text-muted-foreground"
                  onClick={() => applyTopN(allBreakdowns.length)}
                >
                  Show all ({allBreakdowns.length})
                </button>
              </div>
            </>
          )}
        </div>
      )}
      <table
        className="text-sm border-collapse"
        style={{
          tableLayout: 'fixed',
          width: tableMinWidth,
          minWidth: tableMinWidth,
        }}
      >
        <colgroup>
          <col style={{ width: stickyLayout.selection.width }} />
          <col style={{ width: stickyLayout.breakdown.width }} />
          <col style={{ width: stickyLayout.totalConversion.width }} />
          {steps.map((step, i) => {
            if (i === 0) {
              return (
                <col
                  key={`col-${step.event.id ?? i}-count`}
                  style={{ width: metricWidths.firstStepCount }}
                />
              );
            }
            return (
              <Fragment key={`col-${step.event.id ?? i}`}>
                <col style={{ width: metricWidths.time }} />
                <col style={{ width: metricWidths.conversion }} />
                <col style={{ width: metricWidths.count }} />
              </Fragment>
            );
          })}
          <col />
        </colgroup>
        <thead>
          {/* Row 1: step group headers */}
          <tr className="h-12 border-b border-border">
            <th
              className={`h-12 px-2 py-0 align-middle ${stickyHeaderLeft0}`}
              style={stickySelectionStyle}
            />
            <th
              className={`h-12 px-3 py-0 align-middle text-left font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none ${stickyHeaderLeft1}`}
              onClick={() => handleSort('label')}
              style={stickyBreakdownStyle}
            >
              Breakdown
              <SortIcon col="label" />
            </th>
            <th
              className={`h-12 px-3 py-0 align-middle text-right font-medium text-muted-foreground whitespace-nowrap cursor-pointer hover:text-foreground select-none ${stickyHeaderLeft2}`}
              onClick={() => handleSort('totalConv')}
              style={stickyTotalConversionStyle}
            >
              {getFunnelMeasureLabel(measure)}
              <SortIcon col="totalConv" />
            </th>
            {steps.map((step, i) => {
              const colSpan = i === 0 ? 1 : 3;
              return (
                <th
                  key={step.event.id ?? i}
                  colSpan={colSpan}
                  className={`h-12 px-3 py-0 align-middle text-center border-l border-border whitespace-nowrap ${stickyHeader}`}
                >
                  <span className="text-muted-foreground font-normal">
                    {i + 1}
                  </span>{' '}
                  <span className="font-semibold">
                    {step.event.displayName}
                  </span>
                </th>
              );
            })}
            <th
              aria-hidden="true"
              className={`h-12 px-0 py-0 align-middle ${stickyHeader}`}
              style={scrollGutterStyle}
            />
          </tr>
          {/* Row 2: sub-column labels (sortable) */}
          <tr className="h-12 border-b border-border">
            <th
              className={`h-12 px-2 py-0 align-middle ${stickyHeaderLeft0}`}
              style={{ ...stickySelectionStyle, ...stickySubHeaderStyle }}
            />
            <th
              className={`h-12 px-3 py-0 align-middle ${stickyHeaderLeft1}`}
              style={{ ...stickyBreakdownStyle, ...stickySubHeaderStyle }}
            />
            <th
              className={`h-12 px-3 py-0 align-middle ${stickyHeaderLeft2}`}
              style={{
                ...stickyTotalConversionStyle,
                ...stickySubHeaderStyle,
              }}
            />
            {steps.map((step, i) => {
              if (i === 0) {
                return (
                  <Fragment key={`sub-${step.event.id ?? i}`}>
                    {sortableHeader(
                      `step:${i}:count`,
                      '#',
                      `border-l border-border ${stickyHeader}`,
                      stickySubHeaderStyle
                    )}
                  </Fragment>
                );
              }
              return (
                <Fragment key={`sub-${step.event.id ?? i}`}>
                  {sortableHeader(
                    `step:${i}:time`,
                    'Time',
                    `border-l border-border ${stickyHeader}`,
                    stickySubHeaderStyle
                  )}
                  {sortableHeader(
                    `step:${i}:conv`,
                    'Conv %',
                    stickyHeader,
                    stickySubHeaderStyle
                  )}
                  {sortableHeader(
                    `step:${i}:count`,
                    '#',
                    stickyHeader,
                    stickySubHeaderStyle
                  )}
                </Fragment>
              );
            })}
            <th
              aria-hidden="true"
              className={`h-12 px-0 py-0 align-middle ${stickyHeader}`}
              style={{ ...scrollGutterStyle, ...stickySubHeaderStyle }}
            />
          </tr>
        </thead>
        <tbody>
          {sortedBreakdowns.map((item) => {
            const isVisible = visibleSeriesIds.includes(item.id);
            const colorIndex = allBreakdowns.findIndex((b) => b.id === item.id);
            const color =
              colorIndex >= 0 ? getChartColor(colorIndex) : undefined;
            const label =
              item.breakdowns && item.breakdowns.length > 0
                ? item.breakdowns.join(' > ')
                : 'Not set';
            const targetEntry = screenshotTargetByRowId.get(item.id);
            const screenshotQuery = targetEntry
              ? screenshotCatalogQueries[targetEntry.batchIndex]
              : undefined;
            const screenshots = screenshotsByRowId.get(item.id);

            return (
              <tr
                key={item.id}
                className="border-b border-border last:border-b-0 hover:bg-muted/30"
              >
                <td
                  className={`px-2 py-2 ${stickyLeft0}`}
                  style={stickySelectionStyle}
                >
                  <Checkbox
                    checked={isVisible}
                    onCheckedChange={() => onToggleVisibility(item.id)}
                    className="shrink-0"
                    style={{
                      borderColor: color,
                      backgroundColor:
                        isVisible && color ? color : 'transparent',
                    }}
                  />
                </td>
                <td
                  className={`px-3 py-2 font-medium max-w-[200px] ${stickyLeft1}`}
                  style={stickyBreakdownStyle}
                  title={label}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {targetEntry && !screenshotQuery?.isPending && (
                      <EventScreenshotPreview
                        compact
                        eventName={`${targetEntry.target.eventName} — ${label}`}
                        onImageError={() => {
                          const now = Date.now();
                          const lastRefreshedAt =
                            screenshotBatchRefreshedAt.current.get(
                              targetEntry.batchIndex
                            ) ?? 0;
                          if (
                            !screenshotQuery ||
                            screenshotQuery.isFetching ||
                            now - lastRefreshedAt < 30_000
                          ) {
                            return;
                          }
                          screenshotBatchRefreshedAt.current.set(
                            targetEntry.batchIndex,
                            now
                          );
                          screenshotQuery.refetch();
                        }}
                        screenshots={screenshots}
                        showNoMatch
                      />
                    )}
                    <span className="truncate">{label}</span>
                  </div>
                </td>
                <td
                  className={`px-3 py-2 text-right font-mono font-semibold whitespace-nowrap ${stickyLeft2}`}
                  style={stickyTotalConversionStyle}
                >
                  {formatFunnelMeasureValue(
                    number,
                    getFunnelMeasureValue(item.lastStep, measure),
                    measure
                  )}
                </td>
                {item.steps.map((step, stepIdx) => {
                  if (stepIdx === 0) {
                    return (
                      <td
                        key={`${item.id}-s${stepIdx}`}
                        className="px-3 py-2 text-right font-mono whitespace-nowrap border-l border-border cursor-pointer hover:bg-muted/50"
                        onClick={() =>
                          onInspectStep?.(stepIdx, item.breakdowns)
                        }
                      >
                        {number.format(step.stepConversionCount)}
                      </td>
                    );
                  }
                  return (
                    <Fragment key={`${item.id}-s${stepIdx}`}>
                      <td className="px-3 py-2 text-right font-mono border-l border-border whitespace-nowrap text-muted-foreground">
                        {step.medianTimeToConvertSeconds != null
                          ? formatDuration(step.medianTimeToConvertSeconds)
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                        {number.formatWithUnit(
                          step.stepConversionPercent / 100,
                          '%'
                        )}
                      </td>
                      <td
                        className="px-3 py-2 text-right font-mono whitespace-nowrap cursor-pointer hover:bg-muted/50"
                        onClick={() =>
                          onInspectStep?.(stepIdx, item.breakdowns)
                        }
                      >
                        {number.format(step.stepConversionCount)}
                      </td>
                    </Fragment>
                  );
                })}
                <td
                  aria-hidden="true"
                  className="px-0 py-2"
                  style={scrollGutterStyle}
                />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
