import { Checkbox } from '@/components/ui/checkbox';
import { useNumber } from '@/hooks/use-numer-formatter';
import type { RouterOutputs } from '@/trpc/client';
import { getChartColor } from '@/utils/theme';
import { ArrowDown, ArrowUp, ChevronDown } from 'lucide-react';
import { Fragment, useCallback, useMemo, useState } from 'react';
import { formatDuration } from './chart';

type FunnelSeries = RouterOutputs['chart']['funnel']['current'][number];

interface BreakdownListProps {
  data: RouterOutputs['chart']['funnel'];
  visibleSeriesIds: string[];
  onToggleVisibility: (id: string) => void;
  onInspectStep?: (
    stepIndex: number,
    breakdownValues?: string[],
  ) => void;
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

function getSortValue(item: FunnelSeries, key: SortKey): number | string {
  if (key === 'label') {
    return item.breakdowns?.join(' > ') ?? '';
  }
  if (key === 'totalConv') {
    return item.lastStep?.percent ?? 0;
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

// Sticky cell styles
const stickyLeft0 =
  'sticky left-0 z-10 bg-card';
const stickyLeft1 =
  'sticky left-[32px] z-10 bg-card';
const stickyLeft2 =
  'sticky left-[232px] z-10 bg-card border-r border-border';
const stickyHeader =
  'sticky top-0 z-20 bg-card';
const stickyHeaderLeft0 =
  'sticky top-0 left-0 z-30 bg-card';
const stickyHeaderLeft1 =
  'sticky top-0 left-[32px] z-30 bg-card';
const stickyHeaderLeft2 =
  'sticky top-0 left-[232px] z-30 bg-card border-r border-border';

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
      const va = getSortValue(a, sortKey);
      const vb = getSortValue(b, sortKey);
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
  }, [allBreakdowns, sortKey, sortDir]);

  const applyTopN = useCallback(
    (n: number) => {
      setTopNDraft(n);
      setShowTopNMenu(false);
      onTopNChange?.(n === 10 ? undefined : n);
    },
    [onTopNChange],
  );

  if (allBreakdowns.length === 0) {
    return null;
  }

  const steps = allBreakdowns[0]!.steps;

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return null;
    return sortDir === 'asc' ? (
      <ArrowUp className="size-3 inline ml-0.5" />
    ) : (
      <ArrowDown className="size-3 inline ml-0.5" />
    );
  };

  const sortableHeader = (
    key: SortKey,
    label: string,
    className?: string,
  ) => (
    <th
      className={`px-3 py-1 text-right font-normal cursor-pointer hover:text-foreground select-none whitespace-nowrap ${className ?? ''}`}
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
                        const v = Math.min(Math.max(topNDraft, 1), allBreakdowns.length);
                        applyTopN(v);
                      } else if (e.key === 'Escape') {
                        setTopNDraft(displayedTopN);
                        setShowTopNMenu(false);
                      }
                    }}
                    onBlur={() => {
                      const v = Math.min(Math.max(topNDraft, 1), allBreakdowns.length);
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
      <table className="w-full text-sm border-collapse">
        <thead>
          {/* Row 1: step group headers */}
          <tr className={`border-b border-border ${stickyHeader}`}>
            <th className={`px-2 py-2 w-8 ${stickyHeaderLeft0}`} />
            <th
              className={`px-3 py-2 text-left font-medium text-muted-foreground min-w-[200px] cursor-pointer hover:text-foreground select-none ${stickyHeaderLeft1}`}
              onClick={() => handleSort('label')}
            >
              Breakdown
              <SortIcon col="label" />
            </th>
            <th
              className={`px-3 py-2 text-right font-medium text-muted-foreground whitespace-nowrap cursor-pointer hover:text-foreground select-none ${stickyHeaderLeft2}`}
              onClick={() => handleSort('totalConv')}
            >
              Total Conv.
              <SortIcon col="totalConv" />
            </th>
            {steps.map((step, i) => {
              const colSpan = i === 0 ? 1 : 3;
              return (
                <th
                  key={step.event.id ?? i}
                  colSpan={colSpan}
                  className={`px-3 py-2 text-center border-l border-border whitespace-nowrap ${stickyHeader}`}
                >
                  <span className="text-muted-foreground font-normal">{i + 1}</span>{' '}
                  <span className="font-semibold">{step.event.displayName}</span>
                </th>
              );
            })}
          </tr>
          {/* Row 2: sub-column labels (sortable) */}
          <tr className={`border-b border-border ${stickyHeader}`} style={{ top: 37 }}>
            <th className={`px-2 py-1 ${stickyHeaderLeft0}`} style={{ top: 37 }} />
            <th className={`px-3 py-1 ${stickyHeaderLeft1}`} style={{ top: 37 }} />
            <th className={`px-3 py-1 ${stickyHeaderLeft2}`} style={{ top: 37 }} />
            {steps.map((step, i) => {
              if (i === 0) {
                return (
                  <Fragment key={`sub-${step.event.id ?? i}`}>
                    {sortableHeader(
                      `step:${i}:count`,
                      '#',
                      `border-l border-border ${stickyHeader}`,
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
                  )}
                  {sortableHeader(`step:${i}:conv`, 'Conv %', stickyHeader)}
                  {sortableHeader(`step:${i}:count`, '#', stickyHeader)}
                </Fragment>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedBreakdowns.map((item) => {
            const isVisible = visibleSeriesIds.includes(item.id);
            const colorIndex = allBreakdowns.findIndex(
              (b) => b.id === item.id,
            );
            const color =
              colorIndex >= 0 ? getChartColor(colorIndex) : undefined;
            const label =
              item.breakdowns && item.breakdowns.length > 0
                ? item.breakdowns.join(' > ')
                : 'Not set';

            return (
              <tr
                key={item.id}
                className="border-b border-border last:border-b-0 hover:bg-muted/30"
              >
                <td className={`px-2 py-2 ${stickyLeft0}`}>
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
                  className={`px-3 py-2 font-medium truncate max-w-[200px] ${stickyLeft1}`}
                  title={label}
                >
                  {label}
                </td>
                <td className={`px-3 py-2 text-right font-mono font-semibold ${stickyLeft2}`}>
                  {number.formatWithUnit(
                    item.lastStep.percent / 100,
                    '%',
                  )}
                </td>
                {item.steps.map((step, stepIdx) => {
                  if (stepIdx === 0) {
                    return (
                      <td
                        key={`${item.id}-s${stepIdx}`}
                        className="px-3 py-2 text-right font-mono border-l border-border cursor-pointer hover:bg-muted/50"
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
                      <td className="px-3 py-2 text-right font-mono">
                        {number.formatWithUnit(
                          step.stepConversionPercent / 100,
                          '%',
                        )}
                      </td>
                      <td
                        className="px-3 py-2 text-right font-mono cursor-pointer hover:bg-muted/50"
                        onClick={() =>
                          onInspectStep?.(stepIdx, item.breakdowns)
                        }
                      >
                        {number.format(step.stepConversionCount)}
                      </td>
                    </Fragment>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
